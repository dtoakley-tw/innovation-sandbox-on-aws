// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const configure = vi.fn();

vi.mock("aws-amplify", () => ({ Amplify: { configure } }));
vi.mock("aws-amplify/auth/cognito", () => ({
  cognitoUserPoolsTokenProvider: { setKeyValueStorage: vi.fn() },
}));
vi.mock("aws-amplify/utils", () => ({ sessionStorage: {} }));

// Imported dynamically because the `aws-amplify` mock factory above closes over
// `configure`, which the module body has to initialise first; a static import
// would run the factory before that and fail on the temporal dead zone.
const { configureAmplifyAuth } =
  await import("@amzn/innovation-sandbox-frontend/helpers/cognito-config");

const baseConfig = {
  userPoolId: "us-east-1_localdev",
  appClientId: "localdevclientid",
  identityPoolId: "us-east-1:000000000000",
  domain: "localdev",
  region: "us-east-1",
  awsAccessPortalUrl: "http://localhost:4599/local/unsupported/access-portal",
};

const ENDPOINT = "http://localhost:4599/session";

beforeEach(() => {
  configure.mockClear();
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("configureAmplifyAuth", () => {
  it("configures Amplify with a single argument when no local session endpoint is set", () => {
    vi.stubEnv("VITE_LOCAL_SESSION_ENDPOINT", undefined);

    configureAmplifyAuth(baseConfig);

    expect(configure).toHaveBeenCalledTimes(1);
    expect(configure.mock.calls[0]).toHaveLength(1);
  });

  it("treats an empty endpoint value as unset", () => {
    vi.stubEnv("VITE_LOCAL_SESSION_ENDPOINT", "");

    configureAmplifyAuth(baseConfig);

    expect(configure.mock.calls[0]).toHaveLength(1);
  });

  it("treats a whitespace-only endpoint value as unset", () => {
    vi.stubEnv("VITE_LOCAL_SESSION_ENDPOINT", "   \n  ");

    configureAmplifyAuth(baseConfig);

    expect(configure.mock.calls[0]).toHaveLength(1);
  });

  it("passes token and credential providers as Amplify library options", () => {
    vi.stubEnv("VITE_LOCAL_SESSION_ENDPOINT", ENDPOINT);

    configureAmplifyAuth(baseConfig);

    expect(configure).toHaveBeenCalledTimes(1);
    const [, libraryOptions] = configure.mock.calls[0];
    // Amplify calls these two, not the providers themselves, so they are what
    // has to be wired up: a `fetchAuthSession()` with no arguments has to reach
    // the local providers through the configured library options.
    expect(libraryOptions.Auth.tokenProvider.getTokens).toBeTypeOf("function");
    expect(
      libraryOptions.Auth.credentialsProvider.getCredentialsAndIdentityId,
    ).toBeTypeOf("function");
  });

  it("configures the same Cognito resources with and without the local profile", () => {
    vi.stubEnv("VITE_LOCAL_SESSION_ENDPOINT", undefined);
    configureAmplifyAuth(baseConfig);
    const [deployedResources] = configure.mock.calls[0];

    configure.mockClear();
    vi.stubEnv("VITE_LOCAL_SESSION_ENDPOINT", ENDPOINT);
    configureAmplifyAuth(baseConfig);
    const [localResources] = configure.mock.calls[0];

    expect(localResources).toEqual(deployedResources);
    expect(localResources.Auth.Cognito.userPoolId).toBe("us-east-1_localdev");
    expect(localResources.Auth.Cognito.loginWith.oauth.domain).toBe(
      "localdev.auth.us-east-1.amazoncognito.com",
    );
  });

  it("requests the configured endpoint without its surrounding whitespace", async () => {
    vi.stubEnv("VITE_LOCAL_SESSION_ENDPOINT", `  ${ENDPOINT}\n`);
    // Real provider, real session shape: the trimmed endpoint is only
    // observable by driving the provider, so the body mirrors the local edge's
    // `GET /session` response rather than mocking the provider out.
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        token: "h.p.s",
        payload: { exp: Math.floor(Date.now() / 1000) + 3600 },
      }),
    });
    // Borrowed and handed back, rather than `vi.stubGlobal` plus a blanket
    // `unstubAllGlobals` in afterEach, which would also drop the
    // `SOLUTION_VERSION` stub that `src/setupTests.tsx` installed.
    const sharedFetch = globalThis.fetch;
    globalThis.fetch = fetchMock;

    try {
      configureAmplifyAuth(baseConfig);
      const [, libraryOptions] = configure.mock.calls[0];
      const tokens = await libraryOptions.Auth.tokenProvider.getTokens();

      expect(fetchMock).toHaveBeenCalledWith(ENDPOINT, { cache: "no-store" });
      expect(tokens?.idToken?.toString()).toBe("h.p.s");
    } finally {
      globalThis.fetch = sharedFetch;
    }
  });
});
