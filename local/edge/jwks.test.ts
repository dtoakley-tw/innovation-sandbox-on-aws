// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import {
  existsSync,
  mkdtempSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { buildLocalJwks, loadOrCreateKeyPair } from "./jwks.js";

let dir: string;
const originalEnv = process.env.ISB_LOCAL_KEY_DIR;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "isb-local-keys-"));
  process.env.ISB_LOCAL_KEY_DIR = dir;
});

afterEach(() => {
  if (originalEnv === undefined) delete process.env.ISB_LOCAL_KEY_DIR;
  else process.env.ISB_LOCAL_KEY_DIR = originalEnv;
  rmSync(dir, { recursive: true, force: true });
});

describe("local JWKS", () => {
  it("generates a keypair and persists it", async () => {
    const first = await loadOrCreateKeyPair();
    expect(existsSync(join(dir, "local-jwks.json"))).toBe(true);
    expect(first.privateKey).toContain("PRIVATE KEY");
    expect(first.kid).toBeTruthy();
  });

  it("keeps the persisted private key off other users on the machine", async () => {
    await loadOrCreateKeyPair();
    const mode = statSync(join(dir, "local-jwks.json")).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it("returns the same keypair on a second call", async () => {
    const first = await loadOrCreateKeyPair();
    const second = await loadOrCreateKeyPair();
    expect(second.privateKey).toBe(first.privateKey);
    expect(second.kid).toBe(first.kid);
  });

  it("publishes exactly one key matching the signing kid", async () => {
    const keyPair = await loadOrCreateKeyPair();
    const jwks = buildLocalJwks(keyPair);
    expect(jwks.keys).toHaveLength(1);
    expect(jwks.keys[0].kid).toBe(keyPair.kid);
    expect(jwks.keys[0].kty).toBe("RSA");
    expect(jwks.keys[0].alg).toBe("RS256");
    // The private PEM specifically: base64url-encoded n/e/d would not contain
    // this substring, so what actually keeps other private material out is the
    // excess-property check on JwksDocument's return type, not this assertion.
    expect(JSON.stringify(jwks)).not.toContain("PRIVATE");
  });

  // A JWKS encoded with standard base64 rather than base64url is silently
  // rejected by real verifiers, so pin the encoding rather than the values.
  it("encodes the modulus and exponent as unpadded base64url", async () => {
    const keyPair = await loadOrCreateKeyPair();
    const { n, e } = buildLocalJwks(keyPair).keys[0];

    // base64url alphabet only: no "+", "/", or "=" padding.
    expect(n).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(e).toMatch(/^[A-Za-z0-9_-]+$/);

    // 65537, the standard RSA public exponent, as 3 bytes.
    expect(Buffer.from(e, "base64url").toString("hex")).toBe("010001");
    // 2048-bit modulus.
    expect(Buffer.from(n, "base64url")).toHaveLength(256);
  });

  it("names the fix and keeps the cause when the key file is corrupt JSON", async () => {
    writeFileSync(join(dir, "local-jwks.json"), "{ not json");
    const error = await loadOrCreateKeyPair().then(
      () => undefined,
      (e: unknown) => e as Error,
    );
    expect(error?.message).toMatch(/npm run local:reset/);
    // The underlying parse error is preserved rather than swallowed.
    expect(error?.cause).toBeInstanceOf(SyntaxError);
  });

  it("names the fix when the persisted key file is missing its halves", async () => {
    writeFileSync(join(dir, "local-jwks.json"), JSON.stringify({ kid: "abc" }));
    await expect(loadOrCreateKeyPair()).rejects.toThrow(/npm run local:reset/);
  });
});
