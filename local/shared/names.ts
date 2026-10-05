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

/**
 * The compose service name the Lambdas resolve the edge by, and the only host
 * in `LOCAL_JWKS_URI`. One constant for both uses, because the second is
 * derived from the first: the edge's TLS certificate carries a SAN for exactly
 * the host the Lambdas connect to, and a name spelled in two places is how a
 * profile ends up serving a certificate that validates for nothing.
 */
export const LOCAL_EDGE_SERVICE_NAME = "isb-local-edge";

/**
 * The browser's route in, and it has to stay plain HTTP: the browser reaches it
 * directly for `/session`, and a certificate here would mean a trust prompt on
 * every page load. `LOCAL_EDGE_TLS_PORT` is the other listener.
 */
export const LOCAL_EDGE_PORT = 4599;

/**
 * A second listener in the *same* edge process, serving `/.well-known/jwks.json`
 * over TLS, for the Lambdas only.
 *
 * It exists because `aws-jwt-verify@4.0.1` fetches the JWKS with
 * `node:https.request` and no code path down to plain `http:` — on an `http://`
 * URI it throws `ERR_INVALID_PROTOCOL` before a packet leaves the container, so
 * every authenticated request failed at key retrieval. Serving the same document
 * over HTTPS with a development CA the Lambda trusts via `NODE_EXTRA_CA_CERTS`
 * is the fix that needs no change under `source/`.
 *
 * Deliberately *not* published to the host in `local/compose.yaml`: nothing on
 * the host calls it, the browser has no reason to, and publishing it would put
 * a TLS endpoint on the developer's `localhost` for no benefit. Reachability is
 * the `isb-local` network, which is all the Lambdas have.
 */
export const LOCAL_EDGE_TLS_PORT = 4600;

export const LOCAL_JWKS_PATH = "/.well-known/jwks.json";

/**
 * Where the Lambdas load the JWKS from. `https`, on the TLS port above and the
 * service name above, which is what makes `ISB_LOCAL_JWKS_URI` and the
 * certificate the edge serves the same endpoint expressed twice.
 */
export const LOCAL_JWKS_URI = `https://${LOCAL_EDGE_SERVICE_NAME}:${LOCAL_EDGE_TLS_PORT}${LOCAL_JWKS_PATH}`;

/**
 * LocalStack as seen from *inside* the `isb-local` Docker network — by the
 * Lambdas it starts, and by the local edge. The service name, never
 * `localhost`: a Lambda and the edge are each their own container, so on that
 * network `localhost` means themselves and the published port is not there.
 *
 * Distinct from `LOCALSTACK_ENDPOINT` in
 * `local/infrastructure/lib/lambda-environment.ts`, which is the same service
 * as the *host* reaches it, for the CDK CLI. Both name one service, so both
 * constants live here: a second copy of either would be a profile whose
 * components disagree about where LocalStack is.
 */
export const LOCALSTACK_INTERNAL_ENDPOINT = "http://localstack:4566";

/**
 * The `sub` of the single local identity, and therefore its
 * `custom:idc_user_id` claim — `local/edge/mint-token.ts` sets both from one
 * value. It doubles as the `principalId` of the admin principal the seed
 * writes, so a request keyed on the signed-in user's own id finds that record;
 * `fixtures.test.ts` pins the two sides together.
 *
 * It is a UUID because it is an IDC principal id, not a nickname:
 * `IdcPrincipalIdSchema` requires one, and the leases API validates
 * `custom:idc_user_id` against it in `listSharedLeases`
 * (`source/lambdas/api/leases/src/smithy/lease-operations.ts:789`) *before* the
 * role gate, so any other shape is a 400 on the shared-leases query the leases
 * home page issues, and on `getGroupMembershipCache` at `:309`. Being the local
 * Admin does not reach past that check.
 *
 * Pinned rather than generated, for the same reason every other name here is:
 * the value has to be byte-identical across restarts, or a developer would sign
 * in as a principal the seeded records know nothing about. It matches the `0aaa`
 * family the seed's other principal ids are drawn from.
 */
export const LOCAL_IDC_PRINCIPAL_ID = "0aaa0000-0000-4000-8000-000000000001";

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
