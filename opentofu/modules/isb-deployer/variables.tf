variable "environment" {
  type        = string
  description = "The environment name used in role names"
}

variable "github_subject" {
  type        = string
  description = "Exact OIDC sub claim allowed to assume the deployer role. Uses GitHub's immutable ID format, e.g. repo:owner@ownerId/repo@repoId:ref:refs/heads/main"
}

variable "create_oidc_provider" {
  type        = bool
  description = "Create the GitHub OIDC provider in this account. Set to false if it already exists."
  default     = true
}
