// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import { AccountLambdaEnvironmentSchema } from "@amzn/innovation-sandbox-commons/lambda/environments/account-lambda-environment.js";
import { BlueprintLambdaEnvironmentSchema } from "@amzn/innovation-sandbox-commons/lambda/environments/blueprint-lambda-environment.js";
import { ConfigurationLambdaEnvironmentSchema } from "@amzn/innovation-sandbox-commons/lambda/environments/config-lambda-environment.js";
import { LeaseLambdaEnvironmentSchema } from "@amzn/innovation-sandbox-commons/lambda/environments/lease-lambda-environment.js";
import { LeaseTemplateLambdaEnvironmentSchema } from "@amzn/innovation-sandbox-commons/lambda/environments/lease-template-lambda-environment.js";
import { PrincipalsLambdaEnvironmentSchema } from "@amzn/innovation-sandbox-commons/lambda/environments/principals-lambda-environment.js";
import { X509Certificate } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  loadOrCreateDevTlsCredentials,
  LOCAL_CA_CERTIFICATE_FILENAME,
  LOCAL_CA_CERTIFICATE_IN_TASK_ROOT,
  localCaCertificatePath,
} from "../../edge/dev-ca.js";
import {
  LOCAL_EDGE_SERVICE_NAME,
  LOCAL_EDGE_TLS_PORT,
  LOCAL_JWKS_PATH,
  localTableNames,
} from "../../shared/names.js";
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

  // `aws-jwt-verify@4.0.1` fetches the JWKS with `node:https.request` and has no
  // code path down to plain `http:` — on an `http://` URI it throws
  // ERR_INVALID_PROTOCOL before a packet is sent, so every authenticated request
  // failed at key retrieval. An `http` here is a 500 in every Lambda, and the
  // only symptom is a JWKS error behind an "Invalid identity token".
  it("sets ISB_LOCAL_JWKS_URI to the in-network edge address, over TLS", () => {
    const env = buildLocalEnv(LeaseTemplateLambdaEnvironmentSchema);
    expect(env.ISB_LOCAL_JWKS_URI).toBe(LOCAL_JWKS_URI);
    expect(env.ISB_LOCAL_JWKS_URI).toContain("isb-local-edge");
    const url = new URL(env.ISB_LOCAL_JWKS_URI);
    expect(url.protocol).toBe("https:");
    // The host is what the edge's certificate carries a SAN for, and the path is
    // the only route on the TLS listener — both are cross-checked against the
    // constants rather than spelled out, so a rename fails here.
    expect(url.hostname).toBe(LOCAL_EDGE_SERVICE_NAME);
    expect(url.port).toBe(String(LOCAL_EDGE_TLS_PORT));
    expect(url.pathname).toBe(LOCAL_JWKS_PATH);
  });

  // The TLS handshake is only trusted because of this. Node reads
  // NODE_EXTRA_CA_CERTS once at process start and adds the file to the default
  // root store, which `tls.connect` consults when the client sets no `ca` of its
  // own — and `https.request` sets none. Without this, the JWKS fetch fails with
  // a self-signed-certificate error that names the certificate and not the
  // environment variable that was supposed to prevent it.
  //
  // The path has to match where the bundling hook copies the file, at the
  // artifact root. Node's response to a NODE_EXTRA_CA_CERTS file that is not
  // there is a warning on stderr, not an error, so a wrong path would produce
  // six Lambdas that come up healthy and then fail every request.
  it("points NODE_EXTRA_CA_CERTS at the CA the bundling hook copies", () => {
    for (const schema of [
      LeaseTemplateLambdaEnvironmentSchema,
      LeaseLambdaEnvironmentSchema,
      PrincipalsLambdaEnvironmentSchema,
    ]) {
      const env = buildLocalEnv(schema);
      expect(env.NODE_EXTRA_CA_CERTS).toBe(LOCAL_CA_CERTIFICATE_IN_TASK_ROOT);
      // `/var/task` is what LAMBDA_TASK_ROOT names, and the hook copies to
      // `outputDir`, the same directory — so "at the artifact root" and "the
      // path in the environment" are one statement.
      expect(env.NODE_EXTRA_CA_CERTS).toBe(
        `/var/task/${LOCAL_CA_CERTIFICATE_FILENAME}`,
      );
      // A relative path would resolve against the process's working directory,
      // which is not the artifact root on every runtime.
      expect(env.NODE_EXTRA_CA_CERTS.startsWith("/")).toBe(true);
    }
  });

  // The two halves of the arrangement, cross-checked: the CA the environment
  // names is the one whose certificate the edge serves, and it is a *different*
  // document from the leaf. If the bundled file were the served certificate then
  // anything that had read the leaf off the wire — the edge hands it to every
  // caller of the JWKS route, and `local:verify` reads it — could impersonate
  // the edge to every Lambda.
  it("trusts a CA that is not the certificate the edge presents", () => {
    const env = buildLocalEnv(LeaseTemplateLambdaEnvironmentSchema);
    const dir = mkdtempSync(join(tmpdir(), "isb-local-env-ca-"));
    const previous = process.env.ISB_LOCAL_KEY_DIR;
    process.env.ISB_LOCAL_KEY_DIR = dir;
    try {
      const credentials = loadOrCreateDevTlsCredentials();
      const path = localCaCertificatePath();
      expect(path.startsWith(dir)).toBe(true);
      const bundled = readFileSync(path, "utf-8");
      // The file the `cp` will put at NODE_EXTRA_CA_CERTS.
      expect(bundled).toBe(credentials.caCertificatePem);
      expect(bundled).not.toBe(credentials.serverCertificatePem);
      // And the leaf verifies against it, which is the whole point.
      const ca = new X509Certificate(bundled);
      expect(
        new X509Certificate(credentials.serverCertificatePem).verify(
          ca.publicKey,
        ),
      ).toBe(true);
    } finally {
      if (previous === undefined) delete process.env.ISB_LOCAL_KEY_DIR;
      else process.env.ISB_LOCAL_KEY_DIR = previous;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // NODE_EXTRA_CA_CERTS *adds* to the system store rather than replacing it, so
  // setting it does not break the SDKs' own TLS. Stated because a future change
  // that reached for `NODE_TLS_REJECT_UNAUTHORIZED=0` — the usual "fix" for a
  // certificate error — would turn every verification failure into a silent
  // acceptance, and that is a materially worse thing to find in a diff.
  it("does not disable certificate verification anywhere in the environment", () => {
    const env = buildLocalEnv(LeaseTemplateLambdaEnvironmentSchema);
    expect(env.NODE_TLS_REJECT_UNAUTHORIZED).toBeUndefined();
    expect("NODE_OPTIONS").toBeDefined();
    // The trust is a trust anchor, not a bypass.
    expect(env.NODE_OPTIONS).not.toMatch(/reject-unauthorized|insecure/);
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
