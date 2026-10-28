/**
 * Translation between the OpenAI Chat Completions format and the Anthropic Messages
 * format, both ways, for requests, responses and streams (ADR 0006). It lets
 * /v1/chat/completions reach a model served by Anthropic and /v1/messages reach a model
 * served by any OpenAI-compatible provider.
 *
 * Covered: text, images (URL and base64), system and developer messages, tools and tool
 * results, tool choice, stop sequences, max tokens, temperature, top_p, JSON mode (as an
 * instruction), usage with prompt-cache reads. Not translated (dropped): logprobs, n > 1,
 * seed, audio parts, Anthropic thinking blocks and citations.
 */

// ─── Shapes (only what is translated) ──────────────────────────────────────

export type OAIContentPart = { type: "text"; text: string } | { type: "image_url"; image_url: { url: string } } | { type: string; [k: string]: unknown };
export interface OAIToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}
export interface OAIMessage {
  role: "system" | "developer" | "user" | "assistant" | "tool";
  content?: string | OAIContentPart[] | null;
  tool_calls?: OAIToolCall[];
  tool_call_id?: string;
  name?: string;
}
export interface OAIChatRequest {
  model: string;
  messages: OAIMessage[];
  max_tokens?: number;
  max_completion_tokens?: number;
  temperature?: number;
  top_p?: number;
  stop?: string | string[];
  stream?: boolean;
  stream_options?: { include_usage?: boolean };
  tools?: { type: "function"; function: { name: string; description?: string; parameters?: object } }[];
  tool_choice?: "auto" | "none" | "required" | { type: "function"; function: { name: string } };
  response_format?: { type: string };
  [k: string]: unknown;
}
export interface OAIUsage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  prompt_tokens_details?: { cached_tokens?: number };
}
export interface OAIChatResponse {
  id: string;
  object: "chat.completion";
  created: number;
  model: string;
  choices: { index: number; message: { role: "assistant"; content: string | null; tool_calls?: OAIToolCall[] }; finish_reason: string | null }[];
  usage?: OAIUsage;
}
export interface OAIChunk {
  id: string;
  object: "chat.completion.chunk";
  created: number;
  model: string;
  choices: { index: number; delta: { role?: "assistant"; content?: string; tool_calls?: { index: number; id?: string; type?: "function"; function?: { name?: string; arguments?: string } }[] }; finish_reason: string | null }[];
  usage?: OAIUsage | null;
}

export type AnthBlock =
  | { type: "text"; text: string }
  | { type: "image"; source: { type: "base64"; media_type: string; data: string } | { type: "url"; url: string } }
  | { type: "tool_use"; id: string; name: string; input: unknown }
  | { type: "tool_result"; tool_use_id: string; content: string | AnthBlock[]; is_error?: boolean }
  | { type: string; [k: string]: unknown };
export interface AnthMessage {
  role: "user" | "assistant";
  content: string | AnthBlock[];
}
export interface AnthRequest {
  model: string;
  system?: string | { type: "text"; text: string }[];
  messages: AnthMessage[];
  max_tokens: number;
  temperature?: number;
  top_p?: number;
  top_k?: number;
  stop_sequences?: string[];
  stream?: boolean;
  tools?: { name: string; description?: string; input_schema: object }[];
  tool_choice?: { type: "auto" | "any" | "tool" | "none"; name?: string };
  metadata?: unknown;
  [k: string]: unknown;
}
export interface AnthUsage {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
}
export interface AnthResponse {
  id: string;
  type: "message";
  role: "assistant";
  model: string;
  content: AnthBlock[];
  stop_reason: string | null;
  stop_sequence: string | null;
  usage: AnthUsage;
}

const now = () => Math.floor(Date.now() / 1000);

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text || "{}");
  } catch {
    return {};
  }
}

function dataUrl(url: string): { media_type: string; data: string } | null {
  const m = /^data:([^;,]+);base64,(.*)$/s.exec(url);
  return m ? { media_type: m[1]!, data: m[2]! } : null;
}

function textOf(content: string | OAIContentPart[] | AnthBlock[] | null | undefined): string {
  if (!content) return "";
  if (typeof content === "string") return content;
  return content
    .map((p) => (p.type === "text" && typeof (p as { text?: unknown }).text === "string" ? (p as { text: string }).text : ""))
    .filter(Boolean)
    .join("\n");
}

// ─── OpenAI request -> Anthropic request ───────────────────────────────────

const OAI_TO_ANTH_STOP: Record<string, string> = { end_turn: "stop", max_tokens: "length", tool_use: "tool_calls", stop_sequence: "stop", refusal: "content_filter", pause_turn: "stop" };

