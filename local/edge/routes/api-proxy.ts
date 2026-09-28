// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import type { IncomingMessage, ServerResponse } from "node:http";

/**
 * RFC 9110 hop-by-hop headers. Each one describes the single connection it
 * arrived on, and the browser's connection to the edge is not the one to
 * LocalStack, so forwarding them corrupts the next hop.
 */
const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

/** Undici refuses to attach a body to these, whatever the client sent. */
const BODYLESS_METHODS = new Set(["GET", "HEAD"]);

/**
 * Undici's fetch takes a Node `Readable` as a body and demands `duplex: "half"`
 * alongside it, but `local/tsconfig.json` sets no `lib`, so `RequestInit`
 * resolves to the DOM declaration that has neither. Asserted at the one call
 * site rather than pulling in `undici-types` as a direct dependency.
 */
type ForwardedRequestInit = Omit<RequestInit, "body" | "duplex"> & {
  body?: unknown;
  duplex?: "half";
};

const causeOf = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

/**
 * The single response for every way a forward can fail. Without it the
 * developer sees a blank page and a stack trace in the container log; with it,
 * the response names the thing that is wrong.
 */
const unreachable = (res: ServerResponse, cause: string): void => {
  res.writeHead(502, { "content-type": "application/json" });
  res.end(
    JSON.stringify({
      status: "fail",
      message: `Local edge could not reach the LocalStack API Gateway: ${cause}`,
    }),
  );
};

/**
 * Rewrites `/api/<path>` to the local API Gateway invoke URL and forwards the
 * request, mirroring what the CloudFront path behavior does in production: it
 * strips the `/api` prefix and prepends the stage. The browser therefore stays
 * same-origin and no CORS handling is needed anywhere.
 *
 * The frontend's SigV4 signature is intentionally not validated or re-signed —
 * the local gateway runs with `NONE` authorization and the Lambda's
 * `x-isb-identity` check is the real gate. See the spec's "Local infrastructure".
 * Adding signature enforcement here would be worse than useless: the browser
 * signs for the edge's host, and no key it could hold verifies against the
 * gateway.
 */
export function handleApiProxy(
  req: IncomingMessage,
  res: ServerResponse,
  invokeUrl: string,
): void {
  const originalUrl = req.url ?? "/";
  if (!originalUrl.startsWith("/api/")) {
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ status: "fail", message: "Not found" }));
    return;
  }
  let target: URL;
  try {
    const path = originalUrl.slice("/api".length);
    target = new URL(`${invokeUrl}${path}`);
    // `path` already carries the search string and `new URL` picks it up; the
    // explicit assignment keeps that true even if the invoke URL later grows a
    // query of its own, which would otherwise win over the caller's.
    target.search = new URL(originalUrl, "http://localhost").search;
  } catch (error) {
    // A stray space in an exported API id lands here. Unguarded, `new URL`
    // throws out of the request handler, Node treats that as uncaught, and the
    // process dies — so /healthz and every other route go with it and the
    // browser just sees a connection reset. A misconfiguration is reported like
    // any other unreachable gateway instead, naming the variable to fix.
    unreachable(
      res,
      `ISB_LOCAL_API_GATEWAY_INVOKE_URL is not a usable URL (${JSON.stringify(invokeUrl)}): ${causeOf(error)}`,
    );
    return;
  }

  const bodyless = BODYLESS_METHODS.has(req.method ?? "GET");
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(req.headers)) {
    if (typeof value !== "string" || HOP_BY_HOP.has(name)) continue;
    // A stale Host from the Vite proxy confuses LocalStack's routing, so the
    // gateway's own host is left to fetch to derive. Likewise a length without
    // a body to match it would leave undici waiting on a body that never comes.
    if (name === "host" || (bodyless && name === "content-length")) continue;
    headers[name] = value;
  }

  const init: ForwardedRequestInit = { method: req.method, headers };
  if (!bodyless) {
    // `req` is a Readable, so the body streams rather than buffering the
    // request in memory; `duplex: "half"` is mandatory for that and undici
    // throws without it before a byte leaves the process.
    init.body = req;
    init.duplex = "half";
  }

  fetch(target, init as RequestInit)
    .then(async (response) => {
      const body = Buffer.from(await response.arrayBuffer());
      const out: Record<string, string> = {};
      response.headers.forEach((value, name) => {
        // `content-encoding` is dropped because undici has already decoded the
        // body, and re-sending the header would have the browser decode again.
        // `content-length` described those encoded bytes; writeHead derives the
        // real one from the buffer passed to end().
        if (
          HOP_BY_HOP.has(name) ||
          name === "content-encoding" ||
          name === "content-length"
        ) {
          return;
        }
        out[name] = value;
      });
      res.writeHead(response.status, out);
      res.end(body);
    })
    .catch((error: unknown) => {
      unreachable(res, causeOf(error));
    });
}
