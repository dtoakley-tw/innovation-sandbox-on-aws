// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Vitest setup file shared by all API handler test packages.
 *
 * Installs a mock for `aws-jwt-verify` so the SigV4 user-path in
 * `captureIsbUser` accepts the `x-isb-identity` token in test events
 * without having to mint a real Cognito JWT.
 *
 * Encoding contract (mirrors how a real JWT carries its claims):
 *   token = `${TEST_TOKEN_PREFIX}${base64-json-of-claims}`
 * The verifier mock decodes the token back into the claims it would have
 * verified. {@link encodeTestToken} produces tokens; the test fixture
 * (`createAPIGatewayProxyEvent` with `isbUser`) wires them onto the event.
 *
 * Wire this in via `vitest.config.ts`:
 *   setupFiles: [
 *     path.resolve(__dirname, "../../../common/test/lambdas/api-test-setup.ts"),
 *   ],
 */
import { vi } from "vitest";

const TEST_TOKEN_PREFIX = "test:";

export function encodeTestToken(claims: Record<string, unknown>): string {
  return `${TEST_TOKEN_PREFIX}${Buffer.from(JSON.stringify(claims)).toString("base64")}`;
}

function decodeTestToken(token: string): Record<string, unknown> {
  if (!token.startsWith(TEST_TOKEN_PREFIX)) {
    throw new Error(
      `Test token does not have the expected prefix '${TEST_TOKEN_PREFIX}'. Use encodeTestToken() or createAPIGatewayProxyEvent({ isbUser }) to build one.`,
    );
  }
  return JSON.parse(
    Buffer.from(token.slice(TEST_TOKEN_PREFIX.length), "base64").toString(
      "utf-8",
    ),
  ) as Record<string, unknown>;
}

vi.mock("aws-jwt-verify", () => ({
  CognitoJwtVerifier: {
    create: () => ({
      verify: async (token: string) => decodeTestToken(token),
      // No-op: `cacheJwks` is only reached when ISB_LOCAL_JWKS_URI is set, which
      // no upstream test does. Declared so the verifier interface is complete.
      cacheJwks: () => {},
    }),
  },
}));

// `fetchJwks` is only called when ISB_LOCAL_JWKS_URI is set. Several API handler
// suites build their env with `generateSchemaData(<Domain>Schema)`, which
// populates that optional field with a random string; without this mock a
// generated value would reach the network and fail the request. Keyed out so
// the real `aws-jwt-verify/jwk` never issues a request under test.
vi.mock("aws-jwt-verify/jwk", () => ({
  fetchJwks: async () => ({ keys: [] }),
}));
