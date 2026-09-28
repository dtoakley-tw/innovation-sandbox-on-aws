// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import { App } from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  LOCAL_STAGE,
  localTableNames,
  type LocalTableName,
} from "../../shared/names.js";
import { LOCAL_JWKS_URI } from "./lambda-environment.js";
import { LocalComputeStack } from "./local-compute-stack.js";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "../../..");

const env = { account: "000000000000", region: "us-east-1" };

// The six domains, as `API_DOMAINS` spells them. Restated rather than imported
// so this file asserts the count and the construct ids on its own terms.
const DOMAINS = [
  "accounts",
  "blueprints",
  "configurations",
  "leases",
  "leaseTemplates",
  "principals",
] as const;

let outdir: string;
let stack: LocalComputeStack;
let template: Template;

beforeAll(() => {
  // A real outdir, in a temp directory the suite removes: the artifact
  // assertion below reads the bundled asset off disk, and `App` would
  // otherwise drop a `cdk.out` into whatever directory the test ran from.
  outdir = mkdtempSync(join(tmpdir(), "isb-local-compute-"));
  const app = new App({ outdir });
  stack = new LocalComputeStack(app, "IsbLocalCompute", { env });
  template = Template.fromStack(stack);
});

afterAll(() => {
  rmSync(outdir, { recursive: true, force: true });
});

const functions = (): Record<string, any> =>
  template.findResources("AWS::Lambda::Function");

const restApis = (): Record<string, any> =>
  template.findResources("AWS::ApiGateway::RestApi");

const restApiLogicalId = (): string => Object.keys(restApis())[0];

/**
 * The directories CDK staged each function's bundled code into, one per
 * `asset.*` entry in the assembly.
 *
 * Read off the assembly rather than off the template's `aws:asset:path`
 * metadata: that metadata is added by the CDK CLI at deploy time, not by
 * `app.synth()`, so a template synthesized in a test never carries it. The stack
 * creates no asset other than the six functions' code — asserted below — so the
 * staged directories and the functions are the same set.
 */
const artifacts = (): string[] =>
  readdirSync(outdir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name.startsWith("asset."))
    .map((entry) => join(outdir, entry.name));

