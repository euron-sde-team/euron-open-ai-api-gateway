variable "name_prefix" {
  description = "Prefix for every resource name."
  type        = string
}

variable "kms_key_arn" {
  description = "CMK that encrypts the secrets. Null uses the AWS-managed key."
  type        = string
  default     = null
}

variable "recovery_window_in_days" {
  description = "Days a deleted secret stays recoverable. 0 deletes immediately (local and throwaway environments)."
  type        = number
  default     = 30
}

# ─── Gateway keys ────────────────────────────────────────────────────────────

variable "credentials_key" {
  description = "CREDENTIALS_KEY: 32 bytes, base64 (openssl rand -base64 32). Null generates one. Pass it only when moving an existing installation, or the stored provider credentials cannot be decrypted."
  type        = string
  default     = null
  sensitive   = true
  validation {
    condition     = var.credentials_key == null || try(length(base64decode(var.credentials_key)) == 32, false)
    error_message = "credentials_key must be 32 bytes, base64 encoded."
  }
}

variable "api_key_pepper" {
  description = "API_KEY_PEPPER: at least 32 random characters. Null generates one. Pass it only when moving an existing installation, or every issued API key stops working."
  type        = string
  default     = null
  sensitive   = true
  validation {
    condition     = var.api_key_pepper == null || try(length(var.api_key_pepper) >= 32, false)
    error_message = "api_key_pepper must be at least 32 characters."
  }
}

# ─── Payments and FX ─────────────────────────────────────────────────────────

variable "billing_secrets" {
  description = "Initial payment and FX keys: any of STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET, RAZORPAY_KEY_ID, RAZORPAY_KEY_SECRET, RAZORPAY_WEBHOOK_SECRET, FX_API_KEY. Missing keys are written as \"set-me\" (unset) to replace by hand, which keeps them out of Terraform state."
  type        = map(string)
  default     = {}
  sensitive   = true
  validation {
    condition     = alltrue([for k in keys(var.billing_secrets) : contains(["STRIPE_SECRET_KEY", "STRIPE_WEBHOOK_SECRET", "RAZORPAY_KEY_ID", "RAZORPAY_KEY_SECRET", "RAZORPAY_WEBHOOK_SECRET", "FX_API_KEY"], k)])
    error_message = "billing_secrets keys must be among STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET, RAZORPAY_KEY_ID, RAZORPAY_KEY_SECRET, RAZORPAY_WEBHOOK_SECRET, FX_API_KEY."
  }
}
