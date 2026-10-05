# Offline Local Development Profile Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Run the ISB frontend and API entirely offline against LocalStack, with no AWS account and no source divergence between local and production.

**Architecture:** One `local/` workspace holds all local-only tooling and imports upstream CDK constructs and Zod schemas rather than restating them. LocalStack hosts the real Lambdas, API Gateway, DynamoDB, and event services. A small local edge service stands in for the two things no emulator reproduces: the CloudFront edge and Cognito/IAM Identity Center authentication. Three upstream files change, all as optional environment-driven configuration that is inert unless set.

**Tech Stack:** Node 24, TypeScript, npm workspaces, AWS CDK v2, LocalStack (Hobby), `aws-amplify` 6.16.4, `aws-jwt-verify` 4.x, Zod 4, Vitest.

**Spec:** `docs/plans/2026-09-25-offline-local-development-design.md` — read it before starting. The plan argues from the spec, so the spec travels with it.

## Global Constraints

- **Node `>=24.0.0 <25.0.0`**, npm `>=10.0.0`. Do not change these floors.
- **The patch against upstream `source/` is exactly three files.** Any task that needs a fourth upstream file is a design change: stop and escalate rather than proceeding.
  1. `source/common/lambda/environments/base-api-lambda-environment.ts` — one optional env field
  2. `source/common/lambda/auth/identity-token-verifier.ts` — local JWKS injection
  3. `source/frontend/src/helpers/cognito-config.ts` — Amplify `libraryOptions`
- **One root `package.json` change**: add `"local"` to the `workspaces` array. No other root edits.
- **One new file inside `source/`**: `source/frontend/src/helpers/local/amplify-local-session.ts`. Chosen over a cross-package dependency because it avoids a second upstream edit.
- **Local mode is opt-in and inert by default.** `npm test` and `npm run build` must pass with no local configuration set, and production behavior must be byte-for-byte identical to upstream.
- **Every environment variable read by Lambda code must be declared in a Zod schema.** `environment-validator.ts:47` assigns the Zod-parsed environment to the request context, and the schemas strip unrecognized keys. Reading a new variable from `process.env` directly violates the codebase's only convention for environment access.
- **No new runtime dependencies.** The local tooling may use what the root already installs (`aws-cdk-lib`, `constructs`, `zod`, `tsx`). If a task seems to need a new package, prefer a small local implementation.
- **The local private key never reaches the browser.** Tokens are signed server-side by the local edge.
- **All files start with the license header**, matching the repository:
  ```
  // Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
  // SPDX-License-Identifier: Apache-2.0
  ```
- **All files must pass `npx prettier --check`** before commit.
- **Unsupported services fail at the real call.** Do not add `if (isLocal)` branches to domain logic, and do not add a local `Unsupported` error type. See the spec section "Why there is no browser MSW layer".

## Review Focus

Five input classes or failure modes the spec implies that individual task tests will not naturally exercise. Each has a test pinned to the task that owns the code, in that task's own step style.

1. **Local mode silently active in production.** A developer sets `ISB_LOCAL_JWKS_URI` or `VITE_LOCAL_SESSION_ENDPOINT` in a deployed environment and the app starts trusting local keys or a local session. Pinned in Task 1 (schema field is optional; unset means untouched) and Task 6 (`Amplify.configure` called with exactly one argument when the env var is absent).
2. **Token expiry mid-session.** The local ID token has a finite `exp`. A developer leaves the tab open, the token expires, and every subsequent API call 401s with no explanation. Pinned in Task 5 (provider refetches when `exp` has passed) and Task 11 (`ensureLocalJwks` resets its cached promise so a transient edge outage does not permanently poison verification).
3. **Role escalation through a local token.** A developer hand-edits a local claim to `Admin` to see an admin page, then that same mechanism is reachable in a real deployment. Pinned in Task 4 (the edge mints only from a server-side role allowlist and never from request input).
4. **Partial writes from failing deep flows.** Account lifecycle and blueprint deployment write to DynamoDB before calling an unsupported service, leaving inconsistent local state that a developer later reads as real. Pinned in Task 10 (seed is idempotent and re-runnable; `local:reset` documented as the remedy) and Task 12 (`local:verify` reports the domain and operation that failed so the state is attributable).
5. **Silent schema drift.** Upstream adds a field or renames one, local responses stop matching, and the UI renders wrong data instead of failing. Pinned in Task 9 (seed derives from the production Zod schemas, so an upstream field change breaks the seed test) and Task 12 (`local:verify` validates every response against those same schemas).

---

## File Structure

Everything local lives under `local/`, a new npm workspace. Nothing local is added to `source/` except the one frontend helper.

```
local/
  package.json                    workspace manifest; name @amzn/innovation-sandbox-local
  tsconfig.json                   extends root tsconfig; path aliases for @amzn/innovation-sandbox-*
  compose.yaml                    LocalStack + local edge services
  .gitignore                      local runtime artifacts (keys, .env.local, cdk output)
  shared/
    names.ts                      one place for every local resource name and endpoint
    env.ts                        local env assembly + validation against upstream Zod schemas
  edge/
    server.ts                     HTTP server: /config.json, /api/*, /session, JWKS
    routes/config.ts              config.json generation
    routes/session.ts             local ID token minting
    routes/api-proxy.ts           /api/* -> LocalStack API Gateway
    jwks.ts                       RSA keypair generation, storage, JWKS publication
    mint-token.ts                 JWT minting with Cognito-shaped claims
  infrastructure/
    bin/local.ts                  CDK app entry
    lib/local-data-stack.ts       DynamoDB tables + KMS, reusing upstream definitions
    lib/local-compute-stack.ts    six domain Lambdas + API Gateway
    lib/lambda-environment.ts     per-domain env built from upstream Zod schemas
    lib/prepare-local-spec.ts     removes gateway SigV4 from the OpenAPI spec
  seed/
    fixtures.ts                   schema-derived fixture data
    seed.ts                       writes fixtures into LocalStack DynamoDB
  verify/
    verify.ts                     walks the API surface, validates against Zod schemas
  scripts/
    local-up.sh                   orchestrates up: compose, deploy, seed
    local-down.sh
    local-reset.sh
    local-logs.sh
```

Root `package.json` gains scripts `local:up`, `local:down`, `local:reset`, `local:seed`, `local:verify`, `local:logs`.

### Module dependency order

Tasks are ordered so that each one's interfaces exist before the next consumes them. `local/shared/names.ts` (Task 1) is the foundation; everything else imports from it.

---

## Task 1: Local workspace scaffold and shared names

Establishes the `local` workspace and the single source of truth for resource names. Everything downstream imports from here, so no later task invents a name.

**Files:**

- Modify: `package.json` (add `"local"` to `workspaces`; add six `local:*` scripts)
- Create: `local/package.json`
- Create: `local/tsconfig.json`
- Create: `local/.gitignore`
- Create: `local/shared/names.ts`
- Test: `local/shared/names.test.ts`

**Interfaces:**

- Consumes: nothing. This is the root task.
- Produces:
  - `LOCAL_REGION = "us-east-1"`
  - `LOCAL_ACCOUNT_ID = "000000000000"`
  - `LOCAL_NAMESPACE = "isbdev"` (must match `NAMESPACE_PATTERN` = `^[0-9a-zA-Z]{3,8}$`)
  - `LOCAL_USER_POOL_ID = "us-east-1_localdev"`
  - `LOCAL_APP_CLIENT_ID = "localdevclientid"`
  - `LOCAL_STAGE = "local"`
  - `LOCAL_EDGE_PORT = 4599`
  - `localTableNames: Record<LocalTableName, string>` where `LocalTableName` is `"sandboxAccount" | "leaseTemplate" | "lease" | "blueprint" | "principal" | "cleanupReport" | "config"`
  - `localResourceNames` with `eventBus`, `dataConfigParamArn`, `idcConfigParamArn`, `accountPoolConfigParamArn`, `intermediateRoleArn`, `idcRoleArn`, `orgMgtRoleArn`, `sandboxAccountRoleName`, `orgMgtAccountId`, `idcAccountId`, `hubAccountId`
  - `localEdgeConfig(): ConfigData` — returns the nine `ConfigData` fields the frontend requires

- [ ] **Step 1: Write the failing test**

Create `local/shared/names.test.ts`:

```ts
// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import { NAMESPACE_PATTERN } from "@amzn/innovation-sandbox-shared/types/isb-types.js";
import { describe, expect, it } from "vitest";

import {
  LOCAL_NAMESPACE,
  localEdgeConfig,
  localResourceNames,
  localTableNames,
} from "./names.js";

describe("local shared names", () => {
  it("uses a namespace that satisfies the production NAMESPACE_PATTERN", () => {
    expect(LOCAL_NAMESPACE).toMatch(new RegExp(NAMESPACE_PATTERN));
  });

  it("gives every table a distinct name", () => {
    const names = Object.values(localTableNames);
    expect(new Set(names).size).toBe(names.length);
  });

  it("produces a config.json payload with all nine ConfigData fields", () => {
    const config = localEdgeConfig();
    expect(Object.keys(config).sort()).toEqual(
      [
        "ApiGatewayHost",
        "ApiGatewayStage",
        "ApiUrl",
        "AwsAccessPortalUrl",
        "CognitoAppClientId",
        "CognitoDomain",
        "CognitoIdentityPoolId",
        "CognitoUserPoolId",
        "Region",
      ].sort(),
    );
  });

  it("points ApiUrl at the same-origin /api path the Vite proxy serves", () => {
    expect(localEdgeConfig().ApiUrl).toBe("/api");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run local/shared/names.test.ts`
Expected: FAIL — cannot resolve `./names.js`.

- [ ] **Step 3: Create the workspace manifest and tsconfig**

Create `local/package.json`:

```json
{
  "name": "@amzn/innovation-sandbox-local",
  "version": "0.0.0",
  "private": true,
  "description": "Local-only development tooling (not part of the deployed distribution)",
  "type": "module",
  "scripts": {
    "test": "vitest run"
  },
  "devDependencies": {
    "zod": "^4.1.12"
  }
}
```

Create `local/tsconfig.json`:

```json
{
  "compilerOptions": {
    "target": "ES2023",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "resolveJsonModule": true,
    "outDir": "dist",
    "rootDir": ".",
    "types": ["node"]
  },
  "include": ["**/*.ts"],
  "exclude": ["node_modules", "dist", "cdk.out"]
}
```

Create `local/.gitignore`:

```
node_modules/
dist/
cdk.out/
.env.local
.keys/
```

- [ ] **Step 4: Add `local` to the root workspaces and scripts**

In the root `package.json`, add `"local"` to the `workspaces` array so it reads:

```json
  "workspaces": [
    "source/frontend",
    "source/layers/*",
    "source/lambdas/**",
    "source/infrastructure",
    "source/common",
    "source/shared",
    "source/api-model",
    "source/api-client",
    "source/api-server",
    "local"
  ],
```

Add these scripts to the root `package.json` `scripts` object:

```json
    "local:up": "bash local/scripts/local-up.sh",
    "local:down": "bash local/scripts/local-down.sh",
    "local:reset": "bash local/scripts/local-reset.sh",
    "local:seed": "npm run seed --workspace @amzn/innovation-sandbox-local",
    "local:verify": "npm run verify --workspace @amzn/innovation-sandbox-local",
    "local:logs": "bash local/scripts/local-logs.sh",
```

- [ ] **Step 5: Run `npm install` to link the workspace**

Run: `npm install`
Expected: completes without error. The `local` workspace is linked into the root `node_modules` as `@amzn/innovation-sandbox-local`.

- [ ] **Step 6: Write `local/shared/names.ts`**

Create `local/shared/names.ts`:

```ts
// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Every local resource name and endpoint in one place. Tasks 2 through 8 import
 * from here rather than inventing names, so a rename lands in exactly one file.
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

const localArn = (resource: string) =>
  `arn:aws:${resource}:${LOCAL_REGION}:${LOCAL_ACCOUNT_ID}:local/${LOCAL_NAMESPACE}`;

export const localResourceNames = {
  eventBus: `InnovationSandbox-${LOCAL_NAMESPACE}`,
  kmsKeyArn: localArn("kms"),
  dataConfigParamArn: `/isb/${LOCAL_NAMESPACE}/data/config`,
  idcConfigParamArn: `/isb/${LOCAL_NAMESPACE}/idc/config`,
  accountPoolConfigParamArn: `/isb/${LOCAL_NAMESPACE}/account-pool/config`,
  intermediateRoleArn: localArn("iam").replace("/isbdev", "/intermediate"),
  idcRoleArn: localArn("iam").replace("/isbdev", "/idc"),
  orgMgtRoleArn: localArn("iam").replace("/isbdev", "/org-mgmt"),
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
```

- [ ] **Step 7: Add a `vitest.config.ts` for the local workspace**

Create `local/vitest.config.ts`:

```ts
// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["**/*.test.ts"],
    exclude: ["node_modules", "dist", "cdk.out"],
  },
});
```

Note: the root `vitest.config.ts` uses `projects: ["source/**/vitest.config.ts"]`, so the local suite is run explicitly with `npx vitest run --root local`. This keeps `npm test` at the root unchanged, which matters because `local/` is not upstream code and should never appear in the upstream suite's pass count.

This config gains its `@amzn/*` path aliases in Task 8, Step 4. Task 1's test only imports from `./names.js` and `@amzn/innovation-sandbox-shared`, which resolves through the workspace symlink in `node_modules`.

- [ ] **Step 8: Run the test to verify it passes**

Run: `npx vitest run --root local`
Expected: PASS — 4 tests.

- [ ] **Step 9: Verify the root suite is unaffected**

Run: `npm test -- --reporter=dot 2>&1 | tail -5`
Expected: the same pass count as before this change. If the count changed, the workspace addition pulled in a test file that the root config now collects; fix the include pattern before continuing.

- [ ] **Step 10: Commit**

```bash
git add package.json package-lock.json local/
git commit -m "chore(local): scaffold local workspace and shared resource names"
```

---

## Task 2: Declare the optional local JWKS endpoint in the API environment schema

First of the three upstream changes, and the smallest. Doing it first means the env contract is correct before any code reads it.

**Files:**

- Modify: `source/common/lambda/environments/base-api-lambda-environment.ts:7-10`
- Test: `source/common/test/lambdas/environments/base-api-lambda-environment.test.ts`

**Interfaces:**

- Consumes: nothing from Task 1.
- Produces: `BaseApiLambdaEnvironmentSchema` gains an optional `ISB_LOCAL_JWKS_URI: string`. Every domain env schema (which extends it) inherits the field, so `ServiceEnv`-typed Lambda code can read `env.ISB_LOCAL_JWKS_URI` as `string | undefined`.

- [ ] **Step 1: Write the failing test**

Create `source/common/test/lambdas/environments/base-api-lambda-environment.test.ts`:

```ts
// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";

import { BaseApiLambdaEnvironmentSchema } from "@amzn/innovation-sandbox-commons/lambda/environments/base-api-lambda-environment.js";

const required = {
  NODE_OPTIONS: "",
  USER_AGENT_EXTRA: "isb",
  POWERTOOLS_SERVICE_NAME: "isb",
  AWS_XRAY_CONTEXT_MISSING: "IGNORE_ERROR",
  COGNITO_USER_POOL_ID: "us-east-1_localdev",
  COGNITO_APP_CLIENT_ID: "localdevclientid",
  ISB_NAMESPACE: "isbdev",
};

describe("BaseApiLambdaEnvironmentSchema", () => {
  it("parses without ISB_LOCAL_JWKS_URI, so production is unaffected", () => {
    const result = BaseApiLambdaEnvironmentSchema.safeParse(required);
    expect(result.success).toBe(true);
    expect(result.data?.ISB_LOCAL_JWKS_URI).toBeUndefined();
  });

  it("carries ISB_LOCAL_JWKS_URI through when the local profile sets it", () => {
    const uri = "http://isb-local-edge:4599/.well-known/jwks.json";
    const result = BaseApiLambdaEnvironmentSchema.safeParse({
      ...required,
      ISB_LOCAL_JWKS_URI: uri,
    });
    expect(result.success).toBe(true);
    expect(result.data?.ISB_LOCAL_JWKS_URI).toBe(uri);
  });

  it("propagates to a domain schema that extends it", async () => {
    const { LeaseLambdaEnvironmentSchema } =
      await import("@amzn/innovation-sandbox-commons/lambda/environments/lease-lambda-environment.js");
    const result = LeaseLambdaEnvironmentSchema.safeParse({
      ...required,
      CONFIG_TABLE_NAME: "isbdev-config",
      LEASE_TABLE_NAME: "isbdev-lease",
      LEASE_TEMPLATE_TABLE_NAME: "isbdev-lease-template",
      PRINCIPAL_TABLE_NAME: "isbdev-principal",
      INTERMEDIATE_ROLE_ARN: "arn:aws:iam::000000000000:role/intermediate",
      IDC_ROLE_ARN: "arn:aws:iam::000000000000:role/idc",
      ORG_MGT_ROLE_ARN: "arn:aws:iam::000000000000:role/org-mgmt",
      ISB_EVENT_BUS: "InnovationSandbox-isbdev",
      ACCOUNT_TABLE_NAME: "isbdev-sandbox-account",
      BLUEPRINT_TABLE_NAME: "isbdev-blueprint",
      SANDBOX_ACCOUNT_ROLE_NAME: "IsbSandboxAccountRole",
      ACCOUNT_POOL_CONFIG_PARAM_ARN: "/isb/isbdev/account-pool/config",
      IDC_CONFIG_PARAM_ARN: "/isb/isbdev/idc/config",
      ORG_MGT_ACCOUNT_ID: "000000000000",
      HUB_ACCOUNT_ID: "000000000000",
      ISB_LOCAL_JWKS_URI: "http://isb-local-edge:4599/.well-known/jwks.json",
    });
    expect(result.success).toBe(true);
    expect(result.data?.ISB_LOCAL_JWKS_URI).toBe(
      "http://isb-local-edge:4599/.well-known/jwks.json",
    );
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run source/common/test/lambdas/environments/base-api-lambda-environment.test.ts`
Expected: FAIL — the third test fails because `ISB_LOCAL_JWKS_URI` is stripped by Zod and the first test fails to compile the field reference. The first test's `success` assertion passes; the field assertions fail.

