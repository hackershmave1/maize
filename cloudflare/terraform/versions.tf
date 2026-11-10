terraform {
  required_version = ">= 1.10.0"

  cloud {}

  required_providers {
    cloudflare = {
      source  = "cloudflare/cloudflare"
      version = "= 5.28.1"
    }
  }
}

provider "cloudflare" {}
