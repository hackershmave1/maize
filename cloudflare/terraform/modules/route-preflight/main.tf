locals {
  normalized_routes = [
    for route in var.existing_routes : {
      pattern = route.pattern
      value   = trimprefix(trimprefix(lower(route.pattern), "https://"), "http://")
      script  = route.script
    }
  ]

  existing_routes = [
    for route in local.normalized_routes : {
      pattern  = route.pattern
      hostname = split("/", route.value)[0]
      path     = length(split("/", route.value)) > 1 ? "/${join("/", slice(split("/", route.value), 1, length(split("/", route.value))))}" : ""
      script   = route.script
    }
  ]

  overlapping_routes = flatten([
    for hostname in var.target_hostnames : [
      for route in local.existing_routes : "${route.pattern} (${route.script == null ? "<no worker>" : route.script})"
      if(
        (route.hostname == lower(hostname) && route.script != var.worker_name)
        || (startswith(route.hostname, "*") && route.path != "/*" && (
          startswith(route.hostname, "*.")
          ? endswith(lower(hostname), trimprefix(route.hostname, "*")) && length(hostname) > length(trimprefix(route.hostname, "*"))
          : endswith(lower(hostname), trimprefix(route.hostname, "*"))
          )
        )
      )
    ]
  ])
}
