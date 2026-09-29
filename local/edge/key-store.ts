// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import { randomBytes } from "node:crypto";
import {
  existsSync,
  linkSync,
  mkdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Where the local profile keeps everything that has to outlive a process: the
 * session signing key (`jwks.ts`) and the development TLS material
 * (`dev-ca.ts`). `local/.gitignore` excludes it, and `local:down` preserves it
 * for the same reason the node_modules volume does — a dependency and a trust
 * anchor are caches and local state, not a distributed artifact.
 *
 * One resolver for both consumers, read on every call rather than captured at
 * module load, so the edge container, the CDK synth on the host, and a test
 * pointing at a temp directory all agree on where the material is. Two copies
 * of this expression is how the edge would end up serving a JWKS signed by one
 * key while a Lambda bundle trusts a certificate from a different directory.
 */
const DEFAULT_KEY_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  ".keys",
);

export const localKeyDir = (): string =>
  process.env.ISB_LOCAL_KEY_DIR ?? DEFAULT_KEY_DIR;

/** Absolute path of one file in the key directory. */
export const keyFilePath = (name: string): string => join(localKeyDir(), name);

/**
 * Creates `contents` at `file` only if nothing is there yet, and reports which
 * of the two happened.
 *
 * Written to a private temporary name and then `link`ed into place, because the
 * two participants in this profile genuinely race: `local:up` starts the edge
 * container *and then* runs `cdk deploy`, and either may be the first to want
 * the local CA (see `dev-ca.ts`). `writeFileSync(..., { flag: "wx" })` is
 * atomic as a *create* but a reader that arrives between the create and the
 * write back sees a truncated file, which is the one interleaving a JSON parse
 * turns into a hard failure on a machine doing nothing unusual.
 *
 * `link` is the atomic exclusive create: it either makes the name or fails
 * EEXIST, and the winner's bytes are already complete when the name appears.
 * Verified to work on the bind mount the edge container writes this through
 * (Docker Desktop's file sharing), which is the filesystem that matters here.
 */
export const createKeyFileExclusive = (
  file: string,
  contents: string,
  mode: number,
): boolean => {
  mkdirSync(dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}-${randomBytes(6).toString("hex")}`;
  try {
    writeFileSync(temporary, contents, { mode });
    try {
      linkSync(temporary, file);
      return true;
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code !== "EEXIST") throw cause;
      return false;
    }
  } finally {
    // Guarded, so cleaning up a temporary that was never written does not
    // replace the error that matters with an ENOENT.
    if (existsSync(temporary)) unlinkSync(temporary);
  }
};

export const readKeyFile = (file: string): string =>
  readFileSync(file, "utf-8");

/** The mode a file holding a private key is created with. */
export const PRIVATE_KEY_MODE = 0o600;
/** Public material — a certificate — is not a secret. */
export const PUBLIC_FILE_MODE = 0o644;
