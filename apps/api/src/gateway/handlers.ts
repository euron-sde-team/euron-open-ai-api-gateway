/**
 * The /v1 endpoints. Each builds a CallSpec for the pipeline: how to estimate the call
 * for the reservation, and how to execute it against one route (pass the request
 * through to an OpenAI-compatible provider, or translate for Anthropic) and write the
 * response. Streams are relayed chunk by chunk; the model name in every response is the
 * public id the caller asked for, never the upstream id.
 */
import type { Request, Response } from "express";
import { readSse } from "../integrations/http";
import { authenticateKey } from "./auth";
import { catalog, type CatalogModel, type CatalogRoute } from "./catalog";
import { badRequest, GatewayError, sendGatewayError } from "./errors";
import { runCall, type Outcome, type Usage } from "./pipeline";
import { estimateChatInput, estimateEmbeddingInput, estimateTextTokens } from "./tokens";
import {
  AnthropicToOpenAiStream,
  anthropicToOpenAiRequest,
  anthropicToOpenAiResponse,
  openAiToAnthropicRequest,
  openAiToAnthropicResponse,
  OpenAiToAnthropicStream,
  type AnthRequest,
  type AnthResponse,
  type OAIChatRequest,
  type OAIChatResponse,
  type OAIChunk,
} from "./translate";
import { callUpstream, UpstreamError } from "./upstream";


/** Used when a model has no maximum output set in the catalogue. */
const FALLBACK_MAX_OUTPUT = 32_768;

/**
 * The most output tokens a call may produce: what the caller asked for, capped at the
 * model's maximum; the model's maximum when the caller did not ask. The reservation is
 * based on it and every route is called with it, so a provider can never be asked for
 * more than was reserved.
 */
function maxOutput(model: CatalogModel, asked: unknown): number {
  const cap = model.maxOutputTokens ?? FALLBACK_MAX_OUTPUT;
  const n = typeof asked === "number" && asked > 0 ? Math.floor(asked) : cap;
  return Math.min(n, cap);
}

/**
 * The OpenAI-format body sent upstream with the output limit made explicit: the caller's
 * own parameter (max_completion_tokens or max_tokens) capped, or max_completion_tokens
 * when the caller set neither, the parameter current OpenAI models require.
 */
function withOutputCap(body: OAIChatRequest, maxOut: number): OAIChatRequest {
  if (typeof body.max_completion_tokens === "number") return { ...body, max_completion_tokens: maxOut };
  if (typeof body.max_tokens === "number") return { ...body, max_tokens: maxOut };
  return { ...body, max_completion_tokens: maxOut };
}

/** Comment lines keep idle streams alive through proxies (CloudFront closes after 60 s of silence); SSE clients ignore them. */
export const SSE_KEEPALIVE_MS = 15_000;

function startSse(res: Response): void {
  res.status(200);
  res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders();
  const timer = setInterval(() => {
    if (!res.writableEnded) res.write(": keep-alive\n\n");
  }, SSE_KEEPALIVE_MS);
  timer.unref();
  res.once("close", () => clearInterval(timer));
  res.once("finish", () => clearInterval(timer));
}

const isAnthropic = (r: CatalogRoute) => r.provider.kind === "ANTHROPIC";

function usageFromOpenAi(u: { prompt_tokens?: number; completion_tokens?: number; prompt_tokens_details?: { cached_tokens?: number } } | null | undefined): Usage | null {
  if (!u || typeof u.prompt_tokens !== "number") return null;
  return { inputTokens: u.prompt_tokens, outputTokens: u.completion_tokens ?? 0, cachedTokens: u.prompt_tokens_details?.cached_tokens ?? 0, units: 0, estimated: false };
}

function estimatedUsage(input: number, outputText: string): Usage {
  return { inputTokens: input, outputTokens: estimateTextTokens(outputText), cachedTokens: 0, units: 0, estimated: true };
}

// ─── /v1/chat/completions ──────────────────────────────────────────────────

