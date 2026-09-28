// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import { LOCAL_IDC_PRINCIPAL_ID, localEdgeConfig } from "../shared/names.js";

/**
 * The checks that do not need a live API: the local edge's own routes, and the
 * two identity facts whose absence makes every other check meaningless.
 *
 * Split from the API walk so a failure here is reported as "the harness is not
 * up" rather than as six domains failing at once, which is the difference
 * between a five-second and a five-minute diagnosis.
 */

import { fetchLocalSession, request } from "./client.js";
import { checkEnvelope, jsendErrors, jsendMessage } from "./jsend.js";
import type { VerifyResult } from "./types.js";

/**
 * The claims the application itself consumes. If one is missing the UI is signed
 * in but has no identity to make an RBAC decision from, and that surfaces much
 * later as a confusing 403 rather than as a minting bug.
 */
const REQUIRED_CLAIMS = [
  "sub",
  "email",
  "cognito:username",
  "custom:idc_user_id",
  "custom:isb_roles",
  "aud",
  "iss",
  "token_use",
  "iat",
  "exp",
] as const;

const ok = (name: string, detail: string): VerifyResult => ({
  name,
  ok: true,
  detail,
  expectation: "should-work",
});
const fail = (name: string, detail: string): VerifyResult => ({
  name,
  ok: false,
  detail,
  expectation: "should-work",
});

/**
 * `GET /healthz`, `GET /config.json`, `GET /session`, and `GET
 * /.well-known/jwks.json`. Returns the token so the API walk does not have to
 * mint a second one, and so a failure to mint is reported once, here.
 */
