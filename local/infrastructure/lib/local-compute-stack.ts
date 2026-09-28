// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import { CfnOutput, Duration, Stack, type StackProps } from "aws-cdk-lib";
import {
  ApiDefinition,
  RestApiMode,
  SpecRestApi,
} from "aws-cdk-lib/aws-apigateway";
import { ServicePrincipal } from "aws-cdk-lib/aws-iam";
import { Runtime, Tracing } from "aws-cdk-lib/aws-lambda";
import {
  NodejsFunction,
  type ICommandHooks,
} from "aws-cdk-lib/aws-lambda-nodejs";
import type { Construct } from "constructs";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { ZodType } from "zod";

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
} from "@amzn/innovation-sandbox-infrastructure/lib/components/api/prepare-api-gateway-spec.js";

import {
  LOCAL_STAGE,
  LOCALSTACK_INTERNAL_ENDPOINT,
} from "../../shared/names.js";
import { buildLocalEnv } from "./lambda-environment.js";
import { prepareLocalSpec } from "./prepare-local-spec.js";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

/**
 * The six domain handlers, unmodified. Nothing in `local/` copies or wraps them:
 * what runs locally is the same file production deploys, which is the entire
 * point of the profile.
 */
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

/**
 * The `re2-wasm` package, resolved from *this module's* location, and the layout
 * the WebAssembly binary has inside it. The binary is not a free-floating file
 * to be found by name: it is a build artifact of the package, and the package is
 * only installed because something else declares it.
 *
 * `local/package.json` does **not** declare `re2-wasm`. The one declaration in
 * this repository is `source/layers/dependencies/package.json` — the Lambda
 * layer whose packages upstream externalizes, and the layer this profile
 * deliberately cannot use because the LocalStack Hobby tier has none. That
 * declaration is why `re2-wasm` is on disk at all, and **it is the thing that
 * would have to change for this profile to break**: delete that layer workspace,
 * drop its dependency, or let a version conflict nest the copy, and every local
 * Lambda stops bundling. Nothing in `local/` can protect against that, so the
 * failure is made loud instead (see `resolveRe2WasmBinary`) and the coupling is
 * recorded here.
 *
 * Declaring it in `local/package.json` as well would not remove the coupling, it
 * would duplicate it: a second version range for a package the layer already
 * owns, in a workspace whose install is locked by the repository-root
 * `package-lock.json`. Resolution from this module walks the real `node_modules`
 * chain instead, so a hoisted copy, a copy nested under the layer, and a copy in
 * `local/node_modules` are all found without the profile having to care which.
 */
const RE2_WASM_PACKAGE = "re2-wasm";
const RE2_WASM_MANIFEST = `${RE2_WASM_PACKAGE}/package.json`;
/** Where the binary sits inside the package, relative to its manifest. */
const RE2_WASM_WITHIN_PACKAGE = ["build", "wasm", "re2.wasm"];

/**
 * The absolute path of `re2-wasm`'s WebAssembly binary, or a thrown error naming
 * what is missing and where it was expected.
 *
 * Resolved when this module is loaded, i.e. at synth, rather than left to the
 * `cp` in `copyRe2Wasm`. That is deliberate and it is the whole reason the
 * resolution happens here: a `cp` of a missing source fails as a shell error
 * inside esbuild's output, some seconds later, with a path and no explanation —
 * whereas this throws during the stack's own construction, before any
 * deployment exists, saying which package and which layout inside it.
 *
 * `specifier` is a parameter only so a test can drive the failure; production
 * callers take the default.
 */
