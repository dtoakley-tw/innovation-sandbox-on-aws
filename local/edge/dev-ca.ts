// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  randomBytes,
  sign,
  X509Certificate,
} from "node:crypto";
import { existsSync } from "node:fs";
import { get } from "node:https";

import { LOCAL_EDGE_SERVICE_NAME, LOCAL_JWKS_URI } from "../shared/names.js";
import {
  createKeyFileExclusive,
  keyFilePath,
  localKeyDir,
  PRIVATE_KEY_MODE,
  PUBLIC_FILE_MODE,
  readKeyFile,
} from "./key-store.js";

/**
 * The development certificate authority the local Lambdas trust.
 *
 * ## Why this exists
 *
 * `aws-jwt-verify@4.0.1` fetches the JWKS through `node:https.request`
 * (`dist/esm/https-node.js`), which throws `ERR_INVALID_PROTOCOL` for an
 * `http://` URI before a packet is sent. `source/common/lambda/auth/
 * identity-token-verifier.ts` loads the local key set with `fetchJwks`, so while
 * the edge served plain HTTP on 4599, *every* authenticated request failed at
 * key retrieval with a 500. The only fixes are a change under `source/` —
 * forbidden; unmodified upstream is the point of this profile — or the Lambdas
 * talking TLS.
 *
 * So the edge answers the JWKS over HTTPS on `LOCAL_EDGE_TLS_PORT` with a
 * certificate this module signs, and every Lambda is given this CA through
 * `NODE_EXTRA_CA_CERTS` (see `lambda-environment.ts`), which Node adds to the
 * default root store at process start. `https.request` → `tls.connect` with no
 * explicit `ca` then trusts it, and nothing under `source/` knows any of this
 * happened.
 *
 * ## Why a CA and not just a self-signed server certificate
 *
 * `NODE_EXTRA_CA_CERTS` can hold a self-signed leaf, so the simpler arrangement
 * would work. A CA plus a leaf is what the mechanism is for: the file the Lambda
 * trusts is then a *different* document from the one the edge presents, so a
 * copy of the server certificate — which the edge hands to every caller of the
 * JWKS route, and which `local:verify` reads off the wire — cannot be replayed
 * as a trust anchor. `dev-ca.test.ts` pins that separation.
 *
 * ## Why the CA is generated here and not in the edge's startup path
 *
 * The certificate has to exist in two places at two different moments, in
 * processes that do not start together: `cdk deploy` has to copy the CA into the
 * Lambda artifact at bundle time, and the edge has to serve a leaf that CA
 * signed. On a first `local:up` the edge may not have run when the synth
 * happens; on a re-run the synth may not have happened when the edge starts.
 * Whichever side gets there first mints it and the other reads it back, which
 * works because both call this one function, it is idempotent, and
 * `createKeyFileExclusive` makes "first writer wins" atomic — so the race
 * resolves to the same answer for both rather than to two different CAs.
 *
 * ## Why the encoder is here at all
 *
 * `node:crypto` generates keypairs and RSA signatures but has no X.509
 * certificate encoder (`X509Certificate` parses; nothing writes). The material
 * has to be produced identically on the host, for the synth, and inside
 * `node:24-alpine`, for the edge, and shelling out to an `openssl` binary is not
 * an option: the edge image has none — verified — and a host tool would make
 * the profile depend on what a machine happens to have installed. So the handful
 * of DER structures an X.509 certificate is made of are encoded below, and
 * `dev-ca.test.ts` exercises them against a real TLS handshake.
 */

export interface DevTlsCredentials {
  /** The CA certificate, PEM. The Lambda bundle is given exactly this. */
  caCertificatePem: string;
  /** The edge's leaf certificate, PEM. Signed by the CA above. */
  serverCertificatePem: string;
  /** The leaf's private key, PEM. Stays in the edge process. */
  serverPrivateKeyPem: string;
}

/** Name of the CA certificate file, both in the key directory and in a bundle. */
export const LOCAL_CA_CERTIFICATE_FILENAME = "isb-local-ca.pem";

