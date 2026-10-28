export interface StubRequest {
  method: string;
  path: string;
  at: string;
  body: unknown;
  headers: { authorization: "present" | null; "x-api-key": "present" | null; "anthropic-version": string | null };
}
export interface StubOptions {
  port?: number;
  host?: string;
  publicUrl?: string;
  webUrl?: string;
  stripeWebhookSecret?: string;
  razorpayKeySecret?: string;
  razorpayWebhookSecret?: string;
  /** Where the hosted-checkout stand-in delivers Stripe webhooks (default http://localhost:5056). */
  apiUrl?: string;
}
export interface Stubs {
  handler(req: import("node:http").IncomingMessage, res: import("node:http").ServerResponse): Promise<void>;
  config: { publicUrl: string; webUrl: string; stripeWebhookSecret: string; razorpayKeySecret: string; razorpayWebhookSecret: string; apiUrl: string };
  state: { requests: StubRequest[]; sessions: Map<string, Record<string, unknown>>; orders: Map<string, Record<string, unknown>>; payments: Map<string, Record<string, unknown>> };
}
export function createStubs(options?: StubOptions): Stubs;
export function startStubs(options?: StubOptions): Promise<Stubs & { url: string; close(): Promise<void> }>;
export function tokens(text: string): number;
export function promptTokens(messages: { role: string; content: unknown }[] | undefined, system?: unknown): number;
export function lastUserText(messages: { role: string; content: unknown }[] | undefined): string;
export function replyTo(text: string): string;
export function failureFor(model: string): number | null;
export function parseMultipart(buf: Buffer, contentType: string): { fields: Record<string, string>; fileBytes: number };
