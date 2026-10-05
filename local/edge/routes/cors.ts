// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
/**
 * Cross-origin access for the routes the browser reaches directly.
 *
 * `GET /session` is the only such route, and it is cross-origin by
 * construction: `source/frontend/vite/resolve-proxy-target.ts` proxies
 * `/api` and `/config.json` through the dev server, so those are same-origin,
 * but `/session` is not on that list and the frontend fetches
 * `VITE_LOCAL_SESSION_ENDPOINT` — `http://localhost:4599/session` — as an
 * absolute URL. The browser blocks the response without
 * `Access-Control-Allow-Origin`, `localSessionLibraryOptions`'s `fetch` throws,
 * its `catch` returns `null`, and the app renders logged out with nothing in the
 * console pointing at CORS. (Predicted, not observed: no browser was available
 * to drive it.)
 *
 * The policy is an echo, not a wildcard, and only for loopback origins. A
 * wildcard would work and would also let any page a developer visits authorize
 * itself to read a signed identity token; the edge is bound to the developer's
 * own machine, so "the origin is loopback" is the entire set of callers that can
 * legitimately exist, and a wildcard is strictly more than that.
 */

import type { IncomingMessage } from "node:http";

/**
 * The origins a local dev server can present. `localhost` and `127.0.0.1` are
 * different origins to a browser even though they are the same machine, and
 * Vite's default host is `localhost`, so both are accepted; the loopback IPv6
 * address is included because a browser given `localhost` may resolve it there
 * and report `[::1]`.
 *
 * The port is not constrained. It cannot be: Vite moves to 5174, 5175 and beyond
 * whenever a port is taken, so a fixed port would be a policy that works on the
 * developer's machine and fails the moment two are running. The scheme is
 * constrained to `http` because the dev server is served over `http` and an
 * `https` loopback origin is not a thing this profile starts.
 */
const LOOPBACK_ORIGIN =
  /^http:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d{1,5})?$/;

/**
 * The `Access-Control-*` headers for a request, or an empty object when the
 * request is same-origin, has no `Origin`, or comes from somewhere this edge
 * has no reason to trust.
 *
 * An empty object is the same-origin case and is correct: a browser that made
 * the request without an `Origin` does not check for the header, and adding one
 * unconditionally would make the *absence* of a policy impossible to see in a
 * test or in a response dump.
 *
 * `Vary: Origin` is included because the response now depends on the request's
 * origin, and any cache between here and the browser would otherwise be free to
 * hand one origin's `Access-Control-Allow-Origin` to another.
 *
 * No `Access-Control-Allow-Credentials`: the frontend's `fetch` is
 * `{ cache: "no-store" }` with the default `credentials: "same-origin"`, so no
 * cookie or HTTP-auth credential is ever attached to a cross-origin request, and
 * adding the header would only widen what a browser will send here.
 */
export function corsHeaders(req: IncomingMessage): Record<string, string> {
  const origin = req.headers.origin;
  if (typeof origin !== "string" || !LOOPBACK_ORIGIN.test(origin)) return {};
  return {
    "access-control-allow-origin": origin,
    vary: "Origin",
  };
}