/**
 * Where the same file lands inside a Lambda. `/var/task` is the artifact root —
 * the directory CDK stages the bundle into, and the one `LAMBDA_TASK_ROOT` names
 * — so a path relative to it would not resolve.
 */
export const LOCAL_CA_CERTIFICATE_IN_TASK_ROOT = `/var/task/${LOCAL_CA_CERTIFICATE_FILENAME}`;

/** Identity of the persisted CA. Written once, never rewritten. */
const CA_FILE = "local-dev-ca.json";
/** The CA certificate on its own, for the bundling `cp` to copy. */
const CA_PEM_FILE = LOCAL_CA_CERTIFICATE_FILENAME;
/** Prefix of the leaf's file, which also carries the issuing CA's fingerprint. */
const LEAF_FILE_PREFIX = "local-dev-edge-cert";

const CA_COMMON_NAME = "InnovationSandbox Local Development CA";
const CA_ORGANIZATION = "InnovationSandbox local profile";
const SERVER_COMMON_NAME = LOCAL_EDGE_SERVICE_NAME;
const KEY_MODULUS_LENGTH = 2048;
/**
 * Ten years. This is a development trust anchor with no value outside this
 * machine, and one that expired quietly would break every Lambda at once — on
 * the one morning nobody was working on the profile.
 */
const VALIDITY_DAYS = 3650;
/**
 * A day of backdating, so a certificate minted on a machine whose clock is
 * slightly behind a Lambda's is not rejected as not yet valid.
 */
const BACKDATE_DAYS = 1;

// ---------------------------------------------------------------------------
// A minimal DER encoder. X.509 is DER, and every structure below is standard
// ITU-T X.690: a tag, a length, and content.
// ---------------------------------------------------------------------------

const derLength = (length: number): Buffer => {
  if (length < 0x80) return Buffer.from([length]);
  const bytes: number[] = [];
  for (
    let remaining = length;
    remaining > 0;
    remaining = Math.floor(remaining / 256)
  ) {
    bytes.unshift(remaining % 256);
  }
  return Buffer.from([0x80 | bytes.length, ...bytes]);
};

const tlv = (tag: number, content: Buffer): Buffer =>
  Buffer.concat([Buffer.from([tag]), derLength(content.length), content]);

const derSequence = (...items: Buffer[]): Buffer =>
  tlv(0x30, Buffer.concat(items));
const derSet = (...items: Buffer[]): Buffer => tlv(0x31, Buffer.concat(items));
const derNull = (): Buffer => Buffer.from([0x05, 0x00]);
const derOctetString = (bytes: Buffer): Buffer => tlv(0x04, bytes);
const derBoolean = (value: boolean): Buffer =>
  tlv(0x01, Buffer.from([value ? 0xff : 0x00]));
const derUtf8String = (value: string): Buffer =>
  tlv(0x0c, Buffer.from(value, "utf8"));
/** `[n] { … }` — an explicitly tagged constructed value. */
const derExplicit = (index: number, content: Buffer): Buffer =>
  tlv(0xa0 | index, content);

/** `BIT STRING`, with the count of unused trailing bits in the first octet. */
const derBitString = (bytes: Buffer, unusedBits: number): Buffer =>
  tlv(0x03, Buffer.concat([Buffer.from([unusedBits]), bytes]));

/**
 * `INTEGER`, as a big-endian two's-complement value. The leading zero an integer
 * needs when its top bit is set is what keeps a serial number positive, and
 * that is the whole reason it is added here rather than left to the caller.
 */
const derInteger = (value: Buffer): Buffer => {
  let start = 0;
  while (start < value.length - 1 && value[start] === 0) start += 1;
  const body = value.subarray(start);
  const padded =
    body.length > 0 && (body[0] & 0x80) !== 0
      ? Buffer.concat([Buffer.from([0x00]), body])
      : body;
  return tlv(0x02, padded);
};

/** Base-128, most significant group first, every group but the last flagged. */
const derBase128 = (value: number): number[] => {
  const groups = [value & 0x7f];
  for (
    let remaining = Math.floor(value / 128);
    remaining > 0;
    remaining = Math.floor(remaining / 128)
  ) {
    groups.unshift((remaining & 0x7f) | 0x80);
  }
  return groups;
};

