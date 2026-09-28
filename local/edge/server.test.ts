// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "vitest";

import {
  LOCAL_EDGE_PORT,
  LOCAL_STAGE,
  localEdgeConfig,
} from "../shared/names.js";
import { loadOrCreateKeyPair, type KeyPair } from "./jwks.js";

// server.ts runs main() when argv[1] names it, and if that guard ever leaks it
// binds :4599 as a side effect of being imported. The variable main() needs is
// therefore set here, before the dynamic import: without it main() would bail
// on the missing variable and the assertion below could not tell "the guard
// held" from "main() never got far enough to listen".
process.env.ISB_LOCAL_API_GATEWAY_INVOKE_URL = "http://127.0.0.1:1/local";

const { createLocalEdgeServer } = await import("./server.js");

/** One request as the stand-in gateway saw it, so assertions read as the wire. */
interface UpstreamHit {
  method: string;
  url: string;
  headers: IncomingHttpHeaders;
  body: string;
}

const upstreamHits: UpstreamHit[] = [];
const servers: Server[] = [];

let keyDir: string;
let keyPair: KeyPair;
let upstreamUrl: string;
let edge: Server;
let base: string;
const originalKeyDir = process.env.ISB_LOCAL_KEY_DIR;
const originalInvokeUrl = process.env.ISB_LOCAL_API_GATEWAY_INVOKE_URL;

const listen = (server: Server) =>
  new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const close = (server: Server) =>
  new Promise<void>((resolve) => server.close(() => resolve()));
