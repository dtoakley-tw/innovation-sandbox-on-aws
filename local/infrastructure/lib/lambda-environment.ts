// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import type { ZodType } from "zod";

import { LOCAL_CA_CERTIFICATE_IN_TASK_ROOT } from "../../edge/dev-ca.js";
import {
  LOCAL_APP_CLIENT_ID,
  LOCAL_EDGE_PORT,
  LOCAL_JWKS_URI,
  LOCAL_NAMESPACE,
  LOCAL_REGION,
  LOCAL_USER_POOL_ID,
  localResourceNames,
  LOCALSTACK_INTERNAL_ENDPOINT,
  localTableNames,
} from "../../shared/names.js";

/**
 * The address the Lambdas load the JWKS from: the edge, by service name on the
 * compose network, over TLS. Imported from `names.ts` rather than assembled
 * here, because the certificate the edge serves carries a subjectAltName for
 * exactly the host in that URI and a second spelling of either would break the
 * handshake with an error that names neither.
 *
 * Re-exported because this name is this module's contract with the Lambdas' own
 * environment schema; a test importing it from a different file would be
 * checking that the two agree rather than that the value is right.
 */
export { LOCAL_JWKS_URI };

/** Values every API Lambda needs regardless of domain. */
const commonEnv: Record<string, string> = {
  NODE_OPTIONS: "--enable-source-maps",
  USER_AGENT_EXTRA: "InnovationSandboxLocal",
  POWERTOOLS_SERVICE_NAME: "innovation-sandbox-local",
  POWERTOOLS_TRACE_ENABLED: "false",
  AWS_XRAY_CONTEXT_MISSING: "IGNORE_ERROR",
  AWS_REGION: LOCAL_REGION,
  AWS_DEFAULT_REGION: LOCAL_REGION,
  AWS_ACCESS_KEY_ID: "test",
  AWS_SECRET_ACCESS_KEY: "test",
  // Redirects every AWS SDK v3 client to LocalStack without any code change:
  // the SDKs resolve this from process.env during client construction.
  AWS_ENDPOINT_URL: LOCALSTACK_INTERNAL_ENDPOINT,
  COGNITO_USER_POOL_ID: LOCAL_USER_POOL_ID,
  COGNITO_APP_CLIENT_ID: LOCAL_APP_CLIENT_ID,
  ISB_NAMESPACE: LOCAL_NAMESPACE,
  ISB_LOCAL_JWKS_URI: LOCAL_JWKS_URI,
  /**
   * The local development CA, at the artifact root, where the bundling hook
   * copies it (`local-compute-stack.ts`).
   *
   * `aws-jwt-verify@4.0.1` fetches the JWKS with `node:https.request` and
   * nothing below it reaches plain `http:`, so `ISB_LOCAL_JWKS_URI` above is
   * `https://` and the edge signs that connection with a certificate this CA
   * issued. Node reads `NODE_EXTRA_CA_CERTS` once at process start and adds the
   * file to the default root store, which is what `tls.connect` consults when
   * the client sets no `ca` of its own — so `https.request` trusts the edge
   * without a line changed under `source/`.
   *
   * Unconditional rather than conditional, because this environment is only ever
   * assembled for the local profile: the deployed stacks are built by
   * `source/infrastructure` and never see `commonEnv`.
   */
  NODE_EXTRA_CA_CERTS: LOCAL_CA_CERTIFICATE_IN_TASK_ROOT,
  CONFIG_TABLE_NAME: localTableNames.config,
  ACCOUNT_TABLE_NAME: localTableNames.sandboxAccount,
  LEASE_TABLE_NAME: localTableNames.lease,
  LEASE_TEMPLATE_TABLE_NAME: localTableNames.leaseTemplate,
  BLUEPRINT_TABLE_NAME: localTableNames.blueprint,
  PRINCIPAL_TABLE_NAME: localTableNames.principal,
  CLEANUP_REPORT_TABLE_NAME: localTableNames.cleanupReport,
  ISB_EVENT_BUS: localResourceNames.eventBus,
  ACCOUNT_POOL_CONFIG_PARAM_ARN: localResourceNames.accountPoolConfigParamArn,
  IDC_CONFIG_PARAM_ARN: localResourceNames.idcConfigParamArn,
  DATA_CONFIG_PARAM_ARN: localResourceNames.dataConfigParamArn,
  INTERMEDIATE_ROLE_ARN: localResourceNames.intermediateRoleArn,
  IDC_ROLE_ARN: localResourceNames.idcRoleArn,
  ORG_MGT_ROLE_ARN: localResourceNames.orgMgtRoleArn,
  SANDBOX_ACCOUNT_ROLE_NAME: localResourceNames.sandboxAccountRoleName,
  ORG_MGT_ACCOUNT_ID: localResourceNames.orgMgtAccountId,
  IDC_ACCOUNT_ID: localResourceNames.idcAccountId,
  HUB_ACCOUNT_ID: localResourceNames.hubAccountId,
  AWS_ACCESS_PORTAL_URL: `http://localhost:${LOCAL_EDGE_PORT}/local/unsupported/access-portal`,
};

