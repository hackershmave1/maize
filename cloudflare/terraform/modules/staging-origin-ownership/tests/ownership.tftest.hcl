variables {
  enabled               = true
  installation_id       = "test-installation"
  account_id            = "11111111111111111111111111111111"
  existing_script_names = []
  existing_sources      = []
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

run "disabled_skips_collision_read" {
  command = plan

  variables {
    enabled               = false
    existing_script_names = [run.stable_installation_name.worker_name]
    existing_sources      = ["export default {};"]
  }

  assert {
    condition     = output.safe && !output.read_existing_script
    error_message = "Disabled staging must be safe and must not request a collision source read."
  }
}

run "first_creation_ignores_other_names" {
  command = plan

  variables {
    existing_script_names = ["production-origin", "moqesh-staging-origin-other"]
  }

  assert {
    condition     = output.safe && !output.read_existing_script
    error_message = "Without an exact-name collision, first creation must be safe without a source read."
  }
}

run "unowned_collision_blocks_upload" {
  command = plan

  variables {
    existing_script_names = [run.stable_installation_name.worker_name]
    existing_sources      = ["export default {};"]
  }

  assert {
    condition     = !output.safe && output.read_existing_script
    error_message = "An exact-name script without the ownership marker must block upload."
  }
}

run "owned_collision_allows_reuse" {
  command = plan

  variables {
    existing_script_names = [run.stable_installation_name.worker_name]
    existing_sources      = ["// ${run.stable_installation_name.owner_marker}\nexport default {};"]
  }

  assert {
    condition     = output.safe && output.read_existing_script
    error_message = "An exact-name script with this installation's marker must allow reuse."
  }

  assert {
    condition     = output.owner_marker == "moqesh-staging-origin-owner:${sha256("11111111111111111111111111111111:test-installation")}"
    error_message = "Uploaded source must use the same stable installation marker as the guard."
  }
}

run "different_owner_blocks_upload" {
  command = plan

  variables {
    existing_script_names = [run.stable_installation_name.worker_name]
    existing_sources      = ["// ${run.different_installation_name_is_isolated.owner_marker}\nexport default {};"]
  }

  assert {
    condition     = !output.safe
    error_message = "Another installation's marker must not permit overwrite."
  }
}

run "missing_collision_source_fails_closed" {
  command = plan

  variables {
    existing_script_names = [run.stable_installation_name.worker_name]
  }

  assert {
    condition     = !output.safe && output.read_existing_script
    error_message = "A collision must not pass before its source is read."
  }
}

run "null_collision_source_fails_closed" {
  command = plan

  variables {
    existing_script_names = [run.stable_installation_name.worker_name]
    existing_sources      = [null]
  }

  assert {
    condition     = !output.safe
    error_message = "A missing provider source value must fail closed."
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
