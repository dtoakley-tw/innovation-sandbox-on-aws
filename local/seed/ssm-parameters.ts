// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import {
  PutParameterCommand,
  SSMClient,
  type SSMClientConfig,
} from "@aws-sdk/client-ssm";

import {
  AccountPoolConfigSchema,
  type TokenSafeAccountPoolConfig,
} from "@amzn/innovation-sandbox-commons/data/account-pool-stack-config/account-pool-stack-config.js";
import {
  type IdcConfig,
  IdcConfigSchema,
} from "@amzn/innovation-sandbox-commons/data/idc-stack-config/idc-stack-config.js";
import { readManifest } from "@amzn/innovation-sandbox-infrastructure/lib/helpers/manifest-reader.js";

import { LOCALSTACK_ENDPOINT } from "../infrastructure/lib/lambda-environment.js";
import {
  LOCAL_ACCOUNT_ID,
  LOCAL_REGION,
  localResourceNames,
} from "../shared/names.js";

/**
 * The two SSM parameters the six API Lambdas read through
 * `SsmAccountPoolStackConfigStore` and `SsmIdcStackConfigStore`, and which
 * nothing in the profile created until now.
 *
 * `buildLocalEnv` puts `ACCOUNT_POOL_CONFIG_PARAM_ARN` and
 * `IDC_CONFIG_PARAM_ARN` into every domain's environment, so the names were
 * always there; the values were not. The consequence was a `GetParameterError`
 * — the Powertools provider's own error for a missing parameter — from whatever
 * operation happened to need them first: `GET /configurations` for the account
 * pool, `POST /leases` for the IDC config, and the account lifecycle's
 * `SandboxOuService`, which reads the account pool config before it reaches
 * Organizations and so masked the boundary it was supposed to demonstrate.
 *
 * **Why the seed and not the local data stack.** In production neither parameter
 * belongs to the data stack: the account pool stack writes
 * `/isb/<ns>/account-pool/config` from `IsbAccountPoolResources`, and the IDC
 * stack writes `/isb/<ns>/idc/config` from `IsbIdcResources`. The local profile
 * deploys neither, so the seed is the only component that stands in for them —
 * and the design's rule that local code imports the production schemas rather
 * than restating them is satisfied on the seed side (`AccountPoolConfigSchema`
 * and `IdcConfigSchema` below, both parsed here, so an upstream field that
 * becomes required breaks the seed rather than a request at runtime). Putting
 * them in `LocalDataStack` would have invented a resource in a stack that does
 * not own it, and would have made them unre-creatable without a full
 * `cdk deploy` — where `npm run local:seed` alone restores them.
 *
 * **Why the value is the input form and not the parsed output.**
 * `AccountPoolConfigSchema` transforms `isbManagedRegions` from a
 * comma-separated string into `string[]`, and `AccountPoolConfig` is the
 * *output* type. The store does `JSON.parse(value)` and then
 * `AccountPoolConfigSchema.parse(...)`, so the bytes in the parameter must be
 * the schema's *input*: serialising the parsed output would put an array where
 * the store calls `.split(",")` and every read would fail on a type error rather
 * than a missing parameter. Hence `TokenSafeAccountPoolConfig` for the literal
 * and `JSON.stringify` on the literal, with the parse kept purely as validation.
 */

/** One SSM parameter, addressed and serialized, ready to write. */
export interface SsmParameterWrite {
  name: string;
  value: string;
}

export interface SsmParameterOptions {
  endpoint?: string;
  region?: string;
}

/**
 * `supportedSchemas` is `JSON.stringify(["1"])` in all three production stacks
 * (`isb-account-pool-resources.ts:61`, `isb-idc-resources.ts:24`,
 * `isb-data-resources.ts:41`) — a JSON array inside a schema field typed as a
 * string. None of those constants is exported, so the value is restated here and
 * `ssm-parameters.test.ts` pins it to the literal production writes.
 */
const SUPPORTED_SCHEMAS = JSON.stringify(["1"]);

