# Application secrets in Secrets Manager. ECS injects them into the API and worker
# containers as environment variables; the values never appear in a task definition
# or a log.
#
#   <prefix>/app            JWT_SECRET, REFRESH_SECRET: generated here, 64 characters
#                           each. Distinct on purpose (the API refuses to boot if they
#                           are equal), so access tokens and refresh tokens can be
#                           rotated independently.
#   <prefix>/totp           TOTP_ENCRYPTION_KEY: 32 random bytes, base64. Encrypts the
#                           TOTP secrets at rest. Rotating it invalidates every enrolled
#                           authenticator, so it is not rotated with the signing keys.
#   <prefix>/gateway        CREDENTIALS_KEY: 32 bytes, base64; encrypts the provider
#                           credentials admins enter in the console (AES-256-GCM).
#                           API_KEY_PEPPER: 64 characters; the HMAC pepper API keys are
#                           hashed with. Generated here unless passed in. Rotating either
#                           is a procedure, not a re-roll: a new CREDENTIALS_KEY means
#                           re-entering every provider key, a new API_KEY_PEPPER
#                           invalidates every issued API key.
#   <prefix>/billing        STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET, RAZORPAY_KEY_ID,
#                           RAZORPAY_KEY_SECRET, RAZORPAY_WEBHOOK_SECRET, FX_API_KEY.
#                           Every key the caller does not pass holds "set-me", which the
#                           API treats as unset (that gateway, or the FX feed, stays off).
#
# Provider API keys are not here: admins add them in /admin, and the API stores them
# encrypted in Postgres with CREDENTIALS_KEY.
#
# Third-party values can be passed as sensitive variables (they then land in Terraform
# state), or left out and replaced by hand afterwards (aws secretsmanager
# put-secret-value with the full JSON object). Terraform never overwrites a value
# afterwards: secret_string is ignore_changes.
#
# REDIS_URL lives in the cache module's own secret, next to the auth token it embeds.
resource "random_password" "app" {
  for_each = toset(["JWT_SECRET", "REFRESH_SECRET"])
  length   = 64
  special  = false
}

resource "aws_secretsmanager_secret" "app" {
  #checkov:skip=CKV2_AWS_57:These are HMAC signing keys; rotation is an operator procedure (put a new version, roll the services), not a Lambda.
  name                    = "${var.name_prefix}/app"
  description             = "API signing secrets (access and refresh tokens)"
  kms_key_id              = var.kms_key_arn
  recovery_window_in_days = var.recovery_window_in_days
}

resource "aws_secretsmanager_secret_version" "app" {
  secret_id     = aws_secretsmanager_secret.app.id
  secret_string = jsonencode({ for k, v in random_password.app : k => v.result })

  # Rotation happens out of band (put a new version by hand or by pipeline). Without
  # this, the next `terraform apply` would quietly roll every secret back.
  lifecycle {
    ignore_changes = [secret_string]
  }
}

resource "random_bytes" "totp" {
  length = 32
}

resource "aws_secretsmanager_secret" "totp" {
  #checkov:skip=CKV2_AWS_57:A data-encryption key for stored TOTP secrets; rotating it needs a re-encryption, not a Lambda.
  name                    = "${var.name_prefix}/totp"
  description             = "Key that encrypts stored TOTP secrets (TOTP_ENCRYPTION_KEY)"
  kms_key_id              = var.kms_key_arn
  recovery_window_in_days = var.recovery_window_in_days
}

resource "aws_secretsmanager_secret_version" "totp" {
  secret_id     = aws_secretsmanager_secret.totp.id
  secret_string = jsonencode({ TOTP_ENCRYPTION_KEY = random_bytes.totp.base64 })

  lifecycle {
    ignore_changes = [secret_string]
  }
}

# ─── Gateway keys ────────────────────────────────────────────────────────────

resource "random_bytes" "credentials_key" {
  length = 32
}

resource "random_password" "api_key_pepper" {
  length  = 64
  special = false
}

resource "aws_secretsmanager_secret" "gateway" {
  #checkov:skip=CKV2_AWS_57:Data-encryption key and hashing pepper; rotating either needs re-encryption or re-issued API keys, not a Lambda.
  name                    = "${var.name_prefix}/gateway"
  description             = "Provider credential encryption key and API key pepper (CREDENTIALS_KEY, API_KEY_PEPPER)"
  kms_key_id              = var.kms_key_arn
  recovery_window_in_days = var.recovery_window_in_days
}

resource "aws_secretsmanager_secret_version" "gateway" {
  secret_id = aws_secretsmanager_secret.gateway.id
  secret_string = jsonencode({
    CREDENTIALS_KEY = coalesce(var.credentials_key, random_bytes.credentials_key.base64)
    API_KEY_PEPPER  = coalesce(var.api_key_pepper, random_password.api_key_pepper.result)
  })

  lifecycle {
    ignore_changes = [secret_string]
  }
}

# ─── Payments and FX ─────────────────────────────────────────────────────────

locals {
  billing_keys = ["STRIPE_SECRET_KEY", "STRIPE_WEBHOOK_SECRET", "RAZORPAY_KEY_ID", "RAZORPAY_KEY_SECRET", "RAZORPAY_WEBHOOK_SECRET", "FX_API_KEY"]
}

resource "aws_secretsmanager_secret" "billing" {
  #checkov:skip=CKV2_AWS_57:Third-party payment and FX keys; they are rotated at each provider, then put here by hand.
  name                    = "${var.name_prefix}/billing"
  description             = "Stripe, Razorpay and FX provider keys (\"set-me\" means unset)"
  kms_key_id              = var.kms_key_arn
  recovery_window_in_days = var.recovery_window_in_days
}

resource "aws_secretsmanager_secret_version" "billing" {
  secret_id     = aws_secretsmanager_secret.billing.id
  secret_string = jsonencode({ for k in local.billing_keys : k => try(coalesce(var.billing_secrets[k]), "set-me") })

  lifecycle {
    ignore_changes = [secret_string]
  }
}

locals {
  totp_ref = { name = "TOTP_ENCRYPTION_KEY", valueFrom = "${aws_secretsmanager_secret.totp.arn}:TOTP_ENCRYPTION_KEY::" }
  refs = concat(
    [for k in sort(keys(random_password.app)) : { name = k, valueFrom = "${aws_secretsmanager_secret.app.arn}:${k}::" }],
    [local.totp_ref],
    [for k in ["API_KEY_PEPPER", "CREDENTIALS_KEY"] : { name = k, valueFrom = "${aws_secretsmanager_secret.gateway.arn}:${k}::" }],
    [for k in local.billing_keys : { name = k, valueFrom = "${aws_secretsmanager_secret.billing.arn}:${k}::" }],
  )
}
