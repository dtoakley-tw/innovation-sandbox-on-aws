// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import { readManifest } from "@amzn/innovation-sandbox-infrastructure/lib/helpers/manifest-reader.js";
import { describe, expect, it } from "vitest";

import {
  AccountPoolConfigSchema,
  type TokenSafeAccountPoolConfig,
} from "@amzn/innovation-sandbox-commons/data/account-pool-stack-config/account-pool-stack-config.js";
import { IdcConfigSchema } from "@amzn/innovation-sandbox-commons/data/idc-stack-config/idc-stack-config.js";

import { LOCAL_REGION, localResourceNames } from "../shared/names.js";
import {
  buildAccountPoolConfig,
  buildIdcConfig,
  buildSsmParameters,
} from "./ssm-parameters.js";

/**
 * The two stores that read these parameters both do `JSON.parse(value)` and then
 * `Schema.parse(parsed)`. A test that only checked `Schema.parse(config)` on the
 * object would miss the one way this can be wrong in a way nothing else catches:
 * serialising the schema's *output* rather than its *input*, which turns
 * `isbManagedRegions` into an array and makes the store call `.split` on it.
 * Every test below therefore goes through `JSON.parse` of the written bytes.
 */
const parsesAs = <T>(value: string): T => JSON.parse(value) as T;

describe("account pool SSM parameter", () => {
  it("carries the value the account pool stack writes, in the schema's input form", () => {
    const config = buildAccountPoolConfig();
    // The parsed output has an array here; the input has the comma-separated
    // string the store's own transform expects.
    expect(config.isbManagedRegions).toBe(LOCAL_REGION);
    expect(config.isbManagedRegions).not.toContain(",");
    const roundTripped = AccountPoolConfigSchema.parse(config);
    expect(roundTripped.isbManagedRegions).toEqual([LOCAL_REGION]);
  });

  it("survives the exact read the store performs", () => {
    // `SsmAccountPoolStackConfigStore.get` is `JSON.parse` followed by
    // `AccountPoolConfigSchema.parse`, so this reproduces the whole read.
    const written = buildSsmParameters().find(
      (parameter) =>
        parameter.name === localResourceNames.accountPoolConfigParamArn,
    );
    expect(written).toBeDefined();
    const read = AccountPoolConfigSchema.parse(
      parsesAs<TokenSafeAccountPoolConfig>(written?.value as string),
    );
    // The one field the six API domains actually read out of this parameter:
    // `getConfigurations` destructures `isbManagedRegions` from it and returns it
    // in the response body. A string where an array belongs is a 500 on
    // `GET /configurations` with nothing in the response to explain it.
    expect(read.isbManagedRegions).toEqual([LOCAL_REGION]);
  });

  it("gives all eight organizational units a distinct, Organizations-shaped id", () => {
    const config = buildAccountPoolConfig();
    const ouIds = [
      config.sandboxOuId,
      config.availableOuId,
      config.activeOuId,
      config.frozenOuId,
      config.cleanupOuId,
      config.quarantineOuId,
      config.entryOuId,
      config.exitOuId,
    ];
    expect(new Set(ouIds).size).toBe(8);
    // `ou-<4>-<8>`, which is what AWS Organizations issues. Nothing validates
    // this, so it is documentation rather than a constraint — but a value like
    // `ou-active` would read in the console as a mistake.
    for (const id of ouIds) {
      expect(id).toMatch(/^ou-[a-z0-9]{4}-[a-z0-9]{8}$/);
    }
  });

  it("stamps the version the solution manifest declares, not a literal", () => {
    // Production's `solutionVersion` is `getContextFromMapping(scope, "version")`,
    // which resolves through `SolutionContextSchema.version`, whose default is
    // `readManifest().version`. A hard-coded version would go stale silently at
    // the next release; deriving it means the parameter is right by construction.
    expect(buildAccountPoolConfig().solutionVersion).toBe(
      readManifest().version,
    );
    expect(buildIdcConfig().solutionVersion).toBe(readManifest().version);
  });

  it("declares the same supported schemas production does", () => {
    // `supportedSchemas` is `JSON.stringify(["1"])` in all three production
    // stacks; the schema types it as a string, so the value is a JSON array
    // inside a string. Asserted by content rather than by a restated literal
    // alone: a value that stopped being valid JSON would satisfy `=== "[\"1\"]"`
    // only if it also stopped being the thing production writes.
    const parsed = JSON.parse(buildAccountPoolConfig().supportedSchemas);
    expect(parsed).toEqual(["1"]);
  });
});