/**
 * The solution version production stamps into both parameters.
 *
 * `getContextFromMapping(scope, "version")` resolves through `IsbMapping` to
 * `SolutionContextSchema.version`, whose default is `readManifest().version`
 * (`source/infrastructure/lib/helpers/cdk-context.ts:46`). So rather than
 * restate a value that changes on every release, this calls the same
 * `readManifest` the CDK context is defaulted from.
 */
const localSolutionVersion = (): string => readManifest().version;

/**
 * The eight Organizations OU ids, each in the shape AWS Organizations issues
 * (`ou-<4 chars>-<8 chars>`).
 *
 * The prefix is shared so a developer reading the parameter can see at a glance
 * that none of these OUs exists; only `SandboxOuService` consumes them, and only
 * to hand them to `MoveAccount`, which is a boundary the profile is *supposed*
 * to reach. Nothing parses them, so the shape is documentation, not a
 * constraint — but a real-looking one beats `ou-1`, which would read like a
 * placeholder the profile forgot to fill in.
 *
 * Padded *and* truncated to eight characters, because that is how many
 * Organizations issues them (`ou-4wrn-abcd1234`). Doing it here rather than by
 * hand-counting eight-character literals is deliberate: the earlier version
 * wrote `exit000` (seven) and `active0` (seven), which no OU has — and a value
 * whose entire job is to look like the real thing is the wrong place to be off
 * by one character.
 */
const localOuId = (name: string): string =>
  `ou-isl0-${name.slice(0, 8).padEnd(8, "0")}`;

/** The IDC account's identity store id: `d-` plus ten characters. */
const LOCAL_IDENTITY_STORE_ID = `d-${LOCAL_ACCOUNT_ID.slice(0, 10)}`;

/**
 * The IDC instance ARN, `arn:aws:sso:::instance/ssoins-<16 hex>` upstream. The
 * sixteen characters are the local account id, so it is pinned like every other
 * local name — the value is compared with nothing, but a developer who pastes it
 * into the AWS CLI should get a well-formed ARN, not `ssoins-`.
 */
const LOCAL_SSO_INSTANCE_ARN = `arn:aws:sso:::instance/ssoins-${LOCAL_ACCOUNT_ID}${LOCAL_ACCOUNT_ID.slice(0, 4)}`;

/**
 * A permission set ARN on that instance, upstream
 * `arn:aws:sso:::permissionSet/ssoins-<16 hex>/ps-<16 hex>`.
 */
const localPermissionSetArn = (index: string): string =>
  `${LOCAL_SSO_INSTANCE_ARN.replace("/instance/", "/permissionSet/")}/ps-${LOCAL_ACCOUNT_ID}${index}`;

/**
 * The account pool stack's parameter, as the account pool stack would have
 * written it. Validated against `AccountPoolConfigSchema` on every call.
 */
export function buildAccountPoolConfig(): TokenSafeAccountPoolConfig {
  const config: TokenSafeAccountPoolConfig = {
    sandboxOuId: localOuId("sandbox"),
    availableOuId: localOuId("availabl"),
    activeOuId: localOuId("active"),
    frozenOuId: localOuId("frozen"),
    cleanupOuId: localOuId("cleanup"),
    quarantineOuId: localOuId("quarant"),
    entryOuId: localOuId("entry"),
    exitOuId: localOuId("exit"),
    solutionVersion: localSolutionVersion(),
    supportedSchemas: SUPPORTED_SCHEMAS,
    // The one region the profile emulates, and the region every local Lambda
    // runs in. `GET /configurations` surfaces this verbatim as
    // `isbManagedRegions`, so a second region here would put one in the UI that
    // nothing behind it serves.
    isbManagedRegions: LOCAL_REGION,
    // Written as empty strings rather than omitted, because
    // `IsbAccountPoolResources` passes `Fn.join(",", [])` for an unset list and
    // the deployed parameter therefore always carries both keys. Only the
    // metrics Lambdas read them, and the profile deploys neither.
    additionalAllowedServices: "",
    bedrockInferenceProfilePatterns: "",
  };
  // Validation only: `config` is serialized, not this result. See the file
  // comment — the transform on `isbManagedRegions` is why the input is the value
  // that gets written.
  AccountPoolConfigSchema.parse(config);
  return config;
}

