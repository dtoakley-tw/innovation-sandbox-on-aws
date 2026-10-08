output "org_deployer_role_arn" {
  value = module.deployer_org.role_arn
}

output "idc_deployer_role_arn" {
  value = module.deployer_idc.role_arn
}

output "hub_deployer_role_arn" {
  value = module.deployer_hub.role_arn
}