export function openAiToAnthropicRequest(req: OAIChatRequest, upstreamModel: string, defaultMaxTokens: number): AnthRequest {
  const system: string[] = [];
  const messages: AnthMessage[] = [];
  const push = (role: "user" | "assistant", blocks: AnthBlock[]) => {
    if (!blocks.length) return;
    const last = messages[messages.length - 1];
    // Anthropic wants alternating roles: merge consecutive turns of the same role.
    if (last && last.role === role && Array.isArray(last.content)) last.content.push(...blocks);
    else messages.push({ role, content: blocks });
  };
  for (const m of req.messages) {
    if (m.role === "system" || m.role === "developer") {
      const t = textOf(m.content);
      if (t) system.push(t);
    } else if (m.role === "user") {
      const blocks: AnthBlock[] = [];
      if (typeof m.content === "string") blocks.push({ type: "text", text: m.content });
      else
        for (const p of m.content ?? []) {
          if (p.type === "text") blocks.push({ type: "text", text: String((p as { text: unknown }).text ?? "") });
          else if (p.type === "image_url") {
            const url = String((p as { image_url?: { url?: string } }).image_url?.url ?? "");
            const d = dataUrl(url);
            blocks.push({ type: "image", source: d ? { type: "base64", media_type: d.media_type, data: d.data } : { type: "url", url } });
          }
        }
      push("user", blocks);
    } else if (m.role === "assistant") {
      const blocks: AnthBlock[] = [];
      const t = textOf(m.content);
      if (t) blocks.push({ type: "text", text: t });
      for (const c of m.tool_calls ?? []) blocks.push({ type: "tool_use", id: c.id, name: c.function.name, input: parseJson(c.function.arguments) });
      push("assistant", blocks);
    } else if (m.role === "tool") {
      push("user", [{ type: "tool_result", tool_use_id: m.tool_call_id ?? "", content: textOf(m.content) }]);
    }
  }
  if (req.response_format?.type === "json_object" || req.response_format?.type === "json_schema") system.push("Respond with a single valid JSON object and nothing else.");
  const out: AnthRequest = {
    model: upstreamModel,
    messages,
    max_tokens: req.max_completion_tokens ?? req.max_tokens ?? defaultMaxTokens,
  };
  if (system.length) out.system = system.join("\n\n");
  if (req.temperature !== undefined) out.temperature = Math.min(1, req.temperature);
  if (req.top_p !== undefined) out.top_p = req.top_p;
  if (req.stop !== undefined) out.stop_sequences = Array.isArray(req.stop) ? req.stop : [req.stop];
  if (req.tools?.length) out.tools = req.tools.map((t) => ({ name: t.function.name, description: t.function.description, input_schema: t.function.parameters ?? { type: "object", properties: {} } }));
  if (req.tool_choice) {
    const tc = req.tool_choice;
    out.tool_choice = tc === "auto" ? { type: "auto" } : tc === "none" ? { type: "none" } : tc === "required" ? { type: "any" } : { type: "tool", name: tc.function.name };
  }
  if (req.stream) out.stream = true;
  return out;
}

export function anthropicUsageToOpenAi(u: AnthUsage): OAIUsage {
  const cached = u.cache_read_input_tokens ?? 0;
  const prompt = (u.input_tokens ?? 0) + cached + (u.cache_creation_input_tokens ?? 0);
  return { prompt_tokens: prompt, completion_tokens: u.output_tokens ?? 0, total_tokens: prompt + (u.output_tokens ?? 0), prompt_tokens_details: { cached_tokens: cached } };
}

export function anthropicToOpenAiResponse(r: AnthResponse, publicModel: string): OAIChatResponse {
  const text = r.content.filter((b) => b.type === "text").map((b) => (b as { text: string }).text).join("");
  const toolCalls = r.content
    .filter((b) => b.type === "tool_use")
    .map((b) => {
      const t = b as { id: string; name: string; input: unknown };
      return { id: t.id, type: "function" as const, function: { name: t.name, arguments: JSON.stringify(t.input ?? {}) } };
    });
  return {
    id: `chatcmpl-${r.id}`,
    object: "chat.completion",
    created: now(),
    model: publicModel,
    choices: [{ index: 0, message: { role: "assistant", content: text || (toolCalls.length ? null : ""), ...(toolCalls.length ? { tool_calls: toolCalls } : {}) }, finish_reason: OAI_TO_ANTH_STOP[r.stop_reason ?? "end_turn"] ?? "stop" }],
    usage: anthropicUsageToOpenAi(r.usage),
  };
}

/** Anthropic stream events in, OpenAI chunks out. Feed every event; read usage at the end. */
export class AnthropicToOpenAiStream {
  private id = `chatcmpl-${Date.now().toString(36)}`;
  private created = now();
  private toolIndex = new Map<number, number>();
  usage: AnthUsage = { input_tokens: 0, output_tokens: 0 };