/**
 * The IDC stack's parameter, as `IdcIdcConfigurer`'s `onCreate` would have
 * returned it (`source/lambdas/custom-resources/idc-configurer/src/idc-configurer-handler.ts:170`).
 *
 * Every id is a local stand-in. What matters is that all ten keys are present
 * and well-typed, because `getUserFromEmail` reads `identityStoreId` and all
 * three group ids to map group membership onto a role, and returns `undefined`
 * for a user in none of them — which surfaces as "Unable to retrieve user
 * information" rather than as a configuration error. The values are never
 * compared against anything: the first call out of them is `identitystore`,
 * which the LocalStack Community (Hobby) tier does not serve, so
 * `POST /leases` on a template that does not require approval fails at the real
 * call (see the walk's boundary check) rather than on a local value.
 */
export function buildIdcConfig(): IdcConfig {
  // Group ids are `d-` plus ten characters, exactly like the identity store id,
  // and derived from the same local account id. They are never compared with
  // anything, but three identical values would make a mis-mapped role
  // indistinguishable from a correct one in a log line.
  const groupId = (index: string): string =>
    `d-${LOCAL_ACCOUNT_ID.slice(0, 9)}${index}`;

  const config: IdcConfig = {
    identityStoreId: LOCAL_IDENTITY_STORE_ID,
    ssoInstanceArn: LOCAL_SSO_INSTANCE_ARN,
    adminGroupId: groupId("1"),
    managerGroupId: groupId("2"),
    userGroupId: groupId("3"),
    adminPermissionSetArn: localPermissionSetArn("1"),
    managerPermissionSetArn: localPermissionSetArn("2"),
    userPermissionSetArn: localPermissionSetArn("3"),
    solutionVersion: localSolutionVersion(),
    supportedSchemas: SUPPORTED_SCHEMAS,
  };
  IdcConfigSchema.parse(config);
  return config;
}

/**
 * Every parameter the seed writes, in the order it writes them. Pure, so
 * `ssm-parameters.test.ts` can assert the shape and the addressing without a
 * running LocalStack.
 */
export function buildSsmParameters(): SsmParameterWrite[] {
  return [
    {
      name: localResourceNames.accountPoolConfigParamArn,
      value: JSON.stringify(buildAccountPoolConfig()),
    },
    {
      name: localResourceNames.idcConfigParamArn,
      value: JSON.stringify(buildIdcConfig()),
    },
  ];
}

/** SSM client pointed at LocalStack; no AWS credentials are ever needed. */
export function createLocalSsmClient(
  options: SsmParameterOptions = {},
): SSMClient {
  const config: SSMClientConfig = {
    region: options.region ?? LOCAL_REGION,
    endpoint: options.endpoint ?? LOCALSTACK_ENDPOINT,
    credentials: { accessKeyId: "test", secretAccessKey: "test" },
  };
  return new SSMClient(config);
}

/**
 * Writes the parameters, overwriting in place. Idempotent for the same reason
 * the DynamoDB writes are: `Overwrite: true` makes a re-run restore a
 * known-good value rather than fail on a parameter that already exists, which is
 * what `npm run local:seed` has to mean for a developer whose parameters were
 * dropped by a failed deploy.
 */
export async function seedSsmParameters(
  client: SSMClient,
  writes: SsmParameterWrite[] = buildSsmParameters(),
): Promise<number> {
  for (const { name, value } of writes) {
    await client.send(
      new PutParameterCommand({
        Name: name,
        Value: value,
        Type: "String",
        Overwrite: true,
      }),
    );
  }
  return writes.length;
}
