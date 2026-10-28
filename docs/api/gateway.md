# Gateway API (`/v1`)

The data plane: OpenAI-compatible and Anthropic-compatible endpoints that developers call
with a platform API key. One key reaches every model in the catalogue, whichever provider
serves it. Every call is priced, reserved against the account's prepaid wallet, routed
(with failover), and settled at the actual usage.

The code: [`routes/v1.routes.ts`](../../apps/api/src/routes/v1.routes.ts) (mounting, body
limits, error handling), [`gateway/handlers.ts`](../../apps/api/src/gateway/handlers.ts) (one
handler per endpoint), [`gateway/pipeline.ts`](../../apps/api/src/gateway/pipeline.ts) (the
shared path every call takes). The design is in
[data-plane.md](../architecture/data-plane.md); routing in
[routing-and-failover.md](../architecture/routing-and-failover.md); money in
[billing-and-ledger.md](../architecture/billing-and-ledger.md) and
[pricing-and-margins.md](../architecture/pricing-and-margins.md); limits in
[rate-limits.md](../architecture/rate-limits.md).

## Base URL

`GATEWAY_PUBLIC_URL`, including `/v1`. The console's **Docs** page shows the value an admin
set in **Settings** (`gatewayBaseUrl`, which defaults to `GATEWAY_PUBLIC_URL`).

| Where | Base URL |
| --- | --- |
| Local stack, direct to the API | `http://localhost:5056/v1` |
| Local stack, through the web app's proxy | `http://localhost:3560/v1` |
| AWS deployment | `https://<domain>/v1` (the load balancer sends `/v1/*` to the API) |

The examples below use `https://gateway.example.com/v1`.

## Authentication

Send the key either way:

```
Authorization: Bearer gw-...
x-api-key: gw-...
```

`x-api-key` is what the Anthropic SDKs send, so they work unchanged. A key is
`API_KEY_PREFIX` (default `gw-`) followed by 40 letters and digits. The server stores only
an HMAC of it ([`security/api-keys.ts`](../../apps/api/src/security/api-keys.ts)); the
console shows the secret once, at creation.

`/v1` answers any origin (CORS without credentials) and never reads cookies. The
`x-request-id` and `retry-after` response headers are exposed to browsers.

What a key can be limited to (set in the console, enforced on every request, effective on
the next request after an edit):

