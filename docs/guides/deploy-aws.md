# Deploy to AWS

Deploy the gateway to your own AWS account with the Terraform in
[`infra/terraform`](../../infra/terraform) and one script. The result is one host name
(`https://<domain>`) serving the developer console, the console API under `/api/*` and the
gateway under `/v1/*`, with ECS Fargate services in private subnets, RDS PostgreSQL,
ElastiCache Redis, SES, Secrets Manager and a customer-managed KMS key. The system view is in
[HLD.md](../architecture/HLD.md).

## What gets created

The composition is one module, [`modules/deployment`](../../infra/terraform/modules/deployment/main.tf);
the environments [`envs/aws-dev`](../../infra/terraform/envs/aws-dev/main.tf) and
[`envs/aws-prod`](../../infra/terraform/envs/aws-prod/main.tf) only pick sizes and safety
switches.

| Path | Service | Role |
| --- | --- | --- |
| `https://<domain>/v1/*` | api | The gateway: OpenAI- and Anthropic-compatible endpoints, long-lived SSE streams |
| `https://<domain>/api/*`, `/up` | api | The console and admin JSON API, payment webhooks, health |
| `https://<domain>/*` | web | Next.js: the developer console and `/admin` |
| no inbound traffic | worker | BullMQ jobs: reservation sweeper, health probes, FX sync, low-balance emails, suspensions, account purges, retention |
| one-off | migrate, admin | Task definitions on the api image: apply migrations; create the first administrator |

The load balancer sends `/api/*`, `/v1/*` and `/up` straight to the API, never through the
Next server.

| | aws-dev | aws-prod |
| --- | --- | --- |
| Availability zones, NAT | 2, one shared NAT | 3, one NAT per AZ, interface endpoints |
| RDS PostgreSQL | `db.t4g.small`, single AZ, 3 days of backups, no deletion protection | `db.t4g.medium`, Multi-AZ, 14 days, deletion protection |
| ElastiCache Redis | `cache.t4g.small`, 1 node, 1 day of snapshots | `cache.m7g.large`, 2 nodes with failover, 7 days |
| Tasks (min to max) | api 1 to 2, worker 1, web 1 to 2 | api 2 to 10, worker 2 to 6, web 2 to 6 |
| CloudFront + WAF | off by default (`enable_cdn = false`) | on by default |
| KMS deletion window, secret recovery window | 7 days, 0 | 30 days, 30 days |
| Log retention | 14 days | 365 days |

Services scale on CPU (target 60%) and roll out with the ECS deployment circuit breaker and
automatic rollback.

Redis matters more here than in a typical web app: it holds the rate-limit windows, the
circuit breakers, the API key cache and each key's monthly spend counter. Postgres is the
source of truth for money (wallets, reservations, the ledger, top-ups) and the catalogue.

## Prerequisites

- An AWS account and credentials for it (a profile with administrator rights for the first
  apply).
- `terraform` (1.16), `docker` with buildx, the AWS CLI and `python3`.
- A domain. With a Route 53 hosted zone (`route53_zone_id`) the certificate and DNS records
  are created for you; otherwise pass `certificate_arn` for an ACM certificate you made and
  point your DNS at the load balancer (`terraform output load_balancer_dns_name`).
- A sending domain for SES (`mail_domain`, defaults to `domain`). New SES accounts are in the
  sandbox: verify the recipient addresses or request production access.
- At least one model provider account (OpenAI, Anthropic, Google Gemini, Groq or any
  OpenAI-compatible host). Its key is added in `/admin` after the deploy, not in Terraform.
- Optional: a Stripe account (USD top-ups) and a Razorpay account (INR top-ups).

## Configure

```bash
cp infra/terraform/envs/aws-dev/terraform.tfvars.example infra/terraform/envs/aws-dev/terraform.tfvars
cp infra/terraform/envs/aws-dev/backend.tf.example infra/terraform/envs/aws-dev/backend.tf   # remote state (recommended)
```

The environment variables ([`envs/aws-dev/variables.tf`](../../infra/terraform/envs/aws-dev/variables.tf)):

| Variable | Purpose |
| --- | --- |
| `region`, `name_prefix` | Where, and the prefix of every name (3 to 24 lowercase letters, digits and hyphens) |
| `domain`, `route53_zone_id` or `certificate_arn` | The one public host |
| `mail_domain` | SES sending domain |
| `alarm_email` | Who receives the CloudWatch alarms |
| `enable_cdn` | CloudFront and WAF in front of the load balancer (needs `route53_zone_id`) |
| `gateway_public_url` | `GATEWAY_PUBLIC_URL`. Default `https://<domain>/v1` |
| `billing_secrets` | Optional Stripe, Razorpay and FX keys. They land in Terraform state; leave unset and fill the secret by hand instead (below) |
| `fx_provider`, `fx_fixed_inr_per_usd` | Where the INR rate comes from (default `exchangerate`, no key needed) and the fallback rate (85) |
| `cpu_architecture` | `X86_64` (default) or `ARM64` (Graviton) |
| `db_instance_class`, `cache_node_type` | Sizes, defaults in the table above |
| `require_email_verification`, `log_level`, `product_name` | Passed to the API |
| `api_extra_environment`, `api_extra_secrets` | Anything else the API should read (names from [configuration.md](configuration.md)) |

