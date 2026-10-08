# Alpha deployment checklist

This checklist covers the work done outside the source code to deploy the alpha environment. It extends the official [prerequisites](https://docs.aws.amazon.com/solutions/latest/innovation-sandbox-on-aws/prerequisites.html) with the steps this repository needed. Work through it in order.

Status key: `[x]` done, `[ ]` to do, `[~]` in progress or unverified.

## 1. Accounts and organization

- [x] Org Management account (`550338945322`), with AWS Organizations and IAM Identity Center enabled in `us-east-1`
- [x] Hub account (`389939694208`), a member of the organization, dedicated to ISB
- [x] IDC account (`673926694882`), a member of the organization
- [x] Identity Center instance `ssoins-7223ae68bcd814b4` (confirm this matches `SSO_INSTANCE_ARN` in `.env.alpha`)

## 2. Organization-level settings (Org Management account)

Run these once, as an Org Management admin.

- [x] **Service control policies enabled** on the root (`r-kzs8`). The AccountPool stack fails with "This operation can be performed only for enabled policy types" without it.

  ```sh
  aws organizations enable-policy-type --root-id r-kzs8 --policy-type SERVICE_CONTROL_POLICY
  ```

- [x] **RAM sharing with AWS Organizations enabled.** The AccountPool stack shares the config parameter with the Hub account. It fails with "can only be shared within your AWS Organization" without it.

  ```sh
  aws ram enable-sharing-with-aws-organization
  ```

- [x] **Trusted access for CloudFormation StackSets enabled.** The AccountPool stack creates a service-managed StackSet.

  ```sh
  aws organizations enable-aws-service-access \
    --service-principal member.org.stacksets.cloudformation.amazonaws.com
  ```

- [x] **IDC account registered as the Identity Center delegated administrator.** The IDC stack calls `sso:*` and `identitystore:*` from the IDC account.

  ```sh
  aws organizations register-delegated-administrator \
    --account-id 673926694882 \
    --service-principal sso.amazonaws.com
  ```

- [ ] **Cost Explorer enabled** in the Org Management account, per the official prerequisites. It takes about 24 hours to take effect, so enable it early.

Verify the service settings with:

```sh
aws organizations list-aws-service-access-for-organization
aws organizations list-delegated-administrators --service-principal sso.amazonaws.com
```

## 3. Hub account service quotas

- [ ] **Lambda concurrent executions raised to at least 1000** in `us-east-1`. The Compute stack reserves concurrency across about 15 functions, and the account's default limit is too low to fit them. The docs require at least 1000.

  ```sh
  aws lambda get-account-settings --region us-east-1 \
    --query 'AccountLimit.ConcurrentExecutions'
  ```

  Request the increase in **Service Quotas → AWS Lambda → Concurrent executions**.

- [ ] **Amazon SES production access** in the Hub account. The docs say the solution rejects the notification sender address until it's a verified identity in SES. Request production access, then verify the sender domain or address.

## 4. IAM Identity Center SAML application

Create this in the Identity Center console, in the home Region.

- [x] Custom SAML 2.0 application named `isb-saml`, assigned to `isb-admin`
- [x] Copy the **IAM Identity Center SAML metadata URL** from the application configuration page into `SAML_METADATA_URL` in `.env.alpha`
- [ ] **After the Data stack deploys:** replace the placeholder ACS URL and SAML audience with the `CognitoAcsUrl` and `CognitoAudience` outputs from the Data stack. See [Update the SAML application configuration](https://docs.aws.amazon.com/solutions/latest/innovation-sandbox-on-aws/update-saml-app-config.html).

## 5. Credentials and secrets (GitHub)

GitHub secrets hold the credentials for the bootstrap workflow only. The deploy workflow uses OIDC and needs no stored secrets.

| Secret | Used by | Notes |
|---|---|---|
| `ORG_MGT_AWS_ACCESS_KEY_ID`, `ORG_MGT_AWS_SECRET_ACCESS_KEY`, `ORG_MGT_AWS_SESSION_TOKEN` | `bootstrap-infra` | Org Management account. Also hosts the state bucket. |
| `IDC_AWS_ACCESS_KEY_ID`, `IDC_AWS_SECRET_ACCESS_KEY`, `IDC_AWS_SESSION_TOKEN` | `bootstrap-infra`, `cdk-bootstrap` | IDC account |
| `HUB_AWS_ACCESS_KEY_ID`, `HUB_AWS_SECRET_ACCESS_KEY`, `HUB_AWS_SESSION_TOKEN` | `bootstrap-infra`, `cdk-bootstrap` | Hub account |

- [x] Secrets added for all three accounts
- [ ] **Session tokens refreshed before each bootstrap run.** They expire within hours.
- [ ] **Stored secrets removed** once `bootstrap-infra` and `cdk-bootstrap` assume an OIDC bootstrap role. See [oidc-bootstrap-role.md](../improvements/oidc-bootstrap-role.md).

## 6. Bootstrap and deployer roles

These run from the `bootstrap-infra` workflow on `main`.

- [x] OpenTofu state bucket `sandbox-infra-opentofu-alpha-us-east-1` created in `us-east-1`
- [x] Deployer roles (`alpha_isb_deployer`) and GitHub OIDC providers created in the Org Management, IDC, and Hub accounts
- [x] CDK bootstrapped (`CDKToolkit`) in `us-east-1` in each of the three accounts
- [ ] **Old state bucket `sandbox-infra-opentofu-alpha` deleted** in `us-west-2`, after confirming the new bucket works
- [ ] **Old `CDKToolkit` stacks in `us-west-2` deleted** in each account

## 7. Environment settings

- [x] `.env.alpha` filled in and committed, with the `NAMESPACE` set to `isbalpha`. The namespace must be 3 to 8 letters or digits, with no hyphens.
- [x] `DEPLOY_REGION=us-east-1`, matching the Identity Center home Region
- [x] `ACCEPT_SOLUTION_TERMS_OF_USE="Accept"`

## 8. GitHub trust for OIDC

- [x] The deployer role trust policy uses the immutable subject format, because the organization uses it:

  ```
  repo:dtoakley-tw@69360383/innovation-sandbox-on-aws@1383516308:ref:refs/heads/main
  ```

  Run `gh api repos/dtoakley-tw/innovation-sandbox-on-aws --jq '{owner_id: .owner.id, repo_id: .id}'` to check the IDs if the repository is ever moved or recreated.

## 9. Deploy

- [ ] **Compute stack deployed** after the Lambda quota is approved
- [ ] **Data stack outputs copied** into the Identity Center SAML application (step 4)
- [ ] **Post-deployment configuration** completed, following [Post-deployment configuration tasks](https://docs.aws.amazon.com/solutions/latest/innovation-sandbox-on-aws/post-deployment-configuration-tasks.html)

## Troubleshooting reference

| Symptom | Cause | Fix |
|---|---|---|
| `Parameter 'Namespace' must match pattern ^[0-9a-zA-Z]{3,8}$` | Namespace has a hyphen or is too long | Use 3 to 8 letters or digits in `.env.alpha` |
| "This operation can be performed only for enabled policy types" | SCPs not enabled on the org root | Section 2 |
| "can only be shared within your AWS Organization" | RAM sharing with Organizations not enabled | Section 2 |
| Trusted access error on the StackSet | StackSets trusted access not enabled | Section 2 |
| `Not authorized to perform sts:AssumeRoleWithWebIdentity` | The OIDC subject didn't match the trust policy | Section 8 |
| `Specified ReservedConcurrentExecutions ... below its minimum value of [10]` | Lambda concurrency limit too low | Section 3 |
| Deploy job exits 1 after "Deployment completed successfully!" | `deploy.sh` ended with a `&&` test that returned 1 | Fixed in `scripts/cdk/deploy.sh` and `destroy.sh`. Upstream fix pending. |