export async function runHarnessChecks(): Promise<{
  results: VerifyResult[];
  token: string;
}> {
  const results: VerifyResult[] = [];

  try {
    const response = await request({ method: "GET", path: "/healthz" });
    results.push(
      response.status === 200
        ? ok("edge /healthz", `200 after ${response.elapsedMs}ms`)
        : fail(
            "edge /healthz",
            `status ${response.status}: ${response.raw.slice(0, 160)}`,
          ),
    );
  } catch (error: unknown) {
    results.push(
      fail(
        "edge /healthz",
        `is the local edge up? Run \`npm run local:up\` first. ${error instanceof Error ? error.message : String(error)}`,
      ),
    );
    // Without the edge nothing else can run, and reporting eleven identical
    // connection failures buries the one line that says what to do.
    return {
      results: [
        ...results,
        fail(
          "API walk",
          "skipped: the local edge answered nothing, so no API check could run",
        ),
      ],
      token: "",
    };
  }

  // The nine `ConfigData` fields, compared against the ones `names.ts` builds.
  // A count would pass on nine wrong fields; comparing the whole object cannot.
  try {
    const response = await request({ method: "GET", path: "/config.json" });
    const expected = localEdgeConfig();
    if (response.status !== 200) {
      results.push(fail("edge /config.json", `status ${response.status}`));
    } else {
      const served = response.body as Record<string, unknown>;
      const reference: Record<string, unknown> = expected;
      const servedKeys = Object.keys(served).sort();
      const expectedKeys = Object.keys(reference).sort();
      const mismatched = expectedKeys.filter(
        (key) => served[key] !== reference[key],
      );
      if (servedKeys.length !== expectedKeys.length || mismatched.length) {
        results.push(
          fail(
            "edge /config.json",
            `served ${servedKeys.length}/${expectedKeys.length} fields` +
              (mismatched.length
                ? `; wrong or missing: ${mismatched
                    .map((k) => `${k}=${JSON.stringify(served[k])}`)
                    .join(", ")}`
                : `; extra: ${servedKeys.filter((k) => !expectedKeys.includes(k)).join(", ")}`),
          ),
        );
      } else {
        results.push(
          ok(
            "edge /config.json",
            `all ${expectedKeys.length} fields, ApiUrl=${expected.ApiUrl}, pool=${expected.CognitoUserPoolId}`,
          ),
        );
      }
    }
  } catch (error: unknown) {
    results.push(
      fail(
        "edge /config.json",
        error instanceof Error ? error.message : String(error),
      ),
    );
  }

  // The JWKS the Lambdas are told to load. Checked here, without a Lambda, so
  // that a `kid`/key mismatch is reported as an edge problem rather than
  // surfacing later as an opaque "Invalid identity token" from six Lambdas.
  try {
    const response = await request({
      method: "GET",
      path: "/.well-known/jwks.json",
    });
    const document = response.body as { keys?: Array<Record<string, unknown>> };
    const key = document?.keys?.[0];
    if (response.status !== 200 || !key) {
      results.push(
        fail(
          "edge /.well-known/jwks.json",
          `status ${response.status}, no key published`,
        ),
      );
    } else if (key.kty !== "RSA" || key.alg !== "RS256" || !key.kid) {
      results.push(
        fail(
          "edge /.well-known/jwks.json",
          `published key is ${JSON.stringify({ kty: key.kty, alg: key.alg, kid: key.kid })}; the verifier requires an RS256 RSA key with a kid`,
        ),
      );
    } else {
      results.push(
        ok(
          "edge /.well-known/jwks.json",
          `one RS256 key, kid ${String(key.kid)}`,
        ),
      );
    }
  } catch (error: unknown) {
    results.push(
      fail(
        "edge /.well-known/jwks.json",
        error instanceof Error ? error.message : String(error),
      ),
    );
  }

  // The 501 fallback. Never the primary mechanism — every domain is provisioned
  // and the unsupported flows fail deep in the handler — so it is checked only
  // for the shape it is supposed to have.
  try {
    const response = await request({
      method: "GET",
      path: "/local/unsupported/access-portal",
    });
    const envelope = checkEnvelope("edge 501 fallback", response.body);
    results.push(
      response.status === 501 && envelope.ok
        ? ok("edge 501 fallback", "501 with a JSend body, as designed")
        : fail(
            "edge 501 fallback",
            `expected 501 with a JSend body, got ${response.status}: ${response.raw.slice(0, 160)}`,
          ),
    );
  } catch (error: unknown) {
    results.push(
      fail(
        "edge 501 fallback",
        error instanceof Error ? error.message : String(error),
      ),
    );
  }

  // Mint the token every API check authenticates with.
  let token = "";
  try {
    const session = await fetchLocalSession();
    token = session.token;
    const missing = REQUIRED_CLAIMS.filter(
      (claim) => session.payload[claim] === undefined,
    );
    if (missing.length) {
      results.push(
        fail(
          "edge /session",
          `token minted but the claims the application reads are missing: ${missing.join(", ")}`,
        ),
      );
    } else if (session.payload.sub !== LOCAL_IDC_PRINCIPAL_ID) {
      results.push(
        fail(
          "edge /session",
          `sub is ${JSON.stringify(session.payload.sub)}; the seed writes the admin principal under ${LOCAL_IDC_PRINCIPAL_ID}, so a request keyed on the signed-in id would find nothing`,
        ),
      );
    } else {
      results.push(
        ok(
          "edge /session",
          `sub=${String(session.payload.sub)} email=${String(session.payload.email)} roles=${String(session.payload["custom:isb_roles"])} iss=${String(session.payload.iss)}`,
        ),
      );
    }
  } catch (error: unknown) {
    results.push(
      fail(
        "edge /session",
        error instanceof Error ? error.message : String(error),
      ),
    );
  }

  // The one check that proves the identity gate is real rather than absent: a
  // request with no `x-isb-identity` must be refused by the application, with
  // its own 401. A 502 or a 404 here would mean the checks below are passing for
  // the wrong reason.
  //
  // Retried, because the first request to a cold-starting Lambda is answered by
  // LocalStack with a fast 502, and a 401 assertion that occasionally sees a 502
  // would be a flaky check rather than a finding.
  if (token) {
    const name = "unauthenticated /api/leases is refused";
    let detail = "";
    let passed = false;
    for (let attempt = 1; attempt <= 3 && !passed; attempt += 1) {
      try {
        const response = await request({ method: "GET", path: "/api/leases" });
        const errors = jsendErrors(response.body);
        if (response.status === 401) {
          passed = true;
          detail = `401 from the application${errors ? `: ${errors}` : ""}${attempt > 1 ? ` (attempt ${attempt})` : ""}`;
        } else if (response.status >= 500) {
          detail = `expected the application's 401, got ${response.status}: ${response.raw.slice(0, 200)}`;
        } else {
          detail = `expected the application's 401, got ${response.status}: ${response.raw.slice(0, 200)}`;
          break;
        }
      } catch (error: unknown) {
        detail = error instanceof Error ? error.message : String(error);
      }
      if (!passed && attempt < 3) await new Promise((r) => setTimeout(r, 750));
    }
    results.push(passed ? ok(name, detail) : fail(name, detail));
  }

  return { results, token };
}

export { jsendMessage };