export async function chatCompletions(req: Request, res: Response): Promise<void> {
  const body = (req.body ?? {}) as OAIChatRequest;
  if (!Array.isArray(body.messages) || !body.messages.length) return sendGatewayError(res, badRequest("`messages` must be a non-empty array.", "messages"), "openai");
  if (typeof body.n === "number" && body.n > 1) return sendGatewayError(res, badRequest("`n` greater than 1 is not supported.", "n"), "openai");
  const stream = body.stream === true;
  const wantsUsage = body.stream_options?.include_usage === true;
  let inputEstimate = 0;
  await runCall(req, res, {
    endpoint: "/v1/chat/completions",
    format: "openai",
    modelName: body.model,
    kinds: ["CHAT"],
    stream,
    requestBody: body,
    estimate: (model) => {
      inputEstimate = estimateChatInput(body);
      return { inputTokens: inputEstimate, maxOutputTokens: maxOutput(model, body.max_completion_tokens ?? body.max_tokens), units: 0 };
    },
    execute: async (route, model, { signal, started }) => {
      const maxOut = maxOutput(model, body.max_completion_tokens ?? body.max_tokens);
      if (isAnthropic(route)) {
        const up = await callUpstream(route, "/messages", openAiToAnthropicRequest({ ...body, max_tokens: maxOut, max_completion_tokens: undefined }, route.upstreamModel, maxOut), { signal });
        if (!stream) {
          const out = anthropicToOpenAiResponse((await up.json()) as AnthResponse, model.id);
          res.json(out);
          return { usage: usageFromOpenAi(out.usage) ?? estimatedUsage(inputEstimate, out.choices[0]?.message.content ?? ""), statusCode: 200, responseBody: out };
        }
        startSse(res);
        const tx = new AnthropicToOpenAiStream(model.id);
        let text = "";
        let ttfb: number | undefined;
        try {
          for await (const ev of readSse(up.body)) {
            const parsed = JSON.parse(ev.data) as { type: string };
            for (const c of tx.push(parsed)) {
              ttfb ??= Date.now() - started;
              text += c.choices[0]?.delta.content ?? "";
              res.write(`data: ${JSON.stringify(c)}\n\n`);
            }
          }
          if (wantsUsage) res.write(`data: ${JSON.stringify(tx.usageChunk())}\n\n`);
          res.write("data: [DONE]\n\n");
          res.end();
          const u = usageFromOpenAi(tx.usageChunk().usage);
          return { usage: u && (u.inputTokens || u.outputTokens) ? u : estimatedUsage(inputEstimate, text), statusCode: 200, ttfbMs: ttfb, responseBody: { content: text } };
        } catch {
          res.end();
          return { usage: estimatedUsage(inputEstimate, text), statusCode: 200, errorCode: "stream_interrupted", ttfbMs: ttfb, responseBody: { content: text } };
        }
      }
      const upstreamBody = { ...withOutputCap(body, maxOut), model: route.upstreamModel, ...(stream ? { stream_options: { ...(body.stream_options ?? {}), include_usage: true } } : {}) };
      const up = await callUpstream(route, "/chat/completions", upstreamBody, { signal });
      if (!stream) {
        const out = (await up.json()) as OAIChatResponse;
        out.model = model.id;
        res.json(out);
        return { usage: usageFromOpenAi(out.usage) ?? estimatedUsage(inputEstimate, out.choices?.[0]?.message?.content ?? ""), statusCode: 200, responseBody: out };
      }
      startSse(res);
      let usage: Usage | null = null;
      let text = "";
      let ttfb: number | undefined;
      try {
        for await (const ev of readSse(up.body)) {
          if (ev.data === "[DONE]") break;
          let chunk: OAIChunk;
          try {
            chunk = JSON.parse(ev.data) as OAIChunk;
          } catch {
            continue;
          }
          ttfb ??= Date.now() - started;
          if (chunk.usage) usage = usageFromOpenAi(chunk.usage) ?? usage;
          text += chunk.choices?.[0]?.delta?.content ?? "";
          chunk.model = model.id;
          // The usage-only chunk was forced on upstream; pass it on only if the caller asked for it.
          if (chunk.usage && !chunk.choices?.length && !wantsUsage) continue;
          if (!wantsUsage && chunk.usage) delete chunk.usage;
          res.write(`data: ${JSON.stringify(chunk)}\n\n`);
        }
        res.write("data: [DONE]\n\n");
        res.end();
        return { usage: usage ?? estimatedUsage(inputEstimate, text), statusCode: 200, ttfbMs: ttfb, responseBody: { content: text } };
      } catch {
        res.end();
        return { usage: usage ?? estimatedUsage(inputEstimate, text), statusCode: 200, errorCode: "stream_interrupted", ttfbMs: ttfb, responseBody: { content: text } };
      }
    },
  });
}