The deployment module also takes `api_key_prefix` (`gw-`), `gateway_max_body_mb` (20),
`gateway_max_audio_mb` (25), `alb_idle_timeout` (300), and `credentials_key` and
`api_key_pepper` (generated when null; set them only when moving an existing installation).
Change them in [`envs/<env>/main.tf`](../../infra/terraform/envs/aws-dev/main.tf) if you need
to.

The module sets the rest for you: `NODE_ENV=production`, `APP_WEB_URL` and `CORS_ORIGINS`
to `https://<domain>`, `MAIL_MODE=ses`, `TRUST_PROXY` (1, or 2 behind CloudFront), the
database secret, and `JOBS_MODE=queue`.

## Deploy

```bash
make aws-deploy ENV=aws-dev
```

[`scripts/aws-deploy.sh`](../../scripts/aws-deploy.sh) tags images with the current commit
(`TAG`, override it to pin a release) and runs:

1. `terraform apply` of the image registries (and the KMS key that encrypts them);
2. `docker buildx build --push` of the api and web images for `PLATFORM`, which must match
   `cpu_architecture` (`linux/amd64` for `X86_64`, `linux/arm64` for `ARM64`; a mismatch
   builds fine and then dies with `exec format error`);
3. `terraform apply` of what the migrate task needs (network, database, task definition);
4. the migrate task, waited for ([`scripts/aws-run-task.sh`](../../scripts/aws-run-task.sh));
   it must exit 0;
5. `terraform apply` of everything else: cache, edge, the api, worker and web services;
6. a wait until the three services are stable.

It ends by printing the app URL, the gateway base URL for SDKs, and the next steps.

Plan without applying: `make aws-plan ENV=aws-dev`. Run migrations alone:
`make aws-migrate ENV=aws-dev`.

## Secrets

Everything secret lives in Secrets Manager, encrypted with the deployment's KMS key, and is
injected by ECS as environment variables; nothing secret is in a task definition or a log
([`modules/secrets`](../../infra/terraform/modules/secrets/main.tf)).

| Secret | Holds | Created with |
| --- | --- | --- |
| `<name_prefix>/app` | `JWT_SECRET`, `REFRESH_SECRET` | Random, 64 characters each, distinct |
| `<name_prefix>/totp` | `TOTP_ENCRYPTION_KEY` | 32 random bytes, base64 |
| `<name_prefix>/gateway` | `CREDENTIALS_KEY` (encrypts provider credentials), `API_KEY_PEPPER` (hashes API keys) | 32 random bytes and 64 random characters, unless passed in |
| `<name_prefix>/billing` | `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET`, `RAZORPAY_WEBHOOK_SECRET`, `FX_API_KEY` | `set-me` for every key not passed in `billing_secrets`; the API treats `set-me` as unset |
| the cache module's secret | `REDIS_URL` with its AUTH token, TLS | Generated |
| the RDS-managed secret | The database master password | RDS (rotated by RDS; the API reads it per connection through `DATABASE_SECRET_ARN`) |

Terraform never overwrites a secret value after creation (`ignore_changes`), so values you put
in by hand stay.

Do not lose `<name_prefix>/gateway`. A different `CREDENTIALS_KEY` makes every stored provider
credential undecryptable (re-enter them all), and a different `API_KEY_PEPPER` invalidates
every API key your developers hold. When moving an installation to a new deployment, pass the
old values as `credentials_key` and `api_key_pepper`.

There is no provider-keys secret: provider API keys are entered by an admin in `/admin` and
stored encrypted in Postgres.

### Payments

To turn on Stripe, Razorpay or a keyed FX provider, put the full JSON object (every key; keep
`set-me` for the ones you do not use) into the billing secret:

```bash
aws secretsmanager put-secret-value --secret-id "$(terraform -chdir=infra/terraform/envs/aws-dev output -raw billing_secret_name)" \
  --secret-string '{"STRIPE_SECRET_KEY":"<stripe-secret-key>","STRIPE_WEBHOOK_SECRET":"<stripe-signing-secret>","RAZORPAY_KEY_ID":"set-me","RAZORPAY_KEY_SECRET":"set-me","RAZORPAY_WEBHOOK_SECRET":"set-me","FX_API_KEY":"set-me"}'
```

Register the webhooks in each gateway's dashboard:

| Gateway | URL | Events |
| --- | --- | --- |
| Stripe | `https://<domain>/api/webhooks/stripe` | `checkout.session.completed`, `checkout.session.async_payment_succeeded`, `checkout.session.async_payment_failed`, `checkout.session.expired` |
| Razorpay | `https://<domain>/api/webhooks/razorpay` | `payment.captured`, `order.paid`, `payment.failed` |

Then roll the API and worker so they read the new values: run `make aws-deploy` again, or

