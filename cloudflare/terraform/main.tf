data "cloudflare_zone" "target" {
  zone_id = var.zone_id
}

data "cloudflare_dns_records" "protected" {
  zone_id = var.zone_id
  name    = { exact = var.protected_hostname }
  proxied = true
}

data "cloudflare_dns_records" "admin" {
  zone_id = var.zone_id
  name    = { exact = var.admin_hostname }
  proxied = true
}

data "cloudflare_workers_routes" "existing" {
  zone_id = var.zone_id
}

data "cloudflare_workers_scripts" "staging_origin_candidates" {
  count      = var.create_staging_origin ? 1 : 0
  account_id = var.account_id
  max_items  = 1000
}

data "cloudflare_workers_script" "existing_staging_origin" {
  count       = module.staging_origin_ownership.read_existing_script ? 1 : 0
  account_id  = var.account_id
  script_name = var.staging_origin_worker_name
}

locals {
  staging_origin_owner_marker = module.staging_origin_ownership.owner_marker
  target_hostnames            = [var.protected_hostname, var.admin_hostname]
  existing_routes = [
    for route in data.cloudflare_workers_routes.existing.result : {
      pattern = route.pattern
      script  = route.script
    }
  ]
  migration_files = sort(fileset("${path.module}/../migrations", "*.sql"))
  migration_digest = sha256(jsonencode([
    for filename in local.migration_files : {
      name   = filename
      digest = filesha256("${path.module}/../migrations/${filename}")
    }
  ]))
}

module "staging_origin_ownership" {
  source          = "./modules/staging-origin-ownership"
  enabled         = var.create_staging_origin
  installation_id = var.installation_id
  worker_name     = var.staging_origin_worker_name
  existing_script_names = var.create_staging_origin ? [
    for script in data.cloudflare_workers_scripts.staging_origin_candidates[0].result : script.id
  ] : []
  existing_sources = [
    for script in data.cloudflare_workers_script.existing_staging_origin : script.script
  ]
}

module "route_preflight" {
  source           = "./modules/route-preflight"
  target_hostnames = local.target_hostnames
  worker_name      = var.worker_name
  existing_routes  = local.existing_routes
}

resource "terraform_data" "deployment_preflight" {
  input = {
    account_id = var.account_id
    zone_id    = var.zone_id
  }

  lifecycle {
    precondition {
      condition     = var.create_staging_origin ? length(data.cloudflare_workers_scripts.staging_origin_candidates[0].result) < 1000 : true
      error_message = "The Worker script listing reached its safety limit; staging origin ownership cannot be checked exhaustively. Stop before uploading any Worker."
    }

    precondition {
      condition     = module.staging_origin_ownership.safe
      error_message = "An existing staging origin Worker lacks this installation's ownership marker; refusing to overwrite an unmanaged or differently owned Worker."
    }

    precondition {
      condition     = lower(data.cloudflare_zone.target.account.id) == lower(var.account_id)
      error_message = "zone_id must identify a zone in account_id."
    }

    precondition {
      condition     = var.protected_hostname == data.cloudflare_zone.target.name || endswith(var.protected_hostname, ".${data.cloudflare_zone.target.name}")
      error_message = "protected_hostname must be inside the selected Cloudflare zone."
    }

    precondition {
      condition     = var.admin_hostname == data.cloudflare_zone.target.name || endswith(var.admin_hostname, ".${data.cloudflare_zone.target.name}")
      error_message = "admin_hostname must be inside the selected Cloudflare zone."
    }

    precondition {
      condition     = var.protected_hostname != var.admin_hostname
      error_message = "The protected and admin hostnames must be distinct."
    }

    precondition {
      condition     = length(data.cloudflare_dns_records.protected.result) > 0 && alltrue([for record in data.cloudflare_dns_records.protected.result : record.proxied])
      error_message = "The protected hostname must already have at least one proxied DNS record in this zone. Terraform will not create or change DNS."
    }

    precondition {
      condition     = length(data.cloudflare_dns_records.admin.result) > 0 && alltrue([for record in data.cloudflare_dns_records.admin.result : record.proxied])
      error_message = "The admin hostname must already have at least one proxied DNS record in this zone. Terraform will not create or change DNS."
    }

    precondition {
      condition     = length(module.route_preflight.overlapping_routes) == 0
      error_message = "Existing Worker routes overlap a requested hostname: ${join(", ", module.route_preflight.overlapping_routes)}. Stop and resolve ownership/conflicts before continuing."
    }
  }
}

resource "cloudflare_d1_database" "events" {
  account_id = var.account_id
  name       = var.d1_database_name

  depends_on = [terraform_data.deployment_preflight]
}

