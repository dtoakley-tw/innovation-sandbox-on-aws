variable "environment" {
  type        = string
  description = "The environment name used in role names"
}

variable "github_repository" {
  type        = string
  description = "GitHub repository allowed to assume the deployer role, in owner/name form"
}

variable "github_ref" {
  type        = string
  description = "Git ref allowed to assume the deployer role, e.g. refs/heads/main"
}

variable "create_oidc_provider" {
  type        = bool
  description = "Create the GitHub OIDC provider in this account. Set to false if it already exists."
  default     = true
}
