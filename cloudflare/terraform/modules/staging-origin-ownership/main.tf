terraform {
  required_version = ">= 1.10.0"
}

variable "enabled" {
  type = bool
}

variable "installation_id" {
  type = string
}

variable "account_id" {
  type = string
}

locals {
  installation_digest = sha256("${lower(var.account_id)}:${var.installation_id}")
  worker_name         = "moqesh-staging-origin-${substr(local.installation_digest, 0, 16)}"
  owner_marker        = "moqesh-staging-origin-owner:${local.installation_digest}"
}

output "worker_name" {
  value = local.worker_name
}

output "owner_marker" {
  value = local.owner_marker
}

output "safe" {
  value = !var.enabled || length(trimspace(var.installation_id)) > 0
}
