-- Euron Open AI API Gateway: initial schema.
--
-- Conventions
--   * Primary keys are ULIDs stored as text (sortable by creation time), except providers
--     and models, whose ids are the slugs callers use.
--   * Timestamps are timestamptz(3); the API runs with TZ=UTC.
--   * Money is integer micro-USD (1 USD = 1 000 000) in bigint columns. There is one
--     balance per account, in USD; INR top-ups are converted at the rate locked on the
--     order (ADR 0004).
--   * Prices are micro-USD per million tokens (or per unit for images, speech and
--     transcription). Margins are basis points (1500 = 15 %), 0 and up.
--   * Provider credentials are AES-256-GCM ciphertext (security/credentials.ts); no
--     endpoint ever returns one.
--   * Request rows hold counts, timings and money, never prompts or completions. Bodies
--     are kept only for keys that opted in, in request_bodies, and expire.

CREATE EXTENSION IF NOT EXISTS citext;
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- ─── Enums ──────────────────────────────────────────────────────────────────

CREATE TYPE user_role AS ENUM ('USER', 'ADMIN');
CREATE TYPE user_status AS ENUM ('PENDING_VERIFICATION', 'ACTIVE', 'SUSPENDED', 'BANNED', 'DEACTIVATED');
CREATE TYPE auth_token_type AS ENUM ('VERIFY_EMAIL', 'RESET_PASSWORD');

-- OPENAI_COMPATIBLE covers OpenAI itself and Groq, Together, DeepInfra, OpenRouter,
-- Mistral, Fireworks, a local vLLM or Ollama: anything that speaks the OpenAI wire format.
CREATE TYPE provider_kind AS ENUM ('OPENAI_COMPATIBLE', 'ANTHROPIC', 'GEMINI', 'STUB');
-- What a model does, which decides its endpoint and how it is priced.
--   CHAT           /v1/chat/completions and /v1/messages, per million input/output tokens
--   EMBEDDING      /v1/embeddings, per million input tokens
--   IMAGE          /v1/images/generations, per image
--   SPEECH         /v1/audio/speech, per million characters
--   TRANSCRIPTION  /v1/audio/transcriptions, per minute of audio
CREATE TYPE model_kind AS ENUM ('CHAT', 'EMBEDDING', 'IMAGE', 'SPEECH', 'TRANSCRIPTION');
CREATE TYPE api_key_status AS ENUM ('ACTIVE', 'REVOKED');
CREATE TYPE ledger_type AS ENUM ('TOPUP', 'GRANT', 'PROMO', 'SIGNUP', 'USAGE', 'REFUND', 'ADJUSTMENT');
CREATE TYPE reservation_status AS ENUM ('HELD', 'SETTLED', 'RELEASED');
CREATE TYPE payment_gateway AS ENUM ('STRIPE', 'RAZORPAY', 'STUB');
CREATE TYPE topup_status AS ENUM ('CREATED', 'PAID', 'FAILED', 'REFUNDED');

-- ─── Identity ───────────────────────────────────────────────────────────────

