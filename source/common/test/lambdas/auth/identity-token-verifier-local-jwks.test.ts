// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const cacheJwks = vi.fn();
const fetchJwks = vi.fn();

vi.mock("aws-jwt-verify", () => ({
  CognitoJwtVerifier: {
    create: () => ({
      verify: async (token: string) =>
        JSON.parse(Buffer.from(token, "base64").toString("utf-8")),
      cacheJwks,
    }),
  },
}));

vi.mock("aws-jwt-verify/jwk", () => ({
  fetchJwks: (uri: string) => fetchJwks(uri),
}));

const { verifyAndExtractClaims } =
  await import("@amzn/innovation-sandbox-commons/lambda/auth/identity-token-verifier.js");
const { IDENTITY_HEADER } =
  await import("@amzn/innovation-sandbox-shared/utils/auth-utils.js");

const JWKS_URI = "http://isb-local-edge:4599/.well-known/jwks.json";
const POOL_ID = "us-east-1_localdev";
const claims = { sub: "user-1", email: "admin@example.local" };

const buildEvent = () =>
  ({
    headers: {
      [IDENTITY_HEADER]: Buffer.from(JSON.stringify(claims)).toString("base64"),
    },
    requestContext: { identity: { cognitoAuthenticationProvider: null } },
  }) as never;

const baseEnv = {
  COGNITO_USER_POOL_ID: POOL_ID,
  COGNITO_APP_CLIENT_ID: "localdevclientid",
};

beforeEach(() => {
  cacheJwks.mockClear();
  fetchJwks.mockReset();
  fetchJwks.mockResolvedValue({ keys: [{ kid: "local" }] });
});

afterEach(() => {
  vi.resetModules();
});

describe("local JWKS injection", () => {
  it("never fetches or caches a JWKS when ISB_LOCAL_JWKS_URI is unset", async () => {
    await verifyAndExtractClaims(buildEvent(), baseEnv);
    expect(fetchJwks).not.toHaveBeenCalled();
    expect(cacheJwks).not.toHaveBeenCalled();
  });

  it("fetches the configured JWKS and seeds the verifier cache", async () => {
    await verifyAndExtractClaims(buildEvent(), {
      ...baseEnv,
      ISB_LOCAL_JWKS_URI: JWKS_URI,
    });
    expect(fetchJwks).toHaveBeenCalledWith(JWKS_URI);
    // The keys must be cached against the issuer derived from the pool id, not
    // against the local JWKS URI — that is the URI the verifier looks up.
    expect(cacheJwks).toHaveBeenCalledWith(
      { keys: [{ kid: "local" }] },
      POOL_ID,
    );
  });

  it("still returns the verified claims after injection", async () => {
    const result = await verifyAndExtractClaims(buildEvent(), {
      ...baseEnv,
      ISB_LOCAL_JWKS_URI: JWKS_URI,
    });
    expect(result).toEqual(claims);
  });
});
