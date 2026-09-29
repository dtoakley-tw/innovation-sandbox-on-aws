// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import { IdcPrincipalIdSchema } from "@amzn/innovation-sandbox-shared/types/principal.js";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import {
  createServer,
  get,
  type IncomingHttpHeaders,
  type Server,
  type ServerResponse,
} from "node:http";
import { request as httpsRequest } from "node:https";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
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
  LOCAL_EDGE_SERVICE_NAME,
  LOCAL_EDGE_TLS_PORT,
  LOCAL_IDC_PRINCIPAL_ID,
  LOCAL_JWKS_PATH,
  LOCAL_JWKS_URI,
  LOCAL_STAGE,
  localEdgeConfig,
} from "../shared/names.js";
import {
  loadOrCreateDevTlsCredentials,
  type DevTlsCredentials,
} from "./dev-ca.js";
import { buildLocalJwks, loadOrCreateKeyPair, type KeyPair } from "./jwks.js";

// Captured before either is written below, so afterAll restores the inherited
// values rather than this file's own. The other order puts a dead upstream URL
// back into the environment for sibling files under --no-isolate.
const originalKeyDir = process.env.ISB_LOCAL_KEY_DIR;
const originalInvokeUrl = process.env.ISB_LOCAL_API_GATEWAY_INVOKE_URL;

// server.ts runs main() when argv[1] names it, and if that guard ever leaks it
// binds :4599 as a side effect of being imported. The variable main() needs is
// therefore set here, before the dynamic import: without it main() would bail
// on the missing variable and the assertion below could not tell "the guard
// held" from "main() never got far enough to listen".
process.env.ISB_LOCAL_API_GATEWAY_INVOKE_URL = "http://127.0.0.1:1/local";

const { createLocalEdgeServer, createLocalJwksTlsServer, main } =
  await import("./server.js");

/** One request as the stand-in gateway saw it, so assertions read as the wire. */
interface UpstreamHit {
  method: string;
  url: string;
  headers: IncomingHttpHeaders;
  body: string;
}

/** How the stand-in gateway answers. Replaced per test; reset in beforeEach. */
type Responder = (res: ServerResponse, hit: UpstreamHit) => void;

const upstreamHits: UpstreamHit[] = [];
const servers: Server[] = [];

let keyDir: string;
let keyPair: KeyPair;
let upstreamUrl: string;
let edge: Server;
let base: string;
let respond: Responder;

const echoJson: Responder = (res, hit) => {
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({ status: "success", data: { echoed: hit.url } }));
};

const listen = (server: Server) =>
  new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const close = (server: Server) =>
  new Promise<void>((resolve) => server.close(() => resolve()));
