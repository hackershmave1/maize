run "parent_wildcard_allows_staging_hosts" {
  command = plan

  variables {
    target_hostnames = ["staging.kurocyber.com", "admin-staging.kurocyber.com"]
    worker_name      = "moqesh"
    existing_routes = [
      { pattern = "*.kurocyber.com/*", script = "kurocyber-website" },
      { pattern = "https://*.kurocyber.com/*", script = "kurocyber-website" },
    ]
  }

  assert {
    condition     = length(output.overlapping_routes) == 0
    error_message = "A whole-host wildcard must not block more-specific staging routes."
  }
}

run "wildcard_does_not_match_apex" {
  command = plan

  variables {
    target_hostnames = ["kurocyber.com"]
    worker_name      = "moqesh"
    existing_routes  = [{ pattern = "*.kurocyber.com/private/*", script = "other" }]
  }

  assert {
    condition     = length(output.overlapping_routes) == 0
    error_message = "A subdomain wildcard must not match the apex."
  }
}

run "foreign_exact_host_conflicts" {
  command = plan

  variables {
    target_hostnames = ["staging.kurocyber.com"]
    worker_name      = "moqesh"
    existing_routes = [
      { pattern = "staging.kurocyber.com/*", script = "other" },
      { pattern = "https://STAGING.kurocyber.com/private/*", script = "other" },
      { pattern = "staging.kurocyber.com/no-worker", script = null },
    ]
  }

  assert {
    condition = (
      contains(output.overlapping_routes, "staging.kurocyber.com/* (other)") &&
      contains(output.overlapping_routes, "https://STAGING.kurocyber.com/private/* (other)") &&
      contains(output.overlapping_routes, "staging.kurocyber.com/no-worker (<no worker>)")
    )
    error_message = "A foreign exact-host route must be reported."
  }
}

run "narrow_wildcard_conflicts" {
  command = plan

  variables {
    target_hostnames = ["staging.kurocyber.com"]
    worker_name      = "moqesh"
    existing_routes = [
      { pattern = "*.kurocyber.com/private/*", script = "other" },
      { pattern = "*.kurocyber.com/admin/*", script = "moqesh" },
      { pattern = "*kurocyber.com/other/*", script = "other" },
    ]
  }

  assert {
    condition = (
      contains(output.overlapping_routes, "*.kurocyber.com/private/* (other)") &&
      contains(output.overlapping_routes, "*.kurocyber.com/admin/* (moqesh)") &&
      contains(output.overlapping_routes, "*kurocyber.com/other/* (other)")
    )
    error_message = "Narrow wildcard routes must be reported regardless of their Worker."
  }
}

run "unrelated_host_does_not_conflict" {
  command = plan

  variables {
    target_hostnames = ["staging.kurocyber.com"]
    worker_name      = "moqesh"
    existing_routes = [
      { pattern = "other.kurocyber.com/*", script = "other" },
      { pattern = "*.notkurocyber.com/private/*", script = "other" },
    ]
  }

  assert {
    condition     = length(output.overlapping_routes) == 0
    error_message = "Unrelated exact and wildcard routes must not conflict."
  }
}

run "owned_exact_host_does_not_conflict" {
  command = plan

  variables {
    target_hostnames = ["staging.kurocyber.com"]
    worker_name      = "moqesh"
    existing_routes  = [{ pattern = "staging.kurocyber.com/*", script = "moqesh" }]
  }

  assert {
    condition     = length(output.overlapping_routes) == 0
    error_message = "A route already owned by the configured Worker must not conflict."
  }
}
