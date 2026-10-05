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