-- Rate-limit tiers. Every account is on one (or the default); a key may lower or raise
-- its own numbers within what an admin allows. NULL means unlimited.
CREATE TABLE limit_tiers (
  id          text PRIMARY KEY,
  name        text NOT NULL UNIQUE CHECK (length(name) BETWEEN 1 AND 60),
  rpm         integer CHECK (rpm > 0),          -- requests per minute, per key
  tpm         integer CHECK (tpm > 0),          -- tokens per minute, per key
  concurrency integer CHECK (concurrency > 0),  -- requests in flight, per account
  is_default  boolean NOT NULL DEFAULT false,
  created_at  timestamptz(3) NOT NULL DEFAULT now(),
  updated_at  timestamptz(3) NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX limit_tiers_one_default ON limit_tiers (is_default) WHERE is_default;

CREATE TABLE users (
  id                    text PRIMARY KEY,
  email                 citext NOT NULL UNIQUE,
  username              citext NOT NULL UNIQUE CHECK (username ~ '^[a-zA-Z0-9][a-zA-Z0-9-]{1,38}[a-zA-Z0-9]$'),
  display_name          text NOT NULL CHECK (length(display_name) BETWEEN 1 AND 80),
  password_hash         text NOT NULL,
  role                  user_role NOT NULL DEFAULT 'USER',
  status                user_status NOT NULL DEFAULT 'PENDING_VERIFICATION',
  email_verified_at     timestamptz(3),
  totp_secret           text,
  totp_enabled          boolean NOT NULL DEFAULT false,
  totp_last_step        bigint,
  suspended_until       timestamptz(3),
  token_version         integer NOT NULL DEFAULT 0,
  limit_tier_id         text REFERENCES limit_tiers (id) ON DELETE SET NULL,
  -- An account-level margin an admin may set (a partner at cost, say). NULL falls back
  -- to the model's margin, then the default.
  margin_bps            integer CHECK (margin_bps BETWEEN 0 AND 100000),
  deletion_requested_at timestamptz(3),
  last_seen_at          timestamptz(3),
  created_at            timestamptz(3) NOT NULL DEFAULT now(),
  updated_at            timestamptz(3) NOT NULL DEFAULT now()
);
CREATE INDEX users_name_trgm_idx ON users USING gin ((display_name || ' ' || username::text || ' ' || email::text) gin_trgm_ops);
CREATE INDEX users_admin_idx ON users (role) WHERE role <> 'USER';

CREATE TABLE sessions (
  id           text PRIMARY KEY,
  user_id      text NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  family_id    text NOT NULL,
  token_hash   text NOT NULL UNIQUE,
  user_agent   text,
  ip           inet,
  created_at   timestamptz(3) NOT NULL DEFAULT now(),
  last_used_at timestamptz(3) NOT NULL DEFAULT now(),
  expires_at   timestamptz(3) NOT NULL,
  revoked_at   timestamptz(3),
  replaced_by  text
);
CREATE INDEX sessions_user_idx ON sessions (user_id) WHERE revoked_at IS NULL;
CREATE INDEX sessions_family_idx ON sessions (family_id);

CREATE TABLE auth_tokens (
  id         text PRIMARY KEY,
  user_id    text NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  type       auth_token_type NOT NULL,
  token_hash text NOT NULL UNIQUE,
  expires_at timestamptz(3) NOT NULL,
  used_at    timestamptz(3),
  created_at timestamptz(3) NOT NULL DEFAULT now()
);
CREATE INDEX auth_tokens_user_idx ON auth_tokens (user_id, type);

CREATE TABLE totp_recovery_codes (
  user_id    text NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  code_hash  text NOT NULL,
  used_at    timestamptz(3),
  created_at timestamptz(3) NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, code_hash)
);

-- ─── Money ──────────────────────────────────────────────────────────────────

-- One wallet per account. `reserved` is what in-flight requests have put on hold; a
-- request is admitted only when balance - reserved covers its worst-case price.
CREATE TABLE wallets (
  user_id          text PRIMARY KEY REFERENCES users (id) ON DELETE CASCADE,
  balance_micros   bigint NOT NULL DEFAULT 0,
  reserved_micros  bigint NOT NULL DEFAULT 0 CHECK (reserved_micros >= 0),
  low_balance_notified_at timestamptz(3),
  updated_at       timestamptz(3) NOT NULL DEFAULT now()
);

