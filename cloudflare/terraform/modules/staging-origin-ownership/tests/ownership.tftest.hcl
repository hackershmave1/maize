variables {
  enabled               = true
  installation_id       = "test-installation"
  worker_name           = "moqesh-staging-origin"
  existing_script_names = []
  existing_sources      = []
}

run "disabled_skips_collision_read" {
  command = plan

  variables {
    enabled               = false
    existing_script_names = ["moqesh-staging-origin"]
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
    existing_script_names = ["moqesh-staging-origin"]
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
    existing_script_names = ["moqesh-staging-origin"]
    existing_sources      = ["// moqesh-staging-origin-owner:${sha256("test-installation")}\nexport default {};"]
  }

  assert {
    condition     = output.safe && output.read_existing_script
    error_message = "An exact-name script with this installation's marker must allow reuse."
  }

  assert {
    condition     = output.owner_marker == "moqesh-staging-origin-owner:${sha256("test-installation")}"
    error_message = "Uploaded source must use the same stable installation marker as the guard."
  }
}

run "different_owner_blocks_upload" {
  command = plan

  variables {
    existing_script_names = ["moqesh-staging-origin"]
    existing_sources      = ["// moqesh-staging-origin-owner:${sha256("another-installation")}\nexport default {};"]
  }

  assert {
    condition     = !output.safe
    error_message = "Another installation's marker must not permit overwrite."
  }
}

run "missing_collision_source_fails_closed" {
  command = plan

  variables {
    existing_script_names = ["moqesh-staging-origin"]
  }

  assert {
    condition     = !output.safe && output.read_existing_script
    error_message = "A collision must not pass before its source is read."
  }
}

run "null_collision_source_fails_closed" {
  command = plan

  variables {
    existing_script_names = ["moqesh-staging-origin"]
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