const address = (server: Server) =>
  `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

beforeAll(async () => {
  keyDir = mkdtempSync(join(tmpdir(), "isb-local-edge-"));
  process.env.ISB_LOCAL_KEY_DIR = keyDir;
  // One keypair for the whole file: RSA generation dominates the runtime, and a
  // stable kid across tests is what the real service does across restarts.
  keyPair = await loadOrCreateKeyPair();
});

afterAll(() => {
  const restore = (key: string, value: string | undefined) => {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  };
  restore("ISB_LOCAL_KEY_DIR", originalKeyDir);
  restore("ISB_LOCAL_API_GATEWAY_INVOKE_URL", originalInvokeUrl);
  rmSync(keyDir, { recursive: true, force: true });
});

beforeEach(async () => {
  upstreamHits.length = 0;
  const upstream = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      upstreamHits.push({
        method: req.method ?? "",
        url: req.url ?? "",
        headers: req.headers,
        body: Buffer.concat(chunks).toString("utf-8"),
      });
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ status: "success", data: { echoed: req.url } }));
    });
  });
  servers.push(upstream);
  await listen(upstream);
  upstreamUrl = address(upstream);

  edge = createLocalEdgeServer({
    apiGatewayInvokeUrl: `${upstreamUrl}/${LOCAL_STAGE}/_user_request_`,
    keyPair,
  });
  servers.push(edge);
  await listen(edge);
  base = address(edge);
});

// Tracked centrally rather than per-test so an early assertion failure cannot
// skip a close and hang the run on an open handle.
afterEach(async () => {
  await Promise.all(servers.splice(0).map(close));
});

describe("the local edge", () => {
  it("serves a config.json with all nine ConfigData fields", async () => {
    const response = await fetch(`${base}/config.json`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(localEdgeConfig());
  });

  it("strips the /api prefix and prepends the stage when proxying", async () => {
    await fetch(`${base}/api/leases`);
    expect(upstreamHits).toHaveLength(1);
    expect(upstreamHits[0].url).toBe(`/${LOCAL_STAGE}/_user_request_/leases`);
  });

  // A dropped search string silently breaks every paginated list in the UI, and
  // it reads as "the backend is broken" rather than "the edge ate the query".
  it("preserves the query string through the hop", async () => {
    await fetch(`${base}/api/leases?limit=10&nextToken=abc-123`);
    expect(upstreamHits[0].url).toBe(
      `/${LOCAL_STAGE}/_user_request_/leases?limit=10&nextToken=abc-123`,
    );
  });

  it("preserves the request method, body and identity header", async () => {
    const body = JSON.stringify({ accountName: "acct-1" });
    const response = await fetch(`${base}/api/leaseTemplates`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-isb-identity": "t" },
      body,
    });

    expect(response.status).toBe(200);
    expect(upstreamHits[0].method).toBe("POST");
    expect(upstreamHits[0].body).toBe(body);
    expect(upstreamHits[0].headers["x-isb-identity"]).toBe("t");
  });

  it("forwards a bodyless DELETE", async () => {
    await fetch(`${base}/api/leases/l-1`, { method: "DELETE" });
    expect(upstreamHits[0].method).toBe("DELETE");
    expect(upstreamHits[0].body).toBe("");
  });

  // The Vite proxy's Host is the dev server, not the gateway, and LocalStack
  // routes on it. Undici drops a caller-supplied Host today, so this pins the
  // invariant rather than the `delete` in the proxy: a rewrite to node:http
  // would forward the edge's own host straight through.
  it("shows the gateway its own Host, not the edge's", async () => {
    await fetch(`${base}/api/leases`);
    expect(upstreamHits[0].headers.host).toBe(new URL(upstreamUrl).host);
  });

  it("mints a session whose iss matches the local user pool", async () => {
    const response = await fetch(`${base}/session`);
    const session = (await response.json()) as {
      token: string;
      payload: Record<string, unknown>;
    };
    const claims = JSON.parse(
      Buffer.from(session.token.split(".")[1], "base64url").toString("utf-8"),
    );
    expect(claims.iss).toBe(session.payload.iss);
    expect(session.payload).toMatchObject({
      token_use: "id",
      "custom:isb_roles": '["Admin"]',
    });
  });

  it("publishes a JWKS with one key and no private material", async () => {
    const response = await fetch(`${base}/.well-known/jwks.json`);
    const raw = await response.text();
    const jwks = JSON.parse(raw) as { keys: Array<{ kid: string }> };

    expect(jwks.keys).toHaveLength(1);
    expect(jwks.keys[0].kid).toBe(keyPair.kid);
    // Pinned on the wire, not just on the function: this response is the only
    // thing standing between the signing key and anything that can reach :4599.
    expect(raw).not.toContain("PRIVATE");
  });

  it("answers 501 for the documented unsupported paths", async () => {
    const response = await fetch(`${base}/local/unsupported/access-portal`);
    expect(response.status).toBe(501);
  });

  it("reports health", async () => {
    expect((await fetch(`${base}/healthz`)).status).toBe(200);
  });

  it("404s an unrecognised path rather than proxying it", async () => {
    const response = await fetch(`${base}/not-a-route`);
    expect(response.status).toBe(404);
    expect(upstreamHits).toHaveLength(0);
  });

  // A blank page is undiagnosable; a 502 naming the cause points at the one
  // thing that is usually wrong.
  it("reports a 502 naming the cause when the gateway is unreachable", async () => {
    const dead = createServer();
    await listen(dead);
    const deadUrl = address(dead);
    await close(dead);

    const orphan = createLocalEdgeServer({
      apiGatewayInvokeUrl: `${deadUrl}/${LOCAL_STAGE}/_user_request_`,
      keyPair,
    });
    servers.push(orphan);
    await listen(orphan);

    const response = await fetch(`${address(orphan)}/api/leases`);
    expect(response.status).toBe(502);
    expect((await response.json()).message).toMatch(
      /Local edge could not reach the LocalStack API Gateway/,
    );
  });

  it("does not bind the compose port merely by being imported", async () => {
    await expect(
      fetch(`http://127.0.0.1:${LOCAL_EDGE_PORT}/healthz`, {
        signal: AbortSignal.timeout(1_000),
      }),
    ).rejects.toThrow();
  });
});