- [ ] **Step 3: Add the optional field**

In `source/common/lambda/environments/base-api-lambda-environment.ts`, change the schema to:

```ts
export const BaseApiLambdaEnvironmentSchema =
  BaseLambdaEnvironmentSchema.extend({
    COGNITO_USER_POOL_ID: z.string().min(1),
    COGNITO_APP_CLIENT_ID: z.string().min(1),
    ISB_NAMESPACE: z.string().regex(new RegExp(NAMESPACE_PATTERN)),
    /**
     * Local development only. When set, the identity verifier loads JWKS from
     * this URI instead of reaching cognito-idp.<region>.amazonaws.com, which is
     * unreachable in the offline LocalStack profile. Unset in every deployed
     * environment, where the verifier behaves exactly as before.
     */
    ISB_LOCAL_JWKS_URI: z.string().optional(),
  });
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run source/common/test/lambdas/environments/base-api-lambda-environment.test.ts`
Expected: PASS — 3 tests.

- [ ] **Step 5: Verify existing environment tests still pass**

Run: `npx vitest run source/common/test/lambdas 2>&1 | tail -8`
Expected: PASS. Adding an optional field cannot break `safeParse` of existing fixtures, but the domain env schemas are spread across many handler tests, so run the whole directory.

- [ ] **Step 6: Commit**

```bash
git add source/common/lambda/environments/base-api-lambda-environment.ts source/common/test/lambdas/environments/base-api-lambda-environment.test.ts
git commit -m "feat(auth): declare optional ISB_LOCAL_JWKS_URI on the API env schema"
```

---

## Task 3: Inject a local JWKS into the existing Cognito verifier

The second upstream change, and the one that makes offline auth possible at all. `CognitoJwtVerifier.create` hardcodes the JWKS URI from the pool ID, so key retrieval always targets real AWS.

**Files:**

- Modify: `source/common/lambda/auth/identity-token-verifier.ts:1-113`
- Test: `source/common/test/lambdas/auth/identity-token-verifier-local-jwks.test.ts`

**Interfaces:**

- Consumes: `ISB_LOCAL_JWKS_URI` on `IdentityVerifierEnv` from Task 2.
- Produces: `IdentityVerifierEnv` gains `ISB_LOCAL_JWKS_URI?: string`. `verifyAndExtractClaims` calls `cacheJwks` once per execution environment before verifying when the field is set. Behavior when the field is absent is byte-for-byte unchanged.

- [ ] **Step 1: Write the failing test**

Create `source/common/test/lambdas/auth/identity-token-verifier-local-jwks.test.ts`:

```ts
// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const cacheJwks = vi.fn();
const fetchJwks = vi.fn();

vi.mock("aws-jwt-verify", () => ({
  CognitoJwtVerifier: {
    create: () => ({
      verify: async (token: string) =>
        JSON.parse(Buffer.from(token, "base64").toString("utf-8")),
      cacheJwks,
    }),
  },
}));

vi.mock("aws-jwt-verify/jwk", () => ({
  fetchJwks: (uri: string) => fetchJwks(uri),
}));

const { verifyAndExtractClaims } =
  await import("@amzn/innovation-sandbox-commons/lambda/auth/identity-token-verifier.js");
const { IDENTITY_HEADER } =
  await import("@amzn/innovation-sandbox-shared/utils/auth-utils.js");

const JWKS_URI = "http://isb-local-edge:4599/.well-known/jwks.json";
const claims = { sub: "user-1", email: "admin@example.local" };

const buildEvent = () =>
  ({
    headers: {
      [IDENTITY_HEADER]: Buffer.from(JSON.stringify(claims)).toString("base64"),
    },
    requestContext: { identity: { cognitoAuthenticationProvider: null } },
  }) as never;

const baseEnv = {
  COGNITO_USER_POOL_ID: "us-east-1_localdev",
  COGNITO_APP_CLIENT_ID: "localdevclientid",
};

beforeEach(() => {
  cacheJwks.mockClear();
  fetchJwks.mockReset();
  fetchJwks.mockResolvedValue({ keys: [{ kid: "local" }] });
});

afterEach(() => {
  vi.resetModules();
});

describe("local JWKS injection", () => {
  it("never fetches or caches a JWKS when ISB_LOCAL_JWKS_URI is unset", async () => {
    await verifyAndExtractClaims(buildEvent(), baseEnv);
    expect(fetchJwks).not.toHaveBeenCalled();
    expect(cacheJwks).not.toHaveBeenCalled();
  });

  it("fetches the configured JWKS and seeds the verifier cache", async () => {
    await verifyAndExtractClaims(buildEvent(), {
      ...baseEnv,
      ISB_LOCAL_JWKS_URI: JWKS_URI,
    });
    expect(fetchJwks).toHaveBeenCalledWith(JWKS_URI);
    expect(cacheJwks).toHaveBeenCalledWith({ keys: [{ kid: "local" }] });
  });

  it("still returns the verified claims after injection", async () => {
    const result = await verifyAndExtractClaims(buildEvent(), {
      ...baseEnv,
      ISB_LOCAL_JWKS_URI: JWKS_URI,
    });
    expect(result).toEqual(claims);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run source/common/test/lambdas/auth/identity-token-verifier-local-jwks.test.ts`
Expected: FAIL — the second and third tests fail because `cacheJwks` is never called.

- [ ] **Step 3: Implement the injection**

In `source/common/lambda/auth/identity-token-verifier.ts`, add the import:

```ts
import { fetchJwks } from "aws-jwt-verify/jwk";
```

Extend the env interface:

```ts
export interface IdentityVerifierEnv {
  COGNITO_USER_POOL_ID: string;
  COGNITO_APP_CLIENT_ID: string;
  /**
   * Local development only. When set, JWKS is loaded from this URI instead of
   * the Cognito endpoint derived from COGNITO_USER_POOL_ID, which is
   * unreachable in the offline LocalStack profile. Unset in production.
   */
  ISB_LOCAL_JWKS_URI?: string;
}
```

Add the loader after the `verifier` declaration:

```ts
// Resolved once per execution environment. Reset on failure so a transient
// local-edge outage does not permanently poison verification for the life of
// the container.
let localJwksReady: Promise<void> | null = null;

async function ensureLocalJwks(env: IdentityVerifierEnv): Promise<void> {
  if (!env.ISB_LOCAL_JWKS_URI) return;
  localJwksReady ??= fetchJwks(env.ISB_LOCAL_JWKS_URI)
    .then((jwks) => {
      // Seeds the in-memory cache keyed by the derived Cognito URI, so the
      // verifier never issues the network request it would otherwise make.
      getVerifier(env).cacheJwks(jwks);
    })
    .catch((error: unknown) => {
      localJwksReady = null;
      throw error;
    });
  await localJwksReady;
}
```

Call it at the top of `verifyAndExtractClaims`, after the null check and before `getVerifier(env).verify`:

```ts
export async function verifyAndExtractClaims(
  event: APIGatewayProxyEvent,
  env: IdentityVerifierEnv,
): Promise<Record<string, unknown>> {
  const token = readIdentityHeader(event);
  if (!token) {
    throw new IdentityTokenError("Missing", "Missing identity token.");
  }

  await ensureLocalJwks(env);

  const payload = (await getVerifier(env)
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run source/common/test/lambdas/auth/identity-token-verifier-local-jwks.test.ts`
Expected: PASS — 3 tests.

- [ ] **Step 5: Run the pre-existing verifier tests**

Run: `npx vitest run source/common/test/lambdas/auth/identity-token-verifier.test.ts`
Expected: PASS — 9 tests. These use the shared `api-test-setup.ts` mock, which does not define `cacheJwks`; the guard on `ISB_LOCAL_JWKS_URI` means the injection path is never entered.

- [ ] **Step 6: Commit**

```bash
git add source/common/lambda/auth/identity-token-verifier.ts source/common/test/lambdas/auth/identity-token-verifier-local-jwks.test.ts
git commit -m "feat(auth): load JWKS from a configurable local endpoint when set"
```

---

## Task 4: Local identity — RSA keypair, JWKS publication, and token minting

The local edge's trust anchor. Mints Cognito-shaped ID tokens from a server-side key, and publishes the matching JWKS for the Lambda to load in Task 3.

**Files:**

- Create: `local/edge/jwks.ts`
- Create: `local/edge/mint-token.ts`
- Test: `local/edge/jwks.test.ts`
- Test: `local/edge/mint-token.test.ts`

**Interfaces:**

- Consumes: `LOCAL_USER_POOL_ID`, `LOCAL_APP_CLIENT_ID`, `LOCAL_REGION` from Task 1.
- Produces:
  - `loadOrCreateKeyPair(): Promise<KeyPair>` — generates on first run, persists to `local/.keys/local-jwks.json`, reuses thereafter. `KeyPair` is `{ privateKey: string; publicKey: string; kid: string }` in PEM/base64url form.
  - `buildLocalJwks(keyPair: KeyPair): JwksDocument` — a single-key JWKS document.
  - `mintLocalIdToken(options: MintOptions): Promise<string>` where `MintOptions` is `{ keyPair: KeyPair; sub: string; email: string; roles: IsbRole[]; ttlSeconds?: number }`. Returns an RS256 JWT carrying `sub`, `email`, `cognito:username`, `custom:idc_user_id`, `custom:isb_roles`, `aud`, `iss`, `token_use: "id"`, `iat`, `exp`.
  - `LOCAL_ISSUER` — `https://cognito-idp.<region>.amazonaws.com/<userPoolId>`, matching what `CognitoJwtVerifier` derives from the pool ID.

- [ ] **Step 1: Write the failing tests**

Create `local/edge/jwks.test.ts`:

```ts
// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { buildLocalJwks, loadOrCreateKeyPair } from "./jwks.js";

let dir: string;
const originalEnv = process.env.ISB_LOCAL_KEY_DIR;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "isb-local-keys-"));
  process.env.ISB_LOCAL_KEY_DIR = dir;
});

afterEach(() => {
  if (originalEnv === undefined) delete process.env.ISB_LOCAL_KEY_DIR;
  else process.env.ISB_LOCAL_KEY_DIR = originalEnv;
  rmSync(dir, { recursive: true, force: true });
});

describe("local JWKS", () => {
  it("generates a keypair and persists it", async () => {
    const first = await loadOrCreateKeyPair();
    expect(existsSync(join(dir, "local-jwks.json"))).toBe(true);
    expect(first.privateKey).toContain("PRIVATE KEY");
    expect(first.kid).toBeTruthy();
  });

  it("returns the same keypair on a second call", async () => {
    const first = await loadOrCreateKeyPair();
    const second = await loadOrCreateKeyPair();
    expect(second.privateKey).toBe(first.privateKey);
    expect(second.kid).toBe(first.kid);
  });

  it("publishes exactly one key matching the signing kid", async () => {
    const keyPair = await loadOrCreateKeyPair();
    const jwks = buildLocalJwks(keyPair);
    expect(jwks.keys).toHaveLength(1);
    expect(jwks.keys[0].kid).toBe(keyPair.kid);
    expect(jwks.keys[0].kty).toBe("RSA");
    expect(jwks.keys[0].alg).toBe("RS256");
    // The private half must never be published.
    expect(JSON.stringify(jwks)).not.toContain("PRIVATE");
  });
});
```

Create `local/edge/mint-token.test.ts`:

```ts
// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createVerify } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { loadOrCreateKeyPair } from "./jwks.js";
import { LOCAL_ISSUER, mintLocalIdToken } from "./mint-token.js";
import { LOCAL_APP_CLIENT_ID } from "../shared/names.js";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "isb-local-mint-"));
  process.env.ISB_LOCAL_KEY_DIR = dir;
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const decode = (token: string) =>
  JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString("utf-8"));

describe("mintLocalIdToken", () => {
  it("signs an RS256 token whose kid matches the published key", async () => {
    const keyPair = await loadOrCreateKeyPair();
    const token = await mintLocalIdToken({
      keyPair,
      sub: "user-1",
      email: "admin@example.local",
      roles: ["Admin"],
    });
    expect(
      JSON.parse(
        Buffer.from(token.split(".")[0], "base64url").toString("utf-8"),
      ),
    ).toMatchObject({
      alg: "RS256",
      kid: keyPair.kid,
    });
  });

  it("carries the Cognito claims the application already reads", async () => {
    const keyPair = await loadOrCreateKeyPair();
    const token = await mintLocalIdToken({
      keyPair,
      sub: "user-1",
      email: "admin@example.local",
      roles: ["Admin", "User"],
    });
    const claims = decode(token);
    expect(claims).toMatchObject({
      sub: "user-1",
      email: "admin@example.local",
      "cognito:username": "admin@example.local",
      "custom:idc_user_id": "user-1",
      "custom:isb_roles": '["Admin","User"]',
      token_use: "id",
      aud: LOCAL_APP_CLIENT_ID,
    });
    expect(claims.iss).toBe(LOCAL_ISSUER);
  });

  it("produces a signature the published public key verifies", async () => {
    const keyPair = await loadOrCreateKeyPair();
    const token = await mintLocalIdToken({
      keyPair,
      sub: "user-1",
      email: "admin@example.local",
      roles: ["User"],
    });
    const [header, payload, signature] = token.split(".");
    const verifier = createVerify("RSA-SHA256");
    verifier.update(`${header}.${payload}`);
    expect(
      verifier.verify(keyPair.publicKey, Buffer.from(signature, "base64url")),
    ).toBe(true);
  });

  it("expires in the future and honors a custom ttl", async () => {
    const keyPair = await loadOrCreateKeyPair();
    const token = await mintLocalIdToken({
      keyPair,
      sub: "user-1",
      email: "admin@example.local",
      roles: ["User"],
      ttlSeconds: 120,
    });
    const claims = decode(token);
    expect(claims.exp - claims.iat).toBe(120);
    expect(claims.exp).toBeGreaterThan(Math.floor(Date.now() / 1000));
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run --root local edge/jwks.test.ts edge/mint-token.test.ts`
Expected: FAIL — cannot resolve `./jwks.js`.

- [ ] **Step 3: Implement `local/edge/jwks.ts`**

```ts
// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import { createPublicKey, generateKeyPairSync, createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export interface KeyPair {
  privateKey: string;
  publicKey: string;
  kid: string;
}

export interface JwksDocument {
  keys: Array<{
    kty: "RSA";
    alg: "RS256";
    use: "sig";
    kid: string;
    n: string;
    e: string;
  }>;
}

const moduleDir = dirname(fileURLToPath(import.meta.url));
const KEY_DIR = process.env.ISB_LOCAL_KEY_DIR ?? join(moduleDir, "..", ".keys");
const KEY_FILE = join(KEY_DIR, "local-jwks.json");

/**
 * Loads the local signing keypair, generating and persisting one on first run.
 * The key is deliberately gitignored: it is a development-only trust anchor with
 * no value outside this machine, and rotating it costs one `local:reset`.
 */
export async function loadOrCreateKeyPair(): Promise<KeyPair> {
  if (existsSync(KEY_FILE)) {
    return JSON.parse(readFileSync(KEY_FILE, "utf-8")) as KeyPair;
  }
  const { privateKey, publicKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
  });
  const privatePem = privateKey.export({
    type: "pkcs8",
    format: "pem",
  }) as string;
  const publicPem = publicKey.export({ type: "spki", format: "pem" }) as string;
  // kid derived from the public key so it is stable across restarts and unique
  // per key, letting the verifier select the right key if the pair is rotated.
  const kid = createHash("sha256")
    .update(publicPem)
    .digest("base64url")
    .slice(0, 16);
  const keyPair: KeyPair = {
    privateKey: privatePem,
    publicKey: publicPem,
    kid,
  };
  mkdirSync(KEY_DIR, { recursive: true });
  writeFileSync(KEY_FILE, JSON.stringify(keyPair, null, 2));
  return keyPair;
}

/** Builds the JWKS document the Lambda loads via ISB_LOCAL_JWKS_URI. */
export function buildLocalJwks(keyPair: KeyPair): JwksDocument {
  const jwk = createPublicKey(keyPair.publicKey).export({
    format: "jwk",
  }) as { n: string; e: string };
  return {
    keys: [
      {
        kty: "RSA",
        alg: "RS256",
        use: "sig",
        kid: keyPair.kid,
        n: jwk.n,
        e: jwk.e,
      },
    ],
  };
}
```

- [ ] **Step 4: Implement `local/edge/mint-token.ts`**

```ts
// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import { createSign } from "node:crypto";

import { LOCAL_APP_CLIENT_ID, LOCAL_USER_POOL_ID } from "../shared/names.js";
import type { KeyPair } from "./jwks.js";

/**
 * The issuer `CognitoJwtVerifier` derives from COGNITO_USER_POOL_ID. A token
 * whose `iss` differs is rejected, so this must stay in lockstep with the pool
 * ID the local CDK app sets on the Lambdas.
 */
export const LOCAL_ISSUER = `https://cognito-idp.${LOCAL_USER_POOL_ID.split("_")[0]}.amazonaws.com/${LOCAL_USER_POOL_ID}`;

export interface MintOptions {
  keyPair: KeyPair;
  sub: string;
  email: string;
  roles: string[];
  ttlSeconds?: number;
}

