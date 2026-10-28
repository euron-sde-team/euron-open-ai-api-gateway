output "app_url" {
  description = "Public URL of the app."
  value       = module.app.app_url
}

output "cluster_name" {
  description = "ECS cluster."
  value       = module.app.cluster_name
}

output "services" {
  description = "ECS service names (api, worker, web)."
  value       = module.app.services
}

output "ecr_repositories" {
  description = "Image repositories (api, web)."
  value       = module.app.ecr_repositories
}

output "migrate_task_definition_arn" {
  description = "One-off migration task definition."
  value       = module.app.migrate_task_definition_arn
}

output "admin_task_definition_arn" {
  description = "One-off admin bootstrap task definition."
  value       = module.app.admin_task_definition_arn
}

output "run_task" {
  description = "Parameters for the one-off tasks (scripts/aws-run-task.sh)."
  value       = module.app.run_task
}

output "redis_endpoint" {
  description = "Redis primary endpoint."
  value       = module.app.redis_endpoint
}

output "mail_configuration_set" {
  description = "SES configuration set."
  value       = module.app.mail_configuration_set
}

output "load_balancer_dns_name" {
  description = "CNAME target when the zone is not in Route53."
  value       = module.app.load_balancer_dns_name
}

output "certificate_validation_records" {
  description = "Publish by hand when the zone is not in Route53."
  value       = module.app.certificate_validation_records
}

output "mail_dns_records" {
  description = "Publish by hand when the zone is not in Route53."
  value       = module.app.mail_dns_records
}

output "billing_secret_name" {
  description = "Secret holding the Stripe, Razorpay and FX keys (replace each \"set-me\" you need)."
  value       = module.app.billing_secret_name
}

output "gateway_url" {
  description = "The base URL developers point their SDK at (GATEWAY_PUBLIC_URL)."
  value       = module.app.gateway_url
}
