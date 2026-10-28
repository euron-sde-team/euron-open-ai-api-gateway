/**
 * Data-plane errors in the caller's format: the OpenAI envelope
 * `{ "error": { "message", "type", "code", "param" } }` on every endpoint except
 * /v1/messages, which uses Anthropic's `{ "type": "error", "error": { "type", "message" } }`.
 * Messages never contain provider error text.
 */
import type { Response } from "express";

export type GatewayErrorType = "invalid_request_error" | "authentication_error" | "permission_error" | "not_found_error" | "rate_limit_error" | "insufficient_balance" | "api_error" | "overloaded_error";

export class GatewayError extends Error {
  constructor(
    readonly status: number,
    readonly type: GatewayErrorType,
    readonly code: string,
    message: string,
    readonly param: string | null = null,
    readonly headers: Record<string, string> = {},
  ) {
    super(message);
  }
}

const ANTHROPIC_TYPE: Record<GatewayErrorType, string> = {
  invalid_request_error: "invalid_request_error",
  authentication_error: "authentication_error",
  permission_error: "permission_error",
  not_found_error: "not_found_error",
  rate_limit_error: "rate_limit_error",
  insufficient_balance: "billing_error",
  api_error: "api_error",
  overloaded_error: "overloaded_error",
};

export function sendGatewayError(res: Response, err: GatewayError, format: "openai" | "anthropic"): void {
  if (res.headersSent) return;
  for (const [k, v] of Object.entries(err.headers)) res.setHeader(k, v);
  res.status(err.status);
  if (format === "anthropic") res.json({ type: "error", error: { type: ANTHROPIC_TYPE[err.type], message: err.message } });
  else res.json({ error: { message: err.message, type: err.type, code: err.code, param: err.param } });
}

export const badRequest = (message: string, param: string | null = null, code = "invalid_request") => new GatewayError(400, "invalid_request_error", code, message, param);