const derOid = (...arcs: number[]): Buffer => {
  if (arcs.length < 2) throw new Error("an OID needs at least two arcs");
  const [first, second, ...rest] = arcs;
  if (first > 2 || (first < 2 && second >= 40)) {
    throw new Error(`invalid OID arc ${arcs.join(".")}`);
  }
  return tlv(
    0x06,
    Buffer.from([
      ...derBase128(first * 40 + second),
      ...rest.flatMap(derBase128),
    ]),
  );
};

/** `UTCTime` — `YYMMDDHHMMSSZ`, the required form before 2050. */
const derUtcTime = (date: Date): Buffer => {
  const pad = (value: number) => String(value).padStart(2, "0");
  return tlv(
    0x17,
    Buffer.from(
      `${pad(date.getUTCFullYear() % 100)}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}` +
        `${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())}Z`,
      "ascii",
    ),
  );
};

/**
 * `KeyUsage` bit positions, in the order RFC 5280 numbers them and in the order
 * they appear in the `BIT STRING` — most significant bit of the first octet
 * first. Spelled out because the two constants below are arithmetic on these
 * positions, and a value that is off by one bit is a certificate OpenSSL
 * silently refuses to use rather than one that fails loudly here.
 */
const KU = {
  digitalSignature: 0,
  keyEncipherment: 2,
  keyCertSign: 5,
  cRLSign: 6,
} as const;

/**
 * A `KeyUsage` `BIT STRING` for `bits`, with the correct count of unused
 * trailing bits.
 *
 * The unused-bit count is not cosmetic: a verifier *drops* every bit above it,
 * so a wrong value does not widen the key usage, it silently narrows it to
 * whatever survives the truncation. That is how the first version of this
 * module emitted a CA whose only surviving usage was `nonRepudiation`, and an
 * edge certificate with none at all — which OpenSSL reports as
 * `UNABLE_TO_VERIFY_LEAF_SIGNATURE` on the client, from `check_purpose`, with
 * nothing in the message pointing at the key usage. Hence the derivation rather
 * than a literal byte: a literal is exactly the kind of value that gets a
 * comment explaining it and still wrong.
 */
const derKeyUsage = (bits: readonly number[]): Buffer => {
  let byte = 0;
  let highest = -1;
  for (const bit of bits) {
    byte |= 0x80 >> bit;
    highest = Math.max(highest, bit);
  }
  if (highest < 0) throw new Error("a key usage with no bits is not a usage");
  // Bits 0..highest are significant; everything above `highest` is padding.
  return derBitString(Buffer.from([byte]), 7 - highest);
};

const OID_SHA256_WITH_RSA = [1, 2, 840, 113549, 1, 1, 11];
const OID_COMMON_NAME = [2, 5, 4, 3];
const OID_ORGANIZATION_NAME = [2, 5, 4, 10];
const OID_SUBJECT_KEY_IDENTIFIER = [2, 5, 29, 14];
const OID_KEY_USAGE = [2, 5, 29, 15];
const OID_BASIC_CONSTRAINTS = [2, 5, 29, 19];
const OID_SUBJECT_ALT_NAME = [2, 5, 29, 17];
const OID_AUTHORITY_KEY_IDENTIFIER = [2, 5, 29, 35];
const OID_EXT_KEY_USAGE = [2, 5, 29, 37];
const OID_SERVER_AUTH = [1, 3, 6, 1, 5, 5, 7, 3, 1];

const sha256WithRsa = () =>
  derSequence(derOid(...OID_SHA256_WITH_RSA), derNull());

/** `AttributeTypeAndValue`, and the `RDN` that wraps one. */
const atv = (type: number[], value: Buffer) =>
  derSequence(derOid(...type), value);
const rdn = (type: number[], value: string) =>
  derSet(atv(type, derUtf8String(value)));

/**
 * The CA's distinguished name, as DER. Built once by one function and used both
 * as the CA's own subject and as the leaf's issuer, which is what guarantees a
 * leaf can never be issued under a name the CA does not carry.
 */
