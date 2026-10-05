// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import { basename } from "node:path";

import {
  LOCAL_EDGE_URL,
  fetchLocalSession,
  request,
} from "../verify/client.js";

/**
 * The fast health check, distinct from `local:verify`.
 *
 * `local:verify` is the thorough one: it walks every read, mutation, and
 * boundary, validates against the production Zod schemas, and takes a minute or
 * two against real Lambdas. This one exists for the other job — "is the profile
 * up?" — and answers it with no dependencies at all beyond Node's own `fetch`:
 * no Zod, no `@amzn/*` imports, no CDK, nothing that has to resolve a workspace
 * symlink. That matters because the moment a developer most wants a health check
 * is the moment a profile is half-built, and a checker that cannot import is a
 * checker that cannot report.
 *
 * It still exercises the one thing a health check is for: that an *authenticated*
 * request gets past the identity check. A profile whose edge is healthy while
 * every API call 401s is not up, and only an authenticated request can tell the
 * difference.
 */

export interface SmokeResult {
  name: string;
  ok: boolean;
  detail: string;
}

export interface SmokeOptions {
  /** Edge origin. Defaults to `ISB_LOCAL_EDGE_URL`, then `localhost:4599`. */
  edgeUrl?: string;
  /**
   * Attempts per check. LocalStack intermittently answers the first request to a
   * cold-starting Lambda with a fast 502, so a health check that gave up on it
   * would report a working profile as broken roughly once a minute. Default 2.
   */
  maxAttempts?: number;
}

const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));

const truncate = (value: string, limit = 160) =>
  value.length > limit ? `${value.slice(0, limit)}…` : value;

/** True for a gateway-shaped 5xx, which is the one failure worth retrying. */
const isTransient = (status: number, body: string) =>
  status >= 500 || body.includes("Internal server error");

async function check(
  name: string,
  maxAttempts: number,
  fn: () => Promise<string>,
): Promise<SmokeResult> {
  let last = "";
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const detail = await fn();
      return {
        name,
        ok: true,
        detail: attempt > 1 ? `${detail} (attempt ${attempt})` : detail,
      };
    } catch (error: unknown) {
      last = error instanceof Error ? error.message : String(error);
      if (
        !isTransient(
          /status (\d{3})/.exec(last)?.[1]
            ? Number(/status (\d{3})/.exec(last)![1])
            : 0,
          last,
        ) ||
        attempt === maxAttempts
      ) {
        break;
      }
      await sleep(750);
    }
  }
  return { name, ok: false, detail: truncate(last) };
}

/**
 * The checks, in the order a developer would debug them: the edge, then the
 * configuration the frontend reads, then the identity, then one authenticated
 * API call that has to travel the whole chain.
 */
export async function runSmokeChecks(
  options: SmokeOptions = {},
): Promise<SmokeResult[]> {
  const maxAttempts = options.maxAttempts ?? 2;
  const results: SmokeResult[] = [];

  results.push(
    await check("local edge is healthy", maxAttempts, async () => {
      const response = await request({ method: "GET", path: "/healthz" });
      if (response.status !== 200) {
        throw new Error(`status ${response.status}: ${response.raw}`);
      }
      return `ok in ${response.elapsedMs}ms`;
    }),
  );

  results.push(
    await check("config.json serves all nine fields", maxAttempts, async () => {
      const response = await request({ method: "GET", path: "/config.json" });
      if (response.status !== 200) throw new Error(`status ${response.status}`);
      const config = response.body as Record<string, unknown>;
      const count = Object.keys(config).length;
      if (count !== 9) {
        throw new Error(
          `expected 9 fields, got ${count} (${Object.keys(config).join(", ")})`,
        );
      }
      return `${count} fields, ApiUrl=${String(config.ApiUrl)}`;
    }),
  );

  results.push(
    await check("the local identity mints a token", maxAttempts, async () => {
      const session = await fetchLocalSession();
      return `sub=${String(session.payload.sub)} roles=${String(session.payload["custom:isb_roles"])}`;
    }),
  );

  results.push(
    await check(
      "the published JWKS matches the signing key",
      maxAttempts,
      async () => {
        const jwks = await request({
          method: "GET",
          path: "/.well-known/jwks.json",
        });
        const session = await fetchLocalSession();
        const publishedKid = (jwks.body as { keys?: Array<{ kid?: string }> })
          ?.keys?.[0]?.kid;
        const tokenKid = JSON.parse(
          Buffer.from(session.token.split(".")[0], "base64url").toString(
            "utf-8",
          ),
        ).kid as string | undefined;
        if (!publishedKid) throw new Error("the edge published no key");
        if (publishedKid !== tokenKid) {
          throw new Error(
            `the edge signs with kid ${tokenKid} but publishes ${publishedKid}; every Lambda would reject the token`,
          );
        }
        return `kid ${publishedKid}`;
      },
    ),
  );

  // The one that matters. An authenticated read of the leases domain, which is
  // the page the UI opens on, and which has to cross the gateway, verify the
  // token against the JWKS the Lambda fetched over the compose network, and then
  // read DynamoDB. A 401 or 403 here is the interesting failure; a 5xx is
  // LocalStack's cold start, which is why this check retries.
  results.push(
    await check(
      "an authenticated leases read reaches the Lambda",
      maxAttempts,
      async () => {
        const session = await fetchLocalSession();
        const response = await request({
          method: "GET",
          path: "/api/leases",
          token: session.token,
        });
        if (response.status === 401 || response.status === 403) {
          throw new Error(
            `identity rejected (${response.status}): ${truncate(response.raw)}. The Lambda could not verify the token — check that it can reach http://isb-local-edge:4599 over the compose network and that its COGNITO_USER_POOL_ID matches the edge's issuer.`,
          );
        }
        if (response.status >= 400) {
          throw new Error(
            `status ${response.status}: ${truncate(response.raw)}. The request got past the identity check, so the edge, the gateway, the JWKS fetch, and the RBAC decision all work.`,
          );
        }
        const count = (
          (response.body as { data?: { result?: unknown[] } }).data?.result ??
          []
        ).length;
        return `${count} lease(s) in ${response.elapsedMs}ms`;
      },
    ),
  );

  return results;
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  basename(process.argv[1]).startsWith("smoke");

if (invokedDirectly) {
  console.info(`[local-smoke] checking ${LOCAL_EDGE_URL}\n`);
  runSmokeChecks()
    .then((results) => {
      for (const result of results) {
        console.info(
          `${result.ok ? "PASS" : "FAIL"}  ${result.name} — ${result.detail}`,
        );
      }
      console.info("");
      console.info(
        results.every((result) => result.ok)
          ? "The profile is up. For the full API walk: npm run local:verify"
          : "Not up. Run `npm run local:up` and read `npm run local:logs`.",
      );
      if (results.some((result) => !result.ok)) process.exit(1);
    })
    .catch((error: unknown) => {
      console.error(
        `[local-smoke] could not run: ${error instanceof Error ? error.message : String(error)}`,
      );
      process.exit(1);
    });
}
