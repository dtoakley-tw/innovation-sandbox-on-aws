// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import { NAMESPACE_PATTERN } from "@amzn/innovation-sandbox-commons/types/isb-types.js";
import { IsbRoleSchema } from "@amzn/innovation-sandbox-shared/utils/auth-utils.js";
import { describe, expect, it } from "vitest";

import {
  LOCAL_ACCOUNT_ID,
  LOCAL_EDGE_PORT,
  LOCAL_NAMESPACE,
  LOCAL_REGION,
  LOCAL_ROLE_NAMES,
  LOCAL_STAGE,
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

  // LOCAL_ROLE_NAMES restates IsbRoleSchema because local/ cannot import the
  // type. This is the only thing keeping the two lists in step.
  it("mirrors the production IsbRole enum exactly", () => {
    expect([...LOCAL_ROLE_NAMES]).toEqual([...IsbRoleSchema.options]);
  });
});

describe("local resource names", () => {
  it("exposes every name the later tasks read from the environment", () => {
    expect(Object.keys(localResourceNames)).toEqual(
      expect.arrayContaining([
        "accountPoolConfigParamArn",
        "dataConfigParamArn",
        "eventBus",
        "hubAccountId",
        "idcAccountId",
        "idcConfigParamArn",
        "idcRoleArn",
        "intermediateRoleArn",
        "orgMgtAccountId",
        "orgMgtRoleArn",
        "sandboxAccountRoleName",
      ]),
    );
  });

  it("namespaces the event bus so it cannot collide with a deployed stack", () => {
    expect(localResourceNames.eventBus).toBe(
      `InnovationSandbox-${LOCAL_NAMESPACE}`,
    );
  });

  it("gives the three role ARNs one IAM prefix and distinct scopes", () => {
    const prefix = `arn:aws:iam:${LOCAL_REGION}:${LOCAL_ACCOUNT_ID}:local/`;
    const roleArns = [
      localResourceNames.intermediateRoleArn,
      localResourceNames.idcRoleArn,
      localResourceNames.orgMgtRoleArn,
    ];
    for (const arn of roleArns) {
      expect(arn.startsWith(prefix), `${arn} must start with ${prefix}`).toBe(
        true,
      );
    }
    const scopes = roleArns.map((arn) => arn.slice(prefix.length));
    expect(new Set(scopes).size).toBe(roleArns.length);
    expect(scopes).toEqual(["intermediate", "idc", "org-mgmt"]);
  });

  it("gives each config parameter a distinct path", () => {
    const configParams = [
      localResourceNames.dataConfigParamArn,
      localResourceNames.idcConfigParamArn,
      localResourceNames.accountPoolConfigParamArn,
    ];
    expect(new Set(configParams).size).toBe(configParams.length);
  });
});

describe("local edge config", () => {
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

  it("fills every field main.tsx needs before it renders the app", () => {
    const config = localEdgeConfig();
    for (const field of [
      "CognitoUserPoolId",
      "CognitoAppClientId",
      "CognitoIdentityPoolId",
      "CognitoDomain",
      "Region",
      "AwsAccessPortalUrl",
    ] as const) {
      expect(config[field].trim(), `${field} must not be empty`).not.toBe("");
    }
  });

  it("names the host, stage, and region the local edge serves", () => {
    const config = localEdgeConfig();
    expect(config.ApiGatewayHost).toBe(`localhost:${LOCAL_EDGE_PORT}`);
    expect(config.ApiGatewayStage).toBe(LOCAL_STAGE);
    expect(config.Region).toBe(LOCAL_REGION);
  });
});
