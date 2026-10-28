output "secret_arn" {
  description = "ARN of the JSON secret holding JWT_SECRET and REFRESH_SECRET."
  value       = aws_secretsmanager_secret.app.arn
}

output "secret_refs" {
  description = "ECS container `secrets` entries (signing keys, TOTP key, CREDENTIALS_KEY, API_KEY_PEPPER, payment and FX keys): [{ name, valueFrom }]."
  value       = local.refs
}

output "totp_secret_arn" {
  description = "ARN of the TOTP_ENCRYPTION_KEY secret."
  value       = aws_secretsmanager_secret.totp.arn
}

output "totp_secret_ref" {
  description = "ECS container `secrets` entry for TOTP_ENCRYPTION_KEY alone (one-off tasks that need it without the signing keys)."
  value       = local.totp_ref
}

output "gateway_secret_arn" {
  description = "ARN of the <prefix>/gateway secret (CREDENTIALS_KEY, API_KEY_PEPPER)."
  value       = aws_secretsmanager_secret.gateway.arn
}

output "billing_secret_arn" {
  description = "ARN of the <prefix>/billing secret (Stripe, Razorpay and FX keys)."
  value       = aws_secretsmanager_secret.billing.arn
}

output "billing_secret_name" {
  description = "Name of the <prefix>/billing secret."
  value       = aws_secretsmanager_secret.billing.name
}
