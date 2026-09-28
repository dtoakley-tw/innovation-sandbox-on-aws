// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { prepareApiGatewaySpec } from "@amzn/innovation-sandbox-infrastructure/lib/components/api/prepare-api-gateway-spec.js";

import { prepareLocalSpec } from "./prepare-local-spec.js";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "../../..");
const contract = JSON.parse(
  readFileSync(
    join(repoRoot, "docs/openapi/innovation-sandbox-api.json"),
    "utf-8",
  ),
);
const lambdaArns = {
  accounts: "arn:aws:lambda:us-east-1:000000000000:function:accounts",
  blueprints: "arn:aws:lambda:us-east-1:000000000000:function:blueprints",
  configurations:
    "arn:aws:lambda:us-east-1:000000000000:function:configurations",
  leases: "arn:aws:lambda:us-east-1:000000000000:function:leases",
  leaseTemplates:
    "arn:aws:lambda:us-east-1:000000000000:function:leaseTemplates",
  principals: "arn:aws:lambda:us-east-1:000000000000:function:principals",
};

describe("prepareLocalSpec", () => {
  it("removes the gateway SigV4 requirement so unsigned local requests route", () => {
    const spec = prepareLocalSpec(contract, lambdaArns);
    expect(spec.security).toBeUndefined();
  });

  it("keeps every path, so the wire contract is the production one", () => {
    const production = prepareApiGatewaySpec(
      structuredClone(contract),
      lambdaArns,
    );
    const local = prepareLocalSpec(contract, lambdaArns);
    expect(Object.keys(local.paths).sort()).toEqual(
      Object.keys(production.paths).sort(),
    );
  });

  it("keeps request validation disabled so JSend error envelopes survive", () => {
    const spec = prepareLocalSpec(contract, lambdaArns);
    expect(spec["x-amazon-apigateway-request-validator"]).toBe("none");
  });

  it("still wires each path to its domain Lambda", () => {
    const spec = prepareLocalSpec(contract, lambdaArns);
    const integration = (spec.paths["/leases"] as Record<string, any>).get[
      "x-amazon-apigateway-integration"
    ];
    expect(JSON.stringify(integration.uri)).toContain(lambdaArns.leases);
  });

  // The two assertions below are one fact. The scheme is what API Gateway maps
  // onto `AuthorizationType.IAM` at import time, and `prepareApiGatewaySpec`
  // *replaces* the canonical securitySchemes with `aws.auth.sigv4` alone — so
  // dropping the top-level `security` requirement is not sufficient on its own,
  // and neither is dropping the scheme while leaving the requirement behind.
  it("drops the sigv4 scheme as well, or the gateway still enforces IAM", () => {
    const spec = prepareLocalSpec(contract, lambdaArns);
    expect(Object.keys(spec.components?.securitySchemes ?? {})).not.toContain(
      "aws.auth.sigv4",
    );
  });

  // The scheme the Lambda actually enforces. `prepareApiGatewaySpec` drops it
  // along with every other non-sigv4 scheme, so the local transform has to
  // restate it: locally it is the only header the whole request path turns on,
  // and a document that stops describing it hides that from a reader.
  it("keeps the isbIdentity scheme the Lambda verifies documented", () => {
    const spec = prepareLocalSpec(contract, lambdaArns);
    expect(Object.keys(spec.components?.securitySchemes ?? {})).toEqual([
      "isbIdentity",
    ]);
    // Restated verbatim from the canonical contract, not invented: the header
    // name and description are the ones the wire format actually uses.
    expect(spec.components?.securitySchemes?.isbIdentity).toEqual(
      contract.components.securitySchemes.isbIdentity,
    );
  });

  // A contract that has lost the scheme is a contract the local document can no
  // longer describe truthfully, and silently emitting one with an empty
  // `securitySchemes` would look like a deliberate local edit.
  it("fails closed when the canonical contract has no isbIdentity scheme", () => {
    const without = structuredClone(contract);
    delete without.components.securitySchemes.isbIdentity;
    expect(() => prepareLocalSpec(without, lambdaArns)).toThrow(/isbIdentity/);
  });

  it("leaves the canonical contract on disk untouched", () => {
    prepareLocalSpec(contract, lambdaArns);
    expect(contract.security).toEqual([
      { "aws.auth.sigv4": [], isbIdentity: [] },
      { "aws.auth.sigv4": [] },
    ]);
    expect(Object.keys(contract.components.securitySchemes)).toEqual([
      "aws.auth.sigv4",
      "isbIdentity",
    ]);
  });
});
