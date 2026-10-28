# ADR 0006: Speak both the OpenAI and the Anthropic format, translate between them

## Status

Accepted.

## Context

Most SDKs and tools speak OpenAI's Chat Completions format; Anthropic's SDKs and tools
built on them speak the Messages format. A gateway that only speaks one forces callers to
rewrite code to reach the other family of models.

## Decision

- `/v1/chat/completions` and `/v1/messages` both accept every chat model.
- Routes to an `ANTHROPIC` provider are called natively (`x-api-key`,
  `anthropic-version: 2023-06-01`). Routes to `OPENAI_COMPATIBLE`, `GEMINI` (Google's
  OpenAI-compatible surface) and `STUB` providers are called in the OpenAI format.
- When the caller's format and the route's format differ, the request and the response
  are translated, including streams (event by event), system prompts, tools and tool
  calls, images and usage with cached tokens.
- The model name in every response is the public model id the caller used, never the
  upstream id.
- Embeddings, images and audio exist only in the OpenAI format; an Anthropic route cannot
  serve them.

Code: [`apps/api/src/gateway/translate.ts`](../../../apps/api/src/gateway/translate.ts),
[`apps/api/src/gateway/handlers.ts`](../../../apps/api/src/gateway/handlers.ts).

## Consequences

Positive:

- Any SDK reaches any chat model by changing the base URL and the key.
- Operators can swap a model's provider without callers noticing.

Trade-offs:

- Features with no equivalent in the other format (for example provider-specific
  parameters) are dropped in translation; callers who need them should use the model's
  native format.
- Translation code must follow both APIs as they change; the unit tests pin the mappings.

## Alternatives considered

- **OpenAI format only.** Excludes Anthropic SDK users.
- **Pass-through per provider.** Ties callers to providers, which defeats the gateway.