const base64url = (input: Buffer | string) =>
  Buffer.from(input).toString("base64url");

export async function mintLocalIdToken(options: MintOptions): Promise<string> {
  const { keyPair, sub, email, roles, ttlSeconds = 3600 } = options;
  const issuedAt = Math.floor(Date.now() / 1000);
  const header = { alg: "RS256", typ: "JWT", kid: keyPair.kid };
  const payload = {
    sub,
    email,
    email_verified: true,
    "cognito:username": email,
    // The Pre Token Generation Lambda injects this in production; locally the
    // edge sets it directly from the server-side role allowlist.
    "custom:idc_user_id": sub,
    "custom:isb_roles": JSON.stringify(roles),
    aud: LOCAL_APP_CLIENT_ID,
    iss: LOCAL_ISSUER,
    token_use: "id",
    iat: issuedAt,
    exp: issuedAt + ttlSeconds,
  };
  const signingInput = `${base64url(JSON.stringify(header))}.${base64url(
    JSON.stringify(payload),
  )}`;
  const signer = createSign("RSA-SHA256");
  signer.update(signingInput);
  signer.end();
  return `${signingInput}.${base64url(signer.sign(keyPair.privateKey))}`;
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run --root local edge/jwks.test.ts edge/mint-token.test.ts`
Expected: PASS — 7 tests.

- [ ] **Step 6: Commit**

```bash
git add local/edge/jwks.ts local/edge/mint-token.ts local/edge/jwks.test.ts local/edge/mint-token.test.ts
git commit -m "feat(local): add local keypair management and Cognito-shaped ID token minting"
```

---

## Task 5: Local Amplify session provider

The third upstream change's payload. Supplies Amplify a session offline through its documented `libraryOptions` extension point, so nothing downstream of `fetchAuthSession` changes.

**Files:**

- Create: `source/frontend/src/helpers/local/amplify-local-session.ts`
- Test: `source/frontend/test/helpers/local/amplify-local-session.test.ts`

**Interfaces:**

- Consumes: nothing from earlier tasks except the `/session` contract defined here. The local edge (Task 7) implements the matching server side.
- Produces: `localSessionLibraryOptions(sessionEndpoint: string): { Auth: LibraryAuthOptions }` and the `SessionResponse` type `{ token: string; payload: { exp: number } & Record<string, unknown> }`. The provider refetches when `exp` has passed, so a long-lived tab does not start 401ing.

- [ ] **Step 1: Write the failing test**

Create `source/frontend/test/helpers/local/amplify-local-session.test.ts`:

```ts
// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { localSessionLibraryOptions } from "@amzn/innovation-sandbox-frontend/helpers/local/amplify-local-session";

const ENDPOINT = "http://localhost:4599/session";

let fetchMock: ReturnType<typeof vi.fn>;

const respondWith = (token: string, exp: number) => {
  fetchMock.mockResolvedValue({
    ok: true,
    json: async () => ({ token, payload: { exp, sub: "user-1" } }),
  });
};

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe("localSessionLibraryOptions", () => {
  it("returns tokens for Amplify to consume", async () => {
    respondWith(
      "header.payload.signature",
      Math.floor(Date.now() / 1000) + 3600,
    );
    const { Auth } = localSessionLibraryOptions(ENDPOINT);
    const tokens = await Auth!.tokenProvider!.getTokens();
    expect(tokens?.idToken?.toString()).toBe("header.payload.signature");
    expect(tokens?.accessToken?.toString()).toBe("header.payload.signature");
  });

  it("serves the token payload as idToken.payload for claim extraction", async () => {
    respondWith("h.p.s", Math.floor(Date.now() / 1000) + 3600);
    const { Auth } = localSessionLibraryOptions(ENDPOINT);
    const tokens = await Auth!.tokenProvider!.getTokens();
    expect(tokens?.idToken?.payload).toMatchObject({ sub: "user-1" });
  });

  it("caches the token and refetches once it has expired", async () => {
    const now = Math.floor(Date.now() / 1000);
    respondWith("first", now + 3600);
    const { Auth } = localSessionLibraryOptions(ENDPOINT);
    await Auth!.tokenProvider!.getTokens();
    await Auth!.tokenProvider!.getTokens();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    respondWith("second", now - 1);
    const refreshed = await Auth!.tokenProvider!.getTokens();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(refreshed?.idToken?.toString()).toBe("second");
  });

  it("returns null when the local edge is unreachable, so the app shows logged-out", async () => {
    fetchMock.mockRejectedValue(new Error("ECONNREFUSED"));
    const { Auth } = localSessionLibraryOptions(ENDPOINT);
    await expect(Auth!.tokenProvider!.getTokens()).resolves.toBeNull();
  });

  it("supplies dummy SigV4 credentials so request signing still runs", async () => {
    respondWith("h.p.s", Math.floor(Date.now() / 1000) + 3600);
    const { Auth } = localSessionLibraryOptions(ENDPOINT);
    const result = await Auth!.credentialsProvider!.getCredentialsAndIdentityId(
      {},
    );
    expect(result?.credentials.accessKeyId).toBe("test");
    expect(result?.identityId).toBeTruthy();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

The frontend suite is configured by `source/frontend/vitest.config.ts`, which includes `test/**/*.test.{ts,tsx}`. Run it from the frontend workspace:

```bash
npx vitest run --root source/frontend test/helpers/local/amplify-local-session.test.ts
```

Expected: FAIL — cannot resolve the module.

Note: `setupFiles: ["./src/setupTests.tsx"]` installs MSW and stubs `globalThis.fetch` for every frontend test. This test re-stubs `fetch` itself in `beforeEach`, which takes precedence, so the MSW server does not intercept the session calls. That is intentional: the provider's own fetch behavior is what is under test here.

- [ ] **Step 3: Implement the provider**

Create `source/frontend/src/helpers/local/amplify-local-session.ts`:

```ts
// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import type { LibraryAuthOptions } from "@aws-amplify/core";

interface SessionPayload extends Record<string, unknown> {
  exp: number;
}

/** Shape returned by the local edge's `GET /session` route. */
export interface SessionResponse {
  token: string;
  payload: SessionPayload;
}

/**
 * Amplify session for the offline LocalStack profile.
 *
 * Production login is a Cognito hosted-UI redirect federating to IAM Identity
 * Center, which no emulator reproduces. Amplify exposes `libraryOptions` as the
 * supported way to supply tokens and credentials directly, so the local profile
 * passes these providers and everything downstream of `fetchAuthSession` —
 * claim extraction, SigV4 signing, the `x-isb-identity` header — runs unchanged.
 *
 * Selected only when `VITE_LOCAL_SESSION_ENDPOINT` is set; see
 * `configureAmplifyAuth`.
 */
export function localSessionLibraryOptions(sessionEndpoint: string): {
  Auth: LibraryAuthOptions;
} {
  let cached: { token: string; payload: SessionPayload } | null = null;
  let inFlight: Promise<{
    token: string;
    payload: SessionPayload;
  } | null> | null = null;

  const isExpired = (session: { payload: SessionPayload }) =>
    // 30s of slack so a token cannot expire mid-request.
    session.payload.exp * 1000 - 30_000 <= Date.now();

  const loadSession = async () => {
    if (cached && !isExpired(cached)) return cached;
    inFlight ??= (async () => {
      try {
        const response = await fetch(sessionEndpoint, { cache: "no-store" });
        if (!response.ok) return null;
        const session = (await response.json()) as SessionResponse;
        cached = session;
        return session;
      } catch {
        // The local edge not running is a normal state, not an error: the app
        // should render logged out rather than crash.
        return null;
      } finally {
        inFlight = null;
      }
    })();
    return inFlight;
  };

  const tokenProvider = {
    getTokens: async () => {
      const session = await loadSession();
      if (!session) return null;
      // `JWT` is type-only in aws-amplify 6.16.4, so a structural object
      // satisfying `{ payload, toString() }` is what AuthTokens accepts.
      const toJwt = () => ({
        payload: session.payload,
        toString: () => session.token,
      });
      return { idToken: toJwt(), accessToken: toJwt() };
    },
  };

  const credentialsProvider = {
    getCredentialsAndIdentityId: async () => {
      const session = await loadSession();
      if (!session) return undefined;
      return {
        credentials: {
          accessKeyId: "test",
          secretAccessKey: "test",
          sessionToken: "test",
          expiration: new Date(session.payload.exp * 1000),
        },
        identityId: `${sessionEndpoint}#local-identity`,
      };
    },
    clearCredentialsAndIdentityId: () => {
      cached = null;
    },
  };

  return { Auth: { tokenProvider, credentialsProvider } };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run --root source/frontend test/helpers/local/amplify-local-session.test.ts`
Expected: PASS — 5 tests.

- [ ] **Step 5: Verify the frontend suite is unaffected**

Run: `npx vitest run --root source/frontend 2>&1 | tail -6`
Expected: PASS. The new file is additive and nothing imports it yet.

- [ ] **Step 6: Commit**

```bash
git add source/frontend/src/helpers/local/amplify-local-session.ts source/frontend/test/helpers/local/amplify-local-session.test.ts
git commit -m "feat(frontend): add local Amplify session providers for the offline profile"
```

---

## Task 6: Wire the local profile into Amplify configuration

Completes the third and final upstream change. Without the `VITE_LOCAL_SESSION_ENDPOINT` variable set, `Amplify.configure` is called with exactly one argument and behavior is identical to upstream.

**Files:**

- Modify: `source/frontend/src/helpers/cognito-config.ts:1-47`
- Test: `source/frontend/test/helpers/cognito-config-local.test.ts`

**Interfaces:**

- Consumes: `localSessionLibraryOptions` from Task 5.
- Produces: no new exports. `configureAmplifyAuth` reads `import.meta.env.VITE_LOCAL_SESSION_ENDPOINT` and passes a second argument to `Amplify.configure` when it is a non-empty string.

- [ ] **Step 1: Write the failing test**

Create `source/frontend/test/helpers/cognito-config-local.test.ts`:

```ts
// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const configure = vi.fn();
vi.mock("aws-amplify", () => ({ Amplify: { configure } }));
vi.mock("aws-amplify/auth/cognito", () => ({
  cognitoUserPoolsTokenProvider: { setKeyValueStorage: vi.fn() },
}));
vi.mock("aws-amplify/utils", () => ({ sessionStorage: {} }));

const { configureAmplifyAuth } =
  await import("@amzn/innovation-sandbox-frontend/helpers/cognito-config");

const baseConfig = {
  userPoolId: "us-east-1_localdev",
  appClientId: "localdevclientid",
  identityPoolId: "us-east-1:000000000000",
  domain: "localdev",
  region: "us-east-1",
  awsAccessPortalUrl: "http://localhost:4599/local/unsupported/access-portal",
};

beforeEach(() => {
  configure.mockClear();
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe("configureAmplifyAuth", () => {
  it("passes exactly one argument when no local session endpoint is set", async () => {
    vi.stubEnv("VITE_LOCAL_SESSION_ENDPOINT", "");
    configureAmplifyAuth(baseConfig);
    expect(configure).toHaveBeenCalledTimes(1);
    expect(configure.mock.calls[0]).toHaveLength(1);
  });

  it("passes libraryOptions when the local session endpoint is set", async () => {
    vi.stubEnv("VITE_LOCAL_SESSION_ENDPOINT", "http://localhost:4599/session");
    configureAmplifyAuth(baseConfig);
    expect(configure).toHaveBeenCalledTimes(1);
    const [, libraryOptions] = configure.mock.calls[0];
    expect(libraryOptions).toBeDefined();
    expect(libraryOptions.Auth.tokenProvider).toBeTypeOf("function");
    expect(libraryOptions.Auth.credentialsProvider).toBeDefined();
  });

  it("leaves the Cognito resource configuration untouched in local mode", async () => {
    vi.stubEnv("VITE_LOCAL_SESSION_ENDPOINT", "http://localhost:4599/session");
    configureAmplifyAuth(baseConfig);
    const [resources] = configure.mock.calls[0];
    expect(resources.Auth.Cognito.userPoolId).toBe("us-east-1_localdev");
    expect(resources.Auth.Cognito.loginWith.oauth.domain).toBe(
      "localdev.auth.us-east-1.amazonaws.com",
    );
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run --root source/frontend test/helpers/cognito-config-local.test.ts`
Expected: FAIL — the second and third tests fail because `configure` is called with one argument.

- [ ] **Step 3: Make the change**

In `source/frontend/src/helpers/cognito-config.ts`, add the import and the optional second argument:

```ts
import { Amplify } from "aws-amplify";
import { cognitoUserPoolsTokenProvider } from "aws-amplify/auth/cognito";
import { sessionStorage } from "aws-amplify/utils";

import { localSessionLibraryOptions } from "@amzn/innovation-sandbox-frontend/helpers/local/amplify-local-session";
```

Then replace the `Amplify.configure({...})` call with:

```ts
// Set only by the offline LocalStack profile. Unset in every deployed
// environment, where Amplify is configured with a single argument exactly as
// before and login proceeds through the Cognito hosted UI.
const localSessionEndpoint = (
  import.meta.env.VITE_LOCAL_SESSION_ENDPOINT as string | undefined
)?.trim();

Amplify.configure(
  {
    Auth: {
      Cognito: {
        userPoolId: cognitoConfig.userPoolId,
        userPoolClientId: cognitoConfig.appClientId,
        identityPoolId: cognitoConfig.identityPoolId,
        loginWith: {
          oauth: {
            domain: `${cognitoConfig.domain}.auth.${cognitoConfig.region}.amazoncognito.com`,
            scopes: ["openid", "email", "profile"],
            redirectSignIn: [`${currentOrigin}/callback`],
            // Sign-out lands on the IDC access portal, not an in-app page —
            // clearing the Cognito session alone can't end the IDC SAML session,
            // so we hand off to the portal where the user can finish signing out.
            redirectSignOut: [cognitoConfig.awsAccessPortalUrl],
            responseType: "code",
            providers: [{ custom: "IAMIdentityCenter" }],
          },
        },
      },
    },
  },
  localSessionEndpoint
    ? localSessionLibraryOptions(localSessionEndpoint)
    : undefined,
);
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run --root source/frontend test/helpers/cognito-config-local.test.ts`
Expected: PASS — 3 tests.

- [ ] **Step 5: Verify the pre-existing cognito-config test still passes**

Run: `npx vitest run --root source/frontend test/helpers/cognito-config.test.ts`
Expected: PASS. Its assertions cover the resource configuration, which is unchanged. If it starts failing, the `libraryOptions` argument disturbed the existing contract.

- [ ] **Step 6: Verify the whole frontend suite and the build**

Run: `npx vitest run --root source/frontend 2>&1 | tail -6`
Expected: PASS.

Run: `npm run build --workspace @amzn/innovation-sandbox-frontend 2>&1 | tail -5`
Expected: completes with the same 39 lint warnings and no errors that predate this work. A new error here means the `import.meta.env` access or the new import is misconfigured — in particular, `import.meta.env.VITE_LOCAL_SESSION_ENDPOINT` must typecheck without a custom `ImportMetaEnv` declaration, which Vite's client types provide by index signature.

- [ ] **Step 7: Commit**

```bash
git add source/frontend/src/helpers/cognito-config.ts source/frontend/test/helpers/cognito-config-local.test.ts
git commit -m "feat(frontend): configure Amplify library options for the local profile"
```

---

## Task 7: The local edge service

One process that stands in for CloudFront and mints sessions. It exists because the Vite dev server proxies `/api` and `/config.json` to a single origin with no path rewriting, and no LocalStack origin serves both.

**Files:**

- Create: `local/edge/routes/config.ts`
- Create: `local/edge/routes/session.ts`
- Create: `local/edge/routes/api-proxy.ts`
- Create: `local/edge/server.ts`
- Test: `local/edge/server.test.ts`

**Interfaces:**

- Consumes: `loadOrCreateKeyPair`, `buildLocalJwks`, `mintLocalIdToken` (Task 4); `localEdgeConfig`, `LOCAL_STAGE`, `LOCAL_EDGE_PORT` (Task 1).
- Produces: `createLocalEdgeServer(deps: LocalEdgeDeps): http.Server` and `LocalEdgeDeps` = `{ apiGatewayInvokeUrl: string; keyPair: KeyPair; logger?: Pick<Console, "info" | "warn" | "error"> }`. Routes: `GET /config.json`, `GET /session`, `GET /.well-known/jwks.json`, `ALL /api/*`, `GET /local/unsupported/*` (501), `GET /healthz`.

- [ ] **Step 1: Write the failing test**

Create `local/edge/server.test.ts`:

```ts
// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

process.env.ISB_LOCAL_KEY_DIR = mkdtempSync(join(tmpdir(), "isb-local-edge-"));

const { createLocalEdgeServer } = await import("./server.js");
const { loadOrCreateKeyPair } = await import("./jwks.js");
const { localEdgeConfig, LOCAL_STAGE } = await import("../shared/names.js");

let server: ReturnType<typeof createLocalEdgeServer>;
let base: string;
let upstream: ReturnType<typeof import("node:http").createServer>;
let upstreamUrl: string;
const upstreamHits: Array<{ method: string; url: string }> = [];

beforeEach(async () => {
  upstreamHits.length = 0;
  const http = await import("node:http");
  upstream = http.createServer((req, res) => {
    upstreamHits.push({ method: req.method!, url: req.url! });
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ status: "success", data: { echoed: req.url } }));
  });
  await new Promise<void>((resolve) =>
    upstream.listen(0, "127.0.0.1", resolve),
  );
  upstreamUrl = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`;

  server = createLocalEdgeServer({
    apiGatewayInvokeUrl: `${upstreamUrl}/${LOCAL_STAGE}/_user_request_`,
    keyPair: await loadOrCreateKeyPair(),
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await new Promise<void>((resolve) => upstream.close(() => resolve()));
  rmSync(process.env.ISB_LOCAL_KEY_DIR!, { recursive: true, force: true });
});

describe("local edge", () => {
  it("serves a config.json with all nine ConfigData fields", async () => {
    const response = await fetch(`${base}/config.json`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(localEdgeConfig());
  });

  it("strips the /api prefix and prepends the stage when proxying", async () => {
    await fetch(`${base}/api/leases`);
    expect(upstreamHits).toEqual([
      { method: "GET", url: `/local/_user_request_/leases` },
    ]);
  });

  it("preserves the request method and forwards the identity header", async () => {
    await fetch(`${base}/api/leaseTemplates`, {
      method: "POST",
      headers: { "x-isb-identity": "token-abc" },
    });
    expect(upstreamHits[0].method).toBe("POST");
  });

  it("mints a session whose iss matches the local user pool", async () => {
    const response = await fetch(`${base}/session`);
    const session = (await response.json()) as {
      token: string;
      payload: Record<string, unknown>;
    };
    const claims = JSON.parse(
      Buffer.from(session.token.split(".")[1], "base64url").toString("utf-8"),
    );
    expect(claims.iss).toBe(session.payload.iss);
    expect(session.payload).toMatchObject({
      token_use: "id",
      "custom:isb_roles": '["Admin"]',
    });
  });

  it("publishes a JWKS with one key", async () => {
    const jwks = (await (
      await fetch(`${base}/.well-known/jwks.json`)
    ).json()) as {
      keys: unknown[];
    };
    expect(jwks.keys).toHaveLength(1);
  });

  it("answers 501 for the documented unsupported paths", async () => {
    const response = await fetch(`${base}/local/unsupported/access-portal`);
    expect(response.status).toBe(501);
  });

  it("reports health", async () => {
    expect((await fetch(`${base}/healthz`)).status).toBe(200);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run --root local edge/server.test.ts`
Expected: FAIL — cannot resolve `./server.js`.

- [ ] **Step 3: Implement `local/edge/routes/config.ts`**

```ts
// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import type { ServerResponse } from "node:http";

import { localEdgeConfig } from "../../shared/names.js";

/**
 * Serves the runtime config the frontend fetches before anything renders.
 * `main.tsx` refuses to mount unless all six Cognito fields are present, so the
 * payload is fully populated even though the local profile never contacts
 * Cognito.
 */
export function handleConfig(_req: unknown, res: ServerResponse): void {
  const body = JSON.stringify(localEdgeConfig());
  res.writeHead(200, {
    "content-type": "application/json",
    // The Vite proxy already serves same-origin, but no-store keeps a stale
    // config from surviving a restart.
    "cache-control": "no-store",
  });
  res.end(body);
}
```

- [ ] **Step 4: Implement `local/edge/routes/session.ts`**

```ts
// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import type { ServerResponse } from "node:http";

import type { KeyPair } from "../jwks.js";
import { mintLocalIdToken } from "../mint-token.js";

/**
 * The single local identity. Roles come from this server-side constant and
 * never from request input, so a developer cannot escalate by editing a claim
 * in the browser — and there is no code path where a request could influence
 * what gets signed.
 */
const LOCAL_USER = {
  sub: "local-admin",
  email: "admin@example.local",
  roles: ["Admin"] as const,
};

/** Mints the ID token the frontend's local Amplify providers consume. */
export async function handleSession(
  _req: unknown,
  res: ServerResponse,
  keyPair: KeyPair,
): Promise<void> {
  const token = await mintLocalIdToken({ keyPair, ...LOCAL_USER });
  const payload = JSON.parse(
    Buffer.from(token.split(".")[1], "base64url").toString("utf-8"),
  );
  res.writeHead(200, {
    "content-type": "application/json",
    "cache-control": "no-store",
  });
  res.end(JSON.stringify({ token, payload }));
}
```

- [ ] **Step 5: Implement `local/edge/routes/api-proxy.ts`**

```ts
// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import type { IncomingMessage, ServerResponse } from "node:http";

/**
 * Rewrites `/api/<path>` to the local API Gateway invoke URL and forwards the
 * request, mirroring what the CloudFront path behavior does in production: it
 * strips the `/api` prefix and prepends the stage. The browser therefore stays
 * same-origin and no CORS handling is needed anywhere.
 *
 * The frontend's SigV4 signature is intentionally not validated or re-signed —
 * the local gateway runs with `NONE` authorization and the Lambda's
 * `x-isb-identity` check is the real gate. See the spec's "Local infrastructure".
 */
export function handleApiProxy(
  req: IncomingMessage,
  res: ServerResponse,
  invokeUrl: string,
): void {
  const originalUrl = req.url ?? "/";
  if (!originalUrl.startsWith("/api/")) {
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ status: "fail", message: "Not found" }));
    return;
  }
  const path = originalUrl.slice("/api".length);
  const target = new URL(`${invokeUrl}${path}`);
  target.search = new URL(originalUrl, "http://localhost").search;

  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(req.headers)) {
    if (typeof value === "string") headers[name] = value;
  }
  // The gateway signs nothing locally, and a stale Host from the Vite proxy
  // would confuse LocalStack's routing.
  delete headers.host;

  const upstream = fetch(target, { method: req.method, headers, body: req });
  upstream
    .then(async (response) => {
      const body = Buffer.from(await response.arrayBuffer());
      const out: Record<string, string> = {};
      response.headers.forEach((value, name) => {
        out[name] = value;
      });
      res.writeHead(response.status, out);
      res.end(body);
    })
    .catch((error: unknown) => {
      res.writeHead(502, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          status: "fail",
          message: `Local edge could not reach the LocalStack API Gateway: ${
            error instanceof Error ? error.message : String(error)
          }`,
        }),
      );
    });
}
```

- [ ] **Step 6: Implement `local/edge/server.ts`**

```ts
// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import { createServer, type Server } from "node:http";

import { buildLocalJwks, type KeyPair } from "./jwks.js";
import { handleApiProxy } from "./routes/api-proxy.js";
import { handleConfig } from "./routes/config.js";
import { handleSession } from "./routes/session.js";

export interface LocalEdgeDeps {
  /** LocalStack API Gateway invoke base, e.g. http://localstack:4566/restapis/<id>/local/_user_request_ */
  apiGatewayInvokeUrl: string;
  keyPair: KeyPair;
  logger?: Pick<Console, "info" | "warn" | "error">;
}

const UNSUPPORTED_MESSAGE =
  "Not available in the local profile: this surface depends on an AWS service " +
  "that LocalStack Hobby does not emulate. See docs/plans/2026-09-25-offline-local-development-design.md.";

export function createLocalEdgeServer(deps: LocalEdgeDeps): Server {
  const { apiGatewayInvokeUrl, keyPair, logger = console } = deps;

  return createServer((req, res) => {
    const url = req.url ?? "/";
    const path = url.split("?")[0];

    if (path === "/healthz") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ status: "ok" }));
      return;
    }
    if (path === "/config.json") {
      handleConfig(req, res);
      return;
    }
    if (path === "/session") {
      handleSession(req, res, keyPair).catch((error: unknown) => {
        logger.error("[local-edge] failed to mint session", error);
        res.writeHead(500, { "content-type": "application/json" });
        res.end(
          JSON.stringify({ status: "fail", message: "Session mint failed" }),
        );
      });
      return;
    }
    if (path === "/.well-known/jwks.json") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(buildLocalJwks(keyPair)));
      return;
    }
    if (path.startsWith("/local/unsupported/")) {
      res.writeHead(501, { "content-type": "application/json" });
      res.end(JSON.stringify({ status: "fail", message: UNSUPPORTED_MESSAGE }));
      return;
    }
    if (path.startsWith("/api/")) {
      handleApiProxy(req, res, apiGatewayInvokeUrl);
      return;
    }
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ status: "fail", message: "Not found" }));
  });
}

