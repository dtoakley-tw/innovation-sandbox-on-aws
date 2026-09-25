// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import { NAMESPACE_PATTERN } from "@amzn/innovation-sandbox-commons/types/isb-types.js";
import { describe, expect, it } from "vitest";

import { LOCAL_NAMESPACE, localEdgeConfig, localTableNames } from "./names.js";

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
