// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

interface SessionPayload extends Record<string, unknown> {
  exp: number;
}

/** Shape returned by the local edge's `GET /session` route. */
export interface SessionResponse {
  token: string;
  payload: SessionPayload;
}

/**
 * The two provider contracts below are structural restatements of Amplify's
 * `TokenProvider` and `CredentialsAndIdentityIdProvider`. Amplify keeps those
 * types in `@aws-amplify/core`, which is not a declared dependency of this
 * workspace and does not export `LibraryAuthOptions` (the type both providers
 * hang off) from its entry point — so importing them would reach into an
 * undeclared transitive package for a contract this small. `Amplify.configure`
 * re-checks the object these providers build against the real types at the one
 * place it is installed, so drift still fails the build there.
 */
interface Token {
  payload: SessionPayload;
  toString(): string;
}

interface AuthTokens {
  idToken?: Token;
  accessToken: Token;
}

interface TokenProvider {
  getTokens(): Promise<AuthTokens | null>;
}

interface Credentials {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
  expiration?: Date;
}

interface CredentialsAndIdentityIdProvider {
  /** The options are unused: the local session never varies by request. */
  getCredentialsAndIdentityId(
    options: unknown,
  ): Promise<CredentialsAndIdentityId | undefined>;
  clearCredentialsAndIdentityId(): void;
}

interface CredentialsAndIdentityId {
  credentials: Credentials;
  identityId?: string;
}

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
    tokenProvider?: TokenProvider;
    credentialsProvider?: CredentialsAndIdentityIdProvider;
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
        const session = (await response.json()) as SessionResponse;
        cached = session;
        return session;
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
    getTokens: async () => {
      const session = await loadSession();
      if (!session) return null;
      // `JWT` is type-only in aws-amplify 6.16.4, so a structural object
      // satisfying `{ payload, toString() }` is what AuthTokens accepts.
      const toToken = (): Token => ({
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