export function resolveRe2WasmBinary(
  specifier: string = RE2_WASM_MANIFEST,
): string {
  const expected = `${RE2_WASM_PACKAGE}/<package directory>/${RE2_WASM_WITHIN_PACKAGE.join("/")}`;
  let manifest: string;
  try {
    manifest = createRequire(import.meta.url).resolve(specifier);
  } catch (cause) {
    throw new Error(
      `local compute stack: cannot resolve "${specifier}". The local Lambdas ` +
        `need the ${RE2_WASM_PACKAGE} package, which local/package.json does not ` +
        `declare: its only declaration in this repository is ` +
        `source/layers/dependencies/package.json, the Lambda layer this profile ` +
        `cannot use. Install it, or restore that dependency. Expected layout: ` +
        `${expected}.`,
      { cause },
    );
  }
  const binary = join(dirname(manifest), ...RE2_WASM_WITHIN_PACKAGE);
  if (!existsSync(binary)) {
    throw new Error(
      `local compute stack: resolved "${specifier}" to ${manifest}, which does ` +
        `not contain the WebAssembly binary at ${RE2_WASM_WITHIN_PACKAGE.join("/")}. ` +
        `Every local Lambda would cold-start-fail on a missing re2.wasm. Expected ` +
        `layout: ${expected}.`,
    );
  }
  return binary;
}

/** Where the binary is, resolved once per synth. */
const re2WasmBinary = resolveRe2WasmBinary();

/** Single-quotes a path for the `bash -c` the bundling command runs under. */
const shellQuote = (value: string) => `'${value.replaceAll("'", `'\\''`)}'`;

const copyRe2Wasm: ICommandHooks = {
  // All three methods are part of `ICommandHooks` and all three must be present:
  // CDK calls `beforeBundling` and `afterBundling` unconditionally, so a missing
  // method is a `TypeError` at synth. `beforeInstall` is only called when
  // `nodeModules` is set — and it must stay empty if that ever changes. Adding
  // `nodeModules: ["re2-wasm"]` to reach the package through a node_modules
  // install would run `npm ci` inside the bundle step, which needs the network
  // and is the one thing an offline profile cannot do; the resolution above
  // exists so that is never necessary.
  beforeBundling: () => [],
  beforeInstall: () => [],
  /**
   * `re2-wasm` ships a JavaScript wrapper plus a separate `re2.wasm`, and the
   * Smithy server SDK's validation module imports the wrapper eagerly for regex
   * validation. The wrapper then resolves the binary as
   * `__dirname + "/re2.wasm"` — a `readFileSync` at first use, not an import.
   *
   * Two consequences, and upstream's own fix (`IsbLambdaFunction` and the
   * `source/layers/dependencies` layer) is a reaction to both:
   *
   *   1. The binary is not in esbuild's module graph, so no loader can copy it.
   *      `loader: { ".wasm": "copy" }` is inert here — and would be wrong even
   *      if the file were in the graph, since esbuild names copied output
   *      `re2-<hash>.wasm`, which is not the name the wrapper looks for.
   *   2. Once esbuild inlines the wrapper into `index.js`, its `__dirname` is
   *      `/var/task`, so the binary has to sit at the artifact root.
   *
   * Upstream externalizes `re2-wasm` and ships it in a Lambda layer, which
   * leaves the wrapper's own `__dirname` intact and lets `NODE_PATH` resolve it.
   * Layers are a LocalStack Pro feature and the Hobby tier has none, so the
   * same outcome is reached the only other way available: copy the binary to
   * the artifact root, which is exactly where the inlined wrapper looks.
   *
   * The source is the absolute path resolved by `resolveRe2WasmBinary`, not a
   * path relative to CDK's `projectRoot` (which under local bundling happens to
   * be this repository root, and which says nothing about *why*). The `cp` runs
   * on the host, so the absolute path is the only form that cannot silently
   * point somewhere else; under Docker bundling it would not resolve inside the
   * container and would fail, which is the correct outcome — see the note on
   * `esbuild` below.
   *
   * `esbuild` is likewise not declared by `local/package.json`; it arrives
   * transitively through `vite` and `tsx`. If it is ever missing, CDK does not
   * fail — it silently falls back to bundling inside a Docker image, where the
   * absolute `re2.wasm` path above does not exist, and the `cp` is what finally
   * says so.
   */
  afterBundling: (_inputDir: string, outputDir: string) => [
    `cp ${shellQuote(re2WasmBinary)} ${shellQuote(join(outputDir, "re2.wasm"))}`,
  ],
};

export interface LocalComputeStackProps extends StackProps {
  env: { account: string; region: string };
}

/**
 * The six API Lambdas and the API Gateway that fronts them.
 *
 * Deliberately *not* built from the production constructs. `IsbLambdaFunction`
 * hardcodes the dependencies layer, an IAM role, a KMS key, and a log group,
 * and `IsbApiLambdaFunction` / the `components/api/*-api.ts` classes add WAF, a
 * CloudFront base-path mapping, AppConfig, and gateway-level SigV4. None of that
 * is served by the LocalStack Community (Hobby) tier, and the profile's purpose
 * is to run the real handlers unmodified against local doubles — not to
 * reproduce the deploy.
 *
 * What survives from production is everything that decides *whether the
 * application works*: the real handlers, the real env schema validation
 * (`buildLocalEnv`), the real OpenAPI contract (`prepareLocalSpec`), and the
 * real `x-isb-identity` header check, which is what now gates the API.
 */
