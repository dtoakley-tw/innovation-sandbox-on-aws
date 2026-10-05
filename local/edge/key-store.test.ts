// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import {
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  createKeyFileExclusive,
  keyFilePath,
  localKeyDir,
  PRIVATE_KEY_MODE,
  PUBLIC_FILE_MODE,
  readKeyFile,
} from "./key-store.js";

let dir: string;
const originalEnv = process.env.ISB_LOCAL_KEY_DIR;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "isb-local-key-store-"));
  process.env.ISB_LOCAL_KEY_DIR = dir;
});

afterEach(() => {
  if (originalEnv === undefined) delete process.env.ISB_LOCAL_KEY_DIR;
  else process.env.ISB_LOCAL_KEY_DIR = originalEnv;
  rmSync(dir, { recursive: true, force: true });
});

describe("the local key directory", () => {
  // The bug this file exists to prevent, restated: a resolver that does not
  // handle an unset variable hands `undefined` to `path.join`, and the
  // resulting `ENOENT: open 'undefined/…'` names a directory that was never in
  // play. Both of these are the same resolver the edge, the synth and the CA
  // generator use, so getting it wrong breaks all three at once.
  it("falls back to a directory inside local/ when the variable is unset", () => {
    delete process.env.ISB_LOCAL_KEY_DIR;
    expect(localKeyDir()).toMatch(/[/\\]local[/\\]\.keys$/);
    expect(localKeyDir()).not.toContain("undefined");
  });

  it("reads the variable on every call, not once at module load", () => {
    const first = localKeyDir();
    process.env.ISB_LOCAL_KEY_DIR = "/somewhere/else";
    expect(localKeyDir()).not.toBe(first);
    expect(keyFilePath("thing.pem")).toBe("/somewhere/else/thing.pem");
  });

  it("joins a name onto it", () => {
    expect(keyFilePath("isb-local-ca.pem")).toBe(join(dir, "isb-local-ca.pem"));
  });
});

describe("writing key material", () => {
  it("creates the directory it needs, and reports that it created the file", () => {
    const nested = join(dir, "a", "b", "thing.json");
    expect(createKeyFileExclusive(nested, "{}", PRIVATE_KEY_MODE)).toBe(true);
    expect(readKeyFile(nested)).toBe("{}");
  });

  // `local:up` starts the edge container and then runs `cdk deploy`, and both
  // write here. Last-writer-wins would be harmless for identical bytes and
  // catastrophic for these: the edge could end up serving a leaf the bundled CA
  // does not verify, and the symptom is a TLS error six Lambdas deep.
  it("lets exactly one writer create the name, and reports the loser", () => {
    const file = join(dir, "contended.json");
    expect(createKeyFileExclusive(file, "first", PRIVATE_KEY_MODE)).toBe(true);
    expect(createKeyFileExclusive(file, "second", PRIVATE_KEY_MODE)).toBe(
      false,
    );
    // The winner's bytes are what survive, byte for byte.
    expect(readKeyFile(file)).toBe("first");
  });

  // A reader that arrives between a create and a write back sees a truncated
  // file, which is the one interleaving a JSON parse turns into a hard failure.
  // The name appears only once the bytes are complete, so there is no such
  // window: the assertion is that nothing is left behind to be read.
  it("leaves no temporary file behind, however the write ends", () => {
    const file = join(dir, "atomic.json");
    createKeyFileExclusive(file, "payload", PRIVATE_KEY_MODE);
    createKeyFileExclusive(file, "payload", PRIVATE_KEY_MODE);
    expect(readdirSync(dir)).toEqual(["atomic.json"]);
  });

  it("surfaces a real write failure rather than swallowing it", () => {
    // Only `EEXIST` from `link` means "lost the race". Anything else — here, a
    // parent path that is a regular file, so the directory cannot be created —
    // is a real failure and is rethrown, because swallowing it would return a
    // `false` the caller would read as a contended file and then parse.
    const blocked = join(dir, "a-file");
    writeFileSync(blocked, "not a directory");
    expect(() =>
      createKeyFileExclusive(
        join(blocked, "child.json"),
        "{}",
        PRIVATE_KEY_MODE,
      ),
    ).toThrow();
  });

  it("creates private material 0600 and public material world-readable", () => {
    const secret = join(dir, "secret.json");
    const publicFile = join(dir, "public.pem");
    createKeyFileExclusive(secret, "{}", PRIVATE_KEY_MODE);
    createKeyFileExclusive(publicFile, "cert", PUBLIC_FILE_MODE);
    expect(statSync(secret).mode & 0o777).toBe(0o600);
    expect(statSync(publicFile).mode & 0o777).toBe(0o644);
  });

  it("reads back exactly what was written, whatever the content", () => {
    const file = join(dir, "round-trip.json");
    const contents = JSON.stringify({ a: 1, b: "two\nlines\n", c: "✓" });
    createKeyFileExclusive(file, contents, PRIVATE_KEY_MODE);
    expect(readKeyFile(file)).toBe(contents);
    expect(readFileSync(file, "utf-8")).toBe(contents);
  });
});