/**
 * Variables the Lambda runtime sets itself, and which a function may therefore
 * not be *configured* with: CDK refuses to synthesize a function whose
 * environment names one of these
 * (https://docs.aws.amazon.com/lambda/latest/dg/configuration-envvars.html,
 * enforced by `Function.addEnvironment`).
 *
 * Restated in full rather than filtered down to what `commonEnv` happens to set
 * today, so the filter stays correct if a variable is added: a stale *extra*
 * entry is inert, a stale *short* list is an undeployable stack.
 *
 * They are declared in `commonEnv` above because what a Lambda sees at runtime
 * is what this function assembles, and the runtime supplies the same values — so
 * the environment the schema is validated against is complete, and the one
 * handed to CDK is deployable.
 */
const RUNTIME_RESERVED = [
  "_HANDLER",
  "_X_AMZN_TRACE_ID",
  "AWS_ACCESS_KEY",
  "AWS_ACCESS_KEY_ID",
  "AWS_DEFAULT_REGION",
  "AWS_EXECUTION_ENV",
  "AWS_LAMBDA_FUNCTION_MEMORY_SIZE",
  "AWS_LAMBDA_FUNCTION_NAME",
  "AWS_LAMBDA_FUNCTION_VERSION",
  "AWS_LAMBDA_INITIALIZATION_TYPE",
  "AWS_LAMBDA_LOG_GROUP_NAME",
  "AWS_LAMBDA_LOG_STREAM_NAME",
  "AWS_LAMBDA_RUNTIME_API",
  "AWS_REGION",
  "AWS_SECRET_ACCESS_KEY",
  "AWS_SESSION_TOKEN",
  "LAMBDA_RUNTIME_DIR",
  "LAMBDA_TASK_ROOT",
] as const;

/**
 * Assembles a Lambda environment and validates it with the domain's own
 * upstream Zod schema. Deriving the contract from the schema is what keeps the
 * local profile from drifting: when upstream adds a required variable, this
 * throws here instead of failing at request time behind an environment
 * validator error nobody can act on.
 */
export function buildLocalEnv(
  schema: ZodType,
  overrides: Record<string, string | undefined> = {},
): Record<string, string> {
  const merged: Record<string, string> = { ...commonEnv };
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) delete merged[key];
    else merged[key] = value;
  }
  const result = schema.safeParse(merged);
  if (!result.success) {
    const issues = result.error.issues
      .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
      .join("; ");
    throw new Error(
      `Local environment does not satisfy the domain schema. ${issues}`,
    );
  }
  // Return `merged`, the object just validated, rather than `result.data`: a
  // Zod object drops every key its schema does not describe, and the keys no
  // schema describes — AWS_ENDPOINT_URL, POWERTOOLS_TRACE_ENABLED — are exactly
  // the ones the AWS SDK and Powertools read from `process.env`. Projecting
  // through Zod would silently drop the redirection to LocalStack.
  //
  // Validated first, stripped second, so a schema that ever came to require a
  // reserved name fails here as a named field rather than reaching CDK, which
  // reports the same problem without saying which domain or variable led to it.
  for (const reserved of RUNTIME_RESERVED) delete merged[reserved];
  return merged;
}

/**
 * The CDK CLI process resolves its own AWS endpoints from its own environment,
 * not from the Lambda environment assembled above. `local-up.sh` exports this
 * before invoking `cdk deploy`; the constant exists so the two can never drift.
 */
export const LOCALSTACK_ENDPOINT = "http://localhost:4566";
