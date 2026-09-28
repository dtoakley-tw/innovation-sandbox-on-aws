// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import {
  prepareApiGatewaySpec,
  type OpenApiDocument,
} from "@amzn/innovation-sandbox-infrastructure/lib/components/api/prepare-api-gateway-spec.js";

type DomainLambdaArns = Parameters<typeof prepareApiGatewaySpec>[1];

/**
 * The scheme the Lambdas verify themselves. API Gateway cannot enforce it — it
 * is a documented header, not an authorizer — which is exactly why it has to
 * survive into the local document: with the gateway-level requirement gone, it
 * is the only authentication the local request path still turns on, and a spec
 * that stopped describing it would read as though nothing authenticated at all.
 */
const ISB_IDENTITY_SCHEME = "isbIdentity";

/**
 * The production spec with exactly one difference: the gateway-level `awsSigv4`
 * requirement is removed, so API Gateway is created with `NONE` authorization.
 *
 * LocalStack's IAM enforcement of `AWS_IAM` cannot be depended on, and the
 * frontend's signature is computed for the edge's host rather than the
 * gateway's, so enforcing it would fail every request. Authentication is not
 * weakened in practice: the Lambda's `x-isb-identity` verification and the
 * whole RBAC pipeline run unmodified, and they are where the application
 * actually decides who the caller is.
 *
 * Everything else — paths, integrations, request validation, the documented
 * `isbIdentity` scheme — is the production spec, so the local wire contract
 * cannot drift.
 */
export function prepareLocalSpec(
  contract: OpenApiDocument,
  lambdaArns: DomainLambdaArns,
): OpenApiDocument {
  // The enforcement scheme, before the production transform reduces the
  // document to it. `prepareApiGatewaySpec` *replaces* `securitySchemes`
  // wholesale with `aws.auth.sigv4`, so the canonical one is only readable
  // here, on the contract.
  const isbIdentity =
    contract.components?.securitySchemes?.[ISB_IDENTITY_SCHEME];
  if (isbIdentity === undefined) {
    throw new Error(
      `prepareLocalSpec: canonical OpenAPI has no ${ISB_IDENTITY_SCHEME} scheme, so ` +
        `the document cannot describe the header the Lambdas verify`,
    );
  }

  // Clone so the imported contract on disk is never mutated across synths.
  const spec = prepareApiGatewaySpec(structuredClone(contract), lambdaArns);
  // No gateway-level authorization: see the note above.
  delete spec.security;
  // Two deletions, not one. `prepareApiGatewaySpec` sets
  // `security = [{ "aws.auth.sigv4": [] }]` and keeps only that scheme, whose
  // `x-amazon-apigateway-authtype: awsSigv4` API Gateway maps onto `AWS_IAM` on
  // every operation at import time. Dropping the requirement alone leaves the
  // scheme to be mapped anyway, so the whole `securitySchemes` map is replaced
  // with the canonical `isbIdentity` entry: the enforcement scheme out, the
  // documented one back.
  spec.components!.securitySchemes = { [ISB_IDENTITY_SCHEME]: isbIdentity };
  return spec;
}