export class LocalComputeStack extends Stack {
  public readonly restApi: SpecRestApi;
  public readonly apiId: string;
  /**
   * The URL the local edge calls: LocalStack's REST API invoke endpoint, on the
   * Docker network's service name. `local-up.sh` reads it out of the CDK
   * outputs and hands it to the edge container.
   */
  public readonly invokeUrl: string;

  constructor(scope: Construct, id: string, props: LocalComputeStackProps) {
    super(scope, id, props);

    // Lambdas first: their ARN tokens are what the spec's integrations embed.
    const lambdas = Object.fromEntries(
      API_DOMAINS.map((domain) => [domain, this.createDomainLambda(domain)]),
    ) as Record<ApiDomain, NodejsFunction>;
    const lambdaArns = Object.fromEntries(
      API_DOMAINS.map((domain) => [domain, lambdas[domain].functionArn]),
    ) as DomainLambdaArns;

    this.restApi = new SpecRestApi(this, "LocalRestApi", {
      // A fixed physical name, so that `RestApiMode.OVERWRITE` below has an
      // existing API to replace and a repeat deploy converges rather than
      // colliding with the name a previous one took.
      restApiName: "IsbLocalRestApi",
      apiDefinition: ApiDefinition.fromInline(
        prepareLocalSpec(
          JSON.parse(
            // The same contract the production stack imports, so the local wire
            // format cannot drift from the deployed one.
            readFileSync(
              join(repoRoot, "docs/openapi/innovation-sandbox-api.json"),
              "utf-8",
            ),
          ),
          lambdaArns,
        ),
      ),
      // `local:up` is documented as idempotent, and the RestApi has a fixed
      // physical name, so a second deploy has to replace the existing API
      // rather than collide with it. Production sets the same mode.
      mode: RestApiMode.OVERWRITE,
      deployOptions: {
        stageName: LOCAL_STAGE,
        // X-Ray is not available on the Hobby tier.
        tracingEnabled: false,
        // Production's own defaults (`cdk-context.ts`: rate 100, burst 200),
        // which it takes from `cdk.json` context when it is set. The local app
        // sets no context, so the defaults are the values, and restating them
        // here rather than importing `getContextFromMapping` keeps the number in
        // one place: production's schema, not a local guess at a local cap.
        throttlingRateLimit: 100,
        throttlingBurstLimit: 200,
      },
      // A `AWS::ApiGateway::Account` role exists only to write access logs, and
      // the local stage has none. Creating it would put a CloudWatch-dependent
      // resource in a profile that has no CloudWatch to write to.
      cloudWatchRole: false,
    });

    for (const domain of API_DOMAINS) {
      // Mirrors `RestApi.grantApiGatewayInvoke`: the domain root and its
      // descendants, which is the pair a proxy integration's paths fall under.
      for (const [id, path] of [
        ["ApiGatewayInvokeRoot", `/${domain}`],
        ["ApiGatewayInvokeDescendants", `/${domain}/*`],
      ] as const) {
        lambdas[domain].addPermission(id, {
          principal: new ServicePrincipal("apigateway.amazonaws.com"),
          sourceArn: this.restApi.arnForExecuteApi("*", path),
        });
      }
    }

    this.apiId = this.restApi.restApiId;
    this.invokeUrl = `${LOCALSTACK_INTERNAL_ENDPOINT}/restapis/${this.apiId}/${LOCAL_STAGE}/_user_request_`;

    // Both names are the contract with `local-up.sh`, which reads them from the
    // CDK outputs file and aborts if either is missing.
    new CfnOutput(this, "ApiGatewayRestApiId", {
      value: this.apiId,
      description: "REST API id the local edge proxies to",
    });
    new CfnOutput(this, "ApiGatewayInvokeUrl", {
      value: this.invokeUrl,
      description:
        "LocalStack REST API invoke URL for ISB_LOCAL_API_GATEWAY_INVOKE_URL",
    });
  }