-- Append-only. Every change to a balance is one row, with the balance after it. A
-- (ref_type, ref_id) pair can be booked once per type: the unique index makes top-up
-- crediting, usage settlement and promo redemption idempotent.
CREATE TABLE ledger (
  id                   text PRIMARY KEY,
  user_id              text NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  type                 ledger_type NOT NULL,
  amount_micros        bigint NOT NULL,           -- signed: credits positive, debits negative
  balance_after_micros bigint NOT NULL,
  ref_type             text NOT NULL CHECK (length(ref_type) <= 40),
  ref_id               text NOT NULL CHECK (length(ref_id) <= 120),
  description          text NOT NULL DEFAULT '' CHECK (length(description) <= 300),
  created_by           text REFERENCES users (id) ON DELETE SET NULL,
  created_at           timestamptz(3) NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX ledger_once ON ledger (ref_type, ref_id, type);
CREATE INDEX ledger_user_idx ON ledger (user_id, created_at DESC, id DESC);

-- Holds for in-flight requests. Settled with the actual price, or released.
CREATE TABLE reservations (
  id            text PRIMARY KEY,
  user_id       text NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  amount_micros bigint NOT NULL CHECK (amount_micros >= 0),
  status        reservation_status NOT NULL DEFAULT 'HELD',
  created_at    timestamptz(3) NOT NULL DEFAULT now(),
  expires_at    timestamptz(3) NOT NULL
);
CREATE INDEX reservations_held_idx ON reservations (expires_at) WHERE status = 'HELD';

-- Top-ups. USD goes through Stripe, INR through Razorpay. `credit_micros` is fixed when
-- the order is created (INR at `fx_inr_per_usd`, locked then), so the amount credited
-- never depends on when the payment is confirmed.
CREATE TABLE topups (
  id                 text PRIMARY KEY,
  user_id            text NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  gateway            payment_gateway NOT NULL,
  currency           text NOT NULL CHECK (currency IN ('USD', 'INR')),
  amount_minor       bigint NOT NULL CHECK (amount_minor > 0),   -- what is credited, before tax, in cents or paise
  tax_minor          bigint NOT NULL DEFAULT 0 CHECK (tax_minor >= 0),
  total_minor        bigint NOT NULL CHECK (total_minor > 0),   -- what the gateway charges
  fx_inr_per_usd     numeric(12, 6),
  credit_micros      bigint NOT NULL CHECK (credit_micros > 0),
  gateway_order_id   text NOT NULL,
  gateway_payment_id text,
  status             topup_status NOT NULL DEFAULT 'CREATED',
  failure_reason     text CHECK (length(failure_reason) <= 300),
  created_at         timestamptz(3) NOT NULL DEFAULT now(),
  paid_at            timestamptz(3),
  refunded_at        timestamptz(3)
);
CREATE UNIQUE INDEX topups_order_once ON topups (gateway, gateway_order_id);
CREATE UNIQUE INDEX topups_payment_once ON topups (gateway, gateway_payment_id) WHERE gateway_payment_id IS NOT NULL;
CREATE INDEX topups_user_idx ON topups (user_id, created_at DESC);

-- Gateway webhooks seen, so a redelivery is acknowledged without doing anything twice.
CREATE TABLE payment_webhook_events (
  gateway     payment_gateway NOT NULL,
  event_id    text NOT NULL,
  received_at timestamptz(3) NOT NULL DEFAULT now(),
  PRIMARY KEY (gateway, event_id)
);

-- INR per USD, refreshed by a job; the newest row is used for new INR orders.
CREATE TABLE fx_rates (
  id         text PRIMARY KEY,
  inr_per_usd numeric(12, 6) NOT NULL CHECK (inr_per_usd > 0),
  source     text NOT NULL CHECK (length(source) <= 60),
  fetched_at timestamptz(3) NOT NULL DEFAULT now()
);
CREATE INDEX fx_rates_recent_idx ON fx_rates (fetched_at DESC);

CREATE TABLE promo_codes (
  id              text PRIMARY KEY,
  code            citext NOT NULL UNIQUE CHECK (code ~ '^[A-Za-z0-9_-]{3,40}$'),
  amount_micros   bigint NOT NULL CHECK (amount_micros > 0),
  max_redemptions integer CHECK (max_redemptions > 0),
  redeemed_count  integer NOT NULL DEFAULT 0,
  expires_at      timestamptz(3),
  active          boolean NOT NULL DEFAULT true,
  created_by      text REFERENCES users (id) ON DELETE SET NULL,
  created_at      timestamptz(3) NOT NULL DEFAULT now()
);

CREATE TABLE promo_redemptions (
  promo_id    text NOT NULL REFERENCES promo_codes (id) ON DELETE CASCADE,
  user_id     text NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  redeemed_at timestamptz(3) NOT NULL DEFAULT now(),
  PRIMARY KEY (promo_id, user_id)
);

-- ─── Keys ───────────────────────────────────────────────────────────────────

CREATE TABLE api_keys (
  id                   text PRIMARY KEY,
  user_id              text NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  name                 text NOT NULL CHECK (length(name) BETWEEN 1 AND 80),
  -- HMAC-SHA256 of the key with a server pepper (security/api-keys.ts). The key itself is
  -- shown once, at creation.
  key_hash             text NOT NULL UNIQUE,
  display_hint         text NOT NULL CHECK (length(display_hint) <= 40),   -- "gw-a1b2...9xyz"
  status               api_key_status NOT NULL DEFAULT 'ACTIVE',
  expires_at           timestamptz(3),
  -- Empty means every enabled model.
  allowed_models       text[] NOT NULL DEFAULT '{}',
  monthly_budget_micros bigint CHECK (monthly_budget_micros > 0),
  rpm                  integer CHECK (rpm > 0),
  tpm                  integer CHECK (tpm > 0),
  -- CIDRs or single addresses; empty means any.
  ip_allowlist         text[] NOT NULL DEFAULT '{}',
  log_bodies           boolean NOT NULL DEFAULT false,
  -- Set by an admin only.
  margin_bps           integer CHECK (margin_bps BETWEEN 0 AND 100000),
  last_used_at         timestamptz(3),
  revoked_at           timestamptz(3),
  created_at           timestamptz(3) NOT NULL DEFAULT now(),
  updated_at           timestamptz(3) NOT NULL DEFAULT now()
);
CREATE INDEX api_keys_user_idx ON api_keys (user_id, created_at DESC);

-- ─── Catalogue ──────────────────────────────────────────────────────────────

CREATE TABLE providers (
  id           text PRIMARY KEY CHECK (id ~ '^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$'),
  kind         provider_kind NOT NULL,
  display_name text NOT NULL CHECK (length(display_name) BETWEEN 1 AND 60),
  base_url     text CHECK (length(base_url) <= 300),
  enabled      boolean NOT NULL DEFAULT true,
  created_at   timestamptz(3) NOT NULL DEFAULT now(),
  updated_at   timestamptz(3) NOT NULL DEFAULT now()
);

-- Several keys per provider are used round robin; a key the provider rejects is disabled.
CREATE TABLE provider_credentials (
  id          text PRIMARY KEY,
  provider_id text NOT NULL REFERENCES providers (id) ON DELETE CASCADE,
  label       text NOT NULL CHECK (length(label) BETWEEN 1 AND 60),
  ciphertext  text NOT NULL,
  last4       text NOT NULL CHECK (length(last4) <= 4),
  enabled     boolean NOT NULL DEFAULT true,
  disabled_reason text CHECK (length(disabled_reason) <= 200),
  created_at  timestamptz(3) NOT NULL DEFAULT now()
);
CREATE INDEX provider_credentials_provider_idx ON provider_credentials (provider_id) WHERE enabled;

-- What callers ask for. The id is the public model name ("gpt-5.4-mini"); aliases are
-- other names that resolve to it.
CREATE TABLE models (
  id                text PRIMARY KEY CHECK (id ~ '^[A-Za-z0-9][A-Za-z0-9._:/-]{0,118}[A-Za-z0-9]$'),
  kind              model_kind NOT NULL,
  display_name      text NOT NULL CHECK (length(display_name) BETWEEN 1 AND 80),
  description       text NOT NULL DEFAULT '' CHECK (length(description) <= 300),
  owned_by          text NOT NULL DEFAULT '' CHECK (length(owned_by) <= 60),
  aliases           text[] NOT NULL DEFAULT '{}',
  context_window    integer CHECK (context_window > 0),
  max_output_tokens integer CHECK (max_output_tokens > 0),
  supports_tools    boolean NOT NULL DEFAULT false,
  supports_vision   boolean NOT NULL DEFAULT false,
  supports_json     boolean NOT NULL DEFAULT false,
  -- NULL falls back to the default margin in settings.
  margin_bps        integer CHECK (margin_bps BETWEEN 0 AND 100000),
  enabled           boolean NOT NULL DEFAULT false,
  sort_order        integer NOT NULL DEFAULT 0,
  created_at        timestamptz(3) NOT NULL DEFAULT now(),
  updated_at        timestamptz(3) NOT NULL DEFAULT now()
);
CREATE INDEX models_aliases_idx ON models USING gin (aliases);

-- Where a model is served from, in priority order (1 first). Each route carries what
-- that provider charges the platform. The price callers pay is the primary route's cost
-- plus the margin, whichever route actually serves the request (ADR 0005).
CREATE TABLE model_routes (
  id                   text PRIMARY KEY,
  model_id             text NOT NULL REFERENCES models (id) ON DELETE CASCADE,
  provider_id          text NOT NULL REFERENCES providers (id) ON DELETE CASCADE,
  upstream_model       text NOT NULL CHECK (length(upstream_model) BETWEEN 1 AND 160),
  priority             integer NOT NULL DEFAULT 1 CHECK (priority BETWEEN 1 AND 100),
  timeout_ms           integer NOT NULL DEFAULT 120000 CHECK (timeout_ms BETWEEN 1000 AND 600000),
  input_micros_per_mtok   bigint NOT NULL DEFAULT 0 CHECK (input_micros_per_mtok >= 0),
  output_micros_per_mtok  bigint NOT NULL DEFAULT 0 CHECK (output_micros_per_mtok >= 0),
  cached_micros_per_mtok  bigint CHECK (cached_micros_per_mtok >= 0),
  -- Per image (IMAGE), per million characters (SPEECH), per minute (TRANSCRIPTION).
  unit_micros          bigint NOT NULL DEFAULT 0 CHECK (unit_micros >= 0),
  enabled              boolean NOT NULL DEFAULT true,
  created_at           timestamptz(3) NOT NULL DEFAULT now(),
  updated_at           timestamptz(3) NOT NULL DEFAULT now(),
  UNIQUE (model_id, provider_id, upstream_model)
);
CREATE INDEX model_routes_model_idx ON model_routes (model_id, priority);

-- Active probe results, kept a few days for the health page.
CREATE TABLE health_checks (
  id         text PRIMARY KEY,
  route_id   text NOT NULL REFERENCES model_routes (id) ON DELETE CASCADE,
  ok         boolean NOT NULL,
  latency_ms integer,
  error      text CHECK (length(error) <= 300),
  checked_at timestamptz(3) NOT NULL DEFAULT now()
);
CREATE INDEX health_checks_route_idx ON health_checks (route_id, checked_at DESC);

-- ─── Requests ───────────────────────────────────────────────────────────────

-- One row per data-plane call, written when it settles. Money is snapshotted: what the
-- provider charged (cost), the margin applied and what the account paid (price).
CREATE TABLE requests (
  id             text PRIMARY KEY,
  user_id        text NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  api_key_id     text REFERENCES api_keys (id) ON DELETE SET NULL,
  model_id       text NOT NULL,
  route_id       text REFERENCES model_routes (id) ON DELETE SET NULL,
  provider_id    text,
  endpoint       text NOT NULL CHECK (length(endpoint) <= 60),
  stream         boolean NOT NULL DEFAULT false,
  status_code    integer NOT NULL,
  error_code     text CHECK (length(error_code) <= 60),
  attempts       integer NOT NULL DEFAULT 1,
  input_tokens   integer NOT NULL DEFAULT 0,
  output_tokens  integer NOT NULL DEFAULT 0,
  cached_tokens  integer NOT NULL DEFAULT 0,
  units          numeric(14, 4) NOT NULL DEFAULT 0,   -- images, characters or minutes
  -- True when the provider reported no usage and the tokens were estimated.
  estimated      boolean NOT NULL DEFAULT false,
  latency_ms     integer,
  ttfb_ms        integer,
  cost_micros    bigint NOT NULL DEFAULT 0,
  price_micros   bigint NOT NULL DEFAULT 0,
  margin_bps     integer NOT NULL DEFAULT 0,
  ip             inet,
  created_at     timestamptz(3) NOT NULL DEFAULT now()
);
CREATE INDEX requests_user_idx ON requests (user_id, created_at DESC, id DESC);
CREATE INDEX requests_key_month_idx ON requests (api_key_id, created_at);
CREATE INDEX requests_recent_idx ON requests (created_at DESC);
CREATE INDEX requests_model_idx ON requests (model_id, created_at);

-- Bodies, only for keys with log_bodies on; deleted after the retention setting.
CREATE TABLE request_bodies (
  request_id text PRIMARY KEY REFERENCES requests (id) ON DELETE CASCADE,
  request    jsonb NOT NULL,
  response   jsonb,
  expires_at timestamptz(3) NOT NULL
);
CREATE INDEX request_bodies_expiry_idx ON request_bodies (expires_at);

-- ─── Operations ─────────────────────────────────────────────────────────────

CREATE TABLE settings (
  key        text PRIMARY KEY,
  value      jsonb NOT NULL,
  updated_by text REFERENCES users (id) ON DELETE SET NULL,
  updated_at timestamptz(3) NOT NULL DEFAULT now()
);

CREATE TABLE audit_log (
  id          text PRIMARY KEY,
  actor_id    text REFERENCES users (id) ON DELETE SET NULL,
  action      text NOT NULL,
  entity_type text NOT NULL,
  entity_id   text,
  ip          inet,
  data        jsonb NOT NULL DEFAULT '{}',
  created_at  timestamptz(3) NOT NULL DEFAULT now()
);
CREATE INDEX audit_log_recent_idx ON audit_log (created_at DESC, id DESC);
CREATE INDEX audit_log_entity_idx ON audit_log (entity_type, entity_id);
CREATE INDEX audit_log_actor_idx ON audit_log (actor_id, created_at DESC);

-- ─── Seed rows ──────────────────────────────────────────────────────────────

INSERT INTO limit_tiers (id, name, rpm, tpm, concurrency, is_default)
VALUES ('01JDK4V7Q80000000000000000', 'Default', 60, 200000, 8, true);