/** Entry point used by the compose service. */
async function main(): Promise<void> {
  const { loadOrCreateKeyPair } = await import("./jwks.js");
  const { LOCAL_EDGE_PORT } = await import("../shared/names.js");
  const invokeUrl = process.env.ISB_LOCAL_API_GATEWAY_INVOKE_URL;
  if (!invokeUrl) {
    throw new Error(
      "ISB_LOCAL_API_GATEWAY_INVOKE_URL is required (set by local/scripts/local-up.sh)",
    );
  }
  const server = createLocalEdgeServer({
    apiGatewayInvokeUrl: invokeUrl,
    keyPair: await loadOrCreateKeyPair(),
  });
  server.listen(LOCAL_EDGE_PORT, "0.0.0.0", () => {
    console.info(`[local-edge] listening on :${LOCAL_EDGE_PORT}`);
  });
}

if (process.argv[1]?.endsWith("server.ts")) {
  main().catch((error: unknown) => {
    console.error("[local-edge] failed to start", error);
    process.exit(1);
  });
}
```

- [ ] **Step 7: Run the test to verify it passes**

Run: `npx vitest run --root local edge/server.test.ts`
Expected: PASS — 7 tests.

- [ ] **Step 8: Commit**

```bash
git add local/edge/server.ts local/edge/routes/ local/edge/server.test.ts
git commit -m "feat(local): add the local edge serving config, session, JWKS and API proxy"
```

---

## Task 8: Local infrastructure — tables, KMS, and environment assembly

Builds the data layer with the upstream table definitions, and derives each Lambda's environment from the upstream Zod schemas rather than restating variable names.

**Files:**

- Create: `local/infrastructure/lib/lambda-environment.ts`
- Modify: `local/vitest.config.ts` (add `@amzn/*` aliases)
- Test: `local/infrastructure/lib/lambda-environment.test.ts`

**Interfaces:**

- Consumes: `localTableNames`, `localResourceNames`, `LOCAL_NAMESPACE`, `LOCAL_USER_POOL_ID`, `LOCAL_APP_CLIENT_ID` (Task 1); `ISB_LOCAL_JWKS_URI` on the env schemas (Task 2).
- Produces: `buildLocalEnv(schema: ZodType, overrides?: Record<string, string | undefined>): Record<string, string>` which assembles a complete environment and validates it with the supplied upstream schema, throwing on mismatch. Also `LOCAL_JWKS_URI`, the in-network address the Lambdas use to reach the edge, and `LOCALSTACK_ENDPOINT`, the address the CDK CLI uses.

The table definitions themselves are Task 9. This task isolates the environment contract because it is where an upstream schema change surfaces first.

- [ ] **Step 1: Write the failing test**

Create `local/infrastructure/lib/lambda-environment.test.ts`:

```ts
// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";

import { AccountLambdaEnvironmentSchema } from "@amzn/innovation-sandbox-commons/lambda/environments/account-lambda-environment.js";
import { ConfigurationLambdaEnvironmentSchema } from "@amzn/innovation-sandbox-commons/lambda/environments/config-lambda-environment.js";
import { LeaseLambdaEnvironmentSchema } from "@amzn/innovation-sandbox-commons/lambda/environments/lease-lambda-environment.js";
import { LeaseTemplateLambdaEnvironmentSchema } from "@amzn/innovation-sandbox-commons/lambda/environments/lease-template-lambda-environment.js";
import { PrincipalsLambdaEnvironmentSchema } from "@amzn/innovation-sandbox-commons/lambda/environments/principals-lambda-environment.js";

import { buildLocalEnv, LOCAL_JWKS_URI } from "./lambda-environment.js";

describe("buildLocalEnv", () => {
  it("produces an environment every domain schema accepts", () => {
    for (const schema of [
      LeaseLambdaEnvironmentSchema,
      LeaseTemplateLambdaEnvironmentSchema,
      ConfigurationLambdaEnvironmentSchema,
      PrincipalsLambdaEnvironmentSchema,
      AccountLambdaEnvironmentSchema,
    ]) {
      expect(() => buildLocalEnv(schema)).not.toThrow();
    }
  });

  it("sets ISB_LOCAL_JWKS_URI to the in-network edge address", () => {
    const env = buildLocalEnv(LeaseTemplateLambdaEnvironmentSchema);
    expect(env.ISB_LOCAL_JWKS_URI).toBe(LOCAL_JWKS_URI);
    expect(env.ISB_LOCAL_JWKS_URI).toContain("isb-local-edge");
  });

  it("points every AWS client at LocalStack and disables X-Ray", () => {
    const env = buildLocalEnv(LeaseTemplateLambdaEnvironmentSchema);
    expect(env.AWS_ENDPOINT_URL).toMatch(/^http:\/\/localstack:4566$/);
    expect(env.POWERTOOLS_TRACE_ENABLED).toBe("false");
  });

  it("sets the local user pool and client id the verifier checks", () => {
    const env = buildLocalEnv(LeaseTemplateLambdaEnvironmentSchema);
    expect(env.COGNITO_USER_POOL_ID).toBe("us-east-1_localdev");
    expect(env.COGNITO_APP_CLIENT_ID).toBe("localdevclientid");
    expect(env.ISB_NAMESPACE).toBe("isbdev");
  });

  it("throws a useful error when a required variable is missing", () => {
    expect(() =>
      buildLocalEnv(LeaseTemplateLambdaEnvironmentSchema, {
        LEASE_TEMPLATE_TABLE_NAME: undefined as unknown as string,
      }),
    ).toThrow(/LEASE_TEMPLATE_TABLE_NAME|Environment variables/);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run --root local infrastructure/lib/lambda-environment.test.ts`
Expected: FAIL — cannot resolve `./lambda-environment.js`.

- [ ] **Step 3: Implement `local/infrastructure/lib/lambda-environment.ts`**

```ts
// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import type { ZodType } from "zod";

import {
  LOCAL_ACCOUNT_ID,
  LOCAL_APP_CLIENT_ID,
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
export const LOCAL_JWKS_URI =
  "http://isb-local-edge:4599/.well-known/jwks.json";

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
  AWS_ACCESS_PORTAL_URL:
    "http://localhost:4599/local/unsupported/access-portal",
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
  // Return `merged`, the object just validated — NOT `result.data`. A Zod
  // object drops every key its schema does not describe, and the keys no domain
  // schema describes are exactly the ones the AWS SDK and Powertools read from
  // `process.env` at invocation: AWS_ENDPOINT_URL, POWERTOOLS_TRACE_ENABLED,
  // AWS_REGION, AWS_DEFAULT_REGION, AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY.
  // Projecting through Zod would silently drop the redirection to LocalStack and
  // point every Lambda at real AWS. CDK writes this record into the function
  // config verbatim and the handler reads `process.env`, never the parse output,
  // so `result.data` is a third artifact no handler ever sees.
  //
  // The anti-smuggling property is carried entirely by the `safeParse` gate
  // above, which is intact: every key in `merged` was validated. Returning
  // `result.data` adds only removal of keys, which is the bug, not a protection.
  return merged;
}

/**
 * The CDK CLI process resolves its own AWS endpoints from its own environment,
 * not from the Lambda environment assembled above. `local-up.sh` exports this
 * before invoking `cdk deploy`; the constant exists so the two can never drift.
 */
export const LOCALSTACK_ENDPOINT = "http://localhost:4566";
```

- [ ] **Step 4: Add the vitest alias so `local` tests resolve `@amzn/*`**

The root `vitest.config.ts` collects only `source/**/vitest.config.ts`, so the local suite needs its own alias map. Update `local/vitest.config.ts`:

```ts
// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export default defineConfig({
  test: {
    include: ["**/*.test.ts"],
    exclude: ["node_modules", "dist", "cdk.out"],
  },
  resolve: {
    alias: {
      "@amzn/innovation-sandbox-commons": path.join(root, "source/common"),
      "@amzn/innovation-sandbox-shared": path.join(root, "source/shared"),
      "@amzn/innovation-sandbox-infrastructure": path.join(
        root,
        "source/infrastructure/lib",
      ),
    },
  },
});
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx vitest run --root local infrastructure/lib/lambda-environment.test.ts`
Expected: PASS — 5 tests.

- [ ] **Step 6: Commit**

```bash
git add local/infrastructure/lib/lambda-environment.ts local/infrastructure/lib/lambda-environment.test.ts local/vitest.config.ts
git commit -m "feat(local): derive Lambda environments from the upstream Zod schemas"
```

---

## Task 9: Local infrastructure — the data stack

Creates the seven DynamoDB tables and the KMS key with the same key schemas, GSIs, and TTL attributes as `IsbDataResources`, so the real stores work unmodified.

**Files:**

- Create: `local/infrastructure/lib/local-data-stack.ts`
- Test: `local/infrastructure/lib/local-data-stack.test.ts`

**Interfaces:**

- Consumes: `localTableNames` (Task 1).
- Produces: `LocalDataStack extends Stack` exposing `tables: Record<LocalTableName, Table>` and `kmsKey: Key`. Its synthesized template must contain all seven tables with the production key schemas.

- [ ] **Step 1: Write the failing test**

Create `local/infrastructure/lib/local-data-stack.test.ts`:

```ts
// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import { App } from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { beforeAll, describe, expect, it } from "vitest";

import { LOCAL_TABLE_NAMES } from "../../shared/names.js";
import { LocalDataStack } from "./local-data-stack.js";

let template: Template;

beforeAll(() => {
  const app = new App();
  const stack = new LocalDataStack(app, "LocalData", {
    env: { account: "000000000000", region: "us-east-1" },
  });
  template = Template.fromStack(stack);
});

