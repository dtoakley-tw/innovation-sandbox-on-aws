// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import type { ZodType } from "zod";

/**
 * The wire envelope every modeled response wears, and the two assertions
 * `verify.ts` makes about it before it hands anything to a domain schema.
 *
 * `JSendStatus` and `JSendErrorData` are owned by the generated API contract
 * (`docs/openapi/innovation-sandbox-api.json`), which the local gateway imports
 * verbatim. They are *not* re-exported from any `@amzn/innovation-sandbox-*`
 * entry point, so restating the enum here would be a second copy of a contract
 * this repository already treats as generated. What is checked is therefore the
 * part that is a property of the profile rather than of the contract: that a
 * response really is a JSend envelope, so a `DEFAULT_5XX` body from API Gateway
 * (`{"message": "..."}`) can never be mistaken for an application response.
 */

/** `status` in a JSend success envelope. The contract allows fail/error too. */
const JSEND_STATUSES = new Set(["success", "fail", "error"]);

export interface JSendEnvelope {
  status?: unknown;
  data?: unknown;
  message?: unknown;
}

/**
 * Renders a Zod failure as one line a developer can act on: the failing path and
 * what was expected, with the first few issues rather than all of them. A
 * `z.prettifyError` dump for a `strictObject` with a hundred optional fields is
 * noise; the path is the signal.
 */
export function describeZodFailure(error: {
  issues: ReadonlyArray<{ path: ReadonlyArray<PropertyKey>; message: string }>;
}): string {
  const first = error.issues.slice(0, 4).map((issue) => {
    const path = issue.path.map(String).join(".");
    return path ? `${path}: ${issue.message}` : issue.message;
  });
  const rest = error.issues.length - first.length;
  return first.join("; ") + (rest > 0 ? ` (+${rest} more)` : "");
}

export interface Validated<T> {
  ok: boolean;
  detail: string;
  value?: T;
}

/**
 * Parses `data` against a production schema, turning a failure into a report
 * rather than a throw. `label` names the projection so a failure says which of
 * several parses in one response went wrong.
 */
export function validate<T>(
  label: string,
  // `ZodType<unknown>` rather than `ZodType<T>`: the callers pass a schema
  // picked out of a heterogeneous record (`ConfigSchemas[section]`,
  // `LeaseSchema`'s union), and TS cannot narrow `ConfigSchemas[section]` to a
  // single section's type. The output is still `T`; only the input position is
  // widened, which is what a validation boundary wants anyway.
  schema: ZodType<unknown, unknown>,
  data: unknown,
): Validated<T> {
  const result = schema.safeParse(data);
  if (result.success) {
    return {
      ok: true,
      detail: `${label} matches the production schema`,
      value: result.data as T,
    };
  }
  return { ok: false, detail: `${label}: ${describeZodFailure(result.error)}` };
}

/**
 * Asserts the JSend envelope. Separate from `validate` because it applies to
 * error responses too, and because its failure is the signal that a request
 * never reached the application's error handling at all.
 */
export function checkEnvelope(
  label: string,
  body: unknown,
): Validated<JSendEnvelope> {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return {
      ok: false,
      detail: `${label}: body is ${Array.isArray(body) ? "an array" : typeof body}, not a JSend object`,
    };
  }
  const envelope = body as JSendEnvelope;
  if (
    typeof envelope.status !== "string" ||
    !JSEND_STATUSES.has(envelope.status)
  ) {
    // A `{"message": "..."}` body is API Gateway's own DEFAULT_5XX shape, not
    // the application's. Saying so is the difference between a developer
    // reading "the gateway failed" and a developer hunting a phantom Zod bug.
    return {
      ok: false,
      detail:
        `${label}: no JSend \`status\` (keys: ${Object.keys(envelope).join(", ") || "none"}). ` +
        `A body without \`status\` is API Gateway's own error shape, not an application response.`,
    };
  }
  // Which of `message` and `data.errors` carries the text depends on the status,
  // and that split is the generated contract's, not this file's:
  //   success — `data` is the payload, and absent for the actions that return
  //             none (`DeleteLeaseTemplateResponseContent` requires `status` only).
  //   fail    — per-field detail in `data.errors` (`JSendErrorData`).
  //   error   — a top-level `message`, and no `data`.
  // So a `fail` with no `data.errors` and an `error` with no `message` are both
  // real defects in the error path, and both are called out.
  if (envelope.status === "fail") {
    const errors = (envelope.data as { errors?: unknown } | undefined)?.errors;
    // The local edge's own 501 is a `fail` carrying a top-level `message`
    // instead, which is legal: `ValidationErrorResponseContent` requires only
    // `status`, and `message` and `data.errors` are both optional members of it.
    // So a `fail` is well-formed with *either*, and only neither is a defect.
    if (
      typeof envelope.message !== "string" &&
      (!Array.isArray(errors) || errors.length === 0)
    ) {
      return {
        ok: false,
        detail: `${label}: JSend fail carrying neither \`message\` nor \`data.errors\`, so the failure says nothing`,
      };
    }
  }
  if (envelope.status === "error" && typeof envelope.message !== "string") {
    return {
      ok: false,
      detail: `${label}: JSend error with no \`message\`; \`error\` is the status that carries one`,
    };
  }
  return {
    ok: true,
    detail: `${label}: JSend ${envelope.status}`,
    value: envelope,
  };
}

/** Flattens a JSend `data.errors[]` into one readable line, or "" if absent. */
export function jsendErrors(body: unknown): string {
  if (typeof body !== "object" || body === null) return "";
  const errors = (body as { data?: { errors?: unknown } }).data?.errors;
  if (!Array.isArray(errors)) return "";
  return errors
    .map((entry) =>
      typeof entry === "object" && entry !== null
        ? String(
            (entry as { message?: unknown }).message ?? JSON.stringify(entry),
          )
        : String(entry),
    )
    .join("; ");
}

/** The JSend `message`, for a `status: "error"` body. */
export function jsendMessage(body: unknown): string {
  if (typeof body !== "object" || body === null) return "";
  const message = (body as { message?: unknown }).message;
  return typeof message === "string" ? message : "";
}
