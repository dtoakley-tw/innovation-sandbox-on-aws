// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import { createHash, createPublicKey, generateKeyPairSync } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export interface KeyPair {
  privateKey: string;
  publicKey: string;
  kid: string;
}

export interface JwksDocument {
  keys: Array<{
    kty: "RSA";
    alg: "RS256";
    use: "sig";
    kid: string;
    n: string;
    e: string;
  }>;
}

const DEFAULT_KEY_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  ".keys",
);

/**
 * Resolved on every call rather than once at module load so a caller — the
 * edge, or a test pointing at a temp directory — can set
 * ISB_LOCAL_KEY_DIR before asking for the keypair.
 */
const keyFilePath = () =>
  join(process.env.ISB_LOCAL_KEY_DIR ?? DEFAULT_KEY_DIR, "local-jwks.json");

/**
 * A truncated or hand-edited key file would otherwise surface much later as an
 * opaque signing failure, so fail here with the one command that fixes it.
 */
const readKeyPair = (keyFile: string): KeyPair => {
  const unusable = (): never => {
    throw new Error(
      `Local signing key at ${keyFile} is unreadable or incomplete. Delete it and run \`npm run local:reset\` to mint a new one.`,
    );
  };
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(keyFile, "utf-8"));
  } catch {
    return unusable();
  }
  const candidate = parsed as Partial<KeyPair>;
  if (!candidate?.privateKey || !candidate?.publicKey || !candidate?.kid) {
    return unusable();
  }
  return candidate as KeyPair;
};

/**
 * Loads the local signing keypair, generating and persisting one on first run.
 * The key is deliberately gitignored: it is a development-only trust anchor with
 * no value outside this machine, and rotating it costs one `local:reset`.
 */
export async function loadOrCreateKeyPair(): Promise<KeyPair> {
  const keyFile = keyFilePath();
  if (existsSync(keyFile)) {
    return readKeyPair(keyFile);
  }
  const { privateKey, publicKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
  });
  const privatePem = privateKey.export({
    type: "pkcs8",
    format: "pem",
  }) as string;
  const publicPem = publicKey.export({ type: "spki", format: "pem" }) as string;
  // kid derived from the public key so it is stable across restarts and unique
  // per key, letting the verifier select the right key if the pair is rotated.
  const kid = createHash("sha256")
    .update(publicPem)
    .digest("base64url")
    .slice(0, 16);
  const keyPair: KeyPair = {
    privateKey: privatePem,
    publicKey: publicPem,
    kid,
  };
  mkdirSync(dirname(keyFile), { recursive: true });
  writeFileSync(keyFile, JSON.stringify(keyPair, null, 2));
  return keyPair;
}

/** Builds the JWKS document the Lambda loads via ISB_LOCAL_JWKS_URI. */
export function buildLocalJwks(keyPair: KeyPair): JwksDocument {
  const jwk = createPublicKey(keyPair.publicKey).export({
    format: "jwk",
  }) as { n: string; e: string };
  return {
    keys: [
      {
        kty: "RSA",
        alg: "RS256",
        use: "sig",
        kid: keyPair.kid,
        n: jwk.n,
        e: jwk.e,
      },
    ],
  };
}
