// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

// Note: `src/setupTests.tsx` installs MSW and stubs `globalThis.fetch` for
// every frontend test. The `vi.stubGlobal("fetch", ...)` below takes precedence
// over both, so MSW does not intercept the session calls. That is intentional —
// the provider's own fetch behavior is what is under test here.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { localSessionLibraryOptions } from "@amzn/innovation-sandbox-frontend/helpers/local/amplify-local-session";

const ENDPOINT = "http://localhost:4599/session";

let fetchMock: ReturnType<typeof vi.fn>;

const respondWith = (token: string, exp: number) => {
  fetchMock.mockResolvedValue({
    ok: true,
    json: async () => ({ token, payload: { exp, sub: "user-1" } }),
  });
};

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe("localSessionLibraryOptions", () => {
  it("returns tokens for Amplify to consume", async () => {
    respondWith(
      "header.payload.signature",
      Math.floor(Date.now() / 1000) + 3600,
    );
    const { Auth } = localSessionLibraryOptions(ENDPOINT);
    const tokens = await Auth!.tokenProvider!.getTokens();
    expect(tokens?.idToken?.toString()).toBe("header.payload.signature");
    expect(tokens?.accessToken?.toString()).toBe("header.payload.signature");
  });

  it("serves the token payload as idToken.payload for claim extraction", async () => {
    respondWith("h.p.s", Math.floor(Date.now() / 1000) + 3600);
    const { Auth } = localSessionLibraryOptions(ENDPOINT);
    const tokens = await Auth!.tokenProvider!.getTokens();
    expect(tokens?.idToken?.payload).toMatchObject({ sub: "user-1" });
  });

  it("caches the token and refetches once it has expired", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      const now = Math.floor(Date.now() / 1000);
      respondWith("first", now + 3600);
      const { Auth } = localSessionLibraryOptions(ENDPOINT);
      await Auth!.tokenProvider!.getTokens();
      await Auth!.tokenProvider!.getTokens();
      expect(fetchMock).toHaveBeenCalledTimes(1);

      // Let the cached token lapse, so the refetch is genuinely expiry-driven.
      vi.setSystemTime((now + 3601) * 1000);
      respondWith("second", now + 7200);
      const refreshed = await Auth!.tokenProvider!.getTokens();
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(refreshed?.idToken?.toString()).toBe("second");
    } finally {
      vi.useRealTimers();
    }
  });

  it("refetches while the token is still valid but inside the expiry slack", async () => {
    const now = Math.floor(Date.now() / 1000);
    respondWith("first", now + 10);
    const { Auth } = localSessionLibraryOptions(ENDPOINT);
    await Auth!.tokenProvider!.getTokens();
    // 10s of life left is inside the 30s slack, so it is already treated as
    // expired: a token must not be able to lapse mid-request.
    const refreshed = await Auth!.tokenProvider!.getTokens();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(refreshed?.idToken?.toString()).toBe("first");
  });

  it("shares a single in-flight request between concurrent callers", async () => {
    respondWith("shared", Math.floor(Date.now() / 1000) + 3600);
    const { Auth } = localSessionLibraryOptions(ENDPOINT);
    const [first, second] = await Promise.all([
      Auth!.tokenProvider!.getTokens(),
      Auth!.tokenProvider!.getTokens(),
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(first?.idToken?.toString()).toBe("shared");
    expect(second?.idToken?.toString()).toBe("shared");
  });

  it("returns null when the local edge is unreachable, so the app shows logged-out", async () => {
    fetchMock.mockRejectedValue(new Error("ECONNREFUSED"));
    const { Auth } = localSessionLibraryOptions(ENDPOINT);
    await expect(Auth!.tokenProvider!.getTokens()).resolves.toBeNull();
  });

  it("recovers once the edge becomes reachable again", async () => {
    fetchMock.mockRejectedValue(new Error("ECONNREFUSED"));
    const { Auth } = localSessionLibraryOptions(ENDPOINT);
    await expect(Auth!.tokenProvider!.getTokens()).resolves.toBeNull();

    respondWith("late", Math.floor(Date.now() / 1000) + 3600);
    const recovered = await Auth!.tokenProvider!.getTokens();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(recovered?.idToken?.toString()).toBe("late");
  });

  it("returns null rather than caching a session when the edge errors", async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 503,
      json: async () => ({}),
    });
    const { Auth } = localSessionLibraryOptions(ENDPOINT);
    await expect(Auth!.tokenProvider!.getTokens()).resolves.toBeNull();
  });

  it("returns null when the edge returns a body that is not valid JSON", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => {
        throw new SyntaxError("Unexpected token < in JSON at position 0");
      },
    });
    const { Auth } = localSessionLibraryOptions(ENDPOINT);
    await expect(Auth!.tokenProvider!.getTokens()).resolves.toBeNull();
  });

  it("supplies dummy SigV4 credentials so request signing still runs", async () => {
    const exp = Math.floor(Date.now() / 1000) + 3600;
    respondWith("h.p.s", exp);
    const { Auth } = localSessionLibraryOptions(ENDPOINT);
    const result = await Auth!.credentialsProvider!.getCredentialsAndIdentityId(
      {},
    );
    expect(result?.credentials.accessKeyId).toBe("test");
    expect(result?.identityId).toBeTruthy();
    expect(result?.credentials.expiration).toEqual(new Date(exp * 1000));
  });

  it("returns undefined credentials while the edge is unreachable", async () => {
    fetchMock.mockRejectedValue(new Error("ECONNREFUSED"));
    const { Auth } = localSessionLibraryOptions(ENDPOINT);
    await expect(
      Auth!.credentialsProvider!.getCredentialsAndIdentityId({}),
    ).resolves.toBeUndefined();
  });

  it("drops the cached session on sign-out so the next read refetches", async () => {
    respondWith("first", Math.floor(Date.now() / 1000) + 3600);
    const { Auth } = localSessionLibraryOptions(ENDPOINT);
    await Auth!.tokenProvider!.getTokens();
    Auth!.credentialsProvider!.clearCredentialsAndIdentityId();

    respondWith("second", Math.floor(Date.now() / 1000) + 3600);
    const afterSignOut = await Auth!.tokenProvider!.getTokens();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(afterSignOut?.idToken?.toString()).toBe("second");
  });
});