  /**
   * The outputs `local-up.sh` reads, as a record. The template exports the same
   * two values from the same fields, so the shell's contract and the deployed
   * outputs cannot be two separate decisions about the same names.
   */
  public localOutputs(): Record<string, string> {
    return {
      ApiGatewayRestApiId: this.apiId,
      ApiGatewayInvokeUrl: this.invokeUrl,
    };
  }

  private createDomainLambda(domain: ApiDomain): NodejsFunction {
    // No table or KMS grants. LocalStack does not enforce IAM on DynamoDB or
    // KMS, so the policies would be template noise describing an authorization
    // that does not exist locally — and the Lambdas reach their tables by the
    // names `buildLocalEnv` already put in the environment, not through grants.
    return new NodejsFunction(this, `${domain}Lambda`, {
      entry: join(repoRoot, HANDLERS[domain]),
      handler: "handler",
      runtime: Runtime.NODEJS_24_X,
      // No `architecture`, unlike upstream's `Architecture.ARM_64`. LocalStack
      // does not honour it: it starts the runtime's container on the host's
      // architecture, so the declared value describes something that never
      // happens locally, and pinning ARM_64 would fail a developer whose Docker
      // has no arm64 image or emulation. Verified on an arm64 host — an ARM_64
      // declaration deploys and serves identically, which is the point: the
      // setting is inert here, so the profile leaves it at CDK's default rather
      // than asserting a capability the local tier does not implement.
      timeout: Duration.minutes(1),
      memorySize: 1024,
      // X-Ray is not on the Hobby tier. `Tracing.DISABLED` is what the runtime
      // sees; the Powertools `POWERTOOLS_TRACE_ENABLED=false` in the environment
      // is a separate switch, and both have to be off.
      tracing: Tracing.DISABLED,
      environment: buildLocalEnv(environmentSchemaFor(domain)),
      bundling: {
        // The shared `NODE_OPTIONS=--enable-source-maps` only helps if the map
        // is in the artifact, which is production's `sourceMap: true`.
        sourceMap: true,
        // Restated rather than defaulted: setting `externalModules` *replaces*
        // CDK's default rather than extending it. The default is what keeps the
        // AWS SDK v3 the Node 24 runtime already provides out of the bundle —
        // inlining it would bloat the artifact and shadow the runtime's copy.
        externalModules: ["@aws-sdk/*"],
        // No `format`/`target`, matching `IsbLambdaFunction`: the target
        // defaults to the runtime's own node version, and CJS is the default
        // output format.
        commandHooks: copyRe2Wasm,
      },
    });
  }
}

/** The domain's own upstream Zod schema, so a missing variable fails at synth. */
function environmentSchemaFor(domain: ApiDomain): ZodType {
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
