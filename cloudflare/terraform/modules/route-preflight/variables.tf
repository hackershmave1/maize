variable "target_hostnames" {
  type = list(string)
}

variable "worker_name" {
  type = string
}

variable "existing_routes" {
  type = list(object({
    pattern = string
    script  = string
  }))
}