describe("LocalComputeStack", () => {
  it("creates one API Lambda per domain, and nothing else", () => {
    template.resourceCountIs("AWS::Lambda::Function", DOMAINS.length);
    for (const domain of DOMAINS) {
      expect(stack.node.findChild(`${domain}Lambda`), domain).toBeDefined();
    }
  });

  it("points every Lambda at LocalStack, disables tracing, and names the local JWKS", () => {
    for (const [id, fn] of Object.entries(functions())) {
      const variables = fn.Properties.Environment.Variables;
      expect(variables.AWS_ENDPOINT_URL, id).toBe("http://localstack:4566");
      expect(variables.ISB_LOCAL_JWKS_URI, id).toBe(LOCAL_JWKS_URI);
      // X-Ray is not served on the LocalStack Hobby tier, and Powertools reads
      // this variable, not the runtime's tracing mode, to decide whether to emit
      // a segment — so both have to be off and both are asserted.
      expect(variables.POWERTOOLS_TRACE_ENABLED, id).toBe("false");
      expect(fn.Properties.TracingConfig, id).toBeUndefined();
    }
  });

  // Table names are asserted from `localTableNames`, never as literals: the
  // Lambda environment and the table the data stack creates are two separate
  // resources, and the only thing that keeps them in step is this shared map.
  it("gives every Lambda the real table names", () => {
    const expected: Record<string, string> = Object.fromEntries(
      Object.entries({
        CONFIG_TABLE_NAME: "config",
        ACCOUNT_TABLE_NAME: "sandboxAccount",
        LEASE_TABLE_NAME: "lease",
        LEASE_TEMPLATE_TABLE_NAME: "leaseTemplate",
        BLUEPRINT_TABLE_NAME: "blueprint",
        PRINCIPAL_TABLE_NAME: "principal",
        CLEANUP_REPORT_TABLE_NAME: "cleanupReport",
      } satisfies Record<string, LocalTableName>).map(([variable, table]) => [
        variable,
        localTableNames[table],
      ]),
    );
    for (const [id, fn] of Object.entries(functions())) {
      expect(fn.Properties.Environment.Variables, id).toMatchObject(expected);
    }
  });

  // Lambda layers are a LocalStack Pro feature, so the local profile cannot use
  // the one upstream ships its shared dependencies in. Pinned so a future
  // "just add the layer like production" edit fails here, where the reason can
  // be written down, rather than at deploy time on the Hobby tier.
  it("attaches no Lambda layer, because the Hobby tier has none", () => {
    for (const [id, fn] of Object.entries(functions())) {
      expect(fn.Properties.Layers, id).toBeUndefined();
    }
  });

  it("imports the production spec with no gateway security requirement", () => {
    const apis = restApis();
    expect(Object.keys(apis)).toHaveLength(1);
    for (const [id, api] of Object.entries<any>(apis)) {
      expect(api.Properties.Body.security, id).toBeUndefined();
      // The scheme has to go as well as the requirement: API Gateway maps
      // `x-amazon-apigateway-authtype: awsSigv4` onto AWS_IAM on import, so a
      // spec with neither a requirement nor a scheme is the only one the
      // gateway imports as NONE.
      expect(
        Object.keys(api.Properties.Body.components?.securitySchemes ?? {}),
        id,
      ).toEqual(["isbIdentity"]);
    }
  });

  it("serves the API from the local stage with tracing off", () => {
    const stages = template.findResources("AWS::ApiGateway::Stage");
    expect(Object.keys(stages)).toHaveLength(1);
    for (const [id, stage] of Object.entries<any>(stages)) {
      expect(stage.Properties.StageName, id).toBe(LOCAL_STAGE);
      expect(stage.Properties.TracingEnabled, id).toBe(false);
    }
  });

  it("lets API Gateway invoke every domain Lambda, and only by the execute-api path", () => {
    const permissions = Object.values<any>(
      template.findResources("AWS::Lambda::Permission"),
    );
    // Two per domain, mirroring `RestApi.grantApiGatewayInvoke`: the domain
    // root and its descendants, which is the pair a proxy integration's
    // `/domain/...` path and `/domain` path each fall under.
    expect(permissions).toHaveLength(DOMAINS.length * 2);
    for (const permission of permissions) {
      expect(permission.Properties.Principal).toBe("apigateway.amazonaws.com");
      expect(permission.Properties.FunctionName).toBeDefined();
    }
  });

  // `local-up.sh` reads both of these out of the CDK outputs file and aborts if
  // either is missing, so the names are a contract with the shell rather than a
  // convenience. Asserted by value as well: `SpecRestApi` also emits a
  // CDK-generated `LocalRestApiEndpoint...` output, which is the real
  // `execute-api.<region>.amazonaws.com` URL and is of no use to anything on the
  // `isb-local` network — so its presence is not a substitute for these two.
  it("exports the API id and the invoke URL the local edge is configured with", () => {
    const outputs = template.findOutputs("*");
    expect(Object.keys(outputs)).toEqual(
      expect.arrayContaining(["ApiGatewayRestApiId", "ApiGatewayInvokeUrl"]),
    );
    expect(outputs.ApiGatewayRestApiId.Value).toEqual({
      Ref: restApiLogicalId(),
    });
    expect(outputs.ApiGatewayInvokeUrl.Value).toEqual(
      stack.resolve(stack.invokeUrl),
    );
    // The same pair `localOutputs()` reports, so the two can never disagree.
    expect(stack.localOutputs()).toEqual({
      ApiGatewayRestApiId: stack.apiId,
      ApiGatewayInvokeUrl: stack.invokeUrl,
    });
  });

  it("builds an invoke URL the edge can actually reach", () => {
    // By service name, not the published host port: the edge runs on the
    // `isb-local` Docker network, where the port mapping does not exist and
    // `localhost` is the edge's own container.
    expect(stack.resolve(stack.invokeUrl)).toEqual({
      "Fn::Join": [
        "",
        [
          "http://localstack:4566/restapis/",
          { Ref: restApiLogicalId() },
          `/${LOCAL_STAGE}/_user_request_`,
        ],
      ],
    });
  });

  // The load-bearing assertion of this suite. `re2-wasm` ships a JS wrapper plus
  // a separate `re2.wasm` binary and the Smithy server SDK's validation module
  // imports it eagerly, so a bundle without the binary cold-start-fails before
  // handling a request. esbuild only sees a file if something imports it, and
  // nothing does — the wrapper `readFileSync`s the binary from `__dirname` at
  // first use — so no `loader` setting can bring it along. It is copied in by the
  // bundling command hook, and this pins where it lands.
  it("ships re2.wasm next to the bundle, where the wrapper looks for it", () => {
    expect(artifacts()).toHaveLength(DOMAINS.length);
    const source = statSync(
      join(repoRoot, "node_modules/re2-wasm/build/wasm/re2.wasm"),
    ).size;
    for (const artifact of artifacts()) {
      const entries = readdirSync(artifact);
      // The wrapper resolves its binary as `__dirname + "/re2.wasm"`, and
      // `__dirname` for esbuild's `index.js` is the artifact root — so "at the
      // root" and "where the wrapper looks" are one statement.
      expect(entries, artifact).toContain("index.js");
      // The complete set of `.wasm` files, not a hit: a copy under some
      // `node_modules/...` path is exactly the `copy` loader's layout, which the
      // wrapper cannot resolve and which a `**/re2.wasm` check would pass.
      expect(
        entries.filter((name) => name.endsWith(".wasm")),
        artifact,
      ).toEqual(["re2.wasm"]);
      // The real binary at the right path, not an empty or truncated file: an
      // esbuild `file`/`dataurl` loader would have inlined it instead of
      // copying it, and this is what distinguishes the two.
      expect(statSync(join(artifact, "re2.wasm")).size, artifact).toBe(source);
      // And the lookup is still the `__dirname`-relative one that placement
      // assumes. esbuild inlines the wrapper verbatim; it does not rewrite
      // `__dirname` into anything the artifact's own layout can satisfy.
      const bundle = readFileSync(join(artifact, "index.js"), "utf-8");
      expect(bundle, artifact).toContain("__dirname");
      expect(bundle, artifact).toContain("re2.wasm");
    }
  });

  // With the binary in place, the other cold-start hazard the bundling
  // configuration controls is the AWS SDK: inlining it would bloat the artifact
  // and shadow the copy the Node 24 runtime provides, and `externalModules`
  // replaces rather than extends CDK's default — so `@aws-sdk/*` has to be
  // restated explicitly. `--external` is an esbuild flag that leaves no trace in
  // the template, so the bundle is what the assertion can read.
  it("leaves the runtime's AWS SDK external", () => {
    for (const artifact of artifacts()) {
      const bundle = readFileSync(join(artifact, "index.js"), "utf-8");
      // An external import survives as a `require` of the bare specifier; an
      // inlined one is resolved, and the SDK's own module paths replace it.
      expect(bundle, artifact).toContain('require("@aws-sdk/');
      expect(bundle, artifact).not.toContain("node_modules/@aws-sdk/");
    }
  });

  it("keeps the source maps the shared NODE_OPTIONS --enable-source-maps needs", () => {
    for (const fn of Object.values<any>(functions())) {
      expect(fn.Properties.Environment.Variables.NODE_OPTIONS).toBe(
        "--enable-source-maps",
      );
    }
    for (const artifact of artifacts()) {
      expect(existsSync(join(artifact, "index.js.map")), artifact).toBe(true);
    }
  });

  // The six handler paths are the most load-bearing table in the stack, and a
  // wrong one fails as an esbuild "could not resolve" that names a file rather
  // than a domain. Read out of the source maps, so the assertion is about what
  // each artifact actually contains rather than about the table again.
  it("bundles each domain's own handler, and each one once", () => {
    const handlers = artifacts().map((artifact) =>
      (
        JSON.parse(readFileSync(join(artifact, "index.js.map"), "utf-8")) as {
          sources: string[];
        }
      ).sources
        .filter((source) =>
          /lambdas\/api\/[^/]+\/src\/[^/]+-handler\.ts$/.test(source),
        )
        .map((source) => source.split("lambdas/api/")[1].split("/")[0]),
    );
    expect(handlers).toHaveLength(DOMAINS.length);
    for (const domains of handlers) {
      // Exactly one handler per artifact: two in one bundle would mean one
      // domain's function answering for another, which no count on the template
      // can see.
      expect(domains).toHaveLength(1);
    }
    // The six, once each, named by the on-disk directory each domain uses —
    // `leaseTemplates` is spelled `lease-templates` there.
    expect(handlers.flat().sort()).toEqual(
      [
        ...DOMAINS.map((domain) =>
          domain === "leaseTemplates" ? "lease-templates" : domain,
        ),
      ].sort(),
    );
  });
});