const address = (server: Server) =>
  `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

/**
 * The literal header lines the edge wrote. `fetch` cannot answer these
 * questions: undici normalises the connection headers it reports, so it shows
 * the same values whether the edge relayed the gateway's or Node supplied its
 * own.
 */
const rawHeaders = async (url: string): Promise<string[]> => {
  const request = get(url);
  return new Promise<string[]>((resolve, reject) => {
    request.on("response", (response) => {
      const lines: string[] = [];
      for (let i = 0; i < response.rawHeaders.length; i += 2) {
        lines.push(`${response.rawHeaders[i]}: ${response.rawHeaders[i + 1]}`);
      }
      response.resume();
      response.on("end", () => resolve(lines));
    });
    request.on("error", reject);
  });
};

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
  respond = echoJson;
  const upstream = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const hit = {
        method: req.method ?? "",
        url: req.url ?? "",
        headers: req.headers,
        body: Buffer.concat(chunks).toString("utf-8"),
      };
      upstreamHits.push(hit);
      respond(res, hit);
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

  // The gateway's payload, not just its status code: a proxy that forwarded
  // the request and dropped the response body would satisfy every other
  // assertion in this file.
  it("returns the gateway's response body to the browser", async () => {
    const response = await fetch(`${base}/api/leases`);
    expect(await response.json()).toEqual({
      status: "success",
      data: { echoed: `/${LOCAL_STAGE}/_user_request_/leases` },
    });
  });

  // undici decompresses the body but leaves `content-encoding: gzip` sitting on
  // response.headers, so relaying that header would have the browser try to
  // inflate plain text and choke on it.
  it("decodes a gzip gateway response and drops its content-encoding", async () => {
    const payload = JSON.stringify({
      status: "success",
      data: {
        echoed: `/${LOCAL_STAGE}/_user_request_/leases`,
        filler: "x".repeat(400),
      },
    });
    const encoded = gzipSync(Buffer.from(payload, "utf-8"));
    // Guard the guard: if this payload did not actually compress, the test
    // would pass for the wrong reason.
    expect(encoded.length).toBeLessThan(payload.length);
    respond = (res) => {
      res.writeHead(200, {
        "content-type": "application/json",
        "content-encoding": "gzip",
      });
      res.end(encoded);
    };

    const response = await fetch(`${base}/api/leases`);
    expect(response.headers.get("content-encoding")).toBeNull();
    expect(await response.json()).toEqual(JSON.parse(payload));
  });

  // A hop-by-hop header describes one connection, and the browser's connection
  // to the edge is not the one to the gateway. Node re-frames its own response,
  // so a bare "transfer-encoding is absent" is not writable — the gateway sends
  // it lower-cased and Node writes its own capitalised, which is what
  // distinguishes them here.
  it("does not relay the gateway's hop-by-hop headers to the browser", async () => {
    respond = (res) => {
      res.writeHead(200, {
        "content-type": "application/json",
        // A value nothing on this side would ever produce, so it can only
        // arrive if the edge passed the header through verbatim.
        "keep-alive": "timeout=12345",
      });
      res.end(JSON.stringify({ status: "success" }));
    };

    const lines = await rawHeaders(`${base}/api/leases`);
    expect(lines).not.toContain("keep-alive: timeout=12345");
    expect(lines.filter((line) => /^transfer-encoding:/i.test(line))).toEqual([
      "Transfer-Encoding: chunked",
    ]);
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

  // `custom:idc_user_id` is read as the caller's own id by CognitoAuthService
  // and the leases API parses it with `IdcPrincipalIdSchema` *before* its role
  // gate, so a `sub` that is not a UUID is a 400 on the shared-leases query the
  // home page issues — being Admin does not reach past it. The shared-leases
  // and group-membership lookups then key on this id, so it has to be the one
  // the seed writes the admin principal under, not merely a well-formed UUID.
  it("signs the session with the id the seed keys the admin principal on", async () => {
    const response = await fetch(`${base}/session`);
    const session = (await response.json()) as {
      payload: Record<string, unknown>;
    };
    expect(IdcPrincipalIdSchema.safeParse(session.payload.sub).success).toBe(
      true,
    );
    expect(session.payload.sub).toBe(LOCAL_IDC_PRINCIPAL_ID);
    expect(session.payload["custom:idc_user_id"]).toBe(LOCAL_IDC_PRINCIPAL_ID);
  });

  it("publishes a JWKS holding only public key material", async () => {
    const raw = await (await fetch(`${base}/.well-known/jwks.json`)).text();
    const jwks = JSON.parse(raw) as { keys: Array<{ kid: string }> };

    expect(jwks.keys).toHaveLength(1);
    expect(jwks.keys[0].kid).toBe(keyPair.kid);
    // The exact key set is the assertion that means it: a leak in JWK form
    // (d, p, q, dp, dq, qi) carries no "PRIVATE" substring in any encoding, so
    // a substring check would pass straight through a real leak.
    expect(Object.keys(jwks.keys[0]).sort()).toEqual([
      "alg",
      "e",
      "kid",
      "kty",
      "n",
      "use",
    ]);
  });

  it("answers 501 and says why for the documented unsupported paths", async () => {
    const response = await fetch(`${base}/local/unsupported/access-portal`);
    expect(response.status).toBe(501);
    const { message } = (await response.json()) as { message: string };
    // The status alone leaves the developer guessing; the reason is the point.
    expect(message).toMatch(/LocalStack Hobby does not emulate/);
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

  // A stray space in an exported API id makes `new URL` throw, and a throw from
  // a request handler is uncaught: the process dies, taking /healthz and every
  // other route with it, and the browser sees a connection reset.
  it("reports a malformed gateway URL as a 502 and stays up", async () => {
    const broken = createLocalEdgeServer({
      apiGatewayInvokeUrl: "not a url /local/_user_request_",
      keyPair,
    });
    servers.push(broken);
    await listen(broken);
    const brokenBase = address(broken);

    const response = await fetch(`${brokenBase}/api/leases`);
    expect(response.status).toBe(502);
    const { message } = (await response.json()) as { message: string };
    expect(message).toMatch(/ISB_LOCAL_API_GATEWAY_INVOKE_URL/);

    // What proves the process did not die rather than merely recovering.
    expect((await fetch(`${brokenBase}/healthz`)).status).toBe(200);
  });

  it("names the required variable when the gateway URL is missing", async () => {
    const saved = process.env.ISB_LOCAL_API_GATEWAY_INVOKE_URL;
    delete process.env.ISB_LOCAL_API_GATEWAY_INVOKE_URL;
    try {
      await expect(main()).rejects.toThrow(/ISB_LOCAL_API_GATEWAY_INVOKE_URL/);
    } finally {
      if (saved !== undefined) {
        process.env.ISB_LOCAL_API_GATEWAY_INVOKE_URL = saved;
      }
    }
  });

  it("does not bind the compose port merely by being imported", async () => {
    await expect(
      fetch(`http://127.0.0.1:${LOCAL_EDGE_PORT}/healthz`, {
        signal: AbortSignal.timeout(1_000),
      }),
    ).rejects.toThrow();
  });

  it("does not bind the TLS port merely by being imported", async () => {
    await expect(
      fetch(`https://127.0.0.1:${LOCAL_EDGE_TLS_PORT}${LOCAL_JWKS_PATH}`, {
        signal: AbortSignal.timeout(1_000),
      }),
    ).rejects.toThrow();
  });
});

