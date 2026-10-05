// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const cacheJwks = vi.fn<(jwks: unknown, userPoolId?: string) => void>();
const fetchJwks = vi.fn();

// The pool id the verifier is configured with. `cacheJwks` must be handed this
// same id: the library keys the JWKS cache by the issuer it derives from it, so
// a different id would write the keys under a URI the verifier never reads.
interface VerifierProps {
  userPoolId: string;
  tokenUse: "id";
  clientId: string;
}

const createVerifier = vi.fn((_props: VerifierProps) => ({
  verify: async (token: string) =>
    JSON.parse(Buffer.from(token, "base64").toString("utf-8")),
  cacheJwks,
}));

vi.mock("aws-jwt-verify", () => ({
  CognitoJwtVerifier: {
    create: createVerifier,
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

// The verifier and `localJwksReady` are module state, so a test that needs its
// own pristine instance — and therefore its own `create` / `fetchJwks` /
// `cacheJwks` call counts — clears the registry and re-imports.
const importFreshVerifier = async () => {
  vi.resetModules();
  const module =
    await import("@amzn/innovation-sandbox-commons/lambda/auth/identity-token-verifier.js");
  return module.verifyAndExtractClaims;
};

beforeEach(() => {
  createVerifier.mockClear();
  cacheJwks.mockClear();
  fetchJwks.mockReset();
  fetchJwks.mockResolvedValue({ keys: [{ kid: "local" }] });
});

afterEach(() => {
  vi.resetModules();
});

// Tests 2 and 4 own a pristine module instance (see `importFreshVerifier`), so
// their call counts are attributable to that test and they do not depend on the
// order the suite runs in. Tests 1 and 3 share the top-level instance and
// assert only that no fetch happens / the claims come back, which holds either
// way round.
describe("local JWKS injection", () => {
  it("never fetches or caches a JWKS when ISB_LOCAL_JWKS_URI is unset", async () => {
    await verifyAndExtractClaims(buildEvent(), baseEnv);
    expect(fetchJwks).not.toHaveBeenCalled();
    expect(cacheJwks).not.toHaveBeenCalled();
  });

  it("fetches the configured JWKS and seeds the verifier cache", async () => {
    const verify = await importFreshVerifier();
    await verify(buildEvent(), {
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
    // The keys are only found again if they are cached against the same pool id
    // the verifier was configured with, so assert that relationship rather than
    // two literals that could drift apart.
    const configuredPoolId = createVerifier.mock.calls[0]?.[0].userPoolId;
    expect(configuredPoolId).toBe(POOL_ID);
    expect(cacheJwks.mock.calls[0]?.[1]).toBe(configuredPoolId);
  });

  it("still returns the verified claims after injection", async () => {
    const result = await verifyAndExtractClaims(buildEvent(), {
      ...baseEnv,
      ISB_LOCAL_JWKS_URI: JWKS_URI,
    });
    expect(result).toEqual(claims);
  });

  it("retries the fetch after a failure instead of caching the rejection", async () => {
    const verify = await importFreshVerifier();
    const env = { ...baseEnv, ISB_LOCAL_JWKS_URI: JWKS_URI };

    fetchJwks.mockRejectedValueOnce(new Error("local edge unreachable"));
    // The failure propagates — it is not swallowed into a bare 401.
    await expect(verify(buildEvent(), env)).rejects.toThrow(
      "local edge unreachable",
    );

    // The rejection must not be cached, or a single transient local-edge outage
    // would fail every request until the container is recycled.
    await verify(buildEvent(), env);
    expect(fetchJwks).toHaveBeenCalledTimes(2);
    expect(cacheJwks).toHaveBeenCalledWith(
      { keys: [{ kid: "local" }] },
      POOL_ID,
    );
  });
});