const caNameDer = (): Buffer =>
  derSequence(
    rdn(OID_ORGANIZATION_NAME, CA_ORGANIZATION),
    rdn(OID_COMMON_NAME, CA_COMMON_NAME),
  );

/** `Extension`, omitting the `critical` flag when false — it is `DEFAULT`. */
const derExtension = (
  type: number[],
  critical: boolean,
  value: Buffer,
): Buffer =>
  derSequence(
    derOid(...type),
    ...(critical ? [derBoolean(true)] : []),
    derOctetString(value),
  );

const derExtensions = (extensions: Buffer[]): Buffer =>
  derSequence(...extensions);

interface TbsInput {
  serial: Buffer;
  issuer: Buffer;
  subject: Buffer;
  notBefore: Date;
  notAfter: Date;
  /** The raw DER SPKI, taken from the keypair rather than rebuilt. */
  subjectPublicKeyInfo: Buffer;
  extensions: Buffer;
}

const tbsCertificate = (input: TbsInput): Buffer =>
  derSequence(
    // [0] EXPLICIT Version, INTEGER 2 — v3. The extensions below require it.
    derExplicit(0, derInteger(Buffer.from([0x02]))),
    derInteger(input.serial),
    sha256WithRsa(),
    input.issuer,
    derSequence(derUtcTime(input.notBefore), derUtcTime(input.notAfter)),
    input.subject,
    input.subjectPublicKeyInfo,
    derExplicit(3, input.extensions),
  );

/** Signs a TBSCertificate and wraps it into a `Certificate`. */
const derCertificate = (tbs: Buffer, signature: Buffer): Buffer =>
  derSequence(tbs, sha256WithRsa(), derBitString(signature, 0));

const toPem = (label: string, der: Buffer): string => {
  const lines = der.toString("base64").match(/.{1,64}/g) ?? [];
  return `-----BEGIN ${label}-----\n${lines.join("\n")}\n-----END ${label}-----\n`;
};

const daysFromNow = (days: number): Date =>
  new Date(Date.now() + days * 24 * 60 * 60 * 1000);

/** A positive 128-bit serial. Clearing the top bit is all that takes. */
const randomSerial = (): Buffer => {
  const serial = randomBytes(16);
  serial[0] &= 0x7f;
  return serial;
};

/**
 * `SubjectKeyIdentifier`: SHA-1 of the SPKI, which is what RFC 5280 says to
 * derive and what every implementation does. It is an identifier, not a security
 * property — both sides of every comparison are inside this file.
 */
const subjectKeyIdentifier = (subjectPublicKeyInfo: Buffer): Buffer =>
  createHash("sha1").update(subjectPublicKeyInfo).digest();

const generateKeyPair = (): { privateKeyPem: string; spki: Buffer } => {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", {
    modulusLength: KEY_MODULUS_LENGTH,
  });
  return {
    privateKeyPem: privateKey.export({
      type: "pkcs8",
      format: "pem",
    }) as string,
    spki: publicKey.export({ type: "spki", format: "der" }) as Buffer,
  };
};

interface PersistedTlsMaterial {
  certificatePem: string;
  privateKeyPem: string;
}

interface PersistedCa extends PersistedTlsMaterial {
  /** SHA-256 of the CA certificate, hex. Names the leaf this CA signed. */
  fingerprint: string;
}

/**
 * Parses what was just written, and refuses to return it if it does not parse.
 * The alternative is a subtly malformed certificate reaching the TLS stack, and
 * every symptom downstream of that — a handshake failure, a "self-signed
 * certificate" error from a client, a CA that validates nothing — points away
 * from the code that produced it.
 *
 * `expectCa` then asserts the one semantic property a parser cannot see: a CA
 * whose `keyUsage` lacks `keyCertSign` parses perfectly and is rejected at
 * chain-build time, by a client, with an error that names nothing. `X509_check_ca`
 * — the same function OpenSSL's own verifier calls — is what `ca` reads, so this
 * assertion is the exact question the TLS stack will ask, asked here instead of
 * six Lambda cold starts later.
 */
