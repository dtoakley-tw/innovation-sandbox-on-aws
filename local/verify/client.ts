// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import { LOCAL_EDGE_PORT } from "../shared/names.js";

/**
 * The one HTTP client the walker uses, and the only place the local origin is
 * assembled. Every check goes through the local edge exactly as the browser
 * does, so a check passing here is evidence the *whole* path works rather than
 * evidence that a Lambda is reachable by a path nothing else uses.
 */

/** The browser's route in. Overridable so a test can point at a scratch edge. */
export const LOCAL_EDGE_URL =
  process.env.ISB_LOCAL_EDGE_URL ?? `http://localhost:${LOCAL_EDGE_PORT}`;

/**
 * LocalStack's own DEFAULT_5XX body, as opposed to any JSend envelope. Its
 * presence is how `verify` tells "the gateway or LocalStack failed" apart from
 * "the application answered", which is the single most important distinction in
 * a local profile: the first is a broken harness, the second is a result.
 */
export const GATEWAY_ERROR_MARKER = "not a JSend";

/** How many times a `should-work` check is retried before it is called failed. */
export const DEFAULT_MAX_ATTEMPTS = 3;

export interface HttpResponse {
  status: number;
  body: unknown;
  raw: string;
  /** True when the body could not be parsed as JSON at all. */
  unparseable: boolean;
  elapsedMs: number;
}

export interface HttpRequest {
  method: string;
  /** Path below the local edge, e.g. `/api/leases`. */
  path: string;
  /** Sent as `x-isb-identity`; omit to send no identity at all. */
  token?: string;
  body?: unknown;
  /** Milliseconds. A cold-starting Lambda can take ~10s on this host. */
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 60_000;

const describeCause = (error: unknown): string =>
  error instanceof Error
    ? `${error.name}: ${error.message}${
        error.cause instanceof Error ? ` (${error.cause})` : ""
      }`
    : String(error);

/**
 * One request, with the elapsed time recorded. A timeout is a distinct outcome
 * from a 5xx: LocalStack's API Gateway integration timeout surfaces as a fast
 * 502 while a Lambda that simply takes too long surfaces as a slow failure, and
 * the two call for different fixes.
 */
export async function request(options: HttpRequest): Promise<HttpResponse> {
  const started = Date.now();
  const headers: Record<string, string> = {};
  if (options.token) headers["x-isb-identity"] = options.token;
  if (options.body !== undefined) headers["content-type"] = "application/json";

  const init: RequestInit = { method: options.method, headers };
  if (options.body !== undefined) init.body = JSON.stringify(options.body);

  let response: Response;
  try {
    response = await fetch(`${LOCAL_EDGE_URL}${options.path}`, {
      ...init,
      signal: AbortSignal.timeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS),
    });
  } catch (error: unknown) {
    throw new Error(
      `${options.method} ${options.path} never completed — ${describeCause(error)}`,
      { cause: error },
    );
  }
  const raw = await response.text();
  let body: unknown;
  let unparseable = false;
  try {
    body = JSON.parse(raw);
  } catch {
    body = raw;
    unparseable = true;
  }
  return {
    status: response.status,
    body,
    raw,
    unparseable,
    elapsedMs: Date.now() - started,
  };
}

/** `GET /session`, which mints a fresh local ID token. */
export async function fetchLocalSession(): Promise<{
  token: string;
  payload: Record<string, unknown>;
}> {
  const response = await request({ method: "GET", path: "/session" });
  if (response.status !== 200) {
    throw new Error(
      `GET /session returned ${response.status}: ${response.raw.slice(0, 200)}`,
    );
  }
  const body = response.body as { token?: unknown; payload?: unknown };
  if (typeof body.token !== "string") {
    throw new Error(
      `GET /session returned no token: ${response.raw.slice(0, 200)}`,
    );
  }
  return {
    token: body.token,
    payload: (body.payload ?? {}) as Record<string, unknown>,
  };
}
