terraform {
  required_version = ">= 1.10.0"
}

variable "enabled" {
  type = bool
}

variable "installation_id" {
  type = string
}

variable "worker_name" {
  type = string
}

variable "existing_script_names" {
  type = list(string)
}

variable "existing_sources" {
  type = list(string)
}

locals {
  owner_marker         = "moqesh-staging-origin-owner:${sha256(var.installation_id)}"
  read_existing_script = var.enabled && contains(var.existing_script_names, var.worker_name)
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
