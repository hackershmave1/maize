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

variable "existing_script_names" {
  type = list(string)
}

variable "existing_sources" {
  type = list(string)
}

locals {
  installation_digest  = sha256("${lower(var.account_id)}:${var.installation_id}")
  worker_name          = "moqesh-staging-origin-${substr(local.installation_digest, 0, 16)}"
  owner_marker         = "moqesh-staging-origin-owner:${local.installation_digest}"
  read_existing_script = var.enabled && contains(var.existing_script_names, local.worker_name)
}

output "worker_name" {
  value = local.worker_name
}

output "owner_marker" {
  value = local.owner_marker
}

output "read_existing_script" {
  value = local.read_existing_script
}

output "safe" {
  value = !var.enabled ? true : (
    length(trimspace(var.installation_id)) > 0 &&
    (local.read_existing_script ? (
      length(var.existing_sources) == 1 && alltrue([
        for source in var.existing_sources :
        strcontains(coalesce(source, " "), "// ${local.owner_marker}\n")
      ])
    ) : true)
  )
}
