output "worker_name" {
  description = "Terraform-managed Worker script name."
  value       = cloudflare_workers_script.app.script_name
}

output "staging_origin_worker_name" {
  description = "Account- and installation-derived staging origin Worker name, or null when staging is disabled."
  value       = var.create_staging_origin ? local.staging_origin_worker_name : null
}

output "origin_service_name" {
  description = "Selected ORIGIN Worker service name, whether managed staging or an existing external service."
  value       = var.origin_type == "dns" ? null : (var.create_staging_origin ? cloudflare_workers_script.staging_origin[0].script_name : var.origin_service_name)
}

output "events_database_id" {
  description = "Real Terraform-created D1 identifier used by both the Worker binding and migration runner."
  value       = cloudflare_d1_database.events.id
}

output "admin_hostname" {
  description = "Hostname protected by the Access application."
  value       = var.admin_hostname
}

output "access_audience" {
  description = "Cloudflare Access audience bound to the Worker."
  value       = cloudflare_zero_trust_access_application.admin.aud
}

output "public_route_enabled" {
  description = "Whether the staged whole-host route is currently attached."
  value       = var.enable_public_route
}

output "d1_migrations_verified" {
  description = "True only after the Terraform apply's D1 migration runner successfully applied and verified the required migrations."
  value       = terraform_data.d1_migrations.id != ""
}

output "worker_secret_bindings_verified" {
  description = "True only after the Terraform apply uploaded and verified the Worker secret bindings required by this configuration."
  value       = terraform_data.worker_secrets.id != ""
}

output "lure_paths" {
  description = "The paths intercepted as lures by this Worker."
  value       = var.lure_paths
}

output "secret_binding_names" {
  description = "Required Worker secret binding names for this configuration; secret values are never output or stored in Terraform."
  value = var.alert_webhook_enabled ? [
    var.lure_key_secret_binding_name,
    var.alert_webhook_secret_binding_name,
  ] : [var.lure_key_secret_binding_name]
}
