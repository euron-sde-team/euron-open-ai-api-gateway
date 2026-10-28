# Providers, models and routes

How the catalogue is put together, and how to add a provider, a model and its prices. All of
it is data in Postgres, edited in `/admin` (**Providers** and **Models**) or through
`/api/admin/*`; nothing here needs a redeploy. The data plane reads it through
[`gateway/catalog.ts`](../../apps/api/src/gateway/catalog.ts), cached for 5 seconds per API
process (the process that made a change clears its cache at once). Background:
[routing-and-failover.md](../architecture/routing-and-failover.md) and
[pricing-and-margins.md](../architecture/pricing-and-margins.md).

```
provider (kind, base URL)  ── credentials (encrypted, used in turn)
    ▲
    │ route: upstream model name, priority, timeout, cost
    │
model (public id, aliases, kind, margin, enabled)
```

## Providers

A provider is an upstream API. Fields:

| Field | Notes |
| --- | --- |
| Slug (`id`) | Lowercase letters, digits and hyphens, 3 to 40 characters. Fixed once created |
| Kind | `OPENAI_COMPATIBLE`, `ANTHROPIC`, `GEMINI` or `STUB`: decides the wire format and the auth header |
| Base URL | Up to and including the version segment, for example `https://api.openai.com/v1`. Required for OpenAI-compatible; optional for the others |
| Enabled | A disabled provider's routes are skipped |

| Kind | Default base URL | Auth header | Speaks |
| --- | --- | --- | --- |
| `OPENAI_COMPATIBLE` | none (required) | `Authorization: Bearer <key>` | OpenAI format: chat, embeddings, images, speech, transcription |
| `ANTHROPIC` | `https://api.anthropic.com/v1` | `x-api-key: <key>`, `anthropic-version: 2023-06-01` | Anthropic Messages (chat only) |
| `GEMINI` | `https://generativelanguage.googleapis.com/v1beta/openai` | `Authorization: Bearer <key>` | Gemini's OpenAI-compatible surface |
| `STUB` | `STUBS_URL` + `/v1` | none needed | The local stubs; for development and tests |

The gateway appends the endpoint path to the base URL: `/chat/completions`, `/messages`,
`/embeddings`, `/images/generations`, `/audio/speech`, `/audio/transcriptions`, and `/models`
for health probes.

### Credentials

Add one or more under the provider (`POST /api/admin/providers/{id}/credentials`): a label and
the secret. The secret is encrypted on arrival with AES-256-GCM under a key derived from
`CREDENTIALS_KEY`, bound to the credential's row id, and never returned, logged or sent to
the browser; the console shows the label and the last four characters
([`security/credentials.ts`](../../apps/api/src/security/credentials.ts)). Several enabled
credentials on one provider are used round robin, which spreads load across provider
accounts or keys. Disable a credential to take it out of rotation; delete it to destroy the
ciphertext.

A provider other than `STUB` with no enabled credential has no usable routes.

## Models

A model is what developers put in `model`.