// ─── /v1/messages (Anthropic format) ───────────────────────────────────────

export async function messages(req: Request, res: Response): Promise<void> {
  const body = (req.body ?? {}) as AnthRequest;
  if (!Array.isArray(body.messages) || !body.messages.length) return sendGatewayError(res, badRequest("`messages` must be a non-empty array.", "messages"), "anthropic");
  if (typeof body.max_tokens !== "number" || body.max_tokens < 1) return sendGatewayError(res, badRequest("`max_tokens` is required.", "max_tokens"), "anthropic");
  const stream = body.stream === true;
  let inputEstimate = 0;
  await runCall(req, res, {
    endpoint: "/v1/messages",
    format: "anthropic",
    modelName: body.model,
    kinds: ["CHAT"],
    stream,
    requestBody: body,
    estimate: (model) => {
      inputEstimate = estimateChatInput({ messages: body.messages, system: body.system, tools: body.tools });
      return { inputTokens: inputEstimate, maxOutputTokens: maxOutput(model, body.max_tokens), units: 0 };
    },
    execute: async (route, model, { signal, started }) => {
      if (isAnthropic(route)) {
        const up = await callUpstream(route, "/messages", { ...body, model: route.upstreamModel, max_tokens: maxOutput(model, body.max_tokens) }, { signal });
        if (!stream) {
          const out = (await up.json()) as AnthResponse;
          out.model = model.id;
          res.json(out);
          const u = out.usage;
          return { usage: { inputTokens: (u?.input_tokens ?? 0) + (u?.cache_read_input_tokens ?? 0) + (u?.cache_creation_input_tokens ?? 0), outputTokens: u?.output_tokens ?? 0, cachedTokens: u?.cache_read_input_tokens ?? 0, units: 0, estimated: false }, statusCode: 200, responseBody: out };
        }
        startSse(res);
        const usage = { input: 0, output: 0, cached: 0 };
        let text = "";
        let ttfb: number | undefined;
        try {
          for await (const ev of readSse(up.body)) {
            ttfb ??= Date.now() - started;
            let data: { type?: string; message?: { model?: string; usage?: Record<string, number> }; usage?: Record<string, number>; delta?: { text?: string } } = {};
            try {
              data = JSON.parse(ev.data);
            } catch {
              continue;
            }
            if (data.type === "message_start" && data.message) {
              data.message.model = model.id;
              const u = data.message.usage ?? {};
              usage.input = (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0);
              usage.cached = u.cache_read_input_tokens ?? 0;
              usage.output = u.output_tokens ?? 0;
            }
            if (data.type === "message_delta" && data.usage?.output_tokens !== undefined) usage.output = data.usage.output_tokens;
            if (data.type === "content_block_delta") text += data.delta?.text ?? "";
            res.write(`event: ${ev.event ?? data.type}\ndata: ${JSON.stringify(data)}\n\n`);
          }
          res.end();
          const u: Usage = usage.input || usage.output ? { inputTokens: usage.input, outputTokens: usage.output, cachedTokens: usage.cached, units: 0, estimated: false } : estimatedUsage(inputEstimate, text);
          return { usage: u, statusCode: 200, ttfbMs: ttfb, responseBody: { content: text } };
        } catch {
          res.end();
          return { usage: estimatedUsage(inputEstimate, text), statusCode: 200, errorCode: "stream_interrupted", ttfbMs: ttfb, responseBody: { content: text } };
        }
      }
      const oai = anthropicToOpenAiRequest({ ...body, max_tokens: maxOutput(model, body.max_tokens) }, route.upstreamModel);
      const up = await callUpstream(route, "/chat/completions", oai, { signal });
      if (!stream) {
        const out = openAiToAnthropicResponse((await up.json()) as OAIChatResponse, model.id);
        res.json(out);
        return { usage: { inputTokens: out.usage.input_tokens + (out.usage.cache_read_input_tokens ?? 0), outputTokens: out.usage.output_tokens, cachedTokens: out.usage.cache_read_input_tokens ?? 0, units: 0, estimated: false }, statusCode: 200, responseBody: out };
      }
      startSse(res);
      const tx = new OpenAiToAnthropicStream(model.id);
      let text = "";
      let ttfb: number | undefined;
      const emit = (events: { type: string }[]) => {
        for (const e of events) res.write(`event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`);
      };
      try {
        for await (const ev of readSse(up.body)) {
          if (ev.data === "[DONE]") break;
          let chunk: OAIChunk;
          try {
            chunk = JSON.parse(ev.data) as OAIChunk;
          } catch {
            continue;
          }
          ttfb ??= Date.now() - started;
          text += chunk.choices?.[0]?.delta?.content ?? "";
          emit(tx.push(chunk));
        }
        emit(tx.finish());
        res.end();
        const u = usageFromOpenAi(tx.usage);
        return { usage: u ?? estimatedUsage(inputEstimate, text), statusCode: 200, ttfbMs: ttfb, responseBody: { content: text } };
      } catch {
        res.end();
        return { usage: estimatedUsage(inputEstimate, text), statusCode: 200, errorCode: "stream_interrupted", ttfbMs: ttfb, responseBody: { content: text } };
      }
    },
  });
}

