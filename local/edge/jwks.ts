// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import { createHash, createPublicKey, generateKeyPairSync } from "node:crypto";
import { existsSync } from "node:fs";

import {
  createKeyFileExclusive,
  keyFilePath,
  PRIVATE_KEY_MODE,
  readKeyFile,
} from "./key-store.js";

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

/**
 * Resolved on every call rather than once at module load, and through
 * `key-store.ts` rather than a second copy of the expression: the development
 * TLS material in `dev-ca.ts` is written to the same directory by a different
 * process (the CDK synth) and read by a different one, and two resolvers is how
 * the edge would end up signing with one key while a bundle trusts a
 * certificate from somewhere else.
 */
const KEY_FILE = "local-jwks.json";

const signingKeyFilePath = (): string => keyFilePath(KEY_FILE);

/**
 * A truncated or hand-edited key file would otherwise surface much later as an
 * opaque signing failure, so fail here with the one command that fixes it.
 */
const readKeyPair = (keyFile: string): KeyPair => {
  const unusable = (cause?: unknown): never => {
    throw new Error(
      `Local signing key at ${keyFile} is corrupt or incomplete. Delete it and run \`npm run local:reset\` to mint a new one.`,
      { cause },
    );
  };
  // Read outside the try: a permissions failure needs a chmod, not a delete,
  // and it carries its own errno worth surfacing verbatim.
  const contents = readKeyFile(keyFile);
  let parsed: unknown;
  try {
    parsed = JSON.parse(contents);
  } catch (e) {
    return unusable(e);
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
 *
 * Written through `createKeyFileExclusive` for the same reason `dev-ca.ts`
 * writes through it: the edge container and the `local:verify` harness are not
 * the only processes that ask for this key, and a reader that arrived between
 * a truncate and a write back would parse half a key pair.
 */
export async function loadOrCreateKeyPair(): Promise<KeyPair> {
  const keyFile = signingKeyFilePath();
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
  // 0600: the file holds the private key, which has no business being
  // world-readable on a shared machine.
  if (
    !createKeyFileExclusive(
      keyFile,
      JSON.stringify(keyPair, null, 2),
      PRIVATE_KEY_MODE,
    )
  ) {
    // Another process won the race. Its key is the one already published in any
    // JWKS a client has cached, so adopting it is the only convergent answer.
    return readKeyPair(keyFile);
  }
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