resource "cloudflare_zero_trust_access_application" "admin" {
  account_id       = var.account_id
  name             = "Moqesh admin - ${var.installation_id}"
  type             = "self_hosted"
  session_duration = var.access_session_duration
  destinations = [{
    type = "public"
    uri  = "${var.admin_hostname}/*"
  }]
  policies = [{
    name       = "Moqesh dashboard operators"
    decision   = "allow"
    precedence = 1
    include = [
      for email in var.access_allowed_emails : {
        email = { email = email }
      }
    ]
  }]

  depends_on = [terraform_data.deployment_preflight]
}

resource "cloudflare_workers_script" "staging_origin" {
  count              = var.create_staging_origin ? 1 : 0
  account_id         = var.account_id
  script_name        = var.staging_origin_worker_name
  content            = replace(file("${path.module}/../staging-origin/worker.js"), "@@MOQESH_STAGING_ORIGIN_OWNER@@", local.staging_origin_owner_marker)
  main_module        = "worker.js"
  compatibility_date = "2026-11-08"
  assets = {
    directory = "${path.module}/../staging-origin/site"
    config = {
      binding            = "ASSETS"
      run_worker_first   = true
      not_found_handling = "404-page"
    }
  }

  depends_on = [terraform_data.deployment_preflight]
}

resource "cloudflare_workers_script_subdomain" "staging_origin_disabled" {
  count            = var.create_staging_origin ? 1 : 0
  account_id       = var.account_id
  script_name      = var.staging_origin_worker_name
  enabled          = false
  previews_enabled = false

  depends_on = [cloudflare_workers_script.staging_origin]
}

resource "cloudflare_workers_script" "app" {
  account_id         = var.account_id
  script_name        = var.worker_name
  content_file       = "${path.module}/../.wrangler-out/index.js"
  content_sha256     = filesha256("${path.module}/../.wrangler-out/index.js")
  main_module        = "index.js"
  compatibility_date = "2026-11-08"
  logpush            = false
  keep_bindings      = ["secret_text"]
  assets = {
    directory = "${path.module}/../dashboard/dist"
    config = {
      run_worker_first   = true
      not_found_handling = "single-page-application"
    }
  }
  migrations = {
    new_tag            = "v1"
    new_sqlite_classes = ["AgentSession"]
  }
  bindings = [
    {
      name        = "ORIGIN"
      type        = "service"
      service     = var.create_staging_origin ? cloudflare_workers_script.staging_origin[0].script_name : var.origin_service_name
      environment = var.create_staging_origin ? "production" : var.origin_service_environment
    },
    {
      name       = "AGENT_SESSIONS"
      type       = "durable_object_namespace"
      class_name = "AgentSession"
    },
    {
      name        = "EVENTS_DB"
      type        = "d1"
      database_id = cloudflare_d1_database.events.id
    },
    {
      name = "INSTALLATION_ID"
      type = "plain_text"
      text = var.installation_id
    },
    {
      name = "MAZE_RESPONSE_BUDGET"
      type = "plain_text"
      text = tostring(var.response_budget)
    },
    {
      name = "ALLOWLISTED_SOURCES"
      type = "plain_text"
      text = join(",", var.allowlisted_sources)
    },
    {
      name = "ALERT_DIRECT_LURE"
      type = "plain_text"
      text = "false"
    },
    {
      name = "ALERT_CONFIRMATION"
      type = "plain_text"
      text = "true"
    },
    {
      name = "BAIT_API_PATH"
      type = "plain_text"
      text = var.bait_api_path
    },
    {
      name = "ADMIN_HOSTNAME"
      type = "plain_text"
      text = var.admin_hostname
    },
    {
      name = "ADMIN_ROUTE"
      type = "plain_text"
      text = "${var.admin_hostname}/*"
    },
    {
      name = "PUBLIC_SITE_HOSTNAME"
      type = "plain_text"
      text = var.protected_hostname
    },
    {
      name = "PUBLIC_ROUTE"
      type = "plain_text"
      text = "${var.protected_hostname}/*"
    },
    {
      name = "ACCESS_TEAM_DOMAIN"
      type = "plain_text"
      text = var.access_team_domain
    },
    {
      name = "ACCESS_AUD"
      type = "plain_text"
      text = cloudflare_zero_trust_access_application.admin.aud
    },
  ]

  depends_on = [
    terraform_data.deployment_preflight,
    cloudflare_zero_trust_access_application.admin,
  ]

  lifecycle {
    precondition {
      condition     = (var.create_staging_origin ? var.staging_origin_worker_name : var.origin_service_name) != var.worker_name
      error_message = "The ORIGIN service binding must not route this Worker back to itself."
    }
  }
}

