variables {
  enabled         = true
  installation_id = "test-installation"
  account_id      = "11111111111111111111111111111111"
}

run "stable_installation_name" {
  command = plan

  assert {
    condition     = output.worker_name == "moqesh-staging-origin-${substr(sha256("11111111111111111111111111111111:test-installation"), 0, 16)}"
    error_message = "The name must be derived from the account and stable installation identifier."
  }

  assert {
    condition     = length(output.worker_name) <= 63 && can(regex("^[a-z0-9][a-z0-9-]*[a-z0-9]$", output.worker_name))
    error_message = "Derived names must satisfy Cloudflare's script-name limits."
  }
}

run "same_installation_name_is_stable" {
  command = plan

  assert {
    condition     = output.worker_name == run.stable_installation_name.worker_name && output.owner_marker == run.stable_installation_name.owner_marker
    error_message = "Repeated evaluation for the same installation must keep the name and owner marker."
  }
}

run "different_installation_name_is_isolated" {
  command = plan

  variables {
    installation_id = "another-installation"
  }

  assert {
    condition     = output.worker_name != run.stable_installation_name.worker_name && output.owner_marker != run.stable_installation_name.owner_marker
    error_message = "Independent installations must not share origin names or ownership markers."
  }
}

run "different_account_name_is_isolated" {
  command = plan

  variables {
    account_id = "22222222222222222222222222222222"
  }

  assert {
    condition     = output.worker_name != run.stable_installation_name.worker_name && output.owner_marker != run.stable_installation_name.owner_marker
    error_message = "Changing accounts must produce a distinct name and ownership marker."
  }
}

run "disabled_needs_no_installation_identity" {
  command = plan

  variables {
    enabled         = false
    installation_id = ""
  }

  assert {
    condition     = output.safe
    error_message = "Disabled staging must not require an installation identity."
  }
}

run "owner_marker_matches_uploaded_source" {
  command = plan

  assert {
    condition     = output.safe
    error_message = "A nonempty installation identity must be safe to evaluate."
  }

  assert {
    condition     = output.owner_marker == "moqesh-staging-origin-owner:${sha256("11111111111111111111111111111111:test-installation")}"
    error_message = "Uploaded source must use the same stable installation marker as the guard."
  }
}

run "empty_installation_fails_closed" {
  command = plan

  variables {
    installation_id = " "
  }

  assert {
    condition     = !output.safe
    error_message = "Enabled staging must require a nonempty installation identifier."
  }
}