const assertParses = (
  certificatePem: string,
  what: string,
  expectCa?: boolean,
): void => {
  let certificate: X509Certificate;
  try {
    // Parsing is not verification; `checkIssued`/`verify` would need the peer.
    certificate = new X509Certificate(certificatePem);
  } catch (cause) {
    throw new Error(
      `The generated ${what} certificate is not a parseable X.509 certificate. ` +
        `This is a bug in local/edge/dev-ca.ts, not a configuration problem.`,
      { cause },
    );
  }
  if (expectCa !== undefined && certificate.ca !== expectCa) {
    throw new Error(
      `The generated ${what} certificate reports basicConstraints CA:${String(
        expectCa,
      )} as CA:${String(certificate.ca)}. A certificate OpenSSL will not treat ` +
        `as a ${expectCa ? "CA" : "leaf"} cannot complete a TLS handshake, and it ` +
        `is a bug in local/edge/dev-ca.ts, not a configuration problem.`,
    );
  }
};

const createCa = (): PersistedCa => {
  const { privateKeyPem, spki } = generateKeyPair();
  const name = caNameDer();
  const tbs = tbsCertificate({
    serial: randomSerial(),
    // Self-signed: subject and issuer are the same name, and the signature is
    // made with the key the certificate carries.
    issuer: name,
    subject: name,
    notBefore: daysFromNow(-BACKDATE_DAYS),
    notAfter: daysFromNow(VALIDITY_DAYS),
    subjectPublicKeyInfo: spki,
    extensions: derExtensions([
      // CA:TRUE, critical — without it OpenSSL will not treat the certificate
      // as an issuer at all, and the leaf's chain will not build.
      derExtension(OID_BASIC_CONSTRAINTS, true, derSequence(derBoolean(true))),
      // keyCertSign and cRLSign are what make this an issuer at all:
      // `X509_check_ca` in OpenSSL returns "not a CA" for a certificate whose
      // keyUsage extension exists but lacks keyCertSign, so a chain built
      // through a CA without them fails with an error that names nothing.
      // digitalSignature is included because the CA signs the leaf and
      // aws-jwt-verify's `fetchJwks` pins the key set's thumbprint.
      derExtension(
        OID_KEY_USAGE,
        true,
        derKeyUsage([KU.digitalSignature, KU.keyCertSign, KU.cRLSign]),
      ),
      derExtension(
        OID_SUBJECT_KEY_IDENTIFIER,
        false,
        derOctetString(subjectKeyIdentifier(spki)),
      ),
    ]),
  });
  const certificatePem = toPem(
    "CERTIFICATE",
    derCertificate(tbs, sign("sha256", tbs, createPrivateKey(privateKeyPem))),
  );
  assertParses(certificatePem, "certificate authority", true);
  return {
    certificatePem,
    privateKeyPem,
    fingerprint: createHash("sha256").update(certificatePem).digest("hex"),
  };
};

