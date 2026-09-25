// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Every local resource name and endpoint in one place. Tasks 4, 7, 8, 9, 10, and
 * 12 import from here rather than inventing names, so a rename lands in exactly
 * one file.
 *
 * Names deliberately mirror the production CDK constructs in
 * `source/infrastructure/lib/isb-data-resources.ts` — the table count, key
 * schemas, and GSIs must match so the real Lambda stores find their tables.
 */

export const LOCAL_REGION = "us-east-1";
export const LOCAL_ACCOUNT_ID = "000000000000";
export const LOCAL_NAMESPACE = "isbdev";
export const LOCAL_USER_POOL_ID = "us-east-1_localdev";
export const LOCAL_APP_CLIENT_ID = "localdevclientid";
export const LOCAL_STAGE = "local";
export const LOCAL_EDGE_PORT = 4599;

/** The seven tables `IsbDataResources` creates, in its declaration order. */
export const LOCAL_TABLE_NAMES = [
  "sandboxAccount",
  "leaseTemplate",
  "lease",
  "blueprint",
  "principal",
  "cleanupReport",
  "config",
] as const;

export type LocalTableName = (typeof LOCAL_TABLE_NAMES)[number];

/**
 * Mirrors `IsbRoleSchema` in `source/shared/utils/auth-utils.ts`, which `local/`
 * cannot import (no `paths` mapping, and the type is not re-exported from a
 * package entry point). Restated here so a role typo in the local edge is a
 * compile error rather than a 403 that reads like an RBAC bug. `names.test.ts`
 * pins this list to the production enum so the mirror cannot drift.
 */
export const LOCAL_ROLE_NAMES = ["Admin", "Manager", "User"] as const;

export type LocalIsbRole = (typeof LOCAL_ROLE_NAMES)[number];

/** Maps each construct's table to the `*_TABLE_NAME` the Lambdas read. */
export const localTableNames: Record<LocalTableName, string> = {
  sandboxAccount: `${LOCAL_NAMESPACE}-sandbox-account`,
  leaseTemplate: `${LOCAL_NAMESPACE}-lease-template`,
  lease: `${LOCAL_NAMESPACE}-lease`,
  blueprint: `${LOCAL_NAMESPACE}-blueprint`,
  principal: `${LOCAL_NAMESPACE}-principal`,
  cleanupReport: `${LOCAL_NAMESPACE}-cleanup-report`,
  config: `${LOCAL_NAMESPACE}-config`,
};

/** A local stand-in ARN. `scope` is the trailing resource path segment. */
const localArn = (resource: string, scope: string = LOCAL_NAMESPACE) =>
  `arn:aws:${resource}:${LOCAL_REGION}:${LOCAL_ACCOUNT_ID}:local/${scope}`;

export const localResourceNames = {
  eventBus: `InnovationSandbox-${LOCAL_NAMESPACE}`,
  kmsKeyArn: localArn("kms"),
  dataConfigParamArn: `/isb/${LOCAL_NAMESPACE}/data/config`,
  idcConfigParamArn: `/isb/${LOCAL_NAMESPACE}/idc/config`,
  accountPoolConfigParamArn: `/isb/${LOCAL_NAMESPACE}/account-pool/config`,
  intermediateRoleArn: localArn("iam", "intermediate"),
  idcRoleArn: localArn("iam", "idc"),
  orgMgtRoleArn: localArn("iam", "org-mgmt"),
  sandboxAccountRoleName: "IsbSandboxAccountRole",
  orgMgtAccountId: LOCAL_ACCOUNT_ID,
  idcAccountId: LOCAL_ACCOUNT_ID,
  hubAccountId: LOCAL_ACCOUNT_ID,
} as const;

/**
 * The `config.json` payload the local edge serves. Mirrors
 * `ConfigData` in `source/frontend/src/helpers/config.ts`; that type is not
 * exported from a package entry point, so the shape is restated here and
 * pinned by `names.test.ts`.
 */
export function localEdgeConfig(): {
  ApiUrl: string;
  CognitoUserPoolId: string;
  CognitoAppClientId: string;
  CognitoIdentityPoolId: string;
  CognitoDomain: string;
  Region: string;
  AwsAccessPortalUrl: string;
  ApiGatewayHost: string;
  ApiGatewayStage: string;
} {
  return {
    ApiUrl: "/api",
    CognitoUserPoolId: LOCAL_USER_POOL_ID,
    CognitoAppClientId: LOCAL_APP_CLIENT_ID,
    CognitoIdentityPoolId: `${LOCAL_REGION}:${LOCAL_ACCOUNT_ID}`,
    // Never contacted: the local edge injects the session via libraryOptions,
    // so Amplify never performs the hosted-UI redirect. Present only because
    // `main.tsx` refuses to render unless all six Cognito fields are non-empty.
    CognitoDomain: "localdev",
    Region: LOCAL_REGION,
    AwsAccessPortalUrl: `http://localhost:${LOCAL_EDGE_PORT}/local/unsupported/access-portal`,
    ApiGatewayHost: `localhost:${LOCAL_EDGE_PORT}`,
    ApiGatewayStage: LOCAL_STAGE,
  };
}
