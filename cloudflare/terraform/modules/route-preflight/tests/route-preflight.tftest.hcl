run "parent_wildcard_allows_staging_hosts" {
  command = plan

  variables {
    target_hostnames = ["staging.example.com", "admin-staging.example.com"]
    worker_name      = "moqesh"
    existing_routes = [
      { pattern = "*.example.com/*", script = "example-website" },
      { pattern = "https://*.example.com/*", script = "example-website" },
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
    target_hostnames = ["example.com"]
    worker_name      = "moqesh"
    existing_routes  = [{ pattern = "*.example.com/private/*", script = "other" }]
  }

  assert {
    condition     = length(output.overlapping_routes) == 0
    error_message = "A subdomain wildcard must not match the apex."
  }
}

run "foreign_exact_host_conflicts" {
  command = plan

  variables {
    target_hostnames = ["staging.example.com"]
    worker_name      = "moqesh"
    existing_routes = [
      { pattern = "staging.example.com/*", script = "other" },
      { pattern = "https://STAGING.example.com/private/*", script = "other" },
      { pattern = "staging.example.com/no-worker", script = null },
    ]
  }

  assert {
    condition = (
      contains(output.overlapping_routes, "staging.example.com/* (other)") &&
      contains(output.overlapping_routes, "https://STAGING.example.com/private/* (other)") &&
      contains(output.overlapping_routes, "staging.example.com/no-worker (<no worker>)")
    )
    error_message = "A foreign exact-host route must be reported."
  }
}

run "narrow_wildcard_conflicts" {
  command = plan

  variables {
    target_hostnames = ["staging.example.com"]
    worker_name      = "moqesh"
    existing_routes = [
      { pattern = "*.example.com/private/*", script = "other" },
      { pattern = "*.example.com/admin/*", script = "moqesh" },
      { pattern = "*example.com/other/*", script = "other" },
    ]
  }

  assert {
    condition = (
      contains(output.overlapping_routes, "*.example.com/private/* (other)") &&
      contains(output.overlapping_routes, "*.example.com/admin/* (moqesh)") &&
      contains(output.overlapping_routes, "*example.com/other/* (other)")
    )
    error_message = "Narrow wildcard routes must be reported regardless of their Worker."
  }
}

run "unrelated_host_does_not_conflict" {
  command = plan

  variables {
    target_hostnames = ["staging.example.com"]
    worker_name      = "moqesh"
    existing_routes = [
      { pattern = "other.example.com/*", script = "other" },
      { pattern = "*.notexample.com/private/*", script = "other" },
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
    target_hostnames = ["staging.example.com"]
    worker_name      = "moqesh"
    existing_routes  = [{ pattern = "staging.example.com/*", script = "moqesh" }]
  }

  assert {
    condition     = length(output.overlapping_routes) == 0
    error_message = "A route already owned by the configured Worker must not conflict."
  }
}
