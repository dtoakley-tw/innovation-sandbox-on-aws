module "deployer_org" {
  source = "../modules/isb-deployer"
  providers = {
    aws = aws.org
  }

  environment          = var.environment
  github_subject       = var.github_subject
  create_oidc_provider = var.create_oidc_provider_org
}

module "deployer_idc" {
  source = "../modules/isb-deployer"
  providers = {
    aws = aws.idc
  }

  environment          = var.environment
  github_subject       = var.github_subject
  create_oidc_provider = var.create_oidc_provider_idc
}

module "deployer_hub" {
  source = "../modules/isb-deployer"
  providers = {
    aws = aws.hub
  }

  environment          = var.environment
  github_subject       = var.github_subject
  create_oidc_provider = var.create_oidc_provider_hub
}