| Field | Notes |
| --- | --- |
| Id | Letters, digits and `. _ : / -`, up to 120 characters. Fixed once created |
| Kind | `CHAT`, `EMBEDDING`, `IMAGE`, `SPEECH` or `TRANSCRIPTION`: decides the endpoint it answers on and how it is billed |
| Aliases | Other names that resolve to it (case-insensitive). An alias may not equal another model's id or alias (`409 ALIAS_TAKEN`) |
| Display name, description, owned by | Shown in the console |
| Context window, max output | Max output caps the reservation and Anthropic's `max_tokens`; when unset, 32 768 is the cap |
| Tools, vision, JSON mode | Informational flags shown to developers |
| Margin | Optional, in basis points; see [Margins](#margins) |
| Sort order | Order in the console and `/v1/models` |
| Enabled | Off: callers get `404 model_not_found` |

## Routes

A route connects a model to a provider. A model can have several.

| Field | Notes |
| --- | --- |
| Provider | Any provider |
| Upstream model | The provider's own name for the model (`gpt-5.4-mini`, `claude-sonnet-5-5`, `llama-3.3-70b-versatile`). Callers never see it |
| Priority | 1 to 100; lower is tried first. The lowest-numbered usable route is the **primary** |
| Timeout | 1 to 600 seconds, default 120. Bounds one call through this route |
| Cost | What the provider charges you, below |
| Enabled | Off: skipped |

### Costs and their units

Costs are integers in **micro-USD** (1 USD = 1 000 000). Copy them from the provider's price
list.

| Model kind | Fields that matter | Unit |
| --- | --- | --- |
| CHAT | `inputMicrosPerMtok`, `outputMicrosPerMtok`, optional `cachedMicrosPerMtok` | Per million tokens. Cached input (prompt-cache reads) uses the cached price, or the input price when unset |
| EMBEDDING | `inputMicrosPerMtok` | Per million input tokens |
| IMAGE | `unitMicros` | Per image returned |
| SPEECH | `unitMicros` | Per **million characters** of input |
| TRANSCRIPTION | `unitMicros` | Per minute of audio |

Examples: 3 USD per million input tokens is `3000000`; 0.04 USD per image is `40000`; 15 USD
per million characters is `15000000`; 0.006 USD per minute is `6000`.

### Priorities and failover

A request tries the model's usable routes in priority order
([`gateway/pipeline.ts`](../../apps/api/src/gateway/pipeline.ts)):

- A route whose circuit is **open** is skipped. Five retryable failures within a minute open
  a route's circuit for 30 seconds; then one request at a time may try it (half-open), and a
  success closes it ([`gateway/breaker.ts`](../../apps/api/src/gateway/breaker.ts)). A
  provider answering 401 or 403 also counts toward opening the circuit.
- A **retryable** failure moves to the next route: the connection failed, the route timed
  out, or the provider answered 408, 409, 425, 429 or 5xx.
- Anything else (400, 401, 403, 404, 413, 422) stops: the next route would fail the same
  way. The caller gets `400 upstream_rejected` or `502 upstream_error`.
- A stream never fails over after its first byte.
- If every route's circuit is open, the caller gets `503 no_route_available`.

Use priorities for cost or reliability: put the cheaper provider first and a second provider
behind it. Remember that
callers pay the **primary** route's price whichever route served them; the overview shows the
real cost of the route that served each request, so failover to a pricier backup eats into
the margin rather than surprising the caller.

### The Test button

**Test** on a route (`POST /api/admin/models/{id}/routes/{routeId}/test`) builds the route
straight from the database, so it works on a disabled route or model, and makes one tiny real
call ([`gateway/probe.ts`](../../apps/api/src/gateway/probe.ts)):

| Kind | Test call |
| --- | --- |
| CHAT | One output token, to `/messages` (Anthropic) or `/chat/completions` |
| EMBEDDING | Embeds `ping` |
| SPEECH | Four characters with voice `alloy` |
| IMAGE, TRANSCRIPTION | No tiny version exists: a free `GET {base}/models` with the credential instead |

The result (`ok`, latency, and a key-free message such as "The provider refused the credential
(401)" or "The provider does not know this model or endpoint (404)") is recorded as a health
check. Test calls cost a fraction of a cent at the provider and are not billed to anyone.

## Enabling a model: MODEL_UNPRICED

An enabled model must always have at least one route that is enabled, priced, on an enabled
provider, with an enabled credential (the stub needs none). "Priced" depends on the kind:
CHAT needs an input or output cost above zero, EMBEDDING an input cost above zero, the unit
kinds a unit cost above zero. Any change that breaks this is refused in its transaction with
`409 MODEL_UNPRICED` and `details.models` naming the models: enabling a model without such a
route, or disabling or deleting the last route, provider or credential that an enabled model
depends on ([`services/admin-catalog.service.ts`](../../apps/api/src/services/admin-catalog.service.ts)).

The fix is always one of: add or enable a priced route, enable the provider or a credential,
or turn the model off first.

The check is on the **primary** route: the first usable route by priority (route and
provider enabled, a credential enabled unless it is the stub). That is the route the price
is computed from, so a free primary in front of a priced backup is refused too: price the
primary, reorder the routes, or disable the free one.

## Margins

The price a caller pays is the primary route's cost times `(10 000 + margin) / 10 000`,
rounded up to the micro-dollar. The margin in force is the first that is set of:

1. the key's margin (set by an admin on the account sheet),
2. the account's margin,
3. the model's margin,
4. the default margin (Settings, **Pricing**; 0 out of the box).

Margins are basis points from 0 (at cost) to 100 000 (11 times cost). A change applies to the
very next request. The admin **Models** page shows each model's margin in force at the
default and the resulting price; the console shows each account its own prices.

## The starter catalogue

On its first boot against a database with no providers, the API inserts the starter
catalogue ([`demo/catalog.ts`](../../apps/api/src/demo/catalog.ts)): providers `openai`,
`anthropic`, `gemini` and `groq` (all enabled, no credentials) and these models, **all
disabled**:

| Model | Kind | Route |
| --- | --- | --- |
| `gpt-5.4`, `gpt-5.4-mini` | CHAT | openai |
| `claude-sonnet-5-5`, `claude-haiku-5-5` | CHAT | anthropic |
| `gemini-3.5-flash` | CHAT | gemini |
| `llama-3.3-70b` | CHAT | groq (`llama-3.3-70b-versatile`) |
| `text-embedding-3-small` | EMBEDDING | openai |
| `gpt-image-1` | IMAGE | openai |
| `tts-1` | SPEECH | openai |
| `whisper-1` | TRANSCRIPTION | openai |

The costs are starting points, not a source of truth, and model ids change often. To bring
one online:

1. **Providers**: add the provider's API key as a credential.
2. **Models**: open the model, check the upstream model name and the route's cost against the
   provider's current documentation and price list, and set a margin if this model should
   differ from the default.
3. Press **Test** on the route.
4. Turn the model on.

Outside production the local stub providers are added too, with enabled models for every
endpoint: `stub-chat` (alias `stub`), `stub-claude` (served by the Anthropic-format stub),
`stub-failover` (primary route answers 503), `stub-embed`, `stub-image`, `stub-tts` and
`stub-whisper`. They are never inserted in production. The starter catalogue is only inserted
into an empty catalogue; it never overwrites your edits.

## Provider specifics

### Anthropic

Kind `ANTHROPIC`, base URL empty (the default) or your own Anthropic-compatible endpoint.
Anthropic serves chat only. Callers reach it on both chat endpoints: `/v1/messages` passes
through, `/v1/chat/completions` is translated ([gateway.md](../api/gateway.md#cross-format-translation)).
`max_tokens` is always sent (Anthropic requires it). On `/v1/messages` it is the caller's
value capped at the model's max output; on `/v1/chat/completions` it is the caller's
`max_completion_tokens` or `max_tokens` capped the same way, or the model's max output when
the caller sent neither. `temperature` above 1 is lowered to 1.
Token usage includes prompt-cache reads and writes in the input count; reads are priced at the
cached price.

### Gemini

Kind `GEMINI` uses Google's OpenAI-compatible surface
(`https://generativelanguage.googleapis.com/v1beta/openai`), so requests pass through in the
OpenAI format with the Gemini API key as a bearer token. Use Gemini's own model names as the
upstream model (`gemini-3.5-flash`). Chat, embeddings and images work through that surface;
what Google supports there is what works.

### Any OpenAI-compatible host

Kind `OPENAI_COMPATIBLE` with the host's base URL, including its version path:

| Host | Base URL |
| --- | --- |
| OpenAI | `https://api.openai.com/v1` |
| Groq | `https://api.groq.com/openai/v1` |
| A self-hosted server (vLLM, Ollama and others with an OpenAI-compatible API) | `http://<host>:<port>/v1` |

Requests are passed through as the caller sent them (with `model` replaced), so parameters the
host does not support come back as `400 upstream_rejected`. Streams must send OpenAI-style SSE
chunks; usage is billed when the host returns it (the gateway always asks with
`stream_options.include_usage`), else estimated.

The health probe calls `GET {base}/models`. A host without that endpoint shows failed probes on
the Health page; one failed probe every five minutes is not enough to open the circuit on its
own, but it adds to real failures within the same minute. Press **Test** for a real call.

### Stub

Kind `STUB` calls `STUBS_URL`. It needs no credential. The stub's failure switches are
upstream model names: `fail-500`, `fail-503`, `fail-429`, `fail-401`, and `slow-<ms>`
([`apps/stubs/server.mjs`](../../apps/stubs/server.mjs)). Do not create stub providers on a
production deployment.
