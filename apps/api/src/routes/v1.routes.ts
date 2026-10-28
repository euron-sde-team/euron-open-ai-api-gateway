/**
 * The data plane: the OpenAI and Anthropic compatible endpoints under /v1. Mounted in
 * app.ts ahead of the console middleware, because it differs from the rest of the API:
 * callers authenticate with an API key (never a cookie), so any origin may call it; the
 * body limit is larger; and errors use the provider envelopes, not the console's.
 */
import cors from "cors";
import express, { Router, type NextFunction, type Request, type Response } from "express";
import multer from "multer";
import { config } from "../core/config";
import { captureError } from "../core/logger";
import { GatewayError, sendGatewayError } from "../gateway/errors";
import { audioSpeech, audioTranscriptions, chatCompletions, embeddings, imageGenerations, listModels, messages } from "../gateway/handlers";

export const router = Router();

router.use(cors({ origin: true, credentials: false, maxAge: 600, exposedHeaders: ["x-request-id", "retry-after"] }));
router.use(express.json({ limit: `${config.GATEWAY_MAX_BODY_MB}mb` }));

const audio = multer({ storage: multer.memoryStorage(), limits: { fileSize: config.GATEWAY_MAX_AUDIO_MB * 1024 * 1024, files: 1 } });

type Handler = (req: Request, res: Response) => Promise<void>;
const wrap = (fn: Handler) => (req: Request, res: Response, next: NextFunction) => fn(req, res).catch(next);

router.get("/models", wrap(listModels));
router.post("/chat/completions", wrap(chatCompletions));
router.post("/messages", wrap(messages));
router.post("/embeddings", wrap(embeddings));
router.post("/images/generations", wrap(imageGenerations));
router.post("/audio/speech", wrap(audioSpeech));
router.post("/audio/transcriptions", audio.single("file"), wrap(audioTranscriptions));

router.use((req, res) => {
  sendGatewayError(res, new GatewayError(404, "invalid_request_error", "unknown_url", `Unknown endpoint: ${req.method} ${req.baseUrl}${req.path}`), req.path === "/messages" ? "anthropic" : "openai");
});

router.use((err: unknown, req: Request, res: Response, _next: NextFunction) => {
  const format = req.path === "/messages" ? "anthropic" : "openai";
  if (err instanceof GatewayError) return sendGatewayError(res, err, format);
  if (err instanceof multer.MulterError) return sendGatewayError(res, new GatewayError(err.code === "LIMIT_FILE_SIZE" ? 413 : 400, "invalid_request_error", err.code.toLowerCase(), err.code === "LIMIT_FILE_SIZE" ? `Audio files can be at most ${config.GATEWAY_MAX_AUDIO_MB} MB.` : err.message), format);
  const status = (err as { status?: number }).status;
  const type = (err as { type?: string }).type;
  if (status === 413 || type === "entity.too.large") return sendGatewayError(res, new GatewayError(413, "invalid_request_error", "request_too_large", `Request bodies can be at most ${config.GATEWAY_MAX_BODY_MB} MB.`), format);
  if (status && status >= 400 && status < 500) return sendGatewayError(res, new GatewayError(400, "invalid_request_error", "invalid_json", "The request body is not valid JSON."), format);
  captureError(err, { where: "v1", url: req.originalUrl });
  if (res.headersSent) {
    res.end();
    return;
  }
  sendGatewayError(res, new GatewayError(500, "api_error", "internal_error", "The gateway hit an internal error."), format);
});
