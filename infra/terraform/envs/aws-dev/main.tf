# ─────────────────────────────────────────────────────────────────────────────
# aws-dev: a full, cheaper copy of production. Two AZs with a single NAT, single-AZ
# database, one Redis node, one task per service, no deletion protection, no CDN.
#
# Everything is in ../../modules/deployment; this file only picks the sizes.
#   make aws-deploy ENV=aws-dev
# ─────────────────────────────────────────────────────────────────────────────
module "app" {
  source    = "../../modules/deployment"
  providers = { aws = aws, aws.us_east_1 = aws.us_east_1 }

  name_prefix     = var.name_prefix
  domain          = var.domain
  route53_zone_id = var.route53_zone_id
  certificate_arn = var.certificate_arn
  mail_domain     = var.mail_domain
  product_name    = var.product_name
  image_tag       = var.image_tag

  # Provider API keys are entered in /admin and stored encrypted (CREDENTIALS_KEY,
  # generated into <name_prefix>/gateway). Stripe, Razorpay and FX keys go in
  # <name_prefix>/billing; empty billing_secrets keeps them out of state ("set-me"
  # placeholders to replace by hand).
  gateway_public_url   = var.gateway_public_url
  billing_secrets      = var.billing_secrets
  fx_provider          = var.fx_provider
  fx_fixed_inr_per_usd = var.fx_fixed_inr_per_usd

  log_level                  = var.log_level
  require_email_verification = var.require_email_verification
  # Anything else the API reads as a secret (SMTP_PASS, ...), as ECS secret references.
  api_extra_secrets = var.api_extra_secrets

  az_count                   = 2
  single_nat_gateway         = true
  enable_interface_endpoints = false

  enable_cdn = var.enable_cdn
  enable_waf = true

  db_instance_class        = var.db_instance_class
  db_multi_az              = false
  db_backup_retention_days = 3
  deletion_protection      = false

  cache_node_type               = var.cache_node_type
  cache_node_count              = 1
  cache_snapshot_retention_days = 1

  kms_deletion_window_days    = 7
  secret_recovery_window_days = 0

  cpu_architecture = var.cpu_architecture

  app_db_secret_arn = var.app_db_secret_arn
  app_db_username   = var.app_db_username

  api_min_count    = 1
  api_max_count    = 2
  worker_min_count = 1
  worker_max_count = 1
  web_min_count    = 1
  web_max_count    = 2

  log_retention_days      = 14
  flow_log_retention_days = 14
  alarm_email             = var.alarm_email
  api_extra_environment   = var.api_extra_environment
}
