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
import { readFileSync } from "node:fs";
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
 * `re2-wasm`'s WebAssembly binary, as installed. See `copyRe2Wasm` for why the
 * Lambda artifact needs it and why esbuild cannot be asked to bring it along.
 */
const RE2_WASM_PATH = "node_modules/re2-wasm/build/wasm/re2.wasm";

/** Single-quotes a path for the `bash -c` the bundling command runs under. */
const shellQuote = (value: string) => `'${value.replaceAll("'", `'\\''`)}'`;

const copyRe2Wasm: ICommandHooks = {
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
   * `inputDir` is the project root under local bundling, which is the only mode
   * this profile supports — `cp` failing loudly on a missing source is the
   * intended failure, since the alternative is a bundle that cold-start-fails
   * in front of a developer with nothing to act on.
   */
  afterBundling: (inputDir: string, outputDir: string) => [
    `cp ${shellQuote(join(inputDir, RE2_WASM_PATH))} ${shellQuote(join(outputDir, "re2.wasm"))}`,
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
        throttlingRateLimit: 200,
        throttlingBurstLimit: 400,
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