// ─── /v1/embeddings ────────────────────────────────────────────────────────

export async function embeddings(req: Request, res: Response): Promise<void> {
  const body = (req.body ?? {}) as { model?: unknown; input?: unknown };
  if (body.input === undefined || body.input === null || (Array.isArray(body.input) && !body.input.length)) return sendGatewayError(res, badRequest("`input` is required.", "input"), "openai");
  const inputTokens = estimateEmbeddingInput(body.input);
  await runCall(req, res, {
    endpoint: "/v1/embeddings",
    format: "openai",
    modelName: body.model,
    kinds: ["EMBEDDING"],
    stream: false,
    requestBody: { ...body, input: "[omitted]" },
    estimate: () => ({ inputTokens, maxOutputTokens: 0, units: 0 }),
    execute: async (route, model, { signal }) => {
      if (isAnthropic(route)) throw new UpstreamError(400, false, "http", route.provider.id);
      const up = await callUpstream(route, "/embeddings", { ...body, model: route.upstreamModel }, { signal });
      const out = (await up.json()) as { model?: string; usage?: { prompt_tokens?: number; total_tokens?: number } };
      out.model = model.id;
      res.json(out);
      const tokens = out.usage?.prompt_tokens ?? out.usage?.total_tokens;
      return { usage: { inputTokens: tokens ?? inputTokens, outputTokens: 0, cachedTokens: 0, units: 0, estimated: tokens === undefined }, statusCode: 200, responseBody: { usage: out.usage } };
    },
  });
}

// ─── /v1/images/generations ────────────────────────────────────────────────

export async function imageGenerations(req: Request, res: Response): Promise<void> {
  const body = (req.body ?? {}) as { model?: unknown; prompt?: unknown; n?: unknown };
  if (typeof body.prompt !== "string" || !body.prompt.trim()) return sendGatewayError(res, badRequest("`prompt` is required.", "prompt"), "openai");
  const n = typeof body.n === "number" ? Math.floor(body.n) : 1;
  if (n < 1 || n > 10) return sendGatewayError(res, badRequest("`n` must be between 1 and 10.", "n"), "openai");
  await runCall(req, res, {
    endpoint: "/v1/images/generations",
    format: "openai",
    modelName: body.model,
    kinds: ["IMAGE"],
    stream: false,
    requestBody: body,
    estimate: () => ({ inputTokens: 0, maxOutputTokens: 0, units: n }),
    execute: async (route, model, { signal }) => {
      if (isAnthropic(route)) throw new UpstreamError(400, false, "http", route.provider.id);
      const up = await callUpstream(route, "/images/generations", { ...body, n, model: route.upstreamModel }, { signal });
      const out = (await up.json()) as { data?: unknown[] };
      res.json(out);
      const made = Array.isArray(out.data) ? out.data.length : n;
      return { usage: { inputTokens: 0, outputTokens: 0, cachedTokens: 0, units: made, estimated: false }, statusCode: 200, responseBody: { images: made } };
    },
  });
}

// ─── /v1/audio/speech ──────────────────────────────────────────────────────