  constructor(private readonly publicModel: string) {}

  private chunk(delta: OAIChunk["choices"][0]["delta"], finish: string | null = null): OAIChunk {
    return { id: this.id, object: "chat.completion.chunk", created: this.created, model: this.publicModel, choices: [{ index: 0, delta, finish_reason: finish }] };
  }

  push(event: { type: string; [k: string]: unknown }): OAIChunk[] {
    switch (event.type) {
      case "message_start": {
        const m = event.message as { id?: string; usage?: AnthUsage };
        if (m?.id) this.id = `chatcmpl-${m.id}`;
        if (m?.usage) this.usage = { ...this.usage, ...m.usage };
        return [this.chunk({ role: "assistant", content: "" })];
      }
      case "content_block_start": {
        const b = event.content_block as { type: string; id?: string; name?: string };
        if (b?.type === "tool_use") {
          const idx = this.toolIndex.size;
          this.toolIndex.set(Number(event.index), idx);
          return [this.chunk({ tool_calls: [{ index: idx, id: b.id, type: "function", function: { name: b.name, arguments: "" } }] })];
        }
        return [];
      }
      case "content_block_delta": {
        const d = event.delta as { type: string; text?: string; partial_json?: string };
        if (d?.type === "text_delta" && d.text) return [this.chunk({ content: d.text })];
        if (d?.type === "input_json_delta") {
          const idx = this.toolIndex.get(Number(event.index));
          if (idx !== undefined) return [this.chunk({ tool_calls: [{ index: idx, function: { arguments: d.partial_json ?? "" } }] })];
        }
        return [];
      }
      case "message_delta": {
        const d = event.delta as { stop_reason?: string };
        const u = event.usage as Partial<AnthUsage> | undefined;
        if (u) this.usage = { ...this.usage, ...Object.fromEntries(Object.entries(u).filter(([, v]) => typeof v === "number")) } as AnthUsage;
        return [this.chunk({}, OAI_TO_ANTH_STOP[d?.stop_reason ?? "end_turn"] ?? "stop")];
      }
      default:
        return [];
    }
  }

  usageChunk(): OAIChunk {
    return { id: this.id, object: "chat.completion.chunk", created: this.created, model: this.publicModel, choices: [], usage: anthropicUsageToOpenAi(this.usage) };
  }
}

// ─── Anthropic request -> OpenAI request ───────────────────────────────────

const ANTH_FROM_OAI_STOP: Record<string, string> = { stop: "end_turn", length: "max_tokens", tool_calls: "tool_use", content_filter: "refusal", function_call: "tool_use" };

export function anthropicToOpenAiRequest(req: AnthRequest, upstreamModel: string): OAIChatRequest {
  const messages: OAIMessage[] = [];
  const sys = typeof req.system === "string" ? req.system : (req.system ?? []).map((b) => b.text).join("\n\n");
  if (sys) messages.push({ role: "system", content: sys });
  for (const m of req.messages) {
    const blocks: AnthBlock[] = typeof m.content === "string" ? [{ type: "text", text: m.content }] : m.content;
    if (m.role === "user") {
      const parts: OAIContentPart[] = [];
      for (const b of blocks) {
        if (b.type === "text") parts.push({ type: "text", text: (b as { text: string }).text });
        else if (b.type === "image") {
          const s = (b as { source: { type: string; media_type?: string; data?: string; url?: string } }).source;
          parts.push({ type: "image_url", image_url: { url: s.type === "base64" ? `data:${s.media_type};base64,${s.data}` : String(s.url ?? "") } });
        } else if (b.type === "tool_result") {
          const t = b as { tool_use_id: string; content: string | AnthBlock[] };
          messages.push({ role: "tool", tool_call_id: t.tool_use_id, content: typeof t.content === "string" ? t.content : textOf(t.content) });
        }
      }
      if (parts.length) messages.push({ role: "user", content: parts.length === 1 && parts[0]!.type === "text" ? (parts[0] as { text: string }).text : parts });
    } else {
      const text = blocks.filter((b) => b.type === "text").map((b) => (b as { text: string }).text).join("");
      const calls = blocks
        .filter((b) => b.type === "tool_use")
        .map((b) => {
          const t = b as { id: string; name: string; input: unknown };
          return { id: t.id, type: "function" as const, function: { name: t.name, arguments: JSON.stringify(t.input ?? {}) } };
        });
      messages.push({ role: "assistant", content: text || null, ...(calls.length ? { tool_calls: calls } : {}) });
    }
  }
  const out: OAIChatRequest = { model: upstreamModel, messages, max_tokens: req.max_tokens };
  if (req.temperature !== undefined) out.temperature = req.temperature;
  if (req.top_p !== undefined) out.top_p = req.top_p;
  if (req.stop_sequences?.length) out.stop = req.stop_sequences;
  if (req.tools?.length) out.tools = req.tools.map((t) => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.input_schema } }));
  if (req.tool_choice) {
    const tc = req.tool_choice;
    out.tool_choice = tc.type === "auto" ? "auto" : tc.type === "none" ? "none" : tc.type === "any" ? "required" : { type: "function", function: { name: tc.name ?? "" } };
  }
  if (req.stream) {
    out.stream = true;
    out.stream_options = { include_usage: true };
  }
  return out;
}

