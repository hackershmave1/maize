variable "account_id" {
  description = "Cloudflare account containing this installation."
  type        = string

  validation {
    condition     = can(regex("^[a-fA-F0-9]{32}$", var.account_id)) && lower(var.account_id) != "00000000000000000000000000000000"
    error_message = "account_id must be a real 32-character Cloudflare account ID."
  }
}

variable "zone_id" {
  description = "Existing Cloudflare zone that contains both hostnames."
  type        = string

  validation {
    condition     = can(regex("^[a-fA-F0-9]{32}$", var.zone_id)) && lower(var.zone_id) != "00000000000000000000000000000000"
    error_message = "zone_id must be a real 32-character Cloudflare zone ID."
  }
}

variable "protected_hostname" {
  description = "Existing, proxied hostname whose entire host will be routed through this Worker."
  type        = string

  validation {
    condition     = length(var.protected_hostname) <= 253 && can(regex("^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\\.)*[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$", var.protected_hostname)) && var.protected_hostname == lower(var.protected_hostname)
    error_message = "protected_hostname must be a lowercase DNS hostname without a scheme, port, path, or wildcard."
  }
}

variable "admin_hostname" {
  description = "Existing, proxied hostname reserved for the Access-protected dashboard."
  type        = string

  validation {
    condition     = length(var.admin_hostname) <= 253 && can(regex("^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\\.)*[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$", var.admin_hostname)) && var.admin_hostname == lower(var.admin_hostname)
    error_message = "admin_hostname must be a lowercase DNS hostname without a scheme, port, path, or wildcard."
  }
}

variable "worker_name" {
  description = "Name reserved for this installation's Worker; must not be the existing origin Worker."
  type        = string
  default     = "moqesh-cloudflare"

  validation {
    condition     = can(regex("^[a-zA-Z0-9]([a-zA-Z0-9-]{0,58}[a-zA-Z0-9])?$", var.worker_name))
    error_message = "worker_name must be a Cloudflare-compatible Worker script name."
  }
}

variable "create_staging_origin" {
  description = "Explicitly opt in to an isolated, private static staging origin Worker."
  type        = bool
  default     = false
}

variable "agent_session_migration_applied" {
  description = "Set true after the first successful apply has created the AgentSession Durable Object (migration tag v1). Later Worker uploads must omit the already-applied migration."
  type        = bool
  default     = false
}

variable "origin_type" {
  description = "How ordinary traffic reaches the protected app: \"worker\" binds an existing origin Worker (or the managed staging origin); \"dns\" forwards to the server behind the hostname's proxied DNS record."
  type        = string
  default     = "worker"

  validation {
    condition     = contains(["worker", "dns"], var.origin_type)
    error_message = "origin_type must be \"worker\" or \"dns\"."
  }

  validation {
    condition     = !(var.create_staging_origin && var.origin_type == "dns")
    error_message = "create_staging_origin requires origin_type = \"worker\"."
  }
}

variable "origin_service_name" {
  description = "Existing customer origin Worker service name; leave empty when origin_type is \"dns\" or create_staging_origin selects the managed origin. Terraform does not manage external origins."
  type        = string

  validation {
    condition     = var.create_staging_origin || var.origin_type == "dns" || (length(trimspace(var.origin_service_name)) > 0 && var.origin_service_name != var.worker_name)
    error_message = "With origin_type = \"worker\" and no managed staging origin, origin_service_name must name an existing service and must not point this Worker back to itself."
  }
}

variable "origin_service_environment" {
  description = "Existing origin Worker environment used by the ORIGIN service binding."
  type        = string
  default     = "production"
}

variable "d1_database_name" {
  description = "Name for the installation-owned D1 event database."
  type        = string
  default     = "moqesh-events"
}

variable "installation_id" {
  description = "Stable, unique, non-secret identifier for this installation."
  type        = string

  validation {
    condition     = length(trimspace(var.installation_id)) >= 8 && length(var.installation_id) <= 128
    error_message = "installation_id must contain between 8 and 128 non-whitespace characters."
  }
}

variable "bait_api_path" {
  description = "Exact lure API path that confirms reuse of the synthetic key."
  type        = string

  validation {
    condition     = startswith(var.bait_api_path, "/") && !strcontains(var.bait_api_path, "*") && !strcontains(var.bait_api_path, "?") && !strcontains(var.bait_api_path, "#") && !contains(local.disclosure_lure_paths, var.bait_api_path) && var.bait_api_path != "/robots.txt"
    error_message = "bait_api_path must be a distinct absolute URL path without wildcards, query strings, or fragments, and must not reuse a disclosure lure path or /robots.txt."
  }
}

variable "lure_paths" {
  description = "Worker lure paths: the fixed disclosure lures implemented in src/lures.ts plus bait_api_path. Recorded for review only; the Worker does not read this list."
  type        = list(string)

  validation {
    condition     = length(var.lure_paths) == length(local.disclosure_lure_paths) + 1 && length(setsubtract(concat(local.disclosure_lure_paths, [var.bait_api_path]), var.lure_paths)) == 0
    error_message = "lure_paths must contain exactly the disclosure lures implemented by the Worker plus the configured bait_api_path."
  }
}