resource "cloudflare_workers_script_subdomain" "disabled" {
  account_id       = var.account_id
  script_name      = cloudflare_workers_script.app.script_name
  enabled          = false
  previews_enabled = false
}

resource "cloudflare_workers_cron_trigger" "scheduled" {
  account_id  = var.account_id
  script_name = cloudflare_workers_script.app.script_name
  schedules = [
    { cron = "* * * * *" },
  ]
}

resource "terraform_data" "d1_migrations" {
  input = {
    database_id = cloudflare_d1_database.events.id
  }

  triggers_replace = [
    cloudflare_d1_database.events.id,
    var.installation_id,
    local.migration_digest,
    filesha256("${path.module}/scripts/apply-d1-migrations.mjs"),
  ]

  provisioner "local-exec" {
    command = "node \"${path.module}/scripts/apply-d1-migrations.mjs\""
    environment = {
      MOQESH_ACCOUNT_ID             = var.account_id
      MOQESH_D1_DATABASE_ID         = cloudflare_d1_database.events.id
      MOQESH_MIGRATIONS_DIRECTORY   = "${path.module}/../migrations"
      MOQESH_INSTALLATION_ID        = var.installation_id
      MOQESH_MAZE_DURATION_MINUTES  = tostring(var.maze_duration_minutes)
      MOQESH_BLOCK_DURATION_HOURS   = tostring(var.block_duration_hours)
      MOQESH_RESPONSE_BUDGET        = tostring(var.response_budget)
      MOQESH_ALERT_GROUPING_MINUTES = tostring(var.alert_grouping_minutes)
      MOQESH_RETENTION_DAYS         = tostring(var.retention_days)
    }
  }

  depends_on = [
    terraform_data.deployment_preflight,
    cloudflare_d1_database.events,
    cloudflare_workers_script.app,
  ]
}

resource "terraform_data" "worker_secrets" {
  input = {
    script_name              = cloudflare_workers_script.app.script_name
    secret_rotation_revision = var.secret_rotation_revision
    lure_key_binding_name    = var.lure_key_secret_binding_name
    webhook_binding_name     = var.alert_webhook_secret_binding_name
  }

  triggers_replace = [
    var.secret_rotation_revision,
    filesha256("${path.module}/scripts/provision-worker-secrets.mjs"),
  ]

  provisioner "local-exec" {
    command = "node \"${path.module}/scripts/provision-worker-secrets.mjs\""
    environment = {
      MOQESH_ACCOUNT_ID                   = var.account_id
      MOQESH_WORKER_NAME                  = cloudflare_workers_script.app.script_name
      MOQESH_LURE_KEY_SECRET_BINDING      = var.lure_key_secret_binding_name
      MOQESH_ALERT_WEBHOOK_SECRET_BINDING = var.alert_webhook_secret_binding_name
    }
  }

  lifecycle {
    replace_triggered_by = [cloudflare_workers_script.app]
  }

  depends_on = [
    terraform_data.deployment_preflight,
    cloudflare_workers_script.app,
  ]
}

resource "cloudflare_workers_route" "admin" {
  zone_id = var.zone_id
  pattern = "${var.admin_hostname}/*"
  script  = cloudflare_workers_script.app.script_name

  depends_on = [
    terraform_data.deployment_preflight,
    terraform_data.d1_migrations,
    terraform_data.worker_secrets,
    cloudflare_zero_trust_access_application.admin,
    cloudflare_workers_cron_trigger.scheduled,
    cloudflare_workers_script_subdomain.disabled,
  ]

  lifecycle {
    precondition {
      condition     = length(module.route_preflight.overlapping_routes) == 0
      error_message = "An existing route overlaps the admin hostname. Do not replace or reassign it."
    }
  }
}

resource "cloudflare_workers_route" "public" {
  count   = var.enable_public_route ? 1 : 0
  zone_id = var.zone_id
  pattern = "${var.protected_hostname}/*"
  script  = cloudflare_workers_script.app.script_name

  depends_on = [
    terraform_data.deployment_preflight,
    terraform_data.d1_migrations,
    terraform_data.worker_secrets,
    cloudflare_zero_trust_access_application.admin,
    cloudflare_workers_route.admin,
    cloudflare_workers_cron_trigger.scheduled,
    cloudflare_workers_script_subdomain.disabled,
    cloudflare_workers_script_subdomain.staging_origin_disabled,
  ]

  lifecycle {
    precondition {
      condition     = var.enable_public_route
      error_message = "The whole-host route requires explicit enable_public_route approval after staging verification."
    }

    precondition {
      condition     = length(module.route_preflight.overlapping_routes) == 0
      error_message = "An existing route overlaps the protected hostname. Do not replace or reassign it."
    }
  }
}
