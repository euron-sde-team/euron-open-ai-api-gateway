variable "endpoint" {
  description = "Emulator endpoint: http://localhost:4627 from the host, http://floci:4566 inside compose."
  type        = string
  default     = "http://localhost:4627"
}

variable "name_prefix" {
  description = "Must match SES_CONFIGURATION_SET in deploy/compose/compose.floci.yaml."
  type        = string
  default     = "open-gateway-local"
}

variable "mail_domain" {
  description = "Sending domain registered in the emulator's SES (must match MAIL_FROM in deploy/compose/compose.yaml)."
  type        = string
  default     = "gateway.example.test"
}
