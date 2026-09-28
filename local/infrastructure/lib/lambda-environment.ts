// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import type { ZodType } from "zod";

import {
  LOCAL_APP_CLIENT_ID,
  LOCAL_EDGE_PORT,
  LOCAL_NAMESPACE,
  LOCAL_REGION,
  LOCAL_USER_POOL_ID,
  localResourceNames,
  localTableNames,
} from "../../shared/names.js";

/**
 * The Lambdas run inside LocalStack's Docker network, so they reach the edge by
 * service name rather than the published host port the browser uses.
 */
export const LOCAL_JWKS_URI = `http://isb-local-edge:${LOCAL_EDGE_PORT}/.well-known/jwks.json`;

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
  AWS_ENDPOINT_URL: "http://localstack:4566",
  COGNITO_USER_POOL_ID: LOCAL_USER_POOL_ID,
  COGNITO_APP_CLIENT_ID: LOCAL_APP_CLIENT_ID,
  ISB_NAMESPACE: LOCAL_NAMESPACE,
  ISB_LOCAL_JWKS_URI: LOCAL_JWKS_URI,
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
  return merged;
}

/**
 * The CDK CLI process resolves its own AWS endpoints from its own environment,
 * not from the Lambda environment assembled above. `local-up.sh` exports this
 * before invoking `cdk deploy`; the constant exists so the two can never drift.
 */
export const LOCALSTACK_ENDPOINT = "http://localhost:4566";