const createServerCertificate = (ca: PersistedCa): PersistedTlsMaterial => {
  const { privateKeyPem, spki } = generateKeyPair();
  // The CA's SPKI, read back out of its own certificate. Hashing this is what
  // makes the leaf's authorityKeyIdentifier equal the CA's subjectKeyIdentifier:
  // both are SHA-1 over the same SPKI bytes, and the CA's are the ones written
  // by `createCa` from the same kind of export.
  const caSubjectKeyIdentifier = subjectKeyIdentifier(
    createPublicKey(ca.certificatePem).export({
      type: "spki",
      format: "der",
    }) as Buffer,
  );
  const tbs = tbsCertificate({
    serial: randomSerial(),
    issuer: caNameDer(),
    notBefore: daysFromNow(-BACKDATE_DAYS),
    notAfter: daysFromNow(VALIDITY_DAYS),
    subject: derSequence(
      rdn(OID_ORGANIZATION_NAME, CA_ORGANIZATION),
      rdn(OID_COMMON_NAME, SERVER_COMMON_NAME),
    ),
    subjectPublicKeyInfo: spki,
    extensions: derExtensions([
      // An empty SEQUENCE is CA:FALSE, which is the default and is omitted.
      derExtension(OID_BASIC_CONSTRAINTS, true, derSequence()),
      // digitalSignature is the bit TLS 1.3 actually requires of an RSA server
      // certificate, and keyEncipherment is what keeps the certificate usable by
      // a TLS 1.2 client. `check_purpose_ssl_server` accepts either one, so a
      // certificate with neither is refused at the handshake.
      derExtension(
        OID_KEY_USAGE,
        true,
        derKeyUsage([KU.digitalSignature, KU.keyEncipherment]),
      ),
      derExtension(
        OID_EXT_KEY_USAGE,
        false,
        derSequence(derOid(...OID_SERVER_AUTH)),
      ),
      // The reason this module exists: the Lambdas connect to
      // `isb-local-edge`, so that is the one name that has to validate.
      derExtension(
        OID_SUBJECT_ALT_NAME,
        false,
        derSequence(tlv(0x82, Buffer.from(SERVER_COMMON_NAME, "ascii"))),
      ),
      derExtension(
        OID_SUBJECT_KEY_IDENTIFIER,
        false,
        derOctetString(subjectKeyIdentifier(spki)),
      ),
      derExtension(
        OID_AUTHORITY_KEY_IDENTIFIER,
        false,
        derSequence(tlv(0x80, caSubjectKeyIdentifier)),
      ),
    ]),
  });
  const certificatePem = toPem(
    "CERTIFICATE",
    derCertificate(
      tbs,
      sign("sha256", tbs, createPrivateKey(ca.privateKeyPem)),
    ),
  );
  assertParses(certificatePem, "server", false);
  return { privateKeyPem, certificatePem };
};

const unusable = (file: string, cause?: unknown): never => {
  throw new Error(
    `Local development TLS material at ${file} is corrupt or incomplete. ` +
      `Remove ${localKeyDir()} and run \`npm run local:up\` to mint new material.`,
    { cause },
  );
};

const parseMaterial = <T extends PersistedTlsMaterial>(file: string): T => {
  const contents = readKeyFile(file);
  let parsed: unknown;
  try {
    parsed = JSON.parse(contents);
  } catch (cause) {
    return unusable(file, cause);
  }
  const candidate = parsed as Partial<T>;
  if (!candidate?.privateKeyPem || !candidate?.certificatePem) {
    return unusable(file);
  }
  return candidate as T;
};

/** The CA: read it if a previous run made it, else mint it. */
const loadOrCreateCa = (): PersistedCa => {
  const file = keyFilePath(CA_FILE);
  if (existsSync(file)) {
    const ca = parseMaterial<PersistedCa>(file);
    if (!ca.fingerprint) return unusable(file);
    return ca;
  }
  const created = createCa();
  if (
    !createKeyFileExclusive(
      file,
      JSON.stringify(created, null, 2),
      PRIVATE_KEY_MODE,
    )
  ) {
    // Lost the race to the other participant — the edge container, or a
    // concurrent synth. Its CA is the one everything else is being built
    // against, so this side adopts it rather than overwriting.
    return parseMaterial<PersistedCa>(file);
  }
  return created;
};

/**
 * The CA certificate as a standalone PEM file, which is what the bundling hook
 * `cp`s into each Lambda artifact.
 *
 * A projection of the identity in `CA_FILE` rather than a second source of
 * truth: this process and any concurrent one derive the bytes from the same CA,
 * so "first writer wins" leaves a file byte-identical to what the loser would
 * have written.
 */
const projectCaCertificate = (ca: PersistedCa): string => {
  const file = keyFilePath(CA_PEM_FILE);
  if (!existsSync(file)) {
    createKeyFileExclusive(file, ca.certificatePem, PUBLIC_FILE_MODE);
  }
  if (!existsSync(file)) return unusable(file);
  return file;
};

/**
 * The edge's leaf. Its file name carries the issuing CA's fingerprint, which is
 * what makes the whole thing safe under the race described at the top of this
 * file: a leaf is only ever loaded for the CA that signed it, so a
 * last-writer-wins outcome on the CA file cannot leave the edge serving a
 * certificate the bundled CA does not verify.
 */
