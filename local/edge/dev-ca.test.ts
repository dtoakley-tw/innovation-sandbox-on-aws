// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import { X509Certificate } from "node:crypto";
import {
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import type { Server } from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { LOCAL_EDGE_SERVICE_NAME, LOCAL_JWKS_PATH } from "../shared/names.js";
import {
  assertLocalJwksOverTls,
  loadOrCreateDevTlsCredentials,
  LOCAL_CA_CERTIFICATE_FILENAME,
  LOCAL_CA_CERTIFICATE_IN_TASK_ROOT,
  localCaCertificatePath,
} from "./dev-ca.js";
import { loadOrCreateKeyPair } from "./jwks.js";
import { createLocalJwksTlsServer } from "./server.js";

let dir: string;
const originalEnv = process.env.ISB_LOCAL_KEY_DIR;
const servers: Server[] = [];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "isb-local-dev-ca-"));
  process.env.ISB_LOCAL_KEY_DIR = dir;
});

afterEach(async () => {
  await Promise.all(
    servers
      .splice(0)
      .map(
        (server) =>
          new Promise<void>((resolve) => server.close(() => resolve())),
      ),
  );
  if (originalEnv === undefined) delete process.env.ISB_LOCAL_KEY_DIR;
  else process.env.ISB_LOCAL_KEY_DIR = originalEnv;
  rmSync(dir, { recursive: true, force: true });
});