```bash
aws ecs update-service --cluster <cluster> --service <api service> --force-new-deployment
aws ecs update-service --cluster <cluster> --service <worker service> --force-new-deployment
```

(`terraform output cluster_name` and `terraform output services` give the names.) Details and
test modes: [payments.md](payments.md).

## The first administrator

```bash
make aws-admin ENV=aws-dev EMAIL=you@example.com
```

This runs `node dist/cli.js admin:create --email you@example.com` as a one-off task
([`services/admin-bootstrap.service.ts`](../../apps/api/src/services/admin-bootstrap.service.ts)):
it promotes an existing account without touching its password, or creates the account and
emails a set-password link through SES. It never prints a password (task output goes to
CloudWatch Logs). When the link cannot be emailed it creates nothing and exits non-zero:
verify the SES identity first.

## First-time setup in `/admin`

On its first boot against an empty database the API creates the starter catalogue: OpenAI,
Anthropic, Gemini and Groq with their models **disabled**, and no stub providers in
production ([providers.md](providers.md#the-starter-catalogue)). Then:

1. **Providers**: add a credential (your provider API key) to each provider you will use.
2. **Models**: for each model you want to offer, check the upstream model name and the
   route's cost against the provider's current price list, press **Test**, and turn it on.
   Add your own models and routes as needed.
3. **Settings**: name and tagline, support email, the default margin, the signup credit,
   registration (`OPEN`, `INVITE_ONLY` with your email domains, or `CLOSED`), tax and top-up
   limits, retention ([configuration.md](configuration.md#admin-settings-in-the-database)).
   **Integrations** at the bottom confirms the payment gateways and the FX rate the server
   sees, and that `CREDENTIALS_KEY` is set.
4. **Limits**: review the `Default` tier (60 requests and 200 000 tokens a minute, 8 at once)
   and create others.

Then sign up as a developer (or use your admin account), create a key in the console, and call
`https://<domain>/v1/models`.

## Streams and the network

- **Idle timeout.** A streamed completion from a slow or reasoning model can be silent for
  minutes before or between tokens. The load balancer's idle timeout is 300 s
  (`alb_idle_timeout`) so `/v1` streams are not cut off; at the ALB default of 60 s they
  would be. Raise it (up to 4000) if you serve models with longer silences, and keep route
  timeouts (Admin, Models) consistent with it.
- **CloudFront.** With `enable_cdn = true`, `/v1/*` has its own behaviour: caching disabled,
  every header forwarded (`Authorization`, `x-api-key`), compression off so SSE events are
  not buffered ([`modules/cdn`](../../infra/terraform/modules/cdn/main.tf)). CloudFront's
  origin read timeout (`cdn_origin_read_timeout`, 60 s) bounds the silence between bytes;
  the gateway sends an SSE keep-alive comment every 15 seconds while a stream is open, so
  a slow model does not hit it once its stream has started.
- **WAF rate limit.** The WAF blocks an IP after 2000 requests in 5 minutes on everything
  except `/v1/*`: a backend calls the gateway from one address, and the gateway's per-key
  limits are the control there.
- **Client IPs.** Key IP allow-lists and rate limits use the client address as seen through
  `TRUST_PROXY` hops (1 behind the load balancer, 2 behind CloudFront).
- **Outbound.** The API and worker call providers, Stripe, Razorpay and the FX provider over
  the NAT gateway; nothing inbound is needed besides the load balancer.

## CloudFront and WAF

With `enable_cdn = true` CloudFront serves the host, WAF is attached, the load balancer
accepts only CloudFront's origin ranges, and the listener rules require a secret
`X-Origin-Verify` header that only this distribution sends; anything else gets 403.
`TRUST_PROXY` becomes 2. `/_next/static/*` is cached; pages, `/api/*` and `/v1/*` are not.

## Updating

Commit, then `make aws-deploy ENV=aws-prod` again: new images, migrations, then the services
roll. Migrations are forward-only and checksummed; a deploy never edits an applied one. A bad
image is rolled back by the circuit breaker; redeploy a previous tag with
`TAG=<commit> make aws-deploy ENV=...`.

A rolling deploy stops old API tasks with SIGTERM: they stop accepting connections and finish
in-flight requests, including open streams, for up to 25 s, then exit. A stream still running
after that is cut and billed for what was delivered. Reservations held by a task that died are
released by the worker's sweeper within about 16 minutes
([operations.md](operations.md#jobs-and-schedules)).

## Using real AWS from your laptop

`make up-aws` runs the local stack against real SES from an `aws-dev` environment, with your
AWS profile: copy [`deploy/compose/.env.aws.example`](../../deploy/compose/.env.aws.example) to
`.env.aws` and fill it from `terraform output`. `MAIL_FROM` must be a verified SES sender.

## Tearing down

`aws-dev` has no deletion protection: `terraform -chdir=infra/terraform/envs/aws-dev destroy`.
`aws-prod` refuses until you turn `deletion_protection` off. Secrets have a 30-day recovery
window in `aws-prod`.
