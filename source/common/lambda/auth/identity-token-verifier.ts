// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import { Logger } from "@aws-lambda-powertools/logger";
import { CognitoJwtVerifier } from "aws-jwt-verify";
import { fetchJwks } from "aws-jwt-verify/jwk";
import { APIGatewayProxyEvent } from "aws-lambda";

import { IDENTITY_HEADER } from "@amzn/innovation-sandbox-shared/utils/auth-utils.js";

const logger = new Logger({ serviceName: "IdentityTokenVerifier" });

const COGNITO_SIGN_IN_REGEX = /CognitoSignIn:([0-9a-f-]+)$/;

export type IdentityTokenErrorKind = "Missing" | "Invalid" | "SubMismatch";

export class IdentityTokenError extends Error {
  constructor(
    public readonly kind: IdentityTokenErrorKind,
    message: string,
  ) {
    super(message);
    this.name = "IdentityTokenError";
  }
}

export interface IdentityVerifierEnv {
  COGNITO_USER_POOL_ID: string;
  COGNITO_APP_CLIENT_ID: string;
  /**
   * Local development only. When set, JWKS is loaded from this URI instead of
   * the Cognito endpoint derived from COGNITO_USER_POOL_ID, which is
   * unreachable in the offline LocalStack profile. Unset in production.
   */
  ISB_LOCAL_JWKS_URI?: string;
}

// Cache the verifier across invocations: aws-jwt-verify holds the JWKS in
// memory inside the instance, so reusing it for the lifetime of the Lambda
// execution environment avoids re-fetching keys on every request.
let verifier: ReturnType<
  typeof CognitoJwtVerifier.create<{
    userPoolId: string;
    tokenUse: "id";
    clientId: string;
  }>
> | null = null;

function getVerifier(env: IdentityVerifierEnv) {
  if (verifier) return verifier;
  verifier = CognitoJwtVerifier.create({
    userPoolId: env.COGNITO_USER_POOL_ID,
    tokenUse: "id",
    clientId: env.COGNITO_APP_CLIENT_ID,
  });
  return verifier;
}

// Resolved once per execution environment. Reset on failure so a transient
// local-edge outage does not permanently poison verification for the life of
// the container.
let localJwksReady: Promise<void> | null = null;

async function ensureLocalJwks(env: IdentityVerifierEnv): Promise<void> {
  if (!env.ISB_LOCAL_JWKS_URI) return;
  localJwksReady ??= fetchJwks(env.ISB_LOCAL_JWKS_URI)
    .then((jwks) => {
      // Seeds the in-memory cache keyed by the Cognito issuer derived from the
      // pool id, so the verifier never issues the network request it would
      // otherwise make.
      getVerifier(env).cacheJwks(jwks, env.COGNITO_USER_POOL_ID);
    })
    .catch((error: unknown) => {
      localJwksReady = null;
      throw error;
    });
  await localJwksReady;
}

// Format: cognito-idp.<region>.amazonaws.com/<pool>:CognitoSignIn:<sub>
// https://docs.aws.amazon.com/apigateway/latest/developerguide/api-gateway-mapping-template-reference.html#context-variable-reference
export function extractSubFromAuthProvider(
  providerString: string | undefined | null,
): string | null {
  if (!providerString) return null;
  const match = providerString.match(COGNITO_SIGN_IN_REGEX);
  return match?.[1] ?? null;
}

export function readIdentityHeader(event: APIGatewayProxyEvent): string | null {
  const entry = Object.entries(event.headers ?? {}).find(
    ([name, value]) => name.toLowerCase() === IDENTITY_HEADER && value,
  );
  return entry?.[1] ?? null;
}

export async function verifyAndExtractClaims(
  event: APIGatewayProxyEvent,
  env: IdentityVerifierEnv,
): Promise<Record<string, unknown>> {
  const token = readIdentityHeader(event);
  if (!token) {
    throw new IdentityTokenError("Missing", "Missing identity token.");
  }

  await ensureLocalJwks(env);

  const payload = (await getVerifier(env)
    .verify(token)
    .catch((err: unknown) => {
      logger.warn("Identity token verification failed.", {
        error: String(err),
      });
      throw new IdentityTokenError("Invalid", "Invalid identity token.");
    })) as Record<string, unknown>;

  const cognitoAuthProvider =
    event.requestContext?.identity?.cognitoAuthenticationProvider;
  const subFromContext = extractSubFromAuthProvider(cognitoAuthProvider);

  if (subFromContext === null) {
    if (cognitoAuthProvider) {
      // Triggered if AWS ever changes the cognitoAuthenticationProvider
      // string format (current format is documented but not API-stable).
      // We fall open here rather than 401 because the request still
      // carries an API-Gateway-asserted SigV4 signature AND a JWKS-
      // verified ID token — the sub-cross-check is a third defense, not
      // a load-bearing one. Failing closed would 401 every authenticated
      // request mid-incident; the warn log lets operators detect and
      // patch the parser before the next deploy.
      logger.warn(
        "cognitoAuthenticationProvider format not recognized — skipping anti-spoofing sub cross-check. SigV4 signature and JWKS verification still protect the request.",
        { cognitoAuthProvider },
      );
    }
    return payload;
  }

  if (payload.sub !== subFromContext) {
    throw new IdentityTokenError("SubMismatch", "Identity mismatch.");
  }

  return payload;
}