describe("IDC SSM parameter", () => {
  it("carries all ten fields the store's schema requires", () => {
    const config = buildIdcConfig();
    // `IdcConfigSchema` is a plain `z.object`, so a missing field is a thrown
    // `IdcConfigSchema.parse` at request time rather than an undefined later.
    // The parse here is the same call the store makes.
    expect(IdcConfigSchema.parse(config)).toEqual(config);
    expect(Object.keys(config).sort()).toEqual(
      [
        "adminGroupId",
        "adminPermissionSetArn",
        "identityStoreId",
        "managerGroupId",
        "managerPermissionSetArn",
        "solutionVersion",
        "ssoInstanceArn",
        "supportedSchemas",
        "userGroupId",
        "userPermissionSetArn",
      ].sort(),
    );
  });

  it("gives the three roles distinct group ids and permission set ARNs", () => {
    // `IdcService.getUserFromUniqueAttr` maps group membership onto a role by
    // comparing `groupId` against these three values, so duplicates would make
    // two roles indistinguishable. The permission set ARNs are only read by
    // `ssoAdminClient`, which the profile cannot reach, but they are read at all
    // by `IdcConfigSchema`.
    const config = buildIdcConfig();
    const groups = [
      config.adminGroupId,
      config.managerGroupId,
      config.userGroupId,
    ];
    expect(new Set(groups).size).toBe(3);
    const permissionSets = [
      config.adminPermissionSetArn,
      config.managerPermissionSetArn,
      config.userPermissionSetArn,
    ];
    expect(new Set(permissionSets).size).toBe(3);
    // Each permission set ARN is on the instance the parameter also names, which
    // is how the deployed one is built.
    for (const arn of permissionSets) {
      expect(arn).toContain(config.ssoInstanceArn.replace("/instance/", "/"));
    }
  });

  it("survives the exact read the store performs", () => {
    const written = buildSsmParameters().find(
      (parameter) => parameter.name === localResourceNames.idcConfigParamArn,
    );
    expect(written).toBeDefined();
    expect(IdcConfigSchema.parse(JSON.parse(written?.value as string))).toEqual(
      buildIdcConfig(),
    );
  });
});

describe("the parameters the seed writes", () => {
  it("addresses exactly the two names the Lambda environment hands the stores", () => {
    // `buildLocalEnv` sets `ACCOUNT_POOL_CONFIG_PARAM_ARN` and
    // `IDC_CONFIG_PARAM_ARN` from `localResourceNames`, and the stores read
    // `env.ACCOUNT_POOL_CONFIG_PARAM_ARN` / `env.IDC_CONFIG_PARAM_ARN`. A
    // parameter written under any other name would be one the Lambdas never ask
    // for, and the `GetParameterError` would come back.
    expect(buildSsmParameters().map((parameter) => parameter.name)).toEqual([
      localResourceNames.accountPoolConfigParamArn,
      localResourceNames.idcConfigParamArn,
    ]);
  });

  it("writes each parameter as a JSON object, not a bare string", () => {
    // The Powertools `transform: "json"` parses the value before the schema
    // runs, so a non-JSON value is a parse error at the store rather than a
    // validation error naming the offending field.
    for (const parameter of buildSsmParameters()) {
      expect(typeof JSON.parse(parameter.value)).toBe("object");
    }
  });

  it("is deterministic, so a re-run overwrites rather than accumulating", () => {
    // The seed is documented as idempotent. `PutParameter` with `Overwrite: true`
    // is the SSM half of that, and it only converges if the bytes are the same
    // every time — which they are because nothing here reads a clock.
    expect(JSON.stringify(buildSsmParameters())).toBe(
      JSON.stringify(buildSsmParameters()),
    );
  });
});
