# ─── Identity ────────────────────────────────────────────────────────────────

variable "name_prefix" {
  description = "Prefix for every resource name, e.g. \"gw-prod\". Lowercase letters, digits and hyphens."
  type        = string
  validation {
    condition     = can(regex("^[a-z][a-z0-9-]{2,23}$", var.name_prefix))
    error_message = "name_prefix must be 3-24 characters: lowercase letters, digits, hyphens, starting with a letter."
  }
}

variable "domain" {
  description = "The app host, e.g. \"app.example.com\". The web console, the API (/api/*) and the gateway (/v1/*) are all served on it."
  type        = string
}

variable "route53_zone_id" {
  description = "Route53 hosted zone serving the domain. Enables fully automatic certificates and DNS. Without it, pass certificate_arn and publish the records from the outputs."
  type        = string
  default     = null
}

variable "certificate_arn" {
  description = "Existing regional ACM certificate for the app host. Required when route53_zone_id is null."
  type        = string
  default     = null
  validation {
    condition     = var.route53_zone_id != null || var.certificate_arn != null
    error_message = "Set route53_zone_id (automatic certificates and DNS) or certificate_arn (an existing certificate for the app host)."
  }
}

variable "mail_domain" {
  description = "Sending domain verified in SES (defaults to domain). Mail goes out as no-reply@<mail_domain>."
  type        = string
  default     = null
}

variable "dmarc_policy" {
  description = "DMARC policy to publish for the mail domain (none, quarantine, reject), or null to leave DMARC alone."
  type        = string
  default     = "none"
}

variable "product_name" {
  description = "Product name shown in the app, emails and authenticator apps."
  type        = string
  default     = "Euron Open AI API Gateway"
}

variable "image_tag" {
  description = "Tag of the api and web images in ECR (make aws-deploy uses the git commit)."
  type        = string
}

# ─── Gateway ─────────────────────────────────────────────────────────────────
# Provider API keys are not deployment settings: admins enter them in /admin and the
# API stores them encrypted in Postgres with CREDENTIALS_KEY (<prefix>/gateway, generated
# here). The app boots without any provider configured and logs what is missing.

variable "gateway_public_url" {
  description = "GATEWAY_PUBLIC_URL: the base URL developers point their SDK at, including /v1. Null: https://<domain>/v1."
  type        = string
  default     = null
}

variable "api_key_prefix" {
  description = "API_KEY_PREFIX: the prefix every API key starts with (lowercase letters and a trailing hyphen)."
  type        = string
  default     = "gw-"
  validation {
    condition     = can(regex("^[a-z]{1,8}-$", var.api_key_prefix))
    error_message = "api_key_prefix must be 1-8 lowercase letters followed by a hyphen."
  }
}

variable "gateway_max_body_mb" {
  description = "GATEWAY_MAX_BODY_MB: largest data plane request body in megabytes (1-100). Images in vision requests count."
  type        = number
  default     = 20
  validation {
    condition     = var.gateway_max_body_mb >= 1 && var.gateway_max_body_mb <= 100
    error_message = "gateway_max_body_mb must be between 1 and 100."
  }
}

variable "gateway_max_audio_mb" {
  description = "GATEWAY_MAX_AUDIO_MB: largest audio file for transcription in megabytes (1-100)."
  type        = number
  default     = 25
  validation {
    condition     = var.gateway_max_audio_mb >= 1 && var.gateway_max_audio_mb <= 100
    error_message = "gateway_max_audio_mb must be between 1 and 100."
  }
}

variable "credentials_key" {
  description = "CREDENTIALS_KEY (32 bytes, base64). Null generates one. Set only when moving an existing installation."
  type        = string
  default     = null
  sensitive   = true
}

variable "api_key_pepper" {
  description = "API_KEY_PEPPER (at least 32 characters). Null generates one. Set only when moving an existing installation."
  type        = string
  default     = null
  sensitive   = true
}

# ─── Payments and FX ─────────────────────────────────────────────────────────

variable "billing_secrets" {
  description = "Optional payment and FX keys (STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET, RAZORPAY_KEY_ID, RAZORPAY_KEY_SECRET, RAZORPAY_WEBHOOK_SECRET, FX_API_KEY). Stored in Secrets Manager (and therefore in Terraform state). Missing keys are \"set-me\" placeholders, replaced by hand."
  type        = map(string)
  default     = {}
  sensitive   = true
}