// The browser reaches `/session` cross-origin and nothing else does, so these
// are the only CORS assertions in the file. What each one is protecting is
// named: without the first, the app renders logged out with an opaque CORS
// error in the console; without the second, any page a developer visits while
// the profile is up can read a signed identity token out of their browser.
describe("CORS on the local edge", () => {
  it("echoes a loopback origin so the Vite dev server can read /session", async () => {
    // `http://localhost:5173` is what the dev server presents; the port moves
    // when 5173 is taken, which is why the policy is about the host and not the
    // origin as a whole.
    const response = await fetch(`${base}/session`, {
      headers: { origin: "http://localhost:5173" },
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("access-control-allow-origin")).toBe(
      "http://localhost:5173",
    );
    // The response now varies by origin, so any cache on the way has to key on
    // it rather than serving one origin's header to another.
    expect(response.headers.get("vary")).toBe("Origin");
  });

  it.each([
    "http://localhost:5174",
    "http://127.0.0.1:5173",
    "http://[::1]:5173",
  ])("accepts %s", async (origin) => {
    const response = await fetch(`${base}/session`, { headers: { origin } });
    expect(response.headers.get("access-control-allow-origin")).toBe(origin);
  });

  it.each([
    // A wildcard would satisfy all three of these and is what "do not add a
    // blanket permissive policy" rules out.
    "https://example.test",
    "http://localhost.evil.test:5173",
    "http://evil-localhost:5173",
    "http://sub.localhost:5173",
    "https://localhost:5173",
  ])("refuses %s", async (origin) => {
    const response = await fetch(`${base}/session`, { headers: { origin } });
    expect(response.status).toBe(200);
    expect(response.headers.get("access-control-allow-origin")).toBeNull();
    expect(response.headers.get("vary")).toBeNull();
  });

  it("sends nothing for a same-origin request, which carries no Origin", async () => {
    const response = await fetch(`${base}/session`);
    expect(response.status).toBe(200);
    expect(response.headers.get("access-control-allow-origin")).toBeNull();
  });

  // Only `/session` is fetched cross-origin — `/api` and `/config.json` are
  // proxied by the dev server — so a header on any other route is a surface
  // that did not need to be opened.
  it("does not put the header on the proxied routes", async () => {
    for (const path of ["/api/leases", "/config.json", LOCAL_JWKS_PATH]) {
      const response = await fetch(`${base}${path}`, {
        headers: { origin: "http://localhost:5173" },
      });
      expect(response.headers.get("access-control-allow-origin"), path).toBe(
        null,
      );
    }
  });

  // `fetch(sessionEndpoint, { cache: "no-store" })` is a CORS-simple request:
  // the only header the browser adds is `Origin`, which never triggers a
  // preflight. So none is issued, and none is answered — the edge has no
  // `Access-Control-Allow-Methods` to answer one with, which is what makes this
  // a pinned property rather than an accident of the current request shape. A
  // future frontend change that added a custom header would see the browser
  // reject the preflight outright.
  it("answers no preflight, because it advertises no allowed methods", async () => {
    const response = await fetch(`${base}/session`, {
      method: "OPTIONS",
      headers: {
        origin: "http://localhost:5173",
        "access-control-request-method": "GET",
        "access-control-request-headers": "x-some-header",
      },
    });
    for (const header of [
      "access-control-allow-methods",
      "access-control-allow-headers",
      "access-control-max-age",
    ]) {
      expect(response.headers.get(header), header).toBeNull();
    }
  });
});

// The Lambdas' listener. Kept in a separate `describe` because its whole
// purpose is to be a *different* surface from the browser's, and mixing the two
// would let an assertion pass for the wrong listener.
describe("the local edge's TLS listener", () => {
  let tls: Server;
  let credentials: DevTlsCredentials;
  let tlsBase: string;

  beforeEach(async () => {
    credentials = loadOrCreateDevTlsCredentials();
    tls = createLocalJwksTlsServer({ keyPair, credentials });
    servers.push(tls);
    await listen(tls);
    tlsBase = `https://127.0.0.1:${(tls.address() as AddressInfo).port}`;
  });

  /**
   * A raw `https.request`, because `fetch` cannot be given a `ca` and the point
   * of the exercise is the handshake. Options are built explicitly rather than
   * spread from a `URL`: a `URL`'s own enumerable properties are not `host`,
   * `port` and `path`, so spreading one silently produces a request to port 443
   * on the default host.
   */
  const getTls = (
    path: string,
    options: { servername?: string; ca?: string } = {},
  ) =>
    new Promise<{ status: number; body: string }>((resolve, reject) => {
      const url = new URL(`${tlsBase}${path}`);
      const req = httpsRequest(
        {
          host: url.hostname,
          port: url.port,
          path: url.pathname,
          ca: options.ca ?? credentials.caCertificatePem,
          servername: options.servername,
        },
        (response) => {
          const chunks: Buffer[] = [];
          response.on("data", (chunk: Buffer) => chunks.push(chunk));
          response.on("end", () =>
            resolve({
              status: response.statusCode ?? 0,
              body: Buffer.concat(chunks).toString("utf-8"),
            }),
          );
        },
      );
      req.on("error", reject);
      req.end();
    });

  // The load-bearing assertion of the whole TLS arrangement: the Lambdas reach
  // the edge by service name over https, and this is the handshake that has to
  // work. `servername` supplies the name to check, because `isb-local-edge`
  // resolves only on the compose network.
  it("serves the JWKS to a client that trusts the CA and the name", async () => {
    const { status, body } = await getTls(LOCAL_JWKS_PATH, {
      servername: LOCAL_EDGE_SERVICE_NAME,
    });
    expect(status).toBe(200);
    const jwks = JSON.parse(body) as { keys: Array<{ kid: string }> };
    // Byte-identical to what the browser-facing listener serves: two listeners
    // answering with two key sets would verify against one and be signed by the
    // other, and nothing in either would show it.
    expect(jwks.keys[0].kid).toBe(keyPair.kid);
    expect(body).toBe(JSON.stringify(buildLocalJwks(keyPair)));
  });

  it("refuses a client that does not trust the CA", async () => {
    // No `ca`, so the only trust anchor is the system store, which has never
    // heard of a development CA. The failure a Lambda would see if
    // NODE_EXTRA_CA_CERTS were not set.
    await expect(getTls(LOCAL_JWKS_PATH)).rejects.toThrow();
  });

  // `NODE_EXTRA_CA_CERTS` is read once, at process start, and only the file it
  // names is added — so if this failed, a Lambda would report a TLS error with
  // no way to attribute it to the environment variable that was supposed to fix
  // it.
  it("is trusted through the CA file the bundle carries", async () => {
    const caFile = join(keyDir, "isb-local-ca.pem");
    expect(existsSync(caFile)).toBe(true);
    const { body } = await getTls(LOCAL_JWKS_PATH, {
      servername: LOCAL_EDGE_SERVICE_NAME,
      ca: readFileSync(caFile, "utf-8"),
    });
    expect(JSON.parse(body).keys).toHaveLength(1);
  });

  // One route, deliberately. This listener is not published to the host, so a
  // second route would be a second way onto the API for anything on the
  // `isb-local` network, and nothing that fetches a JWKS needs one.
  it.each(["/", "/session", "/config.json", "/api/leases", "/healthz"])(
    "404s %s rather than serving the rest of the edge over TLS",
    async (path) => {
      const { status, body } = await getTls(path, {
        servername: LOCAL_EDGE_SERVICE_NAME,
      });
      expect(status, path).toBe(404);
      // And it says which listener it is, so a developer who mistyped
      // ISB_LOCAL_JWKS_URI finds the typo rather than a bare 404.
      expect(body).toContain(LOCAL_JWKS_PATH);
    },
  );

  // The address the Lambdas are configured with has to be the one this listener
  // binds, or every authenticated request fails at key retrieval with a
  // connection error rather than anything about certificates.
  it("binds the port and name ISB_LOCAL_JWKS_URI names", () => {
    const url = new URL(LOCAL_JWKS_URI);
    expect(url.protocol).toBe("https:");
    expect(url.hostname).toBe(LOCAL_EDGE_SERVICE_NAME);
    expect(url.port).toBe(String(LOCAL_EDGE_TLS_PORT));
    expect(url.pathname).toBe(LOCAL_JWKS_PATH);
  });

  it("does not answer the browser's plain HTTP route", async () => {
    // The browser-facing listener is a different port and a different scheme;
    // conflating them would mean a trust prompt on every page load.
    expect(LOCAL_EDGE_TLS_PORT).not.toBe(LOCAL_EDGE_PORT);
    expect(LOCAL_JWKS_URI).not.toContain(String(LOCAL_EDGE_PORT));
  });
});