export async function audioSpeech(req: Request, res: Response): Promise<void> {
  const body = (req.body ?? {}) as { model?: unknown; input?: unknown; voice?: unknown };
  if (typeof body.input !== "string" || !body.input) return sendGatewayError(res, badRequest("`input` is required.", "input"), "openai");
  if (body.input.length > 4096) return sendGatewayError(res, badRequest("`input` can be at most 4096 characters.", "input"), "openai");
  const chars = body.input.length;
  await runCall(req, res, {
    endpoint: "/v1/audio/speech",
    format: "openai",
    modelName: body.model,
    kinds: ["SPEECH"],
    stream: false,
    requestBody: body,
    estimate: () => ({ inputTokens: 0, maxOutputTokens: 0, units: chars }),
    execute: async (route, _model, { signal }) => {
      if (isAnthropic(route)) throw new UpstreamError(400, false, "http", route.provider.id);
      const up = await callUpstream(route, "/audio/speech", { ...body, model: route.upstreamModel }, { signal });
      const audio = Buffer.from(await up.arrayBuffer());
      res.setHeader("Content-Type", up.headers.get("content-type") ?? "audio/mpeg");
      res.end(audio);
      return { usage: { inputTokens: 0, outputTokens: 0, cachedTokens: 0, units: chars, estimated: false }, statusCode: 200, responseBody: { bytes: audio.length } };
    },
  });
}

// ─── /v1/audio/transcriptions ──────────────────────────────────────────────

/** Rough minutes of audio from its size when the provider reports no duration (about 1 MB a minute for compressed speech). */
const bytesToMinutes = (bytes: number) => Math.max(0.1, bytes / 1_000_000);

export async function audioTranscriptions(req: Request, res: Response): Promise<void> {
  const file = req.file;
  const fields = (req.body ?? {}) as Record<string, string>;
  if (!file) return sendGatewayError(res, badRequest("Attach the audio as the multipart field `file`.", "file"), "openai");
  const asked = fields.response_format ?? "json";
  if (!["json", "text", "verbose_json"].includes(asked)) return sendGatewayError(res, badRequest("`response_format` must be json, text or verbose_json.", "response_format"), "openai");
  const estMinutes = bytesToMinutes(file.size);
  await runCall(req, res, {
    endpoint: "/v1/audio/transcriptions",
    format: "openai",
    modelName: fields.model,
    kinds: ["TRANSCRIPTION"],
    stream: false,
    requestBody: { model: fields.model, language: fields.language, response_format: asked, fileName: file.originalname, bytes: file.size },
    // Reserve for twice the size estimate: compressed audio can be denser than assumed.
    estimate: () => ({ inputTokens: 0, maxOutputTokens: 0, units: Math.ceil(estMinutes * 2 * 10) / 10 }),
    execute: async (route, _model, { signal }) => {
      if (isAnthropic(route)) throw new UpstreamError(400, false, "http", route.provider.id);
      const form = new FormData();
      form.append("file", new Blob([new Uint8Array(file.buffer)], { type: file.mimetype || "application/octet-stream" }), file.originalname || "audio");
      form.append("model", route.upstreamModel);
      // verbose_json carries the duration the bill is based on; the caller gets the format they asked for.
      form.append("response_format", "verbose_json");
      for (const k of ["language", "prompt", "temperature"]) if (fields[k]) form.append(k, fields[k]!);
      const up = await callUpstream(route, "/audio/transcriptions", form, { signal });
      const out = (await up.json()) as { text?: string; duration?: number };
      const minutes = typeof out.duration === "number" ? out.duration / 60 : estMinutes;
      if (asked === "text") res.type("text/plain").send(out.text ?? "");
      else if (asked === "verbose_json") res.json(out);
      else res.json({ text: out.text ?? "" });
      return { usage: { inputTokens: 0, outputTokens: 0, cachedTokens: 0, units: Math.round(minutes * 10_000) / 10_000, estimated: typeof out.duration !== "number" }, statusCode: 200, responseBody: { text: out.text } };
    },
  });
}

// ─── /v1/models ────────────────────────────────────────────────────────────

/** The models this key may call, in the OpenAI list shape. */
export async function listModels(req: Request, res: Response): Promise<void> {
  try {
    const ctx = await authenticateKey(req);
    const { models } = await catalog();
    const visible = ctx.allowedModels.length ? models.filter((m) => ctx.allowedModels.includes(m.id)) : models;
    res.json({ object: "list", data: visible.map((m) => ({ id: m.id, object: "model", created: 0, owned_by: m.ownedBy || "gateway", type: m.kind.toLowerCase() })) });
  } catch (err) {
    if (err instanceof GatewayError) return sendGatewayError(res, err, "openai");
    throw err;
  }
}

export type { Outcome };