variable "fx_provider" {
  description = "FX_PROVIDER: where the INR per USD rate comes from: exchangerate (no key), openexchangerates (needs FX_API_KEY in <prefix>/billing) or fixed."
  type        = string
  default     = "exchangerate"
  validation {
    condition     = contains(["exchangerate", "openexchangerates", "fixed"], var.fx_provider)
    error_message = "fx_provider must be exchangerate, openexchangerates or fixed."
  }
}

variable "fx_fixed_inr_per_usd" {
  description = "FX_FIXED_INR_PER_USD: the rate with fx_provider = \"fixed\", and the fallback before the first fetch."
  type        = number
  default     = 85
}

# ─── Network ─────────────────────────────────────────────────────────────────

variable "vpc_cidr" {
  description = "VPC CIDR."
  type        = string
  default     = "10.70.0.0/16"
}

variable "az_count" {
  description = "Availability zones (2 or 3)."
  type        = number
  default     = 2
}

variable "single_nat_gateway" {
  description = "One shared NAT gateway (cheaper) instead of one per AZ (resilient)."
  type        = bool
  default     = true
}

variable "enable_interface_endpoints" {
  description = "KMS and Secrets Manager interface endpoints (traffic stays off NAT)."
  type        = bool
  default     = false
}

variable "flow_log_retention_days" {
  description = "VPC flow log retention; 0 disables flow logs."
  type        = number
  default     = 30
}

# ─── Edge ────────────────────────────────────────────────────────────────────

variable "enable_cdn" {
  description = "Put CloudFront in front of the load balancer (requires route53_zone_id)."
  type        = bool
  default     = false
  validation {
    condition     = !var.enable_cdn || var.route53_zone_id != null
    error_message = "enable_cdn needs route53_zone_id: the CloudFront certificate is validated through DNS."
  }
}

variable "enable_waf" {
  description = "Attach a WAF web ACL to CloudFront (with enable_cdn)."
  type        = bool
  default     = true
}

variable "cdn_origin_read_timeout" {
  description = "With enable_cdn: seconds CloudFront waits for each packet from the load balancer (1-180). 60 is CloudFront's maximum without a quota increase; raise it (after the increase) if models stay silent longer than that before the first token."
  type        = number
  default     = 60
}

variable "alb_idle_timeout" {
  description = "Load balancer idle timeout in seconds: how long a connection may go without a byte in either direction. 300 because a streamed completion from a slow or reasoning model can sit silent for minutes before or between tokens; at the ALB default of 60 those /v1 streams are cut off mid-answer."
  type        = number
  default     = 300
}

variable "alb_access_logs_bucket" {
  description = "Existing bucket for ALB access logs. Null disables them."
  type        = string
  default     = null
}

# ─── Data ────────────────────────────────────────────────────────────────────

variable "db_instance_class" {
  description = "RDS instance class."
  type        = string
  default     = "db.t4g.medium"
}

variable "db_allocated_storage" {
  description = "Initial storage (GiB)."
  type        = number
  default     = 20
}

variable "db_max_allocated_storage" {
  description = "Storage autoscaling ceiling (GiB)."
  type        = number
  default     = 100
}

variable "db_multi_az" {
  description = "Synchronous standby in a second AZ."
  type        = bool
  default     = false
}

variable "db_backup_retention_days" {
  description = "Automated backup (point-in-time recovery) retention."
  type        = number
  default     = 7
}

variable "db_monitoring_interval" {
  description = "Enhanced monitoring interval in seconds (0 disables)."
  type        = number
  default     = 60
}

variable "app_db_secret_arn" {
  description = "Secrets Manager secret ({\"username\",\"password\"} JSON, encrypted with the deployment's KMS key) of a non-master application role the api and worker connect as. Null: they use the RDS master user. The role is created by hand after the first deploy (docs/guides/operations.md, \"Least-privilege database role\"); migrate and admin keep the master user."
  type        = string
  default     = null
}

variable "app_db_username" {
  description = "Login of the application role (with app_db_secret_arn)."
  type        = string
  default     = null
  validation {
    condition     = (var.app_db_username == null) == (var.app_db_secret_arn == null)
    error_message = "Set app_db_secret_arn and app_db_username together (or neither)."
  }
}

