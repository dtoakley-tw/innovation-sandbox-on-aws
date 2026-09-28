// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import { AccountLambdaEnvironmentSchema } from "@amzn/innovation-sandbox-commons/lambda/environments/account-lambda-environment.js";
import { BlueprintLambdaEnvironmentSchema } from "@amzn/innovation-sandbox-commons/lambda/environments/blueprint-lambda-environment.js";
import { ConfigurationLambdaEnvironmentSchema } from "@amzn/innovation-sandbox-commons/lambda/environments/config-lambda-environment.js";
import { LeaseLambdaEnvironmentSchema } from "@amzn/innovation-sandbox-commons/lambda/environments/lease-lambda-environment.js";
import { LeaseTemplateLambdaEnvironmentSchema } from "@amzn/innovation-sandbox-commons/lambda/environments/lease-template-lambda-environment.js";
import { PrincipalsLambdaEnvironmentSchema } from "@amzn/innovation-sandbox-commons/lambda/environments/principals-lambda-environment.js";
import { describe, expect, it } from "vitest";

import { localTableNames } from "../../shared/names.js";
import {
  buildLocalEnv,
  LOCAL_JWKS_URI,
  LOCALSTACK_ENDPOINT,
} from "./lambda-environment.js";

describe("buildLocalEnv", () => {
  it("produces an environment every domain schema accepts", () => {
    for (const schema of [
      LeaseLambdaEnvironmentSchema,
      LeaseTemplateLambdaEnvironmentSchema,
      ConfigurationLambdaEnvironmentSchema,
      PrincipalsLambdaEnvironmentSchema,
      AccountLambdaEnvironmentSchema,
      BlueprintLambdaEnvironmentSchema,
    ]) {
      expect(() => buildLocalEnv(schema)).not.toThrow();
    }
  });

  // The other half of the drift property: the assembly must fail loudly, naming
  // the offending field, when a variable a schema requires is absent. Without
  // this the test above could pass for the wrong reason.
  it("names the field a schema requires but the environment omits", () => {
    expect(() =>
      buildLocalEnv(LeaseLambdaEnvironmentSchema, {
        PRINCIPAL_TABLE_NAME: undefined as unknown as string,
      }),
    ).toThrow(/PRINCIPAL_TABLE_NAME/);
  });

  it("treats an undefined override as a deletion, not as a blank value", () => {
    const env = buildLocalEnv(PrincipalsLambdaEnvironmentSchema, {
      ISB_LOCAL_JWKS_URI: undefined as unknown as string,
    });
    expect("ISB_LOCAL_JWKS_URI" in env).toBe(false);
  });

  it("lets an override replace a common value", () => {
    const env = buildLocalEnv(LeaseTemplateLambdaEnvironmentSchema, {
      CONFIG_TABLE_NAME: "some-other-config-table",
    });
    expect(env.CONFIG_TABLE_NAME).toBe("some-other-config-table");
  });

  // Overrides exist so a later task can hand a Lambda something commonEnv does
  // not set, so a key no schema describes is passed through rather than
  // rejected or dropped.
  it("passes through an override no schema describes", () => {
    const env = buildLocalEnv(LeaseTemplateLambdaEnvironmentSchema, {
      SOME_FUTURE_VARIABLE: "yes",
    });
    expect(env.SOME_FUTURE_VARIABLE).toBe("yes");
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
    // The CLI reaches LocalStack by a different address than the Lambdas do,
    // because it runs on the host rather than inside the compose network.
    expect(LOCALSTACK_ENDPOINT).toBe("http://localhost:4566");
  });

  it("sets the local user pool and client id the verifier checks", () => {
    const env = buildLocalEnv(LeaseTemplateLambdaEnvironmentSchema);
    expect(env.COGNITO_USER_POOL_ID).toBe("us-east-1_localdev");
    expect(env.COGNITO_APP_CLIENT_ID).toBe("localdevclientid");
    expect(env.ISB_NAMESPACE).toBe("isbdev");
  });

  // The Lambda runtime owns these, and no function may be *configured* with
  // them: CDK refuses to synthesize a `NodejsFunction` whose environment names
  // one, which is how this was found. They are still declared in `commonEnv`,
  // because what a Lambda sees at runtime is the point of this function and the
  // runtime supplies the same values — so the declared environment is complete
  // and the configured one is legal.
  it("omits every variable the Lambda runtime reserves, which CDK refuses to configure", () => {
    const env = buildLocalEnv(LeaseTemplateLambdaEnvironmentSchema);
    for (const reserved of [
      "AWS_REGION",
      "AWS_DEFAULT_REGION",
      "AWS_ACCESS_KEY_ID",
      "AWS_SECRET_ACCESS_KEY",
    ]) {
      expect(reserved in env, reserved).toBe(false);
    }
    // The rest of the environment is untouched: the filter is a list of names,
    // not a whitelist, so a variable no Lambda reserves cannot be dropped by it.
    expect(env.AWS_ENDPOINT_URL).toBe("http://localstack:4566");
  });

  // A table name typo here is invisible until a request 500s, because the
  // schemas only require a string. This pins each name to the one construct
  // Task 9 provisions.
  it("gives every *_TABLE_NAME the name its construct will be created with", () => {
    const env = buildLocalEnv(LeaseLambdaEnvironmentSchema);
    expect(env.CONFIG_TABLE_NAME).toBe(localTableNames.config);
    expect(env.ACCOUNT_TABLE_NAME).toBe(localTableNames.sandboxAccount);
    expect(env.LEASE_TABLE_NAME).toBe(localTableNames.lease);
    expect(env.LEASE_TEMPLATE_TABLE_NAME).toBe(localTableNames.leaseTemplate);
    expect(env.BLUEPRINT_TABLE_NAME).toBe(localTableNames.blueprint);
    expect(env.PRINCIPAL_TABLE_NAME).toBe(localTableNames.principal);
    expect(env.CLEANUP_REPORT_TABLE_NAME).toBe(localTableNames.cleanupReport);
  });
});
