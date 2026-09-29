// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import { createServer, type Server, type ServerResponse } from "node:http";
import {
  createServer as createSecureServer,
  type Server as SecureServer,
} from "node:https";
import { basename } from "node:path";

import {
  LOCAL_EDGE_PORT,
  LOCAL_EDGE_SERVICE_NAME,
  LOCAL_EDGE_TLS_PORT,
  LOCAL_JWKS_PATH,
} from "../shared/names.js";
import { type DevTlsCredentials } from "./dev-ca.js";
import { buildLocalJwks, type KeyPair } from "./jwks.js";
import { handleApiProxy } from "./routes/api-proxy.js";
import { handleConfig } from "./routes/config.js";
import { handleSession } from "./routes/session.js";

export interface LocalEdgeDeps {
  /** LocalStack API Gateway invoke base, e.g. http://localstack:4566/restapis/<id>/local/_user_request_ */
  apiGatewayInvokeUrl: string;
  keyPair: KeyPair;
  logger?: Pick<Console, "info" | "warn" | "error">;
}

const UNSUPPORTED_MESSAGE =
  "Not available in the local profile: this surface depends on an AWS service " +
  "that LocalStack Hobby does not emulate. See docs/plans/2026-09-25-offline-local-development-design.md.";

/**
 * The one origin the Vite dev server proxies to. It exists because `/api` and
 * `/config.json` share a `VITE_API_PROXY_TARGET` with no path rewriting
 * (`source/frontend/vite/resolve-proxy-target.ts`) and no single LocalStack
 * origin serves both.
 */
export function createLocalEdgeServer(deps: LocalEdgeDeps): Server {
  const { apiGatewayInvokeUrl, keyPair, logger = console } = deps;

  return createServer((req, res) => {
    const url = req.url ?? "/";
    const path = url.split("?")[0];

    if (path === "/healthz") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ status: "ok" }));
      return;
    }
    if (path === "/config.json") {
      handleConfig(req, res);
      return;
    }
    if (path === "/session") {
      handleSession(req, res, keyPair).catch((error: unknown) => {
        logger.error("[local-edge] failed to mint session", error);
        res.writeHead(500, { "content-type": "application/json" });
        res.end(
          JSON.stringify({ status: "fail", message: "Session mint failed" }),
        );
      });
      return;
    }
    if (path === LOCAL_JWKS_PATH) {
      writeJwks(res, keyPair);
      return;
    }
    // A fallback signal, not the main mechanism: all six API domains are
    // provisioned locally, and the flows that need an un-emulated service fail
    // at the real call inside the Lambda, which names the missing service.
    if (path.startsWith("/local/unsupported/")) {
      res.writeHead(501, { "content-type": "application/json" });
      res.end(JSON.stringify({ status: "fail", message: UNSUPPORTED_MESSAGE }));
      return;
    }
    if (path.startsWith("/api/")) {
      handleApiProxy(req, res, apiGatewayInvokeUrl);
      return;
    }
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ status: "fail", message: "Not found" }));
  });
}

/**
 * The JWKS document, written identically to both listeners.
 *
 * `buildLocalJwks` is the only thing that crosses the wire: the private key stays
 * in this process, where it is needed to sign sessions. Note for the Lambda
 * wiring that `CognitoJwtVerifier`'s `cacheJwks` does not accept this document's
 * type directly, so a consumer must cross the boundary with a JSON round trip.
 *
 * Shared rather than duplicated because the two listeners must answer with the
 * same key set: the browser never reads either of them, but a divergence here
 * would be invisible until a Lambda verified a token against a key the edge no
 * longer signs with.
 */
const writeJwks = (res: ServerResponse, keyPair: KeyPair): void => {
  res.writeHead(200, {
    "content-type": "application/json",
    "cache-control": "no-store",
  });
  res.end(JSON.stringify(buildLocalJwks(keyPair)));
};