variable "db_pool_max" {
  description = "Postgres connections per API or worker task (DB_POOL_MAX). Tasks x this must stay below the instance's max_connections."
  type        = number
  default     = 10
}

variable "cache_node_type" {
  description = "ElastiCache node type."
  type        = string
  default     = "cache.t4g.small"
}

variable "cache_node_count" {
  description = "Redis nodes: 1, or 2+ for a replica in another AZ with automatic failover."
  type        = number
  default     = 1
}

variable "cache_snapshot_retention_days" {
  description = "Daily Redis snapshots kept."
  type        = number
  default     = 7
}

variable "deletion_protection" {
  description = "Protect the database and load balancer from deletion, keep a final snapshot, refuse to delete non-empty repositories."
  type        = bool
  default     = true
}

variable "kms_deletion_window_days" {
  description = "Waiting period before a scheduled KMS key deletion completes."
  type        = number
  default     = 30
}

variable "kms_admin_principal_arns" {
  description = "IAM principals allowed to administer the KMS key."
  type        = list(string)
  default     = []
}

variable "secret_recovery_window_days" {
  description = "Recovery window for deleted secrets."
  type        = number
  default     = 30
}

# ─── Applications ────────────────────────────────────────────────────────────

variable "migrate_on_boot" {
  description = "The API applies pending migrations at startup (advisory-locked). Default false: make aws-deploy runs the migrate task before rolling the services."
  type        = bool
  default     = false
}

variable "require_email_verification" {
  description = "New accounts must confirm their email address (REQUIRE_EMAIL_VERIFICATION)."
  type        = bool
  default     = true
}

variable "log_level" {
  description = "API and worker LOG_LEVEL."
  type        = string
  default     = "info"
}

variable "cpu_architecture" {
  description = "CPU architecture of every task: X86_64 (default) or ARM64 (Graviton, about 20% cheaper per vCPU). ARM64 needs images built for linux/arm64: deploy with PLATFORM=linux/arm64 make aws-deploy (scripts/aws-deploy.sh), or the tasks fail to start with an exec format error."
  type        = string
  default     = "X86_64"
  validation {
    condition     = contains(["X86_64", "ARM64"], var.cpu_architecture)
    error_message = "cpu_architecture must be X86_64 or ARM64."
  }
}

variable "api_cpu" {
  description = "API task CPU units."
  type        = number
  default     = 512
}

variable "api_memory" {
  description = "API task memory (MiB)."
  type        = number
  default     = 1024
}

variable "api_min_count" {
  description = "Minimum API tasks."
  type        = number
  default     = 1
}

variable "api_max_count" {
  description = "Maximum API tasks."
  type        = number
  default     = 3
}

variable "worker_cpu" {
  description = "Worker task CPU units."
  type        = number
  default     = 512
}

variable "worker_memory" {
  description = "Worker task memory (MiB). Scheduled jobs run here: reservation sweeper, health probes, FX sync, low-balance emails, retention."
  type        = number
  default     = 1024
}

variable "worker_min_count" {
  description = "Minimum worker tasks."
  type        = number
  default     = 1
}

variable "worker_max_count" {
  description = "Maximum worker tasks."
  type        = number
  default     = 2
}

variable "web_cpu" {
  description = "Web app task CPU units."
  type        = number
  default     = 256
}

variable "web_memory" {
  description = "Web app task memory (MiB)."
  type        = number
  default     = 512
}

variable "web_min_count" {
  description = "Minimum web app tasks."
  type        = number
  default     = 1
}

variable "web_max_count" {
  description = "Maximum web app tasks."
  type        = number
  default     = 3
}

variable "api_extra_environment" {
  description = "Extra API and worker environment variables, e.g. ACCESS_TOKEN_TTL_SECONDS or BCRYPT_ROUNDS. Never put secrets here."
  type        = map(string)
  default     = {}
}

variable "api_extra_secrets" {
  description = "Extra API and worker secrets as ECS secret references, e.g. [{ name = \"SMTP_PASS\", valueFrom = \"<secret arn>:SMTP_PASS::\" }]. The execution role is granted read access to each one."
  type        = list(object({ name = string, valueFrom = string }))
  default     = []
}

variable "log_retention_days" {
  description = "CloudWatch log retention for every service."
  type        = number
  default     = 30
}

variable "alarm_email" {
  description = "Address that receives alarm notifications."
  type        = string
  default     = null
}
