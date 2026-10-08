provider "aws" {
  alias      = "org"
  region     = var.aws_region
  access_key = var.org_access_key_id
  secret_key = var.org_secret_access_key
  token      = var.org_session_token
}

provider "aws" {
  alias      = "idc"
  region     = var.aws_region
  access_key = var.idc_access_key_id
  secret_key = var.idc_secret_access_key
  token      = var.idc_session_token
}

provider "aws" {
  alias      = "hub"
  region     = var.aws_region
  access_key = var.hub_access_key_id
  secret_key = var.hub_secret_access_key
  token      = var.hub_session_token
}
