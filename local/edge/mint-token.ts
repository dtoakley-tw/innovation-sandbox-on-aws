// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import { createSign } from "node:crypto";

import { LOCAL_APP_CLIENT_ID, LOCAL_USER_POOL_ID } from "../shared/names.js";
import type { KeyPair } from "./jwks.js";

/**
 * The issuer `CognitoJwtVerifier` derives from COGNITO_USER_POOL_ID. A token
 * whose `iss` differs is rejected, so this must stay in lockstep with the pool
 * ID the local CDK app sets on the Lambdas. The region is taken from the pool
 * ID rather than LOCAL_REGION so there is a single source of truth.
 */
export const LOCAL_ISSUER = `https://cognito-idp.${LOCAL_USER_POOL_ID.split("_")[0]}.amazonaws.com/${LOCAL_USER_POOL_ID}`;

export interface MintOptions {
  keyPair: KeyPair;
  sub: string;
  email: string;
  roles: string[];
  ttlSeconds?: number;
}

const base64url = (input: Buffer | string) =>
  Buffer.from(input).toString("base64url");

export async function mintLocalIdToken(options: MintOptions): Promise<string> {
  const { keyPair, sub, email, roles, ttlSeconds = 3600 } = options;
  const issuedAt = Math.floor(Date.now() / 1000);
  const header = { alg: "RS256", typ: "JWT", kid: keyPair.kid };
  const payload = {
    sub,
    email,
    email_verified: true,
    "cognito:username": email,
    // The Pre Token Generation Lambda injects this in production; locally the
    // edge sets it directly from the server-side role allowlist.
    "custom:idc_user_id": sub,
    "custom:isb_roles": JSON.stringify(roles),
    aud: LOCAL_APP_CLIENT_ID,
    iss: LOCAL_ISSUER,
    token_use: "id",
    iat: issuedAt,
    exp: issuedAt + ttlSeconds,
  };
  const signingInput = `${base64url(JSON.stringify(header))}.${base64url(
    JSON.stringify(payload),
  )}`;
  const signer = createSign("RSA-SHA256");
  signer.update(signingInput);
  signer.end();
  return `${signingInput}.${base64url(signer.sign(keyPair.privateKey))}`;
}
