// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import { createVerify } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  LOCAL_APP_CLIENT_ID,
  LOCAL_REGION,
  LOCAL_USER_POOL_ID,
} from "../shared/names.js";
import { loadOrCreateKeyPair } from "./jwks.js";
import { LOCAL_ISSUER, mintLocalIdToken } from "./mint-token.js";

let dir: string;
const originalEnv = process.env.ISB_LOCAL_KEY_DIR;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "isb-local-mint-"));
  process.env.ISB_LOCAL_KEY_DIR = dir;
});

afterEach(() => {
  if (originalEnv === undefined) delete process.env.ISB_LOCAL_KEY_DIR;
  else process.env.ISB_LOCAL_KEY_DIR = originalEnv;
  rmSync(dir, { recursive: true, force: true });
});

const decode = (token: string) =>
  JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString("utf-8"));

describe("mintLocalIdToken", () => {
  it("signs an RS256 token whose kid matches the published key", async () => {
    const keyPair = await loadOrCreateKeyPair();
    const token = await mintLocalIdToken({
      keyPair,
      sub: "user-1",
      email: "admin@example.local",
      roles: ["Admin"],
    });
    expect(
      JSON.parse(
        Buffer.from(token.split(".")[0], "base64url").toString("utf-8"),
      ),
    ).toMatchObject({
      alg: "RS256",
      kid: keyPair.kid,
    });
  });

  it("carries the Cognito claims the application already reads", async () => {
    const keyPair = await loadOrCreateKeyPair();
    const token = await mintLocalIdToken({
      keyPair,
      sub: "user-1",
      email: "admin@example.local",
      roles: ["Admin", "User"],
    });
    const claims = decode(token);
    expect(claims).toMatchObject({
      sub: "user-1",
      email: "admin@example.local",
      "cognito:username": "admin@example.local",
      "custom:idc_user_id": "user-1",
      "custom:isb_roles": '["Admin","User"]',
      token_use: "id",
      aud: LOCAL_APP_CLIENT_ID,
    });
    expect(claims.iss).toBe(LOCAL_ISSUER);
  });

  it("produces a signature the published public key verifies", async () => {
    const keyPair = await loadOrCreateKeyPair();
    const token = await mintLocalIdToken({
      keyPair,
      sub: "user-1",
      email: "admin@example.local",
      roles: ["User"],
    });
    const [header, payload, signature] = token.split(".");
    const verifier = createVerify("RSA-SHA256");
    verifier.update(`${header}.${payload}`);
    expect(
      verifier.verify(keyPair.publicKey, Buffer.from(signature, "base64url")),
    ).toBe(true);
  });

  it("expires in the future and honors a custom ttl", async () => {
    const keyPair = await loadOrCreateKeyPair();
    const token = await mintLocalIdToken({
      keyPair,
      sub: "user-1",
      email: "admin@example.local",
      roles: ["User"],
      ttlSeconds: 120,
    });
    const claims = decode(token);
    expect(claims.exp - claims.iat).toBe(120);
    expect(claims.exp).toBeGreaterThan(Math.floor(Date.now() / 1000));
  });
});

describe("LOCAL_ISSUER", () => {
  // CognitoJwtVerifier derives the issuer from the pool id, so a hardcoded
  // region here would 401 every request the moment LOCAL_REGION or
  // LOCAL_USER_POOL_ID moved independently.
  it("matches the issuer CognitoJwtVerifier derives from the pool id", () => {
    expect(LOCAL_ISSUER).toBe(
      `https://cognito-idp.${LOCAL_REGION}.amazonaws.com/${LOCAL_USER_POOL_ID}`,
    );
    expect(LOCAL_USER_POOL_ID.startsWith(`${LOCAL_REGION}_`)).toBe(true);
  });
});