| Control | Effect when it refuses |
| --- | --- |
| Expiry | `401 expired_api_key` |
| Model allow-list (by model id; aliases are resolved when saved) | `403 model_not_allowed`; `/v1/models` lists only allowed models |
| IP allow-list (IPv4 or IPv6 addresses and CIDRs) | `403 ip_not_allowed` |
| Monthly budget (USD, calendar month in UTC) | `402 budget_exceeded` |
| RPM and TPM overrides | `429` (see [Rate limits](#rate-limits)) |
| Body logging (opt-in, off by default) | Not a refusal: request and response bodies are kept for `bodyRetentionDays` and shown only to the key's owner |

A revoked key, a key of a suspended, banned or erased account, and a key whose account is
not `ACTIVE` stop working at once (`401 invalid_api_key` or `403 account_restricted`).

## Models

`model` is a model id or one of its aliases, matched case-insensitively. Responses always
carry the public id you asked for (resolved to the model's id, never the provider's
upstream name).

```bash
curl https://gateway.example.com/v1/models -H "Authorization: Bearer $GW_KEY"
```

```json
{
  "object": "list",
  "data": [
    { "id": "stub-chat", "object": "model", "created": 0, "owned_by": "gateway", "type": "chat" },
    { "id": "stub-embed", "object": "model", "created": 0, "owned_by": "gateway", "type": "embedding" }
  ]
}
```

`type` is one of `chat`, `embedding`, `image`, `speech`, `transcription`. A model is listed
(and callable) when it is enabled and has at least one usable route: route enabled,
provider enabled, and a credential that decrypts (the stub provider needs none). Prices are
in the console (**Models**) and at `GET /api/catalog`, not here.

Each endpoint accepts models of one kind. A model of the wrong kind is
`400 model_not_supported`; an unknown or unavailable one is `404 model_not_found`.

| Endpoint | Model kind | Billed on |
| --- | --- | --- |
| `POST /v1/chat/completions` | CHAT | Input, cached input and output tokens |
| `POST /v1/messages` | CHAT | Input, cached input and output tokens |
| `POST /v1/embeddings` | EMBEDDING | Input tokens |
| `POST /v1/images/generations` | IMAGE | Images returned |
| `POST /v1/audio/speech` | SPEECH | Characters of `input` (price per million characters) |
| `POST /v1/audio/transcriptions` | TRANSCRIPTION | Minutes of audio |
| `GET /v1/models` | | Free |

## POST /v1/chat/completions

The OpenAI Chat Completions format. Required: `model` and a non-empty `messages` array.
`n` greater than 1 is refused (`400`, `param: "n"`). Everything else is passed to an
OpenAI-compatible provider as you sent it, with `model` replaced by the route's upstream
model name.

```bash
curl https://gateway.example.com/v1/chat/completions \
  -H "Authorization: Bearer $GW_KEY" \
  -H "Content-Type: application/json" \
  -d '{"model": "stub-chat", "messages": [{"role": "user", "content": "Hello"}]}'
```

### Streaming

With `"stream": true` the answer is Server-Sent Events: `data: <chunk>` lines, ending with
`data: [DONE]`. Response headers include `Content-Type: text/event-stream`,
`Cache-Control: no-cache, no-transform` and `X-Accel-Buffering: no`.

`stream_options.include_usage`:

- The gateway always asks the provider for usage (it forces `include_usage: true`
  upstream), because that is what it bills.
- If you set `stream_options: {"include_usage": true}`, the final usage-only chunk
  (`choices: []`, `usage: {...}`) is passed to you, as with OpenAI.
- If you did not, that chunk is dropped and `usage` is removed from any other chunk, so
  the stream looks exactly as OpenAI would send it without the option.

When the model is served by an Anthropic route, the gateway translates Anthropic's events
into OpenAI chunks and, when you asked for usage, emits a usage chunk before `[DONE]`.

Once the first byte of a stream has been sent the gateway cannot fail over: the status is
already 200. If the provider connection breaks mid-stream, the stream simply ends (no
`[DONE]`), and the request is billed for what was delivered (see [Billing](#billing)).

```bash
curl -N https://gateway.example.com/v1/chat/completions \
  -H "Authorization: Bearer $GW_KEY" \
  -H "Content-Type: application/json" \
  -d '{"model": "stub-chat", "stream": true, "stream_options": {"include_usage": true},
       "messages": [{"role": "user", "content": "Hello"}]}'
```

## POST /v1/messages

The Anthropic Messages format. Required: `model`, a non-empty `messages` array and
`max_tokens` (at least 1). `system`, `tools`, `tool_choice`, `stop_sequences`,
`temperature`, `top_p` and `stream` are supported. Streaming uses Anthropic's named events
(`message_start`, `content_block_delta`, `message_delta`, `message_stop`, ...).

Errors on this endpoint use the Anthropic envelope (see [Errors](#errors)).

```bash
curl https://gateway.example.com/v1/messages \
  -H "x-api-key: $GW_KEY" \
  -H "anthropic-version: 2023-06-01" \
  -H "Content-Type: application/json" \
  -d '{"model": "stub-claude", "max_tokens": 256, "messages": [{"role": "user", "content": "Hello"}]}'
```

The `anthropic-version` header is accepted and ignored; the gateway sends its own
(`2023-06-01`) to Anthropic.

## Cross-format translation

Either chat endpoint reaches any CHAT model, whatever format its provider speaks
([`gateway/translate.ts`](../../apps/api/src/gateway/translate.ts)):

| You call | Route's provider | What happens |
| --- | --- | --- |
| `/v1/chat/completions` | OpenAI-compatible, Gemini, stub | Passed through, with the output limit made explicit (the caller's `max_completion_tokens` or `max_tokens` capped at the model's limit, else `max_completion_tokens` set to it) |
| `/v1/chat/completions` | Anthropic | OpenAI request to Anthropic, response and stream back to OpenAI |
| `/v1/messages` | Anthropic | Passed through (`max_tokens` capped at the model's limit) |
| `/v1/messages` | OpenAI-compatible, Gemini, stub | Anthropic request to OpenAI, response and stream back to Anthropic |

Translated: text, images (URL and base64), system and developer messages, tools and tool
results, `tool_choice`, stop sequences, max tokens, `temperature` (capped at 1 for
Anthropic), `top_p`, JSON mode (`response_format` `json_object` or `json_schema` becomes an
instruction to answer with one JSON object), and usage including prompt-cache reads.
Consecutive turns of the same role are merged for Anthropic. Dropped: logprobs, `n > 1`,
`seed`, audio parts, Anthropic thinking blocks and citations.

Embeddings, images, speech and transcription need an OpenAI-compatible route. An Anthropic
route on one of those models fails as `400 upstream_rejected`.

## POST /v1/embeddings

OpenAI format. Required: `model` and `input` (a string, an array of strings, or token
arrays; an empty array is refused). Billed on the provider's `usage.prompt_tokens` (or
`total_tokens`); if the provider reports neither, on the gateway's estimate.

## POST /v1/images/generations

OpenAI format. Required: `model` and a non-empty `prompt`. `n` is 1 to 10 (default 1).
Billed per image actually returned (`data.length`).

## POST /v1/audio/speech

OpenAI format. Required: `model` and `input` (1 to 4096 characters). The response is the
audio bytes with the provider's `Content-Type` (default `audio/mpeg`). Billed on the
character count of `input`, at the route's price per million characters.

## POST /v1/audio/transcriptions

OpenAI format, `multipart/form-data`:

| Field | Notes |
| --- | --- |
| `file` | Required, one file, at most `GATEWAY_MAX_AUDIO_MB` (default 25) |
| `model` | Required |
| `response_format` | `json` (default), `text` or `verbose_json`. Anything else is `400` |
| `language`, `prompt`, `temperature` | Passed through |

The gateway always asks the provider for `verbose_json`, because its `duration` is what the
bill is based on, then answers in the format you asked for: `{ "text": ... }` for `json`,
plain text for `text`, the provider's full object for `verbose_json`. If the provider
returns no duration, the gateway estimates about one minute per megabyte and flags the
request as estimated.

```bash
curl https://gateway.example.com/v1/audio/transcriptions \
  -H "Authorization: Bearer $GW_KEY" \
  -F model=stub-whisper -F response_format=text -F file=@meeting.mp3
```

## Request ids

Every `/v1` response has an `x-request-id` header. Once the body has passed validation it is
`req_<ULID>`. A request that was served, or that failed at the providers (`502`, `503`), is
written to the request log under that id: the console (**Usage**) and
`GET /api/usage/requests/{id}` find it. Refusals before any provider call (401, 402, 403,
404, 429) are not logged. Responses that fail before the pipeline (a malformed body, an
unknown path) carry the generic request id the API assigns to every HTTP request. Quote the
id when reporting a problem.

## Errors

The OpenAI envelope on every endpoint except `/v1/messages`:

```json
{ "error": { "message": "Your balance is too low for this request. Top up and try again.", "type": "insufficient_balance", "code": "insufficient_balance", "param": null } }
```

The Anthropic envelope on `/v1/messages`:

```json
{ "type": "error", "error": { "type": "billing_error", "message": "Your balance is too low for this request. Top up and try again." } }
```

Anthropic types are the same as the OpenAI types, except `insufficient_balance`, which is
`billing_error`. The Anthropic envelope has no `code`, so the status and type are what to
switch on there. Messages never contain provider error text: provider error bodies are
logged on the server (masked) and never returned.

Every status, type and code the gateway produces
([`gateway/errors.ts`](../../apps/api/src/gateway/errors.ts),
[`pipeline.ts`](../../apps/api/src/gateway/pipeline.ts),
[`auth.ts`](../../apps/api/src/gateway/auth.ts),
[`handlers.ts`](../../apps/api/src/gateway/handlers.ts),
[`v1.routes.ts`](../../apps/api/src/routes/v1.routes.ts)):

| Status | Type | Code | When |
| --- | --- | --- | --- |
| 400 | `invalid_request_error` | `invalid_request` | A required field is missing or out of range (`messages`, `max_tokens`, `n`, `input`, `prompt`, `file`, `response_format`); `param` names it |
| 400 | `invalid_request_error` | `invalid_json` | The body is not valid JSON |
| 400 | `invalid_request_error` | `model_required` | `model` is missing or not a string |
| 400 | `invalid_request_error` | `model_not_supported` | The model's kind does not fit the endpoint |
| 400 | `invalid_request_error` | `upstream_rejected` | The provider answered 400, 413 or 422: the parameters do not suit this model |
| 400 | `invalid_request_error` | a multipart error code, lowercased (for example `limit_unexpected_file`) | A malformed transcription upload |
| 401 | `authentication_error` | `missing_api_key` | No key in `Authorization` or `x-api-key` |
| 401 | `authentication_error` | `invalid_api_key` | Wrong format, unknown, or revoked |
| 401 | `authentication_error` | `expired_api_key` | Past its expiry |
| 402 | `insufficient_balance` | `insufficient_balance` | The wallet's available balance cannot cover the worst-case price |
| 402 | `insufficient_balance` | `budget_exceeded` | The key's monthly budget would be passed |
| 403 | `permission_error` | `account_restricted` | The account is suspended, banned or erased |
| 403 | `permission_error` | `model_not_allowed` | The model is not on the key's allow-list |
| 403 | `permission_error` | `ip_not_allowed` | The caller's address is not on the key's IP allow-list |
| 404 | `not_found_error` | `model_not_found` | No enabled model with a usable route has that id or alias |
| 404 | `invalid_request_error` | `unknown_url` | No such `/v1` endpoint (or wrong method) |
| 413 | `invalid_request_error` | `request_too_large` | The JSON body is over `GATEWAY_MAX_BODY_MB` |
| 413 | `invalid_request_error` | `limit_file_size` | The audio file is over `GATEWAY_MAX_AUDIO_MB` |
| 429 | `rate_limit_error` | `rate_limit_exceeded` | The key's requests per minute are spent |
| 429 | `rate_limit_error` | `tokens_rate_limit_exceeded` | The key's tokens per minute are spent |
| 429 | `rate_limit_error` | `concurrency_limit_exceeded` | The account has its maximum requests in flight |
| 500 | `api_error` | `internal_error` | A gateway bug; the request id is in the server log |
| 502 | `api_error` | `upstream_error` | The provider refused for a reason a retry will not fix (401, 403, 404 and similar): a configuration problem for the operator |
| 502 | `api_error` | `upstream_unavailable` | Every route that was tried failed with a retryable error |
| 503 | `overloaded_error` | `no_route_available` | Every route's circuit is open, so no provider was tried |

Validation of the body (the first row) happens before the key is checked, so a malformed
request without a key gets a 400, not a 401.

## Rate limits

Three limits, counted in Redis so every API task shares them
([`gateway/limits.ts`](../../apps/api/src/gateway/limits.ts)):

| Limit | Scope | Counted |
| --- | --- | --- |
| RPM | Per key | One per request, sliding window over two one-minute buckets |
| TPM | Per key | At admission: the input estimate plus the most output the call may produce (`max_tokens` capped at the model's limit, or the limit itself when unset). After settlement, any excess of the actual tokens over that is added |
| Concurrency | Per account | Requests in flight; released when the call ends |

The numbers come from the key's own `rpm` and `tpm` when set, else the account's tier,
else the default tier (`Default`: 60 RPM, 200 000 TPM, 8 concurrent, seeded by the first
migration). Concurrency comes from the tier only. `null` means unlimited.

A refusal is `429` with a `retry-after` header in seconds: until the current minute ends
for RPM and TPM, `1` for concurrency. That is the only rate-limit header the gateway sends;
there are no `x-ratelimit-*` headers. If Redis is unreachable the limits fail open (the
wallet reservation still bounds spend).

A single request whose TPM estimate is larger than the key's TPM limit is refused every
time. Lower `max_tokens` or raise the limit.

## Billing

All money is integer micro-USD (1 USD = 1 000 000). Each call, in order
([`pipeline.ts`](../../apps/api/src/gateway/pipeline.ts),
[`billing/wallet.ts`](../../apps/api/src/billing/wallet.ts)):

1. **Price.** The margin in force is the key's margin, else the account's, else the
   model's, else the deployment default (`defaultMarginBps` in Settings; basis points, 0
   and up). The list price is the **primary route's** cost (the usable route with the
   lowest priority number) times `(10 000 + margin) / 10 000`, rounded up. That price is
   charged whichever route actually serves the request, so failover never changes what a
   caller pays.
2. **Reserve.** The worst case (estimated input plus the maximum output, or the units the
   call asks for) is put on hold in one conditional update. If the available balance
   (balance minus holds) is short, the answer is `402 insufficient_balance` and no provider
   is called. Parallel requests cannot spend past the balance.
3. **Call.** Routes are tried in priority order, skipping open circuits. A retryable
   failure (connection error, timeout, 408, 409, 425, 429, 5xx) moves to the next route,
   before the first byte of a stream only.
4. **Settle.** Just after the response is written, the actual usage is charged and the hold
   dropped, in the same transaction that writes the request row (and the bodies, when the key
   logs them). The actual price
   may exceed the hold (a provider that ignores the output limit, or counts input tokens
   differently from the estimate);
   it is charged in full and the balance can go below zero, which refuses the next
   request.

What gets billed:

| Outcome | Charge |
| --- | --- |
| Success with provider-reported usage | The reported usage |
| Success without usage from the provider | The gateway's estimate (about four characters a token); the request row is flagged `estimated` |
| A stream cut after the first byte (provider dropped, or the client disconnected) | What was delivered: reported usage if any arrived, else the input estimate plus an estimate of the text sent; the row has `error_code = stream_interrupted` |
| Every route failed, no route available, or a refusal before the call (401, 402, 403, 429, 400) | Nothing. The hold is released |
| The client disconnected before the first byte | Nothing |

Token prices are per million tokens. Cached input tokens (prompt-cache reads) use the
route's cached price when set, else the input price. Images are per image, speech per
million characters, transcription per minute. A worked example: a route that costs
0.50 USD input and 1.50 USD output per million tokens, at a 20% margin (2 000 bps), is
priced at 0.60 and 1.80 USD per million.

A key's monthly budget is checked against this month's spend (a Redis counter seeded from
the request log) plus the worst-case price of the new call.

## Body limits

| Limit | Default | Setting |
| --- | --- | --- |
| JSON request body (images in vision requests count) | 20 MB | `GATEWAY_MAX_BODY_MB` (1 to 100) |
| Transcription audio file | 25 MB | `GATEWAY_MAX_AUDIO_MB` (1 to 100) |
| Speech `input` | 4096 characters | Fixed |
| Image `n` | 1 to 10 | Fixed |

A route's timeout (default 120 s, set per route in Admin, Models) bounds one provider call.
Behind a load balancer, its idle timeout must be longer than the longest silence in a
stream; the Terraform sets 300 s.

## SDK examples

### OpenAI Python

```python
from openai import OpenAI

client = OpenAI(base_url="https://gateway.example.com/v1", api_key="gw-...")

reply = client.chat.completions.create(
    model="stub-chat",
    messages=[{"role": "user", "content": "Hello"}],
)
print(reply.choices[0].message.content, reply.usage)

stream = client.chat.completions.create(
    model="stub-claude",  # served in the Anthropic format, translated for you
    messages=[{"role": "user", "content": "Hello"}],
    stream=True,
    stream_options={"include_usage": True},
)
for chunk in stream:
    if chunk.choices:
        print(chunk.choices[0].delta.content or "", end="")
    elif chunk.usage:
        print("\n", chunk.usage)

vectors = client.embeddings.create(model="stub-embed", input=["one", "two"])
```

### OpenAI Node

```ts
import OpenAI from "openai";

const client = new OpenAI({ baseURL: "https://gateway.example.com/v1", apiKey: process.env.GW_KEY });

const reply = await client.chat.completions.create({
  model: "stub-chat",
  messages: [{ role: "user", content: "Hello" }],
});
console.log(reply.choices[0].message.content);

const stream = await client.chat.completions.create({
  model: "stub-chat",
  messages: [{ role: "user", content: "Hello" }],
  stream: true,
});
for await (const chunk of stream) process.stdout.write(chunk.choices[0]?.delta?.content ?? "");
```

### Anthropic Python

The Anthropic SDKs add `/v1/messages` to the base URL themselves, so the base URL is the
gateway's origin **without** `/v1`.

```python
import anthropic

client = anthropic.Anthropic(base_url="https://gateway.example.com", api_key="gw-...")

message = client.messages.create(
    model="stub-chat",  # an OpenAI-format model, translated for you
    max_tokens=256,
    messages=[{"role": "user", "content": "Hello"}],
)
print(message.content[0].text, message.usage)

with client.messages.stream(
    model="stub-claude",
    max_tokens=256,
    messages=[{"role": "user", "content": "Hello"}],
) as stream:
    for text in stream.text_stream:
        print(text, end="")
```

### Anthropic Node

```ts
import Anthropic from "@anthropic-ai/sdk";

const client = new Anthropic({ baseURL: "https://gateway.example.com", apiKey: process.env.GW_KEY });

const message = await client.messages.create({
  model: "stub-claude",
  max_tokens: 256,
  messages: [{ role: "user", content: "Hello" }],
});
console.log(message.content);
```

### curl

```bash
export GW_KEY=gw-...
export GW=https://gateway.example.com/v1

curl $GW/models -H "Authorization: Bearer $GW_KEY"

curl $GW/chat/completions -H "Authorization: Bearer $GW_KEY" -H "Content-Type: application/json" \
  -d '{"model":"stub","messages":[{"role":"user","content":"Hello"}]}'

curl $GW/images/generations -H "Authorization: Bearer $GW_KEY" -H "Content-Type: application/json" \
  -d '{"model":"stub-image","prompt":"a lighthouse","n":2}'

curl $GW/audio/speech -H "Authorization: Bearer $GW_KEY" -H "Content-Type: application/json" \
  -d '{"model":"stub-tts","input":"Hello","voice":"alloy"}' -o hello.mp3
```

The model ids in these examples are the local stub models; on a real deployment use the
ids in the console's **Models** page.
