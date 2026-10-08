variable "environment" {
  type        = string
  description = "The environment to work with"
}

variable "aws_region" {
  type        = string
  description = "Region for the AWS provider (IAM is global; this must still be set)"
  default     = "us-west-2"
}

variable "org_access_key_id" {
  type        = string
  description = "Access key ID for the Org Management account"
  sensitive   = true
}

variable "org_secret_access_key" {
  type        = string
  description = "Secret access key for the Org Management account"
  sensitive   = true
}

variable "idc_access_key_id" {
  type        = string
  description = "Access key ID for the IDC account"
  sensitive   = true
}

variable "idc_secret_access_key" {
  type        = string
  description = "Secret access key for the IDC account"
  sensitive   = true
}

variable "hub_access_key_id" {
  type        = string
  description = "Access key ID for the Hub account"
  sensitive   = true
}

variable "hub_secret_access_key" {
  type        = string
  description = "Secret access key for the Hub account"
  sensitive   = true
}

variable "github_repository" {
  type        = string
  description = "GitHub repository allowed to assume the deployer roles, in owner/name form"
  default     = "dtoakley-tw/innovation-sandbox-on-aws"
}

variable "github_ref" {
  type        = string
  description = "Git ref allowed to assume the deployer roles"
  default     = "refs/heads/main"
}

variable "create_oidc_provider_org" {
  type        = bool
  description = "Create the GitHub OIDC provider in the Org Management account. Set to false if it already exists."
  default     = true
}

variable "create_oidc_provider_idc" {
  type        = bool
  description = "Create the GitHub OIDC provider in the IDC account. Set to false if it already exists."
  default     = true
}

variable "create_oidc_provider_hub" {
  type        = bool
  description = "Create the GitHub OIDC provider in the Hub account. Set to false if it already exists."
  default     = true
}
