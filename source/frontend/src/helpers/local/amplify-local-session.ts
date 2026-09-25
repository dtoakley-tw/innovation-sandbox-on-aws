// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import type {
  CredentialsAndIdentityIdProvider,
  TokenProvider,
} from "@aws-amplify/core";

/**
 * The JSON value model. Amplify does not export its `JwtPayload`/`JsonObject`
 * from the package root either, so this shape is restated rather than imported.
 * It has to mirror Amplify's exactly: `Token.payload` is typed as a `JsonObject`,
 * so a `Record<string, unknown>` index signature is *not* assignable to it and
 * would make these providers unusable by `Amplify.configure`. The provider
 * interfaces below are imported, so the part of the contract that can actually
 * drift is enforced rather than restated; the
 * `returns library options that Amplify.configure accepts` test in
 * `test/helpers/local/amplify-local-session.test.ts` is the compile-time proof
 * that this restatement is assignable to Amplify's real `LibraryOptions`.
 */
type JsonPrimitive = null | string | number | boolean;
type JsonArray = (JsonPrimitive | JsonObject | JsonArray)[];
interface JsonObject {
  [key: string]: JsonPrimitive | JsonArray | JsonObject;
}

interface SessionPayload extends JsonObject {
  exp: number;
}

/** Shape returned by the local edge's `GET /session` route. */
export interface SessionResponse {
  token: string;
  payload: SessionPayload;
}

/**
 * Narrows an untrusted `/session` body before it is cached. The edge is ours,
 * but a misconfigured `VITE_LOCAL_SESSION_ENDPOINT` or a dev proxy can answer
 * with some other JSON entirely; without this a bad body would be cached and
 * then throw from `isExpired` on every later call, wedging the provider until
 * sign-out.
 */
const isSessionResponse = (value: unknown): value is SessionResponse => {
  if (typeof value !== "object" || value === null) return false;
  if (!("token" in value) || typeof value.token !== "string") return false;
  if (
    !("payload" in value) ||
    typeof value.payload !== "object" ||
    value.payload === null
  ) {
    return false;
  }
  return "exp" in value.payload && typeof value.payload.exp === "number";
};

/**
 * Amplify session for the offline LocalStack profile.
 *
 * Production login is a Cognito hosted-UI redirect federating to IAM Identity
 * Center, which no emulator reproduces. Amplify exposes `libraryOptions` as the
 * supported way to supply tokens and credentials directly, so the local profile
 * passes these providers and everything downstream of `fetchAuthSession` —
 * claim extraction, SigV4 signing, the `x-isb-identity` header — runs unchanged.
 *
 * The token is minted and signed by the local edge; the private key never
 * reaches the browser.
 *
 * Selected only when `VITE_LOCAL_SESSION_ENDPOINT` is set; see
 * `configureAmplifyAuth`.
 */
export function localSessionLibraryOptions(sessionEndpoint: string): {
  Auth: {
    tokenProvider: TokenProvider;
    credentialsProvider: CredentialsAndIdentityIdProvider;
  };
} {
  let cached: SessionResponse | null = null;
  let inFlight: Promise<SessionResponse | null> | null = null;

  const isExpired = (session: SessionResponse) =>
    // 30s of slack so a token cannot expire mid-request.
    session.payload.exp * 1000 - 30_000 <= Date.now();

  const loadSession = async (): Promise<SessionResponse | null> => {
    if (cached && !isExpired(cached)) return cached;
    inFlight ??= (async () => {
      try {
        const response = await fetch(sessionEndpoint, { cache: "no-store" });
        if (!response.ok) return null;
        const body: unknown = await response.json();
        if (!isSessionResponse(body)) return null;
        cached = body;
        return body;
      } catch {
        // The local edge not running is a normal state, not an error: the app
        // should render logged out rather than crash.
        return null;
      } finally {
        // Always cleared, so a failed attempt cannot wedge later callers.
        inFlight = null;
      }
    })();
    return inFlight;
  };

  const tokenProvider: TokenProvider = {
    // `forceRefresh` is deliberately ignored: the local identity is stable for
    // the life of the edge's key, so an explicit re-read buys nothing and the
    // `exp` check already refreshes a lapsed token.
    getTokens: async () => {
      const session = await loadSession();
      if (!session) return null;
      // `JWT` is type-only in aws-amplify 6.16.4, so a structural object
      // satisfying `{ payload, toString() }` is what AuthTokens accepts.
      const toToken = () => ({
        payload: session.payload,
        toString: () => session.token,
      });
      return { idToken: toToken(), accessToken: toToken() };
    },
  };

  const credentialsProvider: CredentialsAndIdentityIdProvider = {
    getCredentialsAndIdentityId: async () => {
      const session = await loadSession();
      if (!session) return undefined;
      return {
        // Fixed dummy credentials: the local API authorizes the ID token, not
        // these, but SigV4 still has to have something to sign with.
        credentials: {
          accessKeyId: "test",
          secretAccessKey: "test",
          sessionToken: "test",
          expiration: new Date(session.payload.exp * 1000),
        },
        identityId: `${sessionEndpoint}#local-identity`,
      };
    },
    clearCredentialsAndIdentityId: () => {
      cached = null;
    },
  };

  return { Auth: { tokenProvider, credentialsProvider } };
}