const loadOrCreateServerCertificate = (
  ca: PersistedCa,
): PersistedTlsMaterial => {
  const file = keyFilePath(
    `${LEAF_FILE_PREFIX}-${ca.fingerprint.slice(0, 16)}.json`,
  );
  if (existsSync(file)) return parseMaterial(file);
  const created = createServerCertificate(ca);
  if (
    !createKeyFileExclusive(
      file,
      JSON.stringify(created, null, 2),
      PRIVATE_KEY_MODE,
    )
  ) {
    return parseMaterial(file);
  }
  return created;
};

/**
 * The credentials the edge's TLS listener is configured with, generating the CA
 * and the leaf on first call. Idempotent, and safe for the edge and the CDK
 * synth to call concurrently, in either order, in either process.
 */
export function loadOrCreateDevTlsCredentials(): DevTlsCredentials {
  const ca = loadOrCreateCa();
  const server = loadOrCreateServerCertificate(ca);
  projectCaCertificate(ca);
  return {
    caCertificatePem: ca.certificatePem,
    serverCertificatePem: server.certificatePem,
    serverPrivateKeyPem: server.privateKeyPem,
  };
}

/**
 * Absolute path of the CA certificate, minting the material if it does not
 * exist yet.
 *
 * Called at synth time by the bundling hook, which is the answer to the race:
 * the CA does not depend on the edge having run, because this call is what
 * makes it. Resolved once per synth and thrown on, so a failure to produce it
 * stops the synth with a named error rather than surfacing as a `cp` failure
 * buried in esbuild's output after a deploy has already been attempted.
 */
export function localCaCertificatePath(): string {
  try {
    return projectCaCertificate(loadOrCreateCa());
  } catch (cause) {
    throw new Error(
      `local compute stack: no development CA certificate for the Lambdas' ` +
        `NODE_EXTRA_CA_CERTS in ${localKeyDir()}. Every local Lambda would fail ` +
        `to fetch the JWKS over TLS. Remove the directory and re-run ` +
        `\`npm run local:up\`.`,
      { cause },
    );
  }
}

/**
 * Confirms, from inside the edge process, that the JWKS is reachable over TLS
 * with the CA it was just handed — the same fetch, to the same URL, that every
 * Lambda makes on its first cold start.
 *
 * Called at startup and fatal, because a listener that cannot serve its own
 * JWKS to a client that already trusts its CA fails every authenticated request
 * with a TLS error that points nowhere near this code, and it is knowable now,
 * before any of that.
 *
 * `target` exists only so a test can point the socket at a listener it started
 * itself, which is the only way to exercise this function off the compose
 * network — `isb-local-edge` resolves there and nowhere else. It is not a way to
 * weaken the check: the certificate's name is still verified, against
 * `target.servername` when given and against the URL's own host otherwise, so a
 * caller that points this at a listener serving anything other than the CA's own
 * leaf still fails. Production callers pass nothing.
 */
export async function assertLocalJwksOverTls(
  credentials: DevTlsCredentials = loadOrCreateDevTlsCredentials(),
  target: { url?: string; servername?: string } = {},
): Promise<void> {
  const url = target.url ?? LOCAL_JWKS_URI;
  const body = await new Promise<string>((resolve, reject) => {
    const request = get(
      url,
      { ca: credentials.caCertificatePem, servername: target.servername },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("end", () =>
          resolve(Buffer.concat(chunks).toString("utf-8")),
        );
      },
    );
    request.on("error", reject);
  });
  let parsed: { keys?: unknown[] };
  try {
    parsed = JSON.parse(body) as { keys?: unknown[] };
  } catch (cause) {
    throw new Error(
      `${url} answered over TLS with a body that is not JSON: ${body.slice(0, 200)}`,
      { cause },
    );
  }
  if (!Array.isArray(parsed.keys) || parsed.keys.length === 0) {
    throw new Error(
      `${url} answered over TLS with no key: ${body.slice(0, 200)}`,
    );
  }
}
