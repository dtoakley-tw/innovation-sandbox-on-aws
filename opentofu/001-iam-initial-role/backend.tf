terraform {
  backend "s3" {
    bucket = "*WILL-BE-REPLACED-BY-WORKFLOW*"
    key    = "initial-role.tfstate"
  }
}
