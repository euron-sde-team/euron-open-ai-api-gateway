# Security Policy

## Supported versions

| Version | Supported |
| ------- | --------- |
| 0.x (latest minor) | Yes |
| Older minors | No |

## Reporting a vulnerability

**Please do not open a public issue for security problems.**

Report privately through GitHub's
[private vulnerability reporting](https://docs.github.com/en/code-security/security-advisories/guidance-on-reporting-and-writing-information-about-vulnerabilities/privately-reporting-a-security-vulnerability)
on this repository ("Security" tab, "Report a vulnerability"):
https://github.com/euron-sde-team/euron-open-ai-api-gateway/security/advisories/new

Please include:

- the affected component (`apps/api`, `apps/web`, `packages/api-client`,
  `infra/terraform/...`) and version or commit,
- a description of the issue and its impact,
- steps to reproduce, or a proof of concept (against your own deployment or the local
  stack, never someone else's),
- any suggested mitigation.

What to expect:

| Stage | Target |
| ----- | ------ |
| Acknowledgement | within 3 business days |
| Initial assessment and severity | within 7 business days |
| Fix or mitigation for critical / high issues | within 30 days |
| Coordinated public disclosure | after a fix is released, credited to you unless you prefer otherwise |

## Scope

In scope: the code in this repository and the infrastructure it provisions with its
default settings. We are most interested in:

- **Authentication and sessions.** Account takeover, access or refresh token theft or
  reuse, bypassing email verification, two-factor or the invite-only domain allowlist,
  session fixation, password reset flaws, sign-in rate limits that can be sidestepped,
  native token mode weaknesses.
- **Money.** Crediting a wallet without paying (forged or replayed webhooks, a forged
  Razorpay return, a top-up credited twice, an amount or currency that differs from the
  order), spending past the balance (parallel requests, a reservation that is never
  settled), being charged less than the listed price, another account's balance moving, or
  redeeming a promo code twice.
- **API keys.** Recovering a key from what the server stores or returns, using a key after
  it is revoked, expired, or its account suspended, or getting past a key's model
  allow-list, IP allow-list, monthly budget or rate limits.
- **Provider credentials.** Any way to make the API return, log or store a provider key in
  clear, or to surface raw provider error text to a caller.
- **Privacy.** Reading another account's keys, usage, ledger, top-ups or kept request
  bodies; an admin endpoint that reveals request bodies; bodies kept for a key that did not
  opt in, or past their retention.
- **The data plane.** Reaching a model that is disabled, unpriced or outside a key's
  allow-list; making the gateway call a URL a caller chose; a request that reaches a
  provider without being authenticated, limited and reserved first.
- **Admin control plane.** Reaching `/api/admin` without the role, changing roles, tiers,
  providers or settings without permission, or tampering with the audit log.

Out of scope:

- **What admins can already do.** Admins manage accounts, balances, margins, providers
  (including their base URLs and credentials), the catalogue and prices. Reports that rely
  on that access are out of scope; reports that let someone gain it are very much in scope.
- **Content sent to configured providers.** Prompts, files and audio go to the providers the
  operator configures, by design.
- **Model behaviour.** A model saying something false or unwanted, without one of the
  concrete impacts listed above.
- **Documented overshoot.** A balance dipping slightly below zero when a provider counts
  more tokens than estimated, or a key's monthly budget overshot by requests already in
  flight ([docs/architecture/threat-model.md](docs/architecture/threat-model.md)).
- **The demo seed.** `make demo` creates well-known demo accounts on purpose and refuses to
  run with `NODE_ENV=production`.
- **The stubs** (`apps/stubs`), test doubles that never run in production.
- Findings that require a compromised host, compromised AWS account, or leaked deployment
  secrets.
- Denial of service through resource exhaustion of a deployment you operate yourself, or
  spending your own wallet or provider budget.

## Hardening checklist for operators

- Deploy with the Terraform in `infra/terraform` (or match it): private subnets, TLS
  everywhere, encryption at rest with a customer-managed key, Redis with TLS and an AUTH
  token, secrets only in Secrets Manager.
- Keep `NODE_ENV=production`: the API refuses to boot with development secrets (including
  `CREDENTIALS_KEY` and `API_KEY_PEPPER`), `PAYMENTS_STUB`, the mail outbox, inline jobs, a
  localhost web or gateway URL or missing CORS origins, and refuses stub providers.
- Put Stripe and Razorpay secrets in the `<prefix>/billing` secret by hand rather than in
  `terraform.tfvars`, so they stay out of Terraform state, and set both webhook secrets.
- Add provider keys only in `/admin/providers`; they are encrypted with `CREDENTIALS_KEY`.
  Keep that key in Secrets Manager and back it up: without it every provider key must be
  entered again.
- Serve the web app and the API on one HTTPS host so the refresh cookie stays first-party
  and `Secure`.
- Choose a registration mode: `INVITE_ONLY` with your own email domains, or `CLOSED`, for a
  private deployment.
- Set rate-limit tiers that match your providers' limits, a margin that covers your costs,
  and spending limits in each provider's console.
- For sensitive use, set a request retention period in `/admin/settings`, keep body logging
  off, and consider a local model (vLLM, Ollama behind an OpenAI-compatible endpoint).
- Enable CloudFront and WAF (`enable_cdn`, on in `aws-prod`) for public deployments.
- Subscribe someone to the alarm topic (`alarm_email`).
