// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import { createServer, type Server } from "node:http";

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
    if (path === "/.well-known/jwks.json") {
      // `buildLocalJwks` is the only thing that crosses the wire: the private
      // key stays in this process, where it is needed to sign sessions. Note
      // for the Lambda wiring (a later task) that `CognitoJwtVerifier`'s
      // `cacheJwks` does not accept this document's type directly, so a
      // consumer must cross the boundary with a JSON round trip.
      res.writeHead(200, {
        "content-type": "application/json",
        "cache-control": "no-store",
      });
      res.end(JSON.stringify(buildLocalJwks(keyPair)));
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

/** Entry point used by the compose service. */
async function main(): Promise<void> {
  const { loadOrCreateKeyPair } = await import("./jwks.js");
  const { LOCAL_EDGE_PORT } = await import("../shared/names.js");
  const invokeUrl = process.env.ISB_LOCAL_API_GATEWAY_INVOKE_URL;
  if (!invokeUrl) {
    throw new Error(
      "ISB_LOCAL_API_GATEWAY_INVOKE_URL is required (set by local/scripts/local-up.sh)",
    );
  }
  const server = createLocalEdgeServer({
    apiGatewayInvokeUrl: invokeUrl,
    keyPair: await loadOrCreateKeyPair(),
  });
  server.listen(LOCAL_EDGE_PORT, "0.0.0.0", () => {
    console.info(`[local-edge] listening on :${LOCAL_EDGE_PORT}`);
  });
}

// Only when launched directly: importing this module — from a test, or from a
// future task that composes the edge — must not open a port as a side effect.
if (process.argv[1]?.endsWith("server.ts")) {
  main().catch((error: unknown) => {
    console.error("[local-edge] failed to start", error);
    process.exit(1);
  });
}
