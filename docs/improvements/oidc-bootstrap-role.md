# Improvement: OIDC bootstrap role to remove stored AWS credentials

Status: proposed, not implemented.

## Problem

The bootstrap workflow (`.github/workflows/bootstrap-infra.yaml`) still authenticates with long-lived or session credentials stored as GitHub secrets:

- `ORG_MGT_AWS_ACCESS_KEY_ID`, `ORG_MGT_AWS_SECRET_ACCESS_KEY`, `ORG_MGT_AWS_SESSION_TOKEN`
- `IDC_AWS_ACCESS_KEY_ID`, `IDC_AWS_SECRET_ACCESS_KEY`, `IDC_AWS_SESSION_TOKEN`
- `HUB_AWS_ACCESS_KEY_ID`, `HUB_AWS_SECRET_ACCESS_KEY`, `HUB_AWS_SESSION_TOKEN`

Session tokens expire within hours, so they have to be refreshed before every bootstrap run. Stored keys are a long-lived secret that lives outside AWS.

The deploy workflow (`deploy-stacks.yaml`) already uses OIDC and needs no stored credentials. Only the bootstrap workflow still needs them.

## Why bootstrap can't just use the deployer role

`alpha_isb_deployer` (created by `opentofu/001-deployer-roles`) can only assume the CDK bootstrap roles (`cdk-hnb659fds-*`). The bootstrap workflow needs more than that:

- `tofu apply` on `001-deployer-roles` creates OIDC providers and IAM roles in all three accounts.
- `cdk bootstrap` creates the `CDKToolkit` stack, IAM roles, an S3 asset bucket, and an SSM parameter.

So the bootstrap workflow needs a separate, higher-privilege role in each account.

## Proposed design

Add a third role per account to `opentofu/001-deployer-roles` (via the existing module, or a sibling module):

| Role | Purpose | Permissions | Trusted by |
|---|---|---|---|
| `alpha_isb_bootstrap` | Runs `tofu apply` on deployer roles and `cdk bootstrap` | Broad (effectively admin in the account) | GitHub OIDC, `refs/heads/main` only |
| `alpha_isb_deployer` | Deploys CDK stacks | Assume `cdk-hnb659fds-*` only | GitHub OIDC, `refs/heads/main` only |

Trust for `alpha_isb_bootstrap` uses the same immutable subject as the deployer role:

```
repo:dtoakley-tw@69360383/innovation-sandbox-on-aws@1383516308:ref:refs/heads/main
```

The bootstrap workflow then uses OIDC instead of stored secrets:

```yaml
permissions:
  id-token: write
  contents: read
steps:
  - uses: aws-actions/configure-aws-credentials@<sha>
    with:
      role-to-assume: arn:aws:iam::<account-id>:role/alpha_isb_bootstrap
      aws-region: us-east-1
```

Each job in the bootstrap workflow assumes the role for its own account. The `cdk-bootstrap` matrix uses the same pattern, with one role per account.

## Rollout sequence

The role can't be created without credentials, so there is one last run that uses stored session tokens:

1. **Bootstrap run with session tokens.** Add `alpha_isb_bootstrap` to `001-deployer-roles` and apply it, using the existing `ORG_MGT_`, `IDC_`, and `HUB_` session tokens.
2. **Switch the workflows to OIDC.** Update `bootstrap-infra` and `cdk-bootstrap` to assume `alpha_isb_bootstrap` per account. Keep the existing secret names until this is verified.
3. **Verify.** Run the bootstrap workflow with OIDC only. Check that the plan shows no changes and the CDK bootstrap succeeds in all three accounts.
4. **Delete the stored secrets.** Remove the `ORG_MGT_`, `IDC_`, and `HUB_` key and session-token secrets from the repository.

## Trade-offs

- **Admin-equivalent role.** The bootstrap role can create IAM roles in every account, so it is effectively admin. Its trust policy is the main control.
- **Stronger control option.** A GitHub Environment with required reviewers would make each bootstrap run wait for approval. This needs the trust subject to change to `repo:...:environment:<name>`.
- **Session tokens still exist** for the one-time step in (1). They are then deleted.
- **Traceability.** Each run assumes the role with a session name, so actions are traceable in CloudTrail.

## Open questions

- Should the bootstrap role be admin (`AdministratorAccess`) or a scoped policy? A scoped policy needs an action list for `cdk bootstrap` and the deployer-roles config.
- Should bootstrap use a GitHub Environment with required reviewers?
- Should `cdk-bootstrap` and `bootstrap-infra` share one role, or keep one role per account?

## Related cleanup

- Delete the old `sandbox-infra-opentofu-alpha` bucket in `us-west-2`.
- Delete the unused `CDKToolkit` stacks in `us-west-2`.
- Confirm that `opentofu/001-deployer-roles/.terraform/` and `opentofu/000-backend-creation/.terraform/` are not committed.