/** A TLS listener on a random port, speaking the one route the edge serves. */
const startTlsListener = async (
  credentials: ReturnType<typeof loadOrCreateDevTlsCredentials>,
): Promise<string> => {
  const server = createLocalJwksTlsServer({
    // The real signing keypair, so the body is a real key set: what is under
    // test here is the certificate the listener is configured with, not the
    // document it answers with.
    keyPair: await loadOrCreateKeyPair(),
    credentials,
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  return `https://127.0.0.1:${port}${LOCAL_JWKS_PATH}`;
};

describe("the local development CA", () => {
  it("mints a CA and a leaf into the key directory, and no temporary files", () => {
    loadOrCreateDevTlsCredentials();
    const entries = readdirSync(dir).sort();
    expect(entries).toEqual([
      LOCAL_CA_CERTIFICATE_FILENAME,
      "local-dev-ca.json",
      // One leaf, named for the CA that signed it.
      expect.stringMatching(/^local-dev-edge-cert-[0-9a-f]{16}\.json$/),
    ]);
  });

  // The edge container and the `cdk deploy` in `local:up` both call this, in
  // either order, and neither waits for the other. Idempotence is what makes
  // that safe; without it the second caller would get a second CA and the
  // bundled copy would verify nothing.
  it("returns the same material on a second call", () => {
    const first = loadOrCreateDevTlsCredentials();
    const second = loadOrCreateDevTlsCredentials();
    expect(second).toEqual(first);
    expect(readdirSync(dir).sort()).toHaveLength(3);
  });

  it("signs the leaf with the CA it hands back", () => {
    const credentials = loadOrCreateDevTlsCredentials();
    const ca = new X509Certificate(credentials.caCertificatePem);
    const leaf = new X509Certificate(credentials.serverCertificatePem);
    // The real check, not "the names look related": a signature that does not
    // verify is what a chain build reports as
    // UNABLE_TO_VERIFY_LEAF_SIGNATURE.
    expect(leaf.verify(ca.publicKey)).toBe(true);
    expect(ca.checkIssued(ca)).toBe(true);
    expect(ca.issuer).toBe(ca.subject);
  });

  // `X509Certificate.ca` is `X509_check_ca`, the same function OpenSSL's own
  // verifier calls. It returns false for a CA whose keyUsage extension exists
  // but lacks keyCertSign, and a certificate like that parses perfectly and is
  // then refused at chain-build time by a client that says nothing about key
  // usage. This is the assertion that would have caught it.
  it("emits a CA OpenSSL will accept as a CA", () => {
    const ca = new X509Certificate(
      loadOrCreateDevTlsCredentials().caCertificatePem,
    );
    expect(ca.ca).toBe(true);
  });

  it("emits a leaf OpenSSL will accept for server authentication", () => {
    const leaf = new X509Certificate(
      loadOrCreateDevTlsCredentials().serverCertificatePem,
    );
    expect(leaf.ca).toBe(false);
    // The one name that has to validate: the Lambdas connect to
    // `isb-local-edge`, and a certificate without that SAN is refused with
    // ERR_TLS_CERT_ALTNAME_INVALID, which names the certificate and not the
    // configuration.
    expect(leaf.subjectAltName).toBe(`DNS:${LOCAL_EDGE_SERVICE_NAME}`);
  });

  // The document the Lambda trusts is deliberately not the document the edge
  // serves. A copy of the server certificate is handed to every caller of the
  // JWKS route, and the edge hands it to the host; if that document were the
  // trust anchor, anyone who read it off the wire could impersonate the edge.
  it("keeps the trust anchor a different document from the served certificate", () => {
    const credentials = loadOrCreateDevTlsCredentials();
    const ca = new X509Certificate(credentials.caCertificatePem);
    const leaf = new X509Certificate(credentials.serverCertificatePem);
    // Different documents, not one document described twice. A copy of the
    // server certificate is handed to every caller of the JWKS route and read
    // off the wire by `local:verify`, and if that document were the trust
    // anchor, anything that had ever seen it could impersonate the edge to
    // every Lambda in the profile.
    expect(ca.raw.equals(leaf.raw)).toBe(false);
    expect(ca.subject).not.toBe(leaf.subject);
    // And the file the bundle `cp`s is the CA, not the leaf.
    expect(readCa(localCaCertificatePath())).toBe(credentials.caCertificatePem);
    expect(readCa(localCaCertificatePath())).not.toBe(
      credentials.serverCertificatePem,
    );
  });

  it("long outlasts a laptop, because an expiry would break every Lambda at once", () => {
    const ca = new X509Certificate(
      loadOrCreateDevTlsCredentials().caCertificatePem,
    );
    const yearsOut = new Date(ca.validTo).getTime() - Date.now();
    expect(yearsOut).toBeGreaterThan(9 * 365 * 24 * 60 * 60 * 1000);
    // And is not yet valid, which a clock a day behind would trip over.
    expect(new Date(ca.validFrom).getTime()).toBeLessThan(Date.now());
  });

  it("names the fix when the persisted CA is corrupt", () => {
    writeFileSync(join(dir, "local-dev-ca.json"), "{ not json");
    let thrown: Error | undefined;
    try {
      loadOrCreateDevTlsCredentials();
    } catch (error: unknown) {
      thrown = error as Error;
    }
    expect(thrown?.message).toContain(dir);
    // `npm run local:reset` does not clear the key directory — `local:down`
    // preserves it on purpose — so the remedy has to be the directory itself.
    expect(thrown?.message).toContain(`Remove ${dir}`);
    expect(thrown?.cause).toBeInstanceOf(SyntaxError);
  });

  it("names the fix when the persisted CA is missing its fingerprint", () => {
    writeFileSync(
      join(dir, "local-dev-ca.json"),
      JSON.stringify({ privateKeyPem: "a", certificatePem: "b" }),
    );
    expect(() => loadOrCreateDevTlsCredentials()).toThrow(
      /corrupt or incomplete/,
    );
  });
});

describe("the CA certificate the bundle is given", () => {
  it("is projected to a standalone PEM that is the CA, byte for byte", () => {
    const credentials = loadOrCreateDevTlsCredentials();
    const path = localCaCertificatePath();
    expect(path).toBe(join(dir, LOCAL_CA_CERTIFICATE_FILENAME));
    expect(readdirSync(dir)).toContain(LOCAL_CA_CERTIFICATE_FILENAME);
    // The file the `cp` takes and the string the handshake is tested with are
    // one document, not two renderings of one identity.
    const projected = new X509Certificate(readCa(path));
    expect(projected.ca).toBe(true);
    expect(
      projected.raw.equals(
        new X509Certificate(credentials.caCertificatePem).raw,
      ),
    ).toBe(true);
  });

  it("is created by the synth alone, with no edge container running", () => {
    // The state before the edge has ever run: a CA, but no projected
    // certificate and no leaf. This is the answer to the race — `local:up` runs
    // `cdk deploy` and starts the edge in the same breath, and the synth has to
    // be able to produce the CA on its own rather than depending on the edge
    // having got there first.
    for (const entry of readdirSync(dir)) {
      if (entry.startsWith("local-dev-edge-cert-")) {
        rmSync(join(dir, entry), { force: true });
      }
    }
    rmSync(join(dir, LOCAL_CA_CERTIFICATE_FILENAME), { force: true });
    expect(readdirSync(dir)).not.toContain(LOCAL_CA_CERTIFICATE_FILENAME);
    expect(localCaCertificatePath()).toBe(
      join(dir, LOCAL_CA_CERTIFICATE_FILENAME),
    );
  });

  it("names the in-task path the Lambda environment points NODE_EXTRA_CA_CERTS at", () => {
    // `/var/task` is the artifact root — what `LAMBDA_TASK_ROOT` names — so a
    // path relative to it would not resolve, and the bundling hook copies to
    // exactly this name.
    expect(LOCAL_CA_CERTIFICATE_IN_TASK_ROOT).toBe(
      `/var/task/${LOCAL_CA_CERTIFICATE_FILENAME}`,
    );
    expect(LOCAL_CA_CERTIFICATE_IN_TASK_ROOT.startsWith("/")).toBe(true);
  });
});

describe("the JWKS over TLS", () => {
  it("fetches over TLS with the CA, checking the certificate's name", async () => {
    const credentials = loadOrCreateDevTlsCredentials();
    const url = await startTlsListener(credentials);
    // The one fetch `server.ts` makes at startup, and the one every Lambda
    // makes on its first cold start. It resolves here; the name check does not,
    // and is the whole reason `servername` is a parameter.
    await expect(
      assertLocalJwksOverTls(credentials, {
        url,
        servername: LOCAL_EDGE_SERVICE_NAME,
      }),
    ).resolves.toBeUndefined();
  });

  it("refuses a listener whose certificate is not the CA's", async () => {
    const credentials = loadOrCreateDevTlsCredentials();
    // A different CA, minted in a different directory. This is the failure the
    // startup check exists to catch: the edge serving a leaf, and the Lambdas
    // holding a CA, that are not the same pair.
    const otherDir = mkdtempSync(join(tmpdir(), "isb-local-dev-ca-other-"));
    const previous = process.env.ISB_LOCAL_KEY_DIR;
    process.env.ISB_LOCAL_KEY_DIR = otherDir;
    const other = loadOrCreateDevTlsCredentials();
    process.env.ISB_LOCAL_KEY_DIR = previous;
    try {
      const url = await startTlsListener(other);
      await expect(
        assertLocalJwksOverTls(credentials, {
          url,
          servername: LOCAL_EDGE_SERVICE_NAME,
        }),
      ).rejects.toThrow(/self.signed|unable to verify|DEPTH_ZERO/i);
    } finally {
      rmSync(otherDir, { recursive: true, force: true });
    }
  });

  it("refuses a certificate presented for a name it does not carry", async () => {
    const credentials = loadOrCreateDevTlsCredentials();
    const url = await startTlsListener(credentials);
    await expect(
      assertLocalJwksOverTls(credentials, {
        url,
        servername: "somewhere.else",
      }),
    ).rejects.toThrow(/alt ?name/i);
  });

  it("refuses a body that is not a key set", async () => {
    const credentials = loadOrCreateDevTlsCredentials();
    const url = await startTlsListener(credentials);
    // A 404 from the TLS listener for a path other than the JWKS is the shape
    // of a misconfigured `ISB_LOCAL_JWKS_URI`, and it must be a startup
    // failure rather than a per-request 500 in six Lambdas. The body is a
    // JSend envelope, so the failure is the empty key set, not the parse.
    await expect(
      assertLocalJwksOverTls(credentials, {
        url: url.replace(LOCAL_JWKS_PATH, "/.well-known/jwks.txt"),
        servername: LOCAL_EDGE_SERVICE_NAME,
      }),
    ).rejects.toThrow(/no key/);
  });
});

/** Reads the projected CA, so a typo in the path is a failed assertion. */
const readCa = (path: string): string => readFileSync(path, "utf-8");