variable "allowlisted_sources" {
  description = "IPv4 or IPv6 source addresses that bypass maze and block behavior."
  type        = list(string)
  default     = []

  validation {
    condition = alltrue([
      for source in var.allowlisted_sources :
      can(cidrhost("${source}/${strcontains(source, ":") ? 128 : 32}", 0))
    ])
    error_message = "allowlisted_sources must contain individual IPv4 or IPv6 addresses, not CIDR ranges."
  }
}

variable "maze_duration_minutes" {
  description = "Initial maze duration, in minutes; runtime settings can subsequently be changed in the dashboard."
  type        = number
  default     = 15

  validation {
    condition     = var.maze_duration_minutes >= 1 && var.maze_duration_minutes <= 120 && floor(var.maze_duration_minutes) == var.maze_duration_minutes
    error_message = "maze_duration_minutes must be a whole number from 1 to 120."
  }
}

variable "block_duration_hours" {
  description = "Initial block duration, in hours; runtime settings can subsequently be changed in the dashboard."
  type        = number
  default     = 24

  validation {
    condition     = var.block_duration_hours >= 1 && var.block_duration_hours <= 168 && floor(var.block_duration_hours) == var.block_duration_hours
    error_message = "block_duration_hours must be a whole number from 1 to 168."
  }
}

variable "response_budget" {
  description = "Initial per-source maze response budget."
  type        = number
  default     = 100

  validation {
    condition     = var.response_budget >= 1 && var.response_budget <= 10000 && floor(var.response_budget) == var.response_budget
    error_message = "response_budget must be a whole number from 1 to 10000."
  }
}

variable "alert_grouping_minutes" {
  description = "Initial webhook grouping interval, in minutes."
  type        = number
  default     = 5

  validation {
    condition     = var.alert_grouping_minutes >= 1 && var.alert_grouping_minutes <= 60 && floor(var.alert_grouping_minutes) == var.alert_grouping_minutes
    error_message = "alert_grouping_minutes must be a whole number from 1 to 60."
  }
}

variable "retention_days" {
  description = "Initial event and audit retention duration, in days."
  type        = number
  default     = 30

  validation {
    condition     = var.retention_days >= 1 && var.retention_days <= 30 && floor(var.retention_days) == var.retention_days
    error_message = "retention_days must be a whole number from 1 to 30."
  }
}

variable "access_team_domain" {
  description = "Existing Cloudflare Access team domain used by the Worker to validate assertions."
  type        = string

  validation {
    condition     = length(var.access_team_domain) <= 253 && can(regex("^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\\.)*[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$", var.access_team_domain)) && var.access_team_domain == lower(var.access_team_domain)
    error_message = "access_team_domain must be a DNS hostname without a scheme or path."
  }
}

variable "access_allowed_emails" {
  description = "Exact email addresses allowed by the dashboard Access policy."
  type        = list(string)

  validation {
    condition     = length(var.access_allowed_emails) > 0 && alltrue([for email in var.access_allowed_emails : can(regex("^[^ @]+@[^ @]+$", email))])
    error_message = "access_allowed_emails must contain at least one valid email address."
  }
}

variable "access_session_duration" {
  description = "Maximum validity for dashboard Access sessions."
  type        = string
  default     = "8h"

  validation {
    condition     = can(regex("^[1-9][0-9]*(m|h)$", var.access_session_duration))
    error_message = "access_session_duration must be a positive number of minutes or hours, such as 30m or 8h."
  }
}

variable "lure_key_secret_binding_name" {
  description = "Cloudflare Worker secret binding name for the per-installation lure key."
  type        = string
  default     = "LURE_KEY_SECRET"

  validation {
    condition     = var.lure_key_secret_binding_name == "LURE_KEY_SECRET"
    error_message = "This Worker requires the per-installation secret binding name LURE_KEY_SECRET."
  }
}

variable "alert_webhook_secret_binding_name" {
  description = "Cloudflare Worker secret binding name for the alert webhook destination."
  type        = string
  default     = "ALERT_WEBHOOK_URL"

  validation {
    condition     = var.alert_webhook_secret_binding_name == "ALERT_WEBHOOK_URL"
    error_message = "This Worker requires the secret binding name ALERT_WEBHOOK_URL."
  }
}

variable "alert_webhook_enabled" {
  description = "Whether to send external webhook alerts. Set false only when an installation is intentionally deployed without an alert destination."
  type        = bool
  default     = true
}

variable "secret_rotation_revision" {
  description = "Non-secret revision marker. Increment it whenever either Worker secret is rotated."
  type        = string
  default     = "initial"

  validation {
    condition     = length(trimspace(var.secret_rotation_revision)) > 0
    error_message = "secret_rotation_revision must be a non-empty, non-secret marker."
  }
}

variable "enable_public_route" {
  description = "Second-stage gate for the protected hostname/* route. Keep false until staging checks pass."
  type        = bool
  default     = false
}

locals {
  # Must match DISCLOSURE_LURES in ../src/lures.ts (enforced by terraform/test/config-consistency.node.mjs).
  disclosure_lure_paths = [
    "/.env",
    "/.env.production",
    "/.git/config",
    "/.aws/credentials",
    "/config.json",
    "/wp-config.php.bak",
    "/backup.sql",
    "/api/v1/keys",
    "/swagger.json",
  ]
}