/**
 * The Lambdas' view of the edge: `/.well-known/jwks.json` and nothing else, over
 * TLS, on `LOCAL_EDGE_TLS_PORT`.
 *
 * ## Why a second listener rather than TLS on the one the browser uses
 *
 * `aws-jwt-verify@4.0.1` fetches the JWKS through `node:https.request` and has
 * no code path down to plain `http:` — on an `http://` URI it throws
 * `ERR_INVALID_PROTOCOL` before a packet is sent, so
 * `source/common/lambda/auth/identity-token-verifier.ts`'s `ensureLocalJwks`
 * could never load the key set and every authenticated request failed at key
 * retrieval. The other way out is a change under `source/`, which this profile
 * exists to avoid, so the Lambdas have to be the ones that speak TLS.
 *
 * The browser's listener stays plain HTTP on `LOCAL_EDGE_PORT` because the
 * browser reaches it directly for `/session` and `/api`, and a certificate there
 * means a trust prompt on every page load — a worse trade than the one made
 * here, where the certificate is seen only by a Node process in the same Docker
 * network that has been handed the CA.
 *
 * ## Why the surface is one route
 *
 * This listener is not published to the host (see `local/compose.yaml`), so
 * everything it serves is reachable only from the `isb-local` network. Giving
 * it the full edge would mean a second, unproxied route to `/api` for anything
 * on that network, and nothing that fetches a JWKS needs one. A 404 here is
 * the assertion that the surface has not grown.
 */
export function createLocalJwksTlsServer(deps: {
  keyPair: KeyPair;
  credentials: DevTlsCredentials;
}): SecureServer {
  return createSecureServer(
    {
      cert: deps.credentials.serverCertificatePem,
      key: deps.credentials.serverPrivateKeyPem,
      // The edge serves the leaf only. The Lambdas were handed the CA, which is
      // the whole point of the arrangement, so there is no reason to put the
      // trust anchor back on the wire — `dev-ca.test.ts` pins that the CA file
      // and the served certificate are different documents for this reason.
      minVersion: "TLSv1.2",
    },
    (req, res) => {
      const path = (req.url ?? "/").split("?")[0];
      if (path !== LOCAL_JWKS_PATH) {
        res.writeHead(404, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            status: "fail",
            message: "Not found",
            detail: `${LOCAL_JWKS_PATH} is the only route on the local edge's TLS listener.`,
          }),
        );
        return;
      }
      writeJwks(res, deps.keyPair);
    },
  );
}

/** Entry point used by the compose service. Exported so a test can pin the
 *  startup precondition without going through a real listen. */
export async function main(): Promise<void> {
  const { loadOrCreateKeyPair } = await import("./jwks.js");
  const { assertLocalJwksOverTls, loadOrCreateDevTlsCredentials } =
    await import("./dev-ca.js");
  const invokeUrl = process.env.ISB_LOCAL_API_GATEWAY_INVOKE_URL;
  if (!invokeUrl) {
    throw new Error(
      "ISB_LOCAL_API_GATEWAY_INVOKE_URL is required (set by local/scripts/local-up.sh)",
    );
  }
  const keyPair = await loadOrCreateKeyPair();
  const server = createLocalEdgeServer({
    apiGatewayInvokeUrl: invokeUrl,
    keyPair,
  });
  server.listen(LOCAL_EDGE_PORT, "0.0.0.0", () => {
    console.info(`[local-edge] listening on :${LOCAL_EDGE_PORT}`);
  });

  // Minted here, in the process that serves the leaf, rather than read from the
  // key directory: the two have to be one decision, and a leaf that exists only
  // because a previous run left one behind is a leaf nobody can explain. See
  // `dev-ca.ts` for why the edge and the CDK synth can mint concurrently.
  const credentials = loadOrCreateDevTlsCredentials();
  const tls = createLocalJwksTlsServer({ keyPair, credentials });
  await new Promise<void>((resolve) =>
    tls.listen(LOCAL_EDGE_TLS_PORT, "0.0.0.0", () => resolve()),
  );
  console.info(
    `[local-edge] serving ${LOCAL_JWKS_PATH} over TLS on :${LOCAL_EDGE_TLS_PORT} for ${LOCAL_EDGE_SERVICE_NAME}`,
  );

  // Fatal, and fatal *after* the listener is up so the check exercises the real
  // socket. Every authenticated request fails with a TLS error that points
  // nowhere near this process if the certificate the edge serves and the CA the
  // Lambdas were handed ever disagree, and that is knowable now.
  await assertLocalJwksOverTls(credentials);
  console.info("[local-edge] JWKS reachable over TLS with the local CA");
}

// Only when launched directly: importing this module — from a test, or from a
// future task that composes the edge — must not open a port as a side effect.
// Matched on the basename so the compiled `dist/edge/server.js` reaches main()
// as well as the TypeScript source; anchoring on the extension pair is what
// keeps `server.test.ts` from matching. Without the .js arm a build would exit
// 0 with no server and no log.
if (/server\.[jt]s$/.test(basename(process.argv[1] ?? ""))) {
  main().catch((error: unknown) => {
    console.error("[local-edge] failed to start", error);
    process.exit(1);
  });
}