export function openAiUsageToAnthropic(u: OAIUsage | undefined | null): AnthUsage {
  const cached = u?.prompt_tokens_details?.cached_tokens ?? 0;
  return { input_tokens: Math.max(0, (u?.prompt_tokens ?? 0) - cached), output_tokens: u?.completion_tokens ?? 0, cache_read_input_tokens: cached };
}

export function openAiToAnthropicResponse(r: OAIChatResponse, publicModel: string): AnthResponse {
  const choice = r.choices[0];
  const content: AnthBlock[] = [];
  if (choice?.message.content) content.push({ type: "text", text: choice.message.content });
  for (const c of choice?.message.tool_calls ?? []) content.push({ type: "tool_use", id: c.id, name: c.function.name, input: parseJson(c.function.arguments) });
  return {
    id: `msg_${r.id.replace(/^chatcmpl-/, "")}`,
    type: "message",
    role: "assistant",
    model: publicModel,
    content,
    stop_reason: ANTH_FROM_OAI_STOP[choice?.finish_reason ?? "stop"] ?? "end_turn",
    stop_sequence: null,
    usage: openAiUsageToAnthropic(r.usage),
  };
}

type AnthEvent = { type: string; [k: string]: unknown };

/** OpenAI chunks in, Anthropic stream events out. */
export class OpenAiToAnthropicStream {
  private started = false;
  private block = -1;
  private textOpen = false;
  private tools = new Map<number, number>();
  private stop: string | null = null;
  usage: OAIUsage | null = null;

  constructor(
    private readonly publicModel: string,
    private readonly id = `msg_${Date.now().toString(36)}`,
  ) {}

  private start(): AnthEvent[] {
    if (this.started) return [];
    this.started = true;
    return [{ type: "message_start", message: { id: this.id, type: "message", role: "assistant", model: this.publicModel, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 0, output_tokens: 0 } } }];
  }

  private closeText(): AnthEvent[] {
    if (!this.textOpen) return [];
    this.textOpen = false;
    return [{ type: "content_block_stop", index: this.block }];
  }

  push(chunk: OAIChunk): AnthEvent[] {
    const out = this.start();
    if (chunk.usage) this.usage = chunk.usage;
    const c = chunk.choices?.[0];
    if (!c) return out;
    if (c.delta.content) {
      if (!this.textOpen) {
        this.block++;
        this.textOpen = true;
        out.push({ type: "content_block_start", index: this.block, content_block: { type: "text", text: "" } });
      }
      out.push({ type: "content_block_delta", index: this.block, delta: { type: "text_delta", text: c.delta.content } });
    }
    for (const t of c.delta.tool_calls ?? []) {
      let idx = this.tools.get(t.index);
      if (idx === undefined) {
        out.push(...this.closeText());
        if (this.tools.size) out.push({ type: "content_block_stop", index: this.block });
        this.block++;
        idx = this.block;
        this.tools.set(t.index, idx);
        out.push({ type: "content_block_start", index: idx, content_block: { type: "tool_use", id: t.id ?? `toolu_${idx}`, name: t.function?.name ?? "", input: {} } });
      }
      if (t.function?.arguments) out.push({ type: "content_block_delta", index: idx, delta: { type: "input_json_delta", partial_json: t.function.arguments } });
    }
    if (c.finish_reason) this.stop = ANTH_FROM_OAI_STOP[c.finish_reason] ?? "end_turn";
    return out;
  }

  finish(): AnthEvent[] {
    const out = this.start();
    out.push(...this.closeText());
    if (this.tools.size) out.push({ type: "content_block_stop", index: this.block });
    const u = openAiUsageToAnthropic(this.usage);
    out.push({ type: "message_delta", delta: { stop_reason: this.stop ?? "end_turn", stop_sequence: null }, usage: { output_tokens: u.output_tokens, input_tokens: u.input_tokens, cache_read_input_tokens: u.cache_read_input_tokens } });
    out.push({ type: "message_stop" });
    return out;
  }
}