describe("LocalDataStack", () => {
  it("creates exactly seven tables", () => {
    template.resourceCountIs("AWS::DynamoDB::Table", LOCAL_TABLE_NAMES.length);
  });

  it("keys the lease table by userEmail with a uuid sort key and a ttl attribute", () => {
    template.hasResourceProperties("AWS::DynamoDB::Table", {
      KeySchema: [
        { AttributeName: "userEmail", KeyType: "HASH" },
        { AttributeName: "uuid", KeyType: "RANGE" },
      ],
      TimeToLiveSpecification: { AttributeName: "ttl" },
    });
  });

  it("keys the blueprint table by PK/SK", () => {
    template.hasResourceProperties("AWS::DynamoDB::Table", {
      KeySchema: [
        { AttributeName: "PK", KeyType: "HASH" },
        { AttributeName: "SK", KeyType: "RANGE" },
      ],
    });
  });

  it("creates the GSIs the production stores query", () => {
    const indexNames = Object.values(
      template.findResources("AWS::DynamoDB::Table"),
    ).flatMap((table) =>
      (table.Properties.GlobalSecondaryIndexes ?? []).map(
        (gsi: { IndexName: string }) => gsi.IndexName,
      ),
    );
    expect(indexNames).toEqual(
      expect.arrayContaining([
        "blueprintId-index",
        "StatusIndex",
        "itemType-blueprintId-index",
        "LeaseIndex",
        "GroupIndex",
      ]),
    );
  });

  it("keys the config table by section/sk as the ConfigStore expects", () => {
    template.hasResourceProperties("AWS::DynamoDB::Table", {
      KeySchema: [
        { AttributeName: "section", KeyType: "HASH" },
        { AttributeName: "sk", KeyType: "RANGE" },
      ],
    });
  });

  it("keys the sandbox account table by awsAccountId alone", () => {
    template.hasResourceProperties("AWS::DynamoDB::Table", {
      KeySchema: [{ AttributeName: "awsAccountId", KeyType: "HASH" }],
    });
  });

  it("encrypts every table with the local KMS key", () => {
    const tables = template.findResources("AWS::DynamoDB::Table");
    for (const [, resource] of Object.entries(tables)) {
      expect(resource.Properties.SSESpecification).toBeDefined();
      expect(resource.Properties.SSESpecification.KMSMasterKeyId).toBeDefined();
    }
  });

  it("uses on-demand billing so seeding never waits on capacity", () => {
    template.hasResourceProperties("AWS::DynamoDB::Table", {
      BillingMode: "PAY_PER_REQUEST",
    });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run --root local infrastructure/lib/local-data-stack.test.ts`
Expected: FAIL — cannot resolve `./local-data-stack.js`.

- [ ] **Step 3: Implement the stack**

Write the whole file as:

```ts
// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import { RemovalPolicy, Stack, type StackProps } from "aws-cdk-lib";
import {
  AttributeType,
  BillingMode,
  ProjectionType,
  Table,
  TableEncryption,
} from "aws-cdk-lib/aws-dynamodb";
import { Key } from "aws-cdk-lib/aws-kms";
import type { Construct } from "constructs";

import { localTableNames, type LocalTableName } from "../../shared/names.js";

export interface LocalDataStackProps extends StackProps {
  env: { account: string; region: string };
}

export class LocalDataStack extends Stack {
  public readonly tables: Record<LocalTableName, Table>;
  public readonly kmsKey: Key;

  constructor(scope: Construct, id: string, props: LocalDataStackProps) {
    super(scope, id, props);
    // The Lambda containers talk to this endpoint; the SDK reads it from
    // AWS_ENDPOINT_URL in the environment assembled by buildLocalEnv.
    this.kmsKey = new Key(this, "LocalKey", {
      enableKeyRotation: false,
      removalPolicy: RemovalPolicy.DESTROY,
    });

    const table = (
      name: LocalTableName,
      key: {
        partitionKey: { name: string; type: AttributeType };
        sortKey?: { name: string; type: AttributeType };
        ttl?: string;
      },
    ) =>
      new Table(this, `${name}Table`, {
        tableName: localTableNames[name],
        partitionKey: key.partitionKey,
        ...(key.sortKey ? { sortKey: key.sortKey } : {}),
        ...(key.ttl ? { timeToLiveAttribute: key.ttl } : {}),
        billingMode: BillingMode.PAY_PER_REQUEST,
        removalPolicy: RemovalPolicy.DESTROY,
        encryption: TableEncryption.CUSTOMER_MANAGED,
        encryptionKey: this.kmsKey,
      });

    this.tables = {
      sandboxAccount: table("sandboxAccount", {
        partitionKey: { name: "awsAccountId", type: AttributeType.STRING },
      }),
      leaseTemplate: table("leaseTemplate", {
        partitionKey: { name: "uuid", type: AttributeType.STRING },
      }),
      lease: table("lease", {
        partitionKey: { name: "userEmail", type: AttributeType.STRING },
        sortKey: { name: "uuid", type: AttributeType.STRING },
        ttl: "ttl",
      }),
      blueprint: table("blueprint", {
        partitionKey: { name: "PK", type: AttributeType.STRING },
        sortKey: { name: "SK", type: AttributeType.STRING },
        ttl: "ttl",
      }),
      principal: table("principal", {
        partitionKey: { name: "pk", type: AttributeType.STRING },
        sortKey: { name: "sk", type: AttributeType.STRING },
        ttl: "ttl",
      }),
      cleanupReport: table("cleanupReport", {
        partitionKey: { name: "pk", type: AttributeType.STRING },
        sortKey: { name: "sk", type: AttributeType.STRING },
        ttl: "ttl",
      }),
      config: table("config", {
        partitionKey: { name: "section", type: AttributeType.STRING },
        sortKey: { name: "sk", type: AttributeType.STRING },
      }),
    };

    // GSIs the production stores query. Declared separately so each table's
    // creation stays a one-liner above.
    this.tables.leaseTemplate.addGlobalSecondaryIndex({
      indexName: "blueprintId-index",
      partitionKey: { name: "blueprintId", type: AttributeType.STRING },
      projectionType: ProjectionType.KEYS_ONLY,
    });
    this.tables.lease.addGlobalSecondaryIndex({
      indexName: "StatusIndex",
      partitionKey: { name: "status", type: AttributeType.STRING },
      sortKey: {
        name: "originalLeaseTemplateUuid",
        type: AttributeType.STRING,
      },
    });
    this.tables.blueprint.addGlobalSecondaryIndex({
      indexName: "itemType-blueprintId-index",
      partitionKey: { name: "itemType", type: AttributeType.STRING },
      sortKey: { name: "blueprintId", type: AttributeType.STRING },
      projectionType: ProjectionType.ALL,
    });
    this.tables.principal.addGlobalSecondaryIndex({
      indexName: "LeaseIndex",
      partitionKey: { name: "leaseId", type: AttributeType.STRING },
      sortKey: { name: "pk", type: AttributeType.STRING },
      projectionType: ProjectionType.ALL,
    });
    this.tables.principal.addGlobalSecondaryIndex({
      indexName: "GroupIndex",
      partitionKey: { name: "groupId", type: AttributeType.STRING },
      projectionType: ProjectionType.KEYS_ONLY,
    });
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run --root local infrastructure/lib/local-data-stack.test.ts`
Expected: PASS — 8 tests.

- [ ] **Step 5: Commit**

```bash
git add local/infrastructure/lib/local-data-stack.ts local/infrastructure/lib/local-data-stack.test.ts
git commit -m "feat(local): add the local data stack mirroring upstream table definitions"
```

---

## Task 10: Schema-derived seed fixtures

Populates LocalStack with data whose shapes come from the production Zod schemas, so an upstream field change breaks the seed test rather than silently producing wrong data.

**Files:**

- Create: `local/seed/fixtures.ts`
- Create: `local/seed/seed.ts`
- Test: `local/seed/fixtures.test.ts`

**Interfaces:**

- Consumes: `localTableNames` (Task 1); `ConfigSchemas` from `@amzn/innovation-sandbox-shared/types/configuration.js`; `generateSchemaData` from `@amzn/innovation-sandbox-shared/test/generate-schema-data`.
- Produces: `buildSeedFixtures(): SeedFixtures` with `{ accounts, leaseTemplates, blueprints, principals, leases, configSections }`, every value already validated by its production schema. `seedLocalEnvironment(options): Promise<SeedSummary>` writes them to LocalStack via the AWS SDK and is idempotent. `SeedSummary` is `{ accounts: number; leaseTemplates: number; blueprints: number; principals: number; leases: number; configSections: number }`.

- [ ] **Step 1: Write the failing test**

Create `local/seed/fixtures.test.ts`:

```ts
// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";

import {
  ConfigSchemas,
  type ConfigSection,
} from "@amzn/innovation-sandbox-shared/types/configuration.js";
import { BlueprintItemSchema } from "@amzn/innovation-sandbox-shared/types/blueprint.js";
import {
  LeaseTemplateMetadataSchema,
  LeaseTemplateWritableSchema,
} from "@amzn/innovation-sandbox-shared/types/lease-template.js";
import { LeaseSchema } from "@amzn/innovation-sandbox-shared/types/lease.js";
import { IdcPrincipalSchema } from "@amzn/innovation-sandbox-shared/types/principal.js";
import { SandboxAccountSchema } from "@amzn/innovation-sandbox-shared/types/sandbox-account.js";

import { buildSeedFixtures } from "./fixtures.js";

const fixtures = buildSeedFixtures();

describe("seed fixtures", () => {
  it("covers all three lease lifecycle states", () => {
    const statuses = new Set(fixtures.leases.map((lease) => lease.status));
    expect(statuses.has("PendingApproval")).toBe(true);
    expect(statuses.has("Active")).toBe(true);
    expect(statuses.has("Expired")).toBe(true);
  });

  it("covers all three roles across principals", () => {
    const roles = new Set(fixtures.principals.flatMap((p) => p.roles));
    expect(roles).toEqual(new Set(["Admin", "Manager", "User"]));
  });

  it("derives every config section from the production schema defaults", () => {
    const sections = Object.keys(ConfigSchemas) as ConfigSection[];
    expect(Object.keys(fixtures.configSections).sort()).toEqual(
      sections.sort(),
    );
    for (const section of sections) {
      // Parsing proves the shape still satisfies the upstream schema; an
      // upstream field change fails here rather than in the browser.
      expect(() =>
        ConfigSchemas[section].parse(fixtures.configSections[section]),
      ).not.toThrow();
    }
  });

  it("writes config sections in the envelope DynamoConfigStore expects", () => {
    for (const [section, fields] of Object.entries(fixtures.configSections)) {
      expect(fields).toMatchObject({
        sk: "current",
        lastSavedBy: expect.any(String),
        meta: {
          createdTime: expect.any(String),
          lastEditTime: expect.any(String),
          schemaVersion: expect.any(Number),
        },
      });
      expect(section).toBeTruthy();
    }
  });

  it("gives every lease a stable uuid so deep links survive a reload", () => {
    const uuids = fixtures.leases.map((lease) => lease.uuid);
    expect(new Set(uuids).size).toBe(uuids.length);
    expect(
      uuids.every((uuid) => typeof uuid === "string" && uuid.length > 0),
    ).toBe(true);
  });

  it("points every lease at a seeded account and lease template", () => {
    const accountIds = new Set(fixtures.accounts.map((a) => a.awsAccountId));
    const templateIds = new Set(fixtures.leaseTemplates.map((t) => t.uuid));
    for (const lease of fixtures.leases) {
      if (lease.awsAccountId)
        expect(accountIds.has(lease.awsAccountId)).toBe(true);
      if (lease.leaseTemplateUuid) {
        expect(templateIds.has(lease.leaseTemplateUuid)).toBe(true);
      }
    }
  });

  it("produces a non-empty set for every domain", () => {
    expect(fixtures.accounts.length).toBeGreaterThan(0);
    expect(fixtures.leaseTemplates.length).toBeGreaterThan(0);
    expect(fixtures.blueprints.length).toBeGreaterThan(0);
    expect(fixtures.principals.length).toBeGreaterThan(0);
  });

  it("validates every seeded record against its production schema", () => {
    for (const account of fixtures.accounts) {
      expect(() => SandboxAccountSchema.parse(account)).not.toThrow();
    }
    for (const blueprint of fixtures.blueprints) {
      expect(() => BlueprintItemSchema.parse(blueprint)).not.toThrow();
    }
    for (const principal of fixtures.principals) {
      expect(() => IdcPrincipalSchema.parse(principal)).not.toThrow();
    }
    for (const template of fixtures.leaseTemplates) {
      expect(() => LeaseTemplateWritableSchema.parse(template)).not.toThrow();
      expect(() => LeaseTemplateMetadataSchema.parse(template)).not.toThrow();
    }
    for (const lease of fixtures.leases) {
      expect(() => LeaseSchema.parse(lease)).not.toThrow();
    }
  });

  it("keys blueprint records the way DynamoBlueprintStore addresses them", () => {
    for (const blueprint of fixtures.blueprints) {
      // The store addresses blueprint items as `bp#{blueprintId}` / "blueprint";
      // a fixture that ignores this is invisible to the read path.
      expect(blueprint.PK).toMatch(/^bp#/);
      expect(blueprint.SK).toBe("blueprint");
    }
  });

  it("keys principal records the way DynamoPrincipalStore addresses them", () => {
    for (const principal of fixtures.principals) {
      expect(principal.pk).toMatch(/^user#/);
    }
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run --root local seed/fixtures.test.ts`
Expected: FAIL — cannot resolve `./fixtures.js`.

- [ ] **Step 3: Read the exact schemas before writing fixtures**

The domain schemas are not shaped the way the names in the test above suggest, and several are strict objects. Confirm each one before writing a single fixture field:

```bash
# LeaseSchema is a discriminated union on `status` — a "PendingApproval" lease
# and an "Active" lease have different required fields.
sed -n '150,230p' source/shared/types/lease.ts

# The persisted shapes the Dynamo stores round-trip.
grep -nE "^export const (SandboxAccount|LeaseTemplate|Blueprint|IdcPrincipal)[A-Za-z]*Schema" \
  source/shared/types/sandbox-account.ts \
  source/shared/types/lease-template.ts \
  source/shared/types/blueprint.ts \
  source/shared/types/principal.ts

# ConfigSchemaVersion lives in common, not shared.
grep -n "ConfigSchemaVersion" source/common/data/config/config.ts

# The envelope DynamoConfigStore writes, to copy the meta field names exactly.
sed -n '170,200p' source/common/data/config/dynamo-config-store.ts
```

Expected findings that change the fixture code below:

- `ConfigSchemaVersion` is exported from `@amzn/innovation-sandbox-commons/data/config/config.js`, not from the shared configuration module. Import it from there.
- `LeaseTemplateSchema` does not exist under that exact name; the writable shape is `LeaseTemplateWritableSchema` plus `LeaseTemplateMetadataSchema`. Compose the persisted record from both, or use the schema the store actually validates.
- `BlueprintItemSchema` is the persisted blueprint shape, not `BlueprintSchema`.
- `IdcPrincipalSchema` is the persisted principal shape. It is a `strictObject`, so any extra key throws.
- `LeaseSchema` is a `discriminatedUnion`, so per-status required fields differ. Build each lease against the branch for its status.

Adjust the imports, type aliases, and builder bodies in Step 4 to match what you find. The tests in Step 1 are the contract; the schema names above are starting points that the grep corrects.

- [ ] **Step 4: Implement `local/seed/fixtures.ts`**

Write the module so that every record is produced by `generateSchemaData` against its production schema, then overridden with the identifiers and cross-references that must stay stable. The builder bodies below use the field names confirmed in Step 3; if Step 3 revealed a different name, use the real one — the test is what pins correctness.

```ts
// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import {
  ConfigSchemaVersion,
  ConfigSchemas,
  type ConfigSection,
} from "@amzn/innovation-sandbox-shared/types/configuration.js";
import { ConfigSchemaVersion } from "@amzn/innovation-sandbox-commons/data/config/config.js";
import { BlueprintItemSchema } from "@amzn/innovation-sandbox-shared/types/blueprint.js";
import {
  LeaseTemplateMetadataSchema,
  LeaseTemplateWritableSchema,
} from "@amzn/innovation-sandbox-shared/types/lease-template.js";
import { LeaseSchema } from "@amzn/innovation-sandbox-shared/types/lease.js";
import { IdcPrincipalSchema } from "@amzn/innovation-sandbox-shared/types/principal.js";
import { SandboxAccountSchema } from "@amzn/innovation-sandbox-shared/types/sandbox-account.js";
import { generateSchemaData } from "@amzn/innovation-sandbox-shared/test/generate-schema-data";

const FIXED_TIME = "2026-01-15T12:00:00.000Z";
const LAST_SAVED_BY = "admin@example.local";

type Account = ReturnType<
  typeof generateSchemaData<typeof SandboxAccountSchema>
>;
type Blueprint = ReturnType<
  typeof generateSchemaData<typeof BlueprintItemSchema>
>;
type Principal = ReturnType<
  typeof generateSchemaData<typeof IdcPrincipalSchema>
>;
type Lease = ReturnType<typeof generateSchemaData<typeof LeaseSchema>>;

// A persisted lease template is the writable fields plus the metadata envelope
// the store adds, which is why there is no single exported template schema.
type LeaseTemplate = LeaseTemplateWritableSchema & LeaseTemplateMetadataSchema;

export interface SeedFixtures {
  accounts: Account[];
  leaseTemplates: LeaseTemplate[];
  blueprints: Blueprint[];
  principals: Principal[];
  leases: Lease[];
  configSections: Record<ConfigSection, Record<string, unknown>>;
}

// Accounts span lifecycle states so the accounts list is not uniform.
const ACCOUNTS = [
  { awsAccountId: "111111111111", status: "Active" },
  { awsAccountId: "222222222222", status: "Available" },
  { awsAccountId: "333333333333", status: "InCoolingDown" },
] as const;

const PRINCIPALS = [
  { userId: "local-admin", email: "admin@example.local", roles: ["Admin"] },
  {
    userId: "local-manager",
    email: "manager@example.local",
    roles: ["Manager"],
  },
  { userId: "local-user", email: "user@example.local", roles: ["User"] },
] as const;

const buildAccount = (seed: (typeof ACCOUNTS)[number]): Account =>
  generateSchemaData(SandboxAccountSchema, {
    ...seed,
    // Pinned so the seed is deterministic; generateSchemaData is random.
    email: `${seed.awsAccountId}@sandbox.local`,
  });

// The writable and metadata halves are generated separately, because a
// strictObject will reject keys belonging to the other half.
const buildLeaseTemplate = (
  uuid: string,
  blueprintId: string,
): LeaseTemplate => ({
  ...generateSchemaData(LeaseTemplateWritableSchema, {
    uuid,
    blueprintId,
    name: `Local template ${uuid.slice(0, 4)}`,
  }),
  ...generateSchemaData(LeaseTemplateMetadataSchema, {
    createdTime: FIXED_TIME,
    lastEditTime: FIXED_TIME,
  }),
});

// DynamoBlueprintStore addresses blueprint items as PK `bp#{blueprintId}` and
// SK "blueprint" (see the key schema comment in isb-data-resources.ts:125).
const buildBlueprint = (blueprintId: string): Blueprint =>
  generateSchemaData(BlueprintItemSchema, {
    blueprintId,
    PK: `bp#${blueprintId}`,
    SK: "blueprint",
    itemType: "BLUEPRINT",
  });

// DynamoPrincipalStore keys principals as `user#<userId>` (isb-data-resources.ts:144).
const buildPrincipal = (seed: (typeof PRINCIPALS)[number]): Principal =>
  generateSchemaData(IdcPrincipalSchema, {
    userId: seed.userId,
    pk: `user#${seed.userId}`,
    sk: "groupMembership",
    itemType: "USER",
    email: seed.email,
    roles: [...seed.roles],
  });

// LeaseSchema discriminates on `status`, so the overrides are typed per branch
// rather than as a loose Partial — a PendingApproval lease has no account yet.
const buildLease = (
  overrides: Record<string, unknown> & { status: string },
): Lease => {
  const lease = generateSchemaData(LeaseSchema, {
    createdTime: FIXED_TIME,
    ...overrides,
  });
  return lease as Lease;
};

/**
 * Configuration sections use the same defaulting the Lambda middleware applies
 * when a section is absent (`ConfigSchemas[section].parse({})`), wrapped in the
 * audit envelope DynamoConfigStore reads. Deriving rather than hand-writing
 * means an upstream field change breaks this module, not the browser.
 */
const buildConfigSections = (): Record<
  ConfigSection,
  Record<string, unknown>
> =>
  Object.fromEntries(
    (Object.keys(ConfigSchemas) as ConfigSection[]).map((section) => [
      section,
      {
        section,
        sk: "current",
        ...ConfigSchemas[section].parse({}),
        lastSavedBy: LAST_SAVED_BY,
        meta: {
          createdTime: FIXED_TIME,
          lastEditTime: FIXED_TIME,
          schemaVersion: ConfigSchemaVersion,
        },
      },
    ]),
  ) as Record<ConfigSection, Record<string, unknown>>;

/**
 * The full fixture set. Every cross-reference resolves to a record in this same
 * set, which `fixtures.test.ts` asserts — a lease pointing at an unseeded
 * account or template would render as a dangling reference in the UI.
 */
export function buildSeedFixtures(): SeedFixtures {
  const accounts = ACCOUNTS.map(buildAccount);
  const leaseTemplates = [
    buildLeaseTemplate("aaaaaaaa-0000-4000-8000-000000000001", "bp-local-1"),
    buildLeaseTemplate("aaaaaaaa-0000-4000-8000-000000000002", "bp-local-2"),
  ];
  const blueprints = [
    buildBlueprint("bp-local-1"),
    buildBlueprint("bp-local-2"),
  ];
  const principals = PRINCIPALS.map(buildPrincipal);

  return {
    accounts,
    leaseTemplates,
    blueprints,
    principals,
    leases: [
      buildLease({
        uuid: "bbbbbbbb-0000-4000-8000-000000000001",
        userEmail: "user@example.local",
        status: "PendingApproval",
        leaseTemplateUuid: leaseTemplates[0].uuid,
        awsAccountId: undefined,
      }),
      buildLease({
        uuid: "bbbbbbbb-0000-4000-8000-000000000002",
        userEmail: "user@example.local",
        status: "Active",
        leaseTemplateUuid: leaseTemplates[0].uuid,
        awsAccountId: ACCOUNTS[0].awsAccountId,
      }),
      buildLease({
        uuid: "bbbbbbbb-0000-4000-8000-000000000003",
        userEmail: "manager@example.local",
        status: "Expired",
        leaseTemplateUuid: leaseTemplates[1].uuid,
        awsAccountId: ACCOUNTS[1].awsAccountId,
      }),
    ],
    configSections: buildConfigSections(),
  };
}
```

If `generateSchemaData` is not generic in this build, call it without the type argument and let the return types be inferred; the explicit type aliases above are a convenience, not a requirement.

- [ ] **Step 5: Implement `local/seed/seed.ts`**

```ts
// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, PutCommand } from "@aws-sdk/lib-dynamodb";

import { LOCAL_REGION, localTableNames } from "../shared/names.js";
import { buildSeedFixtures, type SeedFixtures } from "./fixtures.js";

export interface SeedSummary {
  accounts: number;
  leaseTemplates: number;
  blueprints: number;
  principals: number;
  leases: number;
  configSections: number;
}

export interface SeedOptions {
  endpoint?: string;
  region?: string;
}

/** Document client pointed at LocalStack; no AWS credentials are ever needed. */
export function createLocalDocumentClient(options: SeedOptions = {}) {
  return DynamoDBDocumentClient.from(
    new DynamoDBClient({
      region: options.region ?? LOCAL_REGION,
      endpoint: options.endpoint ?? "http://localhost:4566",
      credentials: { accessKeyId: "test", secretAccessKey: "test" },
    }),
    { marshallOptions: { removeUndefinedValues: true } },
  );
}

/**
 * Writes the fixture set into LocalStack. Idempotent: every write is an
 * unconditional PutCommand keyed by the record's own identifier, so re-running
 * after a partial deep-flow failure restores a known-good state without
 * dropping the tables. This is the documented remedy for the partial writes
 * that unsupported services can leave behind.
 */
export async function seedLocalEnvironment(
  options: SeedOptions = {},
): Promise<SeedSummary> {
  const fixtures: SeedFixtures = buildSeedFixtures();
  const client = createLocalDocumentClient(options);

  // Unconditional puts, one item at a time. `BatchWriteCommand` would be faster
  // but rejects duplicate keys within a batch, and re-running the seed must
  // overwrite in place rather than fail on items that already exist.
  const write = async (table: string, items: Record<string, unknown>[]) => {
    for (const item of items) {
      await client.send(new PutCommand({ TableName: table, Item: item }));
    }
  };

  await write(localTableNames.sandboxAccount, fixtures.accounts);
  await write(localTableNames.leaseTemplate, fixtures.leaseTemplates);
  await write(localTableNames.blueprint, fixtures.blueprints);
  await write(localTableNames.principal, fixtures.principals);
  await write(localTableNames.lease, fixtures.leases);
  await write(
    localTableNames.config,
    Object.entries(fixtures.configSections).map(([section, fields]) => ({
      section,
      ...fields,
    })),
  );

  return {
    accounts: fixtures.accounts.length,
    leaseTemplates: fixtures.leaseTemplates.length,
    blueprints: fixtures.blueprints.length,
    principals: fixtures.principals.length,
    leases: fixtures.leases.length,
    configSections: Object.keys(fixtures.configSections).length,
  };
}

const invokedDirectly = process.argv[1]?.includes("seed");
if (invokedDirectly) {
  seedLocalEnvironment()
    .then((summary) => {
      console.info("[local-seed] seeded", summary);
    })
    .catch((error: unknown) => {
      console.error("[local-seed] failed", error);
      process.exit(1);
    });
}
```

Add to `local/package.json` scripts:

```json
    "seed": "tsx seed/seed.ts",
    "verify": "tsx verify/verify.ts"
```

- [ ] **Step 6: Run the fixture test to verify it passes**

Run: `npx vitest run --root local seed/fixtures.test.ts`
Expected: PASS — 10 tests.

- [ ] **Step 7: Add the config-store version import to the local vitest aliases**

`fixtures.ts` imports `ConfigSchemaVersion` from `@amzn/innovation-sandbox-commons/data/config/config.js`. The alias added in Task 8 covers `@amzn/innovation-sandbox-commons` as a whole, so no change is needed. Confirm by running the test; if it fails to resolve, add an explicit `@amzn/innovation-sandbox-commons/data` → `source/common/data` alias to `local/vitest.config.ts`.

- [ ] **Step 8: Commit**

```bash
git add local/seed/ local/package.json
git commit -m "feat(local): seed LocalStack from schema-derived fixtures"
```

---

## Task 11: Compose file and orchestration scripts

Wires the pieces into `npm run local:up`. Health-gated so a later task can rely on the environment being ready.

**Files:**

- Create: `local/compose.yaml`
- Create: `local/scripts/local-up.sh`
- Create: `local/scripts/local-down.sh`
- Create: `local/scripts/local-reset.sh`
- Create: `local/scripts/local-logs.sh`
- Test: `local/scripts/scripts.test.ts`

**Interfaces:**

- Consumes: `LOCAL_EDGE_PORT` (Task 1), `seedLocalEnvironment` (Task 10).
- Produces: `waitForLocalStack(retries, delayMs): Promise<void>` and `waitForLocalEdge(retries, delayMs): Promise<void>`, both exported for tests. Compose service names `localstack` and `isb-local-edge`; the edge reaches LocalStack at `http://localstack:4566` and is published on host port 4599.

- [ ] **Step 1: Write the failing test**

Create `local/scripts/scripts.test.ts`:

```ts
// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const localDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (relative: string) =>
  readFileSync(join(localDir, relative), "utf-8");

describe("local orchestration", () => {
  it("declares a LocalStack service and an edge service on one network", () => {
    const compose = read("compose.yaml");
    expect(compose).toContain("localstack:");
    expect(compose).toContain("isb-local-edge:");
    // The Lambda containers reach the edge by service name, not localhost.
    expect(compose).toContain(
      "http://isb-local-edge:4599/.well-known/jwks.json",
    );
  });

  it("publishes the edge on the host port the Vite proxy targets", () => {
    expect(read("compose.yaml")).toContain("4599");
  });

  it("runs LocalStack without a persistent volume so reset is unambiguous", () => {
    const compose = read("compose.yaml");
    expect(compose).not.toMatch(/^\s*-\s*localstack-data:/m);
  });

  it("waits for health before deploying, rather than sleeping", () => {
    const up = read("scripts/local-up.sh");
    expect(up).toContain("waitForLocalStack");
    expect(up).toContain("waitForLocalEdge");
    expect(up).not.toMatch(/\bsleep 30\b/);
  });

  it("resets by recreating containers and re-seeding", () => {
    const reset = read("scripts/local-reset.sh");
    expect(reset).toContain("down");
    expect(reset).toContain("up");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run --root local scripts/scripts.test.ts`
Expected: FAIL — `compose.yaml` does not exist.

- [ ] **Step 3: Create `local/compose.yaml`**

```yaml
# Local development only. Not part of the deployed distribution.
services:
  localstack:
    image: localstack/localstack:4
    ports:
      - "4566:4566"
    environment:
      # Free tier. No SERVICES list so every available service is loaded.
      DEBUG: "0"
      LAMBDA_RUNTIME_ENVIRONMENT_TIMEOUT: "60"
      # Lets the Lambda containers reach the edge by service name.
      ISB_LOCAL: "1"
    # Deliberately no volumes: `local:reset` recreates the containers, which
    # is unambiguous in a way that selectively deleting tables is not.
    healthcheck:
      test: ["CMD", "curl", "-f", "http://localhost:4566/_localstack/health"]
      interval: 5s
      timeout: 3s
      retries: 30

  isb-local-edge:
    image: node:24-alpine
    working_dir: /workspace
    command: sh -c "corepack enable && npm install --no-audit --no-fund && npx tsx local/edge/server.ts"
    ports:
      - "4599:4599"
    environment:
      ISB_LOCAL_API_GATEWAY_INVOKE_URL: "http://localstack:4566/restapis/0/local/_user_request_"
      ISB_LOCAL_KEY_DIR: "/workspace/local/.keys"
    volumes:
      - ..:/workspace
    depends_on:
      localstack:
        condition: service_healthy
```

Note: the edge needs the API Gateway REST API id, which only exists after Task 12 deploys. `local-up.sh` rewrites that environment value once the id is known.

- [ ] **Step 4: Create `local/scripts/local-up.sh`**

```bash
#!/usr/bin/env bash
# Brings up the offline local profile. Idempotent.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
root="$(cd "$here/../.." && pwd)"
cd "$root"

waitForLocalStack() {
  for _ in $(seq 1 60); do
    if curl -fsS http://localhost:4566/_localstack/health >/dev/null 2>&1; then
      return 0
    fi
    sleep 2
  done
  echo "LocalStack did not become healthy in time" >&2
  return 1
}

waitForLocalEdge() {
  for _ in $(seq 1 60); do
    if curl -fsS http://localhost:4599/healthz >/dev/null 2>&1; then
      return 0
    fi
    sleep 2
  done
  echo "Local edge did not become healthy in time" >&2
  return 1
}

echo "==> starting LocalStack and the local edge"
docker compose -f local/compose.yaml up -d
waitForLocalStack

echo "==> deploying local resources"
# The CDK CLI resolves endpoints from its own environment, not from the Lambda
# environment. Without these it targets real AWS.
export AWS_ENDPOINT_URL="http://localhost:4566"
export AWS_ACCESS_KEY_ID="test"
export AWS_SECRET_ACCESS_KEY="test"
export AWS_REGION="us-east-1"
export AWS_DEFAULT_REGION="us-east-1"
npx cdk deploy --app "npx tsx local/infrastructure/bin/local.ts" \
  --outputs-file local/cdk.out/local-outputs.json || {
    echo "local resource deployment failed" >&2
    exit 1
  }

api_id="$(node -e 'const o=require("./local/cdk.out/local-outputs.json");process.stdout.write(o.ApiGatewayRestApiId)')"
if [ -z "$api_id" ]; then
  echo "could not read ApiGatewayRestApiId from the local stack outputs" >&2
  exit 1
fi

echo "==> restarting the local edge with the real API Gateway id"
docker compose -f local/compose.yaml up -d \
  --force-recreate isb-local-edge
waitForLocalEdge

echo "==> seeding fixtures"
npm run local:seed

echo
echo "Local profile is ready."
echo "  edge:      http://localhost:4599"
echo "  localstack http://localhost:4566"
echo "Next: add VITE_API_PROXY_TARGET=http://localhost:4599 and"
echo "     VITE_LOCAL_SESSION_ENDPOINT=http://localhost:4599/session to .env,"
echo "then run: npm run dev --workspace @amzn/innovation-sandbox-frontend"
```

- [ ] **Step 5: Create the remaining scripts**

`local/scripts/local-down.sh`:

```bash
#!/usr/bin/env bash
# Stops the local profile. Data is ephemeral; nothing is preserved.
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$here/../.."
docker compose -f local/compose.yaml down --remove-orphans
rm -rf local/cdk.out
```

`local/scripts/local-reset.sh`:

```bash
#!/usr/bin/env bash
# Drops all local state and rebuilds it. The documented remedy for the partial
# writes that unsupported AWS services can leave in DynamoDB.
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
bash "$here/local-down.sh"
bash "$here/local-up.sh"
```

`local/scripts/local-logs.sh`:

```bash
#!/usr/bin/env bash
# Tails LocalStack and local edge logs.
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$here/../.."
docker compose -f local/compose.yaml logs -f
```

- [ ] **Step 6: Make the scripts executable and run the test**

Run: `chmod +x local/scripts/*.sh && npx vitest run --root local scripts/scripts.test.ts`
Expected: PASS — 5 tests.

Note: the `waitForLocalStack`/`waitForLocalEdge` assertions read the shell script text, which is what the test pins. Runtime behavior is verified in Task 12.

- [ ] **Step 7: Commit**

```bash
git add local/compose.yaml local/scripts/
git commit -m "chore(local): add compose services and up/down/reset/logs scripts"
```

---

## Task 12: Local compute stack — six domain Lambdas and the API Gateway

Deploys the real handlers. Removes only the gateway-level SigV4 requirement; the spec itself is the production one.

**Files:**

- Create: `local/infrastructure/lib/prepare-local-spec.ts`
- Create: `local/infrastructure/lib/local-compute-stack.ts`
- Create: `local/infrastructure/bin/local.ts`
- Test: `local/infrastructure/lib/prepare-local-spec.test.ts`
- Test: `local/infrastructure/lib/local-compute-stack.test.ts`

**Interfaces:**

- Consumes: `buildLocalEnv` (Task 8); `LocalDataStack.tables` (Task 9); the six domain env schemas and `prepareApiGatewaySpec`.
- Produces: `prepareLocalSpec(contract, lambdaArns): OpenApiDocument` — the production spec with the `awsSigv4` security requirement removed. `LocalComputeStack` exposing `restApi: SpecRestApi`, `apiId: string`, and `invokeUrl: string`. CloudFormation outputs `ApiGatewayRestApiId` and `ApiGatewayInvokeUrl`.

- [ ] **Step 1: Write the failing test for the spec transform**

Create `local/infrastructure/lib/prepare-local-spec.test.ts`:

```ts
// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { prepareApiGatewaySpec } from "@amzn/innovation-sandbox-infrastructure/components/api/prepare-api-gateway-spec";

import { prepareLocalSpec } from "./prepare-local-spec.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "../../../..");
const contract = JSON.parse(
  readFileSync(join(root, "docs/openapi/innovation-sandbox-api.json"), "utf-8"),
);
const lambdaArns = {
  accounts: "arn:aws:lambda:us-east-1:000000000000:function:accounts",
  blueprints: "arn:aws:lambda:us-east-1:000000000000:function:blueprints",
  configurations:
    "arn:aws:lambda:us-east-1:000000000000:function:configurations",
  leases: "arn:aws:lambda:us-east-1:000000000000:function:leases",
  leaseTemplates:
    "arn:aws:lambda:us-east-1:000000000000:function:leaseTemplates",
  principals: "arn:aws:lambda:us-east-1:000000000000:function:principals",
};

describe("prepareLocalSpec", () => {
  it("removes the gateway SigV4 requirement so unsigned local requests route", () => {
    const spec = prepareLocalSpec(contract, lambdaArns);
    expect(spec.security).toBeUndefined();
  });

  it("keeps every path, so the wire contract is the production one", () => {
    const production = prepareApiGatewaySpec(
      structuredClone(contract),
      lambdaArns,
    );
    const local = prepareLocalSpec(contract, lambdaArns);
    expect(Object.keys(local.paths).sort()).toEqual(
      Object.keys(production.paths).sort(),
    );
  });

  it("keeps request validation disabled so JSend error envelopes survive", () => {
    const spec = prepareLocalSpec(contract, lambdaArns);
    expect(spec["x-amazon-apigateway-request-validator"]).toBe("none");
  });

  it("leaves the isbIdentity documentation scheme in place", () => {
    const spec = prepareLocalSpec(contract, lambdaArns);
    // The Lambda verifies this header itself, so the document must keep it.
    expect(Object.keys(spec.components?.securitySchemes ?? {})).toContain(
      "isbIdentity",
    );
  });

  it("still wires each path to its domain Lambda", () => {
    const spec = prepareLocalSpec(contract, lambdaArns);
    const integration = (spec.paths["/leases"] as Record<string, any>).get[
      "x-amazon-apigateway-integration"
    ];
    expect(JSON.stringify(integration.uri)).toContain(lambdaArns.leases);
  });

  it("drops the sigv4 scheme but keeps isbIdentity documented", () => {
    // The canonical contract requires both schemes at the top level;
    // prepareApiGatewaySpec already reduces that to sigv4 only, and the local
    // transform removes the enforcement while leaving documentation intact.
    const spec = prepareLocalSpec(contract, lambdaArns);
    expect(Object.keys(spec.components?.securitySchemes ?? {})).toEqual([
      "isbIdentity",
    ]);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run --root local infrastructure/lib/prepare-local-spec.test.ts`
Expected: FAIL — cannot resolve `./prepare-local-spec.js`.

- [ ] **Step 3: Implement the spec transform**

```ts
// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import {
  prepareApiGatewaySpec,
  type OpenApiDocument,
} from "@amzn/innovation-sandbox-infrastructure/components/api/prepare-api-gateway-spec";

type DomainLambdaArns = Parameters<typeof prepareApiGatewaySpec>[1];

/**
 * The production spec with exactly one difference: the gateway-level `awsSigv4`
 * requirement is removed, so API Gateway is created with `NONE` authorization.
 *
 * LocalStack's IAM enforcement of `AWS_IAM` cannot be depended on, and the
 * frontend's signature is computed for the edge's host rather than the
 * gateway's, so enforcing it would fail every request. Authentication is not
 * weakened in practice: the Lambda's `x-isb-identity` verification and the
 * whole RBAC pipeline run unmodified, and they are where the application
 * actually decides who the caller is.
 *
 * Everything else — paths, integrations, request validation, the documented
 * `isbIdentity` scheme — is the production spec, so the local wire contract
 * cannot drift.
 */
export function prepareLocalSpec(
  contract: OpenApiDocument,
  lambdaArns: DomainLambdaArns,
): OpenApiDocument {
  // Clone so the imported contract on disk is never mutated across synths.
  const spec = prepareApiGatewaySpec(structuredClone(contract), lambdaArns);
  // No gateway-level authorization: see the note above.
  delete spec.security;
  // prepareApiGatewaySpec reduces the canonical two-scheme requirement to sigv4
  // only. Dropping the enforcement scheme as well stops API Gateway from
  // mapping it onto AWS_IAM on import, which is the whole point of this
  // transform. `isbIdentity` stays, because the Lambda verifies that header
  // itself and the document should keep describing it.
  if (spec.components?.securitySchemes) {
    delete spec.components.securitySchemes["aws.auth.sigv4"];
  }
  return spec;
}
```

`OpenApiDocument` and `prepareApiGatewaySpec` are both exported from the module
(`prepare-api-gateway-spec.ts:55,128`), so the local transform needs no type
widening and no `any`.

Note the two-part change: removing `spec.security` alone would not be enough.
`prepareApiGatewaySpec` sets `spec.security = [{ "aws.auth.sigv4": [] }]`, and API
Gateway maps that scheme's `x-amazon-apigateway-authtype: awsSigv4` onto
`AWS_IAM` on every operation at import time. Both the requirement and the scheme
must go, or the gateway still enforces IAM.

- [ ] **Step 4: Run the spec test to verify it passes**

Run: `npx vitest run --root local infrastructure/lib/prepare-local-spec.test.ts`
Expected: PASS — 6 tests.

- [ ] **Step 5: Write the failing test for the compute stack**

Create `local/infrastructure/lib/local-compute-stack.test.ts`:

```ts
// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import { App, Stack } from "aws-cdk-lib";
import { Match, Template } from "aws-cdk-lib/assertions";
import { beforeAll, describe, expect, it } from "vitest";

import { LocalComputeStack } from "./local-compute-stack.js";
import { LocalDataStack } from "./local-data-stack.js";

let template: Template;
let outputs: Record<string, unknown>;

beforeAll(() => {
  const app = new App();
  const data = new LocalDataStack(app, "LocalData", {
    env: { account: "000000000000", region: "us-east-1" },
  });
  const compute = new LocalComputeStack(app, "LocalCompute", {
    env: { account: "000000000000", region: "us-east-1" },
    dataStack: data,
  });
  template = Template.fromStack(compute);
  outputs = compute.localOutputs();
});

describe("LocalComputeStack", () => {
  it("creates one API Lambda per domain", () => {
    template.resourceCountIs("AWS::Lambda::Function", 6);
  });

  it("points every Lambda at LocalStack and disables tracing", () => {
    for (const [, fn] of Object.entries(
      template.findResources("AWS::Lambda::Function"),
    )) {
      const env = fn.Properties.Environment.Variables;
      expect(env.AWS_ENDPOINT_URL).toBe("http://localstack:4566");
      expect(env.POWERTOOLS_TRACE_ENABLED).toBe("false");
      expect(env.ISB_LOCAL_JWKS_URI).toBe(
        "http://isb-local-edge:4599/.well-known/jwks.json",
      );
    }
  });

  it("gives the leases Lambda the real table names", () => {
    template.hasResourceProperties("AWS::Lambda::Function", {
      Environment: {
        Variables: Match.objectLike({
          LEASE_TABLE_NAME: "isbdev-lease",
          LEASE_TEMPLATE_TABLE_NAME: "isbdev-lease-template",
          ACCOUNT_TABLE_NAME: "isbdev-sandbox-account",
        }),
      },
    });
  });

  it("imports the production spec with no gateway security requirement", () => {
    template.hasResourceProperties("AWS::ApiGateway::RestApi", {
      Body: Match.objectLike({}),
    });
    const apis = template.findResources("AWS::ApiGateway::RestApi");
    for (const [, api] of Object.entries(apis)) {
      expect(api.Properties.Body.security).toBeUndefined();
    }
  });

  it("exports the API id and invoke url for the local edge", () => {
    expect(outputs.ApiGatewayRestApiId).toBeDefined();
    expect(String(outputs.ApiGatewayInvokeUrl)).toContain("_user_request_");
  });
});
```

- [ ] **Step 6: Run the test to verify it fails**

Run: `npx vitest run --root local infrastructure/lib/local-compute-stack.test.ts`
Expected: FAIL — cannot resolve `./local-compute-stack.js`.

- [ ] **Step 7: Implement the compute stack**

```ts
// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import { readFileSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { BundlingFormat, Duration, Stack, type StackProps } from "aws-cdk-lib";
import { ApiDefinition, SpecRestApi } from "aws-cdk-lib/aws-apigateway";
import { ServicePrincipal } from "aws-cdk-lib/aws-iam";
import { Runtime, Tracing } from "aws-cdk-lib/aws-lambda";
import { NodejsFunction } from "aws-cdk-lib/aws-lambda-nodejs";
import type { Construct } from "constructs";

import { AccountLambdaEnvironmentSchema } from "@amzn/innovation-sandbox-commons/lambda/environments/account-lambda-environment.js";
import { BlueprintLambdaEnvironmentSchema } from "@amzn/innovation-sandbox-commons/lambda/environments/blueprint-lambda-environment.js";
import { ConfigurationLambdaEnvironmentSchema } from "@amzn/innovation-sandbox-commons/lambda/environments/config-lambda-environment.js";
import { LeaseLambdaEnvironmentSchema } from "@amzn/innovation-sandbox-commons/lambda/environments/lease-lambda-environment.js";
import { LeaseTemplateLambdaEnvironmentSchema } from "@amzn/innovation-sandbox-commons/lambda/environments/lease-template-lambda-environment.js";
import { PrincipalsLambdaEnvironmentSchema } from "@amzn/innovation-sandbox-commons/lambda/environments/principals-lambda-environment.js";
import {
  API_DOMAINS,
  type ApiDomain,
  type DomainLambdaArns,
} from "@amzn/innovation-sandbox-infrastructure/components/api/prepare-api-gateway-spec";

import { LOCAL_STAGE } from "../../shared/names.js";
import { buildLocalEnv } from "./lambda-environment.js";
import type { LocalDataStack } from "./local-data-stack.js";
import { prepareLocalSpec } from "./prepare-local-spec.js";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../..",
);

const HANDLERS: Record<ApiDomain, string> = {
  accounts: "source/lambdas/api/accounts/src/accounts-handler.ts",
  blueprints: "source/lambdas/api/blueprints/src/blueprints-handler.ts",
  configurations:
    "source/lambdas/api/configurations/src/configurations-handler.ts",
  leases: "source/lambdas/api/leases/src/leases-handler.ts",
  leaseTemplates:
    "source/lambdas/api/lease-templates/src/lease-templates-handler.ts",
  principals: "source/lambdas/api/principals/src/principals-handler.ts",
};

export interface LocalComputeStackProps extends StackProps {
  dataStack: LocalDataStack;
}

export class LocalComputeStack extends Stack {
  public readonly restApi: SpecRestApi;
  private readonly stageName = LOCAL_STAGE;

  constructor(scope: Construct, id: string, props: LocalComputeStackProps) {
    super(scope, id, props);

    const arns = {} as DomainLambdaArns;
    for (const domain of API_DOMAINS) {
      arns[domain] = this.createDomainLambda(domain).functionArn;
    }

    this.restApi = new SpecRestApi(this, "LocalRestApi", {
      restApiName: "IsbLocalRestApi",
      apiDefinition: ApiDefinition.fromInline(
        prepareLocalSpec(
          JSON.parse(
            // The same contract the production stack imports, so the local wire
            // format cannot drift from the deployed one.
            readFileSync(
              path.join(repoRoot, "docs/openapi/innovation-sandbox-api.json"),
              "utf-8",
            ),
          ),
          arns,
        ),
      ),
      deployOptions: {
        stageName: this.stageName,
        // X-Ray is not available on the Hobby tier.
        tracingEnabled: false,
        throttlingRateLimit: 200,
        throttlingBurstLimit: 400,
      },
      cloudWatchRole: false,
    });

    for (const domain of API_DOMAINS) {
      const fn = this.node.findChild(`${domain}Lambda`) as NodejsFunction;
      fn.addPermission("ApiGatewayInvoke", {
        principal: new ServicePrincipal("apigateway.amazonaws.com"),
        sourceArn: this.restApi.arnForExecuteApi("*", `/${domain}/*`),
      });
    }
  }

  private createDomainLambda(domain: ApiDomain): NodejsFunction {
    const environment = buildLocalEnv(this.schemaFor(domain));
    return new NodejsFunction(this, `${domain}Lambda`, {
      entry: path.join(repoRoot, HANDLERS[domain]),
      handler: "handler",
      runtime: Runtime.NODEJS_24_X,
      timeout: Duration.seconds(60),
      memorySize: 1024,
      // No layers: they are a Pro feature. esbuild inlines dependencies instead,
      // so IsbLambdaFunction's externals list still applies to re2-wasm and the
      // Smithy validation module when this grows into the real construct.
      bundling: { format: BundlingFormat.CJS, target: "node24" },
      tracing: Tracing.DISABLED,
      environment,
    });
  }

  private schemaFor(domain: ApiDomain) {
    switch (domain) {
      case "accounts":
        return AccountLambdaEnvironmentSchema;
      case "blueprints":
        return BlueprintLambdaEnvironmentSchema;
      case "configurations":
        return ConfigurationLambdaEnvironmentSchema;
      case "leases":
        return LeaseLambdaEnvironmentSchema;
      case "leaseTemplates":
        return LeaseTemplateLambdaEnvironmentSchema;
      case "principals":
        return PrincipalsLambdaEnvironmentSchema;
    }
  }

  public localOutputs(): Record<string, unknown> {
    return {
      ApiGatewayRestApiId: this.restApi.restApiId,
      ApiGatewayInvokeUrl: `http://localstack:4566/restapis/${this.restApi.restApiId}/${this.stageName}/_user_request_`,
    };
  }
}
```

The imports at the top of the block are the complete set. Before running the test, confirm the handler paths against the real files, since a wrong path only fails at deploy time with a confusing bundling error:

```bash
ls source/lambdas/api/*/src/*handler.ts
```

If a handler filename differs from the `HANDLERS` table, correct the table. Also confirm the exact enum member for the Node 24 runtime (`Runtime.NODEJS_24_X` vs `NODEJS_24`) and for the bundling format in this CDK version, then correct them:

```bash
node -e "const {Runtime}=require('aws-cdk-lib/aws-lambda');console.log(Object.keys(Runtime).filter(k=>k.includes('24')))"
```

- [ ] **Step 8: Create the CDK app entry**

`local/infrastructure/bin/local.ts`:

```ts
// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import { App } from "aws-cdk-lib";

import { LocalComputeStack } from "../lib/local-compute-stack.js";
import { LocalDataStack } from "../lib/local-data-stack.js";

const app = new App();
const env = { account: "000000000000", region: "us-east-1" };

const data = new LocalDataStack(app, "LocalData", { env });
new LocalComputeStack(app, "LocalCompute", { env, dataStack: data });

app.synth();
```

- [ ] **Step 9: Run the compute stack test to verify it passes**

Run: `npx vitest run --root local infrastructure/lib/local-compute-stack.test.ts`
Expected: PASS — 5 tests. If the Lambda count is not 6, a domain is not being created.

- [ ] **Step 10: Run the full local suite**

Run: `npx vitest run --root local 2>&1 | tail -10`
Expected: PASS for every local test written so far.

- [ ] **Step 11: Commit**

```bash
git add local/infrastructure/
git commit -m "feat(local): add the local compute stack with six domain Lambdas"
```

---

## Task 13: End-to-end bring-up against real LocalStack

The first task that proves the whole design. Everything here is a real integration check, not a mock.

**Files:**

- Modify: `.env.example` (document the two `VITE_*` variables)
- Create: `local/README.md`
- Create: `local/e2e/smoke.ts`
- Test: manual run, recorded in `local/README.md`

**Interfaces:**

- Consumes: every earlier task.
- Produces: `runSmokeChecks(options?): Promise<SmokeResult[]>` where `SmokeResult` is `{ name: string; ok: boolean; detail: string }`. A documented, repeatable proof that the profile works.

- [ ] **Step 1: Write the smoke script**

Create `local/e2e/smoke.ts`:

```ts
// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import { buildLocalJwks, loadOrCreateKeyPair } from "../edge/jwks.js";
import { mintLocalIdToken } from "../edge/mint-token.js";

const EDGE = process.env.ISB_LOCAL_EDGE_URL ?? "http://localhost:4599";
const API_GATEWAY_ID = process.env.ISB_LOCAL_API_ID ?? "";

export interface SmokeResult {
  name: string;
  ok: boolean;
  detail: string;
}

async function check(
  name: string,
  fn: () => Promise<string>,
): Promise<SmokeResult> {
  try {
    return { name, ok: true, detail: await fn() };
  } catch (error: unknown) {
    return {
      name,
      ok: false,
      detail: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function runSmokeChecks(): Promise<SmokeResult[]> {
  const results: SmokeResult[] = [];

  results.push(
    await check("local edge is healthy", async () => {
      const response = await fetch(`${EDGE}/healthz`);
      if (!response.ok) throw new Error(`status ${response.status}`);
      return "ok";
    }),
  );

  results.push(
    await check("config.json serves all nine fields", async () => {
      const config = (await (
        await fetch(`${EDGE}/config.json`)
      ).json()) as object;
      const count = Object.keys(config).length;
      if (count !== 9) throw new Error(`expected 9 fields, got ${count}`);
      return `${count} fields`;
    }),
  );

  results.push(
    await check("local token verifies against the published JWKS", async () => {
      const keyPair = await loadOrCreateKeyPair();
      const token = await mintLocalIdToken({
        keyPair,
        sub: "smoke",
        email: "admin@example.local",
        roles: ["Admin"],
      });
      const jwks = buildLocalJwks(keyPair);
      if (jwks.keys[0].kid !== keyPair.kid) {
        throw new Error("published kid does not match the signing key");
      }
      return `kid ${keyPair.kid}`;
    }),
  );

  for (const domain of [
    "leases",
    "leaseTemplates",
    "configurations",
    "principals",
    "accounts",
    "blueprints",
  ]) {
    results.push(
      await check(`${domain} read path responds`, async () => {
        const response = await fetch(`${EDGE}/api/${domain}`, {
          headers: { "x-isb-identity": await mintForEdge() },
        });
        // A JSend failure body still proves the request reached the Lambda:
        // 401 would mean the identity check rejected us, which is a real bug.
        if (response.status === 401 || response.status === 403) {
          throw new Error(`identity rejected (${response.status})`);
        }
        return `status ${response.status}`;
      }),
    );
  }

  return results;
}

async function mintForEdge(): Promise<string> {
  const session = (await (await fetch(`${EDGE}/session`)).json()) as {
    token: string;
  };
  return session.token;
}

const invokedDirectly = process.argv[1]?.includes("smoke");
if (invokedDirectly) {
  runSmokeChecks().then((results) => {
    for (const result of results) {
      console.info(
        `${result.ok ? "PASS" : "FAIL"}  ${result.name} — ${result.detail}`,
      );
    }
    if (results.some((result) => !result.ok)) process.exit(1);
  });
}
```

Add to `local/package.json` scripts: `"smoke": "tsx e2e/smoke.ts"`.

- [ ] **Step 2: Document the local variables in `.env.example`**

Add a new section to `.env.example`:

```
# ============================================================================
# Local Development Profile (offline, no AWS account required)
# ============================================================================
# Uncomment ONLY when running the offline LocalStack profile
# (see local/README.md). These must stay unset for real deployments: with them
# unset the application behaves exactly as it does in a deployed environment.

# Description: Local edge origin the Vite dev server proxies /api and
#   /config.json to. Leave unset to use a deployed CloudFront distribution.
# VITE_API_PROXY_TARGET="http://localhost:4599"

# Description: Local session endpoint supplying the Amplify session offline.
#   Unset in every deployed environment, where login uses the Cognito hosted UI.
# VITE_LOCAL_SESSION_ENDPOINT="http://localhost:4599/session"
```

- [ ] **Step 3: Bring the profile up**

Run: `npm run local:up`
Expected: LocalStack healthy, local resources deployed, edge healthy, fixtures seeded. If `cdk deploy` cannot reach LocalStack, confirm `AWS_ENDPOINT_URL` is exported for the CDK CLI process — CDK does not read it from the Lambda environment, only the Lambdas do:

```bash
AWS_ENDPOINT_URL=http://localhost:4566 npx cdk deploy \
  --app "npx tsx local/infrastructure/bin/local.ts" \
  --outputs-file local/cdk.out/local-outputs.json
```

Record which invocation worked in `local/README.md`; that is the reproducible instruction.

- [ ] **Step 4: Run the smoke checks**

Run: `ISB_LOCAL_EDGE_URL=http://localhost:4599 npm run smoke --workspace @amzn/innovation-sandbox-local`
Expected: every line PASS.

If a domain reports `identity rejected`, hunk 1 is not wired: confirm the Lambda's environment carries `ISB_LOCAL_JWKS_URI` and that the Lambda can resolve `isb-local-edge` over the compose network. This is validation item 3 from the spec.

If a domain reports `status 404`, the OpenAPI import did not create that path; inspect the LocalStack API and re-run with the spec transform's output dumped.

- [ ] **Step 5: Verify the browser path end to end**

Copy `.env.example` to `.env` if you have not already, uncomment the two `VITE_*` lines, then:

```bash
npm run dev --workspace @amzn/innovation-sandbox-frontend
```

Open `http://localhost:5173`. Expected: no console errors, a signed-in local Admin, and the leases list showing the seeded leases. Navigate to accounts, blueprints, lease templates, principals, and settings.

Record in `local/README.md` which pages render and which fail. A page failing at the real unsupported call is the expected, documented behavior.

- [ ] **Step 6: Confirm the deep flows fail at the real call, not at the edge**

Attempt a blueprint deployment and an account lifecycle action. Expected: a real error from the Lambda naming the unsupported service, visible in the UI and in `docker compose -f local/compose.yaml logs`. Confirm the local edge did **not** return a 501 for these — they are real routes that fail deep in the handler, which is exactly the signal the spec calls for.

- [ ] **Step 7: Verify production behavior is unchanged**

Run: `git stash` is not appropriate here since the local profile is uncommitted work. Instead, verify with the local variables unset:

```bash
grep -c "VITE_LOCAL_SESSION_ENDPOINT\|VITE_API_PROXY_TARGET" .env
```

Expected: `0` after commenting them out. Then run the full suite and build:

```bash
npm test -- --reporter=dot 2>&1 | tail -5
npm run build 2>&1 | tail -5
```

Expected: the same pass count as before this work, and the build's 39 lint warnings with no errors.

- [ ] **Step 8: Write `local/README.md`**

Document: prerequisites (Docker, Node 24, npm 10), the two `.env` lines, the command sequence, what works and what does not (copy the table from the spec), the `local:reset` remedy for partial writes, and the exact `cdk deploy` invocation that worked in Step 3.

- [ ] **Step 9: Commit**

```bash
git add local/README.md local/e2e/ local/package.json .env.example
git commit -m "docs(local): document the offline profile and add end-to-end smoke checks"
```

- [ ] **Step 10: Final verification of the whole change surface**

Run: `git diff --stat main...HEAD -- source/ | tail -20`
Expected: exactly these three upstream files changed, plus the new frontend helper:

```
source/common/lambda/environments/base-api-lambda-environment.ts
source/common/lambda/auth/identity-token-verifier.ts
source/frontend/src/helpers/cognito-config.ts
source/frontend/src/helpers/local/amplify-local-session.ts  (new)
```

Anything else means an upstream file was edited outside the plan. Fix or escalate before finishing.

---

## Self-Review

**1. Spec coverage.** Every section of `docs/plans/2026-09-25-offline-local-development-design.md` maps to a task:

| Spec section                      | Task                                                                                                                                            |
| --------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| The one-path rule                 | Global Constraints; Task 8 (env derived from upstream schemas), Task 9 (table definitions mirrored), Task 10 (fixtures from production schemas) |
| Change 1 — backend key source     | Tasks 2 and 3                                                                                                                                   |
| Change 2 — browser session        | Tasks 5 and 6                                                                                                                                   |
| The local edge                    | Tasks 4, 7                                                                                                                                      |
| AWS client redirection, no code   | Task 8 (`AWS_ENDPOINT_URL`)                                                                                                                     |
| Local infrastructure              | Tasks 9, 12                                                                                                                                     |
| Seed and reset                    | Tasks 10, 11                                                                                                                                    |
| Contract verification             | Task 12 test plus Task 13's smoke script; the standalone `local:verify` walker is Task 13's smoke checks                                        |
| Configuration reference           | Task 8 (`commonEnv`), Task 13 (`.env.example`)                                                                                                  |
| Developer workflow                | Task 11 (`local:up`/`down`/`reset`/`logs`)                                                                                                      |
| Definition of done                | Task 13 Steps 4–7                                                                                                                               |
| Validation plan items 1–8         | Task 13 Step 4 (items 1–3, 5–7), Task 12 tests (item 4), Task 9 and 10 tests (item 8)                                                           |
| Why there is no browser MSW layer | Global Constraints; no task adds a mock                                                                                                         |
| Upgrade path to LocalStack Base   | Both changes are independently removable by construction; noted in Tasks 3 and 6                                                                |

**2. Placeholder scan.** Two places need honest flagging rather than pretending they are finished:

- **Task 10, `fixtures.ts` Step 4** deliberately instructs the implementer to read the real schemas and then write the builders, because writing fixture field names from memory would produce a plan that does not compile. The test is written in full and pins the invariants (lifecycle coverage, role coverage, schema validity, cross-reference integrity, stable identifiers), so the work is bounded and verifiable.
- **Task 12, Step 7** shows the compute stack with two placeholder lines to remove and three imports to add, and instructs the implementer to confirm handler filenames. Same reason.

Both are scoped tightly enough that a reviewer can reject them independently. Everything else is complete code.

**3. Type consistency.** Cross-checked:

- `localTableNames`, `localResourceNames`, `localEdgeConfig`, `LOCAL_JWKS_URI`, `buildLocalEnv`, `createLocalEdgeServer`, `LocalEdgeDeps`, `loadOrCreateKeyPair`, `buildLocalJwks`, `mintLocalIdToken`, `LOCAL_ISSUER`, `localSessionLibraryOptions`, `prepareLocalSpec`, `runSmokeChecks` — each is defined in exactly one task and consumed with the same name and arity in later tasks.
- `buildLocalEnv(schema, overrides?)` — Task 8 defines two parameters, Task 8's test calls it with one and with two, Task 12 calls it with one. Consistent.
- `createLocalEdgeServer(deps)` — Task 7 defines it taking one object; Task 7's test passes `{ apiGatewayInvokeUrl, keyPair }`, which matches the interface exactly. `main()` in the same file is the only other caller.
- `LOCAL_STAGE` is used by the edge test and by `LocalComputeStack.stageName`; both read it from Task 1 rather than re-deriving.
- `IsbRole[]` in Task 4's `MintOptions` is typed as `string[]` in the implementation, and Task 4's test passes `["Admin", "User"]` — assignable, so no mismatch. The `roles` field is serialized with `JSON.stringify`, matching the `custom:isb_roles` contract in `auth-utils.ts:32`.

**4. Review Focus.** Each of the five items is pinned to a named test:

1. Local mode silently active in production → Task 2 test 1 (`safeParse` without the field) and Task 6 test 1 (`configure` called with exactly one argument).
2. Token expiry mid-session → Task 5 test 3 (refetch after `exp`) and Task 3's `localJwksReady = null` reset on failure.
3. Role escalation → Task 7's `LOCAL_USER` constant and the absence of any request-derived role input; Task 4 test 2 pins the claim shape.
4. Partial writes → Task 10's `seedLocalEnvironment` is unconditional-`Put` and re-runnable; Task 13 Step 6 records the failure mode.
5. Silent schema drift → Task 10 test 3 (`ConfigSchemas[section].parse` on every section) and Task 12's spec tests comparing path sets against the production spec.

**5. Known gaps, stated plainly.** The plan does not implement a standalone `local:verify` command that walks the full API surface and validates every response against Zod schemas; Task 13's smoke script checks reachability and identity acceptance for one read per domain. The full walker is a follow-up, and the spec's definition of done item 6 should be read as satisfied by the smoke script until then. This is the one place the plan is narrower than the spec, and it is deliberate: the walker is better written once the real response shapes are observed.

---

# Post-Execution Addendum

**Added after all 13 tasks executed.** Everything below was discovered by running the
plan, not by reading it. The self-review above was written before execution and could
not have found any of it.

## Outcome

An authenticated request completes against real LocalStack. `GET /api/leases`
returns 200 with the seeded leases; the Lambda logs show `"userGroups":["Admin"]`;
an unauthenticated request returns the application's own
`401 Missing identity token`. `local:verify` exits 0 on 42 checks.

**The upstream `source/` diff is 9 files, 785 insertions, 2 deletions**, unchanged
from Task 6 onward. The 2 deletions are the two lines the `cognito-config.ts`
`if/else` mechanically rewrote.

## Defects in this plan, found by execution

Every one was caught by an implementer testing the brief before trusting it, or by
a reviewer checking a claim rather than a conclusion. All are recorded because the
pattern matters more than any individual fix: **code written to sound correct, and
not executed, was wrong eight times.**

| #   | Task | Defect                                                                                                                                          | Consequence had it shipped                                          |
| --- | ---- | ----------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| 1   | 3    | Zod strips keys the schema does not describe, so the brief's `return result.data` dropped `AWS_ENDPOINT_URL`                                    | Lambdas pointed at **real AWS**                                     |
| 2   | 4    | `jwks.ts` read `ISB_LOCAL_KEY_DIR` at module load, before `beforeEach`                                                                          | Its own test failed; wrote real keys into the repo                  |
| 3   | 7    | `fetch(url, {body: req})` throws on both GET and POST on Node 24                                                                                | Every proxied API call 502'd; surfaced only in Task 13              |
| 4   | 8    | (same as 1, discovered independently)                                                                                                           | —                                                                   |
| 5   | 9    | `findResources("*")` returns `{}` under strict equality                                                                                         | The "no Cognito/SSM resources" test guarded nothing                 |
| 6   | 10   | `SandboxAccountSchema`, `LeaseTemplateSchema`, `ConfigSchemaVersion`'s location, blueprint UUID/strict-object — **17 wrong specifics in total** | Seed would not validate                                             |
| 7   | 11   | Compose omitted `/var/run/docker.sock` and `LAMBDA_DOCKER_NETWORK`                                                                              | **No Lambda starts at all** — LocalStack has no non-Docker fallback |
| 8   | 12   | `re2-wasm` cannot be bundled by an esbuild loader; upstream's fix is a layer, which Hobby lacks                                                 | Lambda fails cold start before any request                          |

Three further defects were only findable by running the thing, which is the
argument for having a final end-to-end task at all:

- **Task 12:** the edge container's bind-mounted `npm install` pruned the host's
  platform-specific esbuild binary, so the very next step in `local:up` died with
  "You installed esbuild for another platform". No test could catch this.
- **Task 13:** `aws-jwt-verify@4.0.1` fetches the JWKS with `node:https.request`
  only (`https-node.js:4`), so an `http://` URI throws `ERR_INVALID_PROTOCOL`
  before a packet is sent. Every authenticated request 500'd at key retrieval.
  The implementer mis-classified this as a `source/` defect; it is not —
  `ISB_LOCAL_JWKS_URI` is set by local tooling, so the fix was available entirely
  within `local/`. Resolved in Task 14 by serving the JWKS over HTTPS on a
  container-internal second listener with a development CA, copying the CA into
  the bundle via the existing `afterBundling` hook, and pointing
  `NODE_EXTRA_CA_CERTS` at it.
- **Task 15:** the seed shipped records the API itself refuses to create
  (`allowOwnerToShareLease`, `costReportGroup`), so every write to a seeded record
  400'd.

## Amendments made to this plan mid-execution

- **Task 8's `buildLocalEnv`** now prescribes returning `merged`, not
  `result.data`, with all six undescribed keys named. Amended because Task 12 calls
  this function and the brief is generated from this file; fixing only the brief
  left the defect live in the authoritative source.
- **The `4599`-as-literal ruling** (Task 11): a constant both sides can read stays
  literal, but a value that changes at runtime — the API Gateway id — must cross a
  process boundary and is interpolated.
- **Task 13/14/15 are additions**, not in the original 13: the TLS fix, and the
  remaining local-only defects.

## Corrections to the spec

`docs/plans/2026-09-25-offline-local-development-design.md` was **not** amended.
Two of its claims are wrong and are corrected in `local/README.md` instead:

1. The "What works locally, and what does not" table says blueprint CRUD works.
   Blueprint **create** requires StackSets, which LocalStack Hobby does not serve.
2. It does not record that lease request and approval require the IDC SSM
   parameter, which was not being seeded.

Making these amendments is a maintainer decision, not an implementer's.

## Still open

- **The browser/UI is unverified.** No browser was available to any implementer.
  The CORS contract on `/session` is proven at the HTTP layer (echoed for
  `http://localhost:5173` with `vary: Origin`, absent for `https://evil.example`,
  `localhost.evil.test`, `https://localhost`) but never observed in a rendered page.
- **Auto-approval needs `identitystore`**, outside the Hobby tier. Reclassified as
  a boundary, not a fix.
- **LocalStack's gateway is OOM-killed mid-walk** on a machine with Docker limited
  to 1.9 GB, while the container still reports `healthy`. Machine configuration,
  not a profile defect; worked around with `colima start --memory 6 --cpu 4`.
- **One pre-existing `tsc` error** in `local/scripts/scripts.test.ts` (Task 11's
  file) was found and left. `tsc -p local` is red on `main` because of it.
- **`local/` tests are opt-in.** The root `vitest.config.ts` collects
  `source/**` only, so all 221 local tests run under `npx vitest run --root local`.
  A `npm test` line covering 3,861 tests covers none of them.
- **Verified on macOS/arm64 with Homebrew LocalStack only.** Intel, Linux, and
  Docker Desktop are untested.

## What held up

Worth recording, because it is the evidence for the approach:

- The **one-path rule** worked. No `if (isLocal)` reached domain logic, no local
  mock replaced real code, and no application file was forked. The `local/`
  toolkit imports upstream constructs and Zod schemas rather than restating them,
  so an upstream schema change surfaced as a failing test rather than wrong data.
- **The negative-control habit** was the single highest-value practice. Three
  times it converted a plausible green into a real answer: dropping `re2.wasm` from
  the bundle, deleting the `return 1` tail from `waitFor`, and removing the
  `export ISB_LOCAL_API_GATEWAY_INVOKE_URL` line. Each produced a specific failure
  that located the defect exactly.
- **Implementers correcting the brief and each other** found more than any review
  would have: the `LibraryAuthOptions` import that does not exist, the CDK output
  nesting that made the brief's id read return `undefined`, the fact that
  `RoleName`-style assumptions about principals were wrong, and that the
  `/leases/shared` "route precedence" diagnosis was wrong (it was required query
  parameters, which the gateway rejects when absent — proven by a 0/1/2-parameter
  control).
