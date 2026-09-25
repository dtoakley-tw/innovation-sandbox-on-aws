// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
    // The private half must never be published.
    expect(JSON.stringify(jwks)).not.toContain("PRIVATE");
  });

  it("names the fix when the persisted key file is unreadable", async () => {
    writeFileSync(join(dir, "local-jwks.json"), "{ not json");
    await expect(loadOrCreateKeyPair()).rejects.toThrow(/npm run local:reset/);
  });

  it("names the fix when the persisted key file is missing its halves", async () => {
    writeFileSync(join(dir, "local-jwks.json"), JSON.stringify({ kid: "abc" }));
    await expect(loadOrCreateKeyPair()).rejects.toThrow(/npm run local:reset/);
  });
});
