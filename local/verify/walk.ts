// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import { LOCAL_IDC_PRINCIPAL_ID } from "../shared/names.js";
import { DEFAULT_MAX_ATTEMPTS, type HttpResponse, request } from "./client.js";
import { checkEnvelope, jsendErrors, jsendMessage, validate } from "./jsend.js";
import {
  BLUEPRINT_ITEM_SCHEMA,
  BLUEPRINT_LIST_ITEM_SCHEMA,
  CONFIG_SECTION_SCHEMAS,
  LEASE_SCHEMA,
  LEASE_TEMPLATE_SCHEMA,
  PRINCIPAL_SCHEMA,
  SANDBOX_ACCOUNT_SCHEMA,
  SEEDED_ADMIN_PRINCIPAL_ID,
} from "./schemas.js";
import type { Expectation, VerifyOptions, VerifyResult } from "./types.js";

/**
 * The API walk: every read path the design says must work, one authenticated
 * mutation per domain where it says CRUD works, and the flows it says must fail.
 *
 * Two properties are deliberate and both cost something:
 *
 *  1. **Nothing throws.** Every check is wrapped, every failure is collected, and
 *     the summary is printed at the end. A walker that stops at the first
 *     problem makes a broken profile *more* expensive to diagnose, not less —
 *     and the likeliest state of a new local profile is that several things are
 *     wrong at once.
 *  2. **Boundary checks are first-class.** A flow the design says must fail at
 *     the real unsupported AWS call is checked for failing *there*: not with a
 *     501 from the edge, and not with a bare gateway 5xx. A synthetic refusal
 *     would pass a naive status check while destroying the signal the design
 *     exists to produce, so it is asserted against explicitly.
 */

const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));

const describe = (response: HttpResponse): string =>
  `${response.status}${jsendMessage(response.body) ? ` ${jsendMessage(response.body)}` : ""}`;

const truncate = (value: string, limit = 220) =>
  value.length > limit ? `${value.slice(0, limit)}…` : value;

/** The evidence a `should-fail` check has to produce, assembled from one response. */
export interface BoundaryEvidence {
  /** True when the response came from API Gateway/LocalStack, not the application. */
  fromGateway: boolean;
  /** True when the local edge refused it rather than the Lambda. */
  fromEdge: boolean;
  /** The application's own text, if it produced any. */
  text: string;
  /** True when that text names the AWS service, which is the useful signal. */
  namesService: boolean;
  status: number;
}

/**
 * A `status: "error"` body is the application's own generic 500 envelope,
 * `{"status":"error","message":"An unexpected error occurred."}`. The *specific*
 * cause — the SDK error naming Organizations, StackSets, and so on — is written
 * to the Lambda's log, not to the response, because the application deliberately
 * does not leak internals. So the body alone rarely names the service, and
 * reporting that honestly is better than implying the response proved it.
 */
const SERVICE_NAMES =
  /organization|stackset|cloudformation|cognito|identity.?center|ssoadmin|cost.?explorer|codebuild|\becr\b|appconfig/i;

export function inspectBoundary(response: HttpResponse): BoundaryEvidence {
  const text =
    `${jsendMessage(response.body)} ${jsendErrors(response.body)}`.trim();
  return {
    status: response.status,
    // The edge's 501 fallback, and the edge's own 502. Either means the request
    // never reached the handler, which is precisely what must not happen.
    fromEdge:
      response.status === 501 ||
      text.includes("Not available in the local profile"),
    // API Gateway's DEFAULT_5XX is a bare `{"message": "..."}` carrying no JSend
    // `status` at all. The status *code* cannot distinguish it, because the
    // application returns 500 too; the envelope can.
    fromGateway: !checkEnvelope("boundary", response.body).ok,
    text: truncate(text, 300),
    namesService: SERVICE_NAMES.test(text),
  };
}

interface WalkContext {
  token: string;
  options: Required<VerifyOptions>;
  results: VerifyResult[];
  /**
   * The seeded template with `requiresApproval: false`, discovered by the read
   * walk and confirmed by the mutation walk. `walkBoundaries` turns it into the
   * auto-approval boundary check; `undefined` means the seed has no such
   * template, which is reported rather than passed over.
   */
  autoApprovingTemplate?: DiscoveredLeaseTemplate;
}

/**
 * A boundary check could not tell whether the boundary held, because the only
 * thing it ever saw was a bare gateway 5xx. Thrown rather than returned so the
 * retry logic gets a chance, and marked so the summary can report it as neither a
 * leak nor a hold.
 */
class BoundaryUndetermined extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BoundaryUndetermined";
  }
}

/**
 * Records a check that could not run, and why.
 *
 * Several checks are conditional on something a *previous* check may have
 * consumed — the seeded Active lease, chiefly. The `quarantine` boundary check
 * terminates the seeded Active lease, so a second `local:verify` on the same
 * profile has no Active lease left to `GET /api/leases/{id}` or `PATCH`. The
 * previous code guarded those with `if (discovered.leaseId)` and simply did not
 * emit them, so the run reported 39 checks instead of 42 and every one of them
 * passed. That is the worst possible shape for a verification script: a shrunken
 * run reads as a *better* run, and nothing in the output says a check was
 * dropped.
 *
 * A skip is therefore reported as a result, in its own group, and it does not
 * set the exit code — the underlying cause (a boundary check that mutated the
 * profile) is reported by the check that did it, and `local:reset` is the
 * documented remedy. What is rejected is the silence, not the situation.
 */
function skipCheck(
  context: WalkContext,
  name: string,
  reason: string,
  options: { path: string; method: string },
): void {
  context.results.push({
    name,
    ok: true,
    detail: `skipped: ${reason}`,
    expectation: "should-work",
    request: `${options.method} ${options.path}`,
    skipped: true,
  });
}

/**
 * Runs one check, retrying only on the LocalStack fast-502. A JSend body — even
 * a `status: "error"` one — is a real answer and is never retried, because
 * retrying it would hide a genuine defect behind a retry that fails the same way.
 */
async function runCheck(
  context: WalkContext,
  name: string,
  expectation: Expectation,
  call: () => Promise<string>,
  options: { path: string; method: string; attempts?: number },
): Promise<void> {
  const { maxAttempts, retryDelayMs } = context.options;
  // A `should-fail` check gets retries too, but only ever spends them on a bare
  // gateway 5xx: a JSend answer is an answer whatever it says, so re-asking a
  // boundary that already replied would change nothing.
  const attemptsAllowed = options.attempts ?? maxAttempts;
  const request_ = `${options.method} ${options.path}`;
  let lastFailure = "";
  let undetermined = false;
  let attempts = 0;

  for (let attempt = 1; attempt <= attemptsAllowed; attempt += 1) {
    attempts = attempt;
    try {
      const detail = await call();
      context.results.push({
        name,
        ok: true,
        detail,
        expectation,
        request: request_,
        ...(attempt > 1 ? { attempts: attempt } : {}),
      });
      return;
    } catch (error: unknown) {
      lastFailure = error instanceof Error ? error.message : String(error);
      // Only a gateway-shaped failure is worth another go; a JSend application
      // error is the answer, and a second identical answer is not progress.
      const retryable =
        /Internal server error|never completed|status 50[0234]/.test(
          lastFailure,
        );
      if (!retryable || attempt === attemptsAllowed) {
        undetermined = error instanceof BoundaryUndetermined;
        break;
      }
      await sleep(retryDelayMs);
    }
  }
  context.results.push({
    name,
    ok: false,
    detail: truncate(lastFailure, 400),
    expectation,
    request: request_,
    attempts,
    ...(undetermined ? { undetermined: true } : {}),
  });
}

/**
 * A successful JSend response, or a thrown message naming what was wrong.
 *
 * `data` is optional because the contract does not require it on every action:
 * `DeleteLeaseTemplateResponseContent` requires `status` alone, and
 * `EjectAccountResponseContent` is the same. Requiring it would fail a correct
 * response, which is worse than missing a real defect.
 */
function requireSuccess(
  name: string,
  response: HttpResponse,
  allowed: number[] = [200],
): void {
  const envelope = checkEnvelope(name, response.body);
  if (!envelope.ok) {
    throw new Error(
      `${name}: ${envelope.detail}. Body: ${truncate(response.raw)}`,
    );
  }
  if (!allowed.includes(response.status)) {
    throw new Error(
      `${name}: expected ${allowed.join("/")}, got ${describe(response)} with ${truncate(response.raw)}`,
    );
  }
  if (envelope.value?.status !== "success") {
    throw new Error(
      `${name}: JSend ${String(envelope.value?.status)} at ${describe(response)}: ` +
        `${jsendMessage(response.body) || jsendErrors(response.body)}`,
    );
  }
}

/** Reads `data` off a JSend success, as a record. */
function dataOf(response: HttpResponse): Record<string, unknown> {
  const data = (response.body as { data?: unknown }).data;
  if (typeof data !== "object" || data === null) {
    throw new Error(
      `no \`data\` object in the response: ${truncate(response.raw, 200)}`,
    );
  }
  return data as Record<string, unknown>;
}

/**
 * `data` where a member may legitimately be absent, for the actions whose
 * response content the contract types as optional.
 */
function dataMaybe(response: HttpResponse): Record<string, unknown> {
  const data = (response.body as { data?: unknown }).data;
  return typeof data === "object" && data !== null
    ? (data as Record<string, unknown>)
    : {};
}

function arrayField(response: HttpResponse, field: string): unknown[] {
  const data = dataOf(response);
  const value = data?.[field];
  return Array.isArray(value) ? value : [];
}

/** Validates every member of a list against one schema, and reports the index. */
function validateList(
  label: string,
  schema: Parameters<typeof validate>[1],
  items: unknown[],
): string {
  if (items.length === 0) {
    throw new Error(
      `${label}: the seeded fixtures guarantee at least one record, so an empty list means the read did not reach DynamoDB`,
    );
  }
  const problems: string[] = [];
  items.forEach((item, index) => {
    const result = validate(`${label}[${index}]`, schema, item);
    if (!result.ok) problems.push(result.detail);
  });
  if (problems.length) {
    throw new Error(
      `${problems.length}/${items.length} did not match: ${problems.slice(0, 2).join(" | ")}`,
    );
  }
  return `${items.length} record(s), all matching the production schema`;
}

const get = (token: string, path: string) =>
  request({ method: "GET", path, token });
// `body` is optional because the contract models no body for the DELETE actions
// and for the account lifecycle POSTs, and sending an empty string where the
// contract sends nothing is a 415 the check would then be reporting.
const send = (token: string, method: string, path: string, body?: unknown) =>
  request({ method, path, token, body });

// ---------------------------------------------------------------------------
// Read paths
// ---------------------------------------------------------------------------

/**
 * Everything the design's table marks as working, in the order a developer
 * would visit it. The leases walk comes first because it is the page the UI
 * opens on, and because it is the only domain whose read path needs a value
 * derived from another read (the `leaseId`), so it also exercises the
 * composition the frontend depends on.
 */
async function walkReads(
  context: WalkContext,
  discovered: {
    leaseId?: string;
    leaseTemplates: DiscoveredLeaseTemplate[];
    blueprintId?: string;
  },
): Promise<void> {
  const { token } = context;

  // --- leases -------------------------------------------------------------
  let leasesList: HttpResponse | undefined;
  await runCheck(
    context,
    "leases: GET /api/leases",
    "should-work",
    async () => {
      leasesList = await get(token, "/api/leases");
      requireSuccess("leases: GET /api/leases", leasesList);
      const detail = validateList(
        "leases: data.result[]",
        LEASE_SCHEMA,
        arrayField(leasesList, "result"),
      );
      const leases = arrayField(leasesList, "result") as Array<
        Record<string, unknown>
      >;
      const active = leases.find((lease) => lease.status === "Active");
      if (active?.leaseId) discovered.leaseId = String(active.leaseId);
      const emails = new Set(leases.map((lease) => lease.userEmail));
      if (emails.size !== 1 || !emails.has("admin@example.local")) {
        throw new Error(
          `leases: the signed-in user is admin@example.local but the leases are owned by ${[...emails].join(", ")}. \`getLeasesForUser\` keys on the token's email, so the home page would be empty.`,
        );
      }
      return `${detail}; owners all admin@example.local; leaseId captured`;
    },
    { method: "GET", path: "/api/leases" },
  );

  // `userId` and `accessType` are **`required: true`** in the contract
  // (`docs/openapi/innovation-sandbox-api.json`, `/leases/shared`), and the
  // generated `ListSharedLeases` UriSpec binds both as query segments.
  // `HttpBindingMux.match` returns false for a spec whose required query
  // segments are absent, so a request with no query string does not fail *at*
  // `ListSharedLeases` — it fails to match that route at all and falls through
  // to `GetLease` (`/leases/{leaseId}`), which then rejects the literal segment
  // `shared` as a base64 composite key with
  // `400 LeaseId path parameter provided is invalid.`
  //
  // That is worth stating precisely because it reads exactly like the
  // route-precedence bug it resembles: an earlier version of this file recorded
  // it as LocalStack matching `/leases/{leaseId}` before the static path. It is
  // not. `awslocal apigateway get-resources` shows both resources imported
  // correctly and in order, and the failing request's Lambda event carries
  // `"resource": "/leases/shared"` and `"resourceId"` of the *static* resource —
  // API Gateway routed it right. The application's own mux then failed to match
  // the operation because the query string was empty. With the two parameters
  // present the same request returns 200; with only one of them it 400s again,
  // which is the behaviour of a route that requires both.
  const sharedLeasesPath = `/api/leases/shared?userId=${encodeURIComponent(
    LOCAL_IDC_PRINCIPAL_ID,
  )}&accessType=direct`;
  await runCheck(
    context,
    "leases: GET /api/leases/shared",
    "should-work",
    async () => {
      const response = await get(token, sharedLeasesPath);
      requireSuccess("leases: GET /api/leases/shared", response);
      const data = dataOf(response);
      if (!Array.isArray(data.result)) {
        throw new Error(
          `leases: GET /api/leases/shared: no \`data.result\` array; the leases home page reads it. Got ${truncate(response.raw)}`,
        );
      }
      // A list, not a count of one: the point is that the *static* path reached
      // `ListSharedLeases`. An empty list is the honest result — the seed
      // assigns no lease to another principal — and asserting non-empty here
      // would fail on a correct profile.
      return `${(data.result as unknown[]).length} shared lease(s); the static path with its two required query parameters reached ListSharedLeases, not GetLease`;
    },
    { method: "GET", path: "/api/leases/shared?userId=…&accessType=direct" },
  );

  if (discovered.leaseId) {
    const leaseId = discovered.leaseId;
    await runCheck(
      context,
      "leases: GET /api/leases/{leaseId}",
      "should-work",
      async () => {
        const response = await get(token, `/api/leases/${leaseId}`);
        requireSuccess("leases: GET /api/leases/{leaseId}", response);
        validate("leases: data", LEASE_SCHEMA, dataOf(response));
        return `lease ${leaseId.slice(0, 12)}… matches the production Lease union`;
      },
      { method: "GET", path: `/api/leases/${leaseId}` },
    );

    await runCheck(
      context,
      "leases: GET /api/leases/{leaseId}/assignments",
      "should-work",
      async () => {
        const response = await get(token, `/api/leases/${leaseId}/assignments`);
        requireSuccess(
          "leases: GET /api/leases/{leaseId}/assignments",
          response,
        );
        if (!Array.isArray(dataOf(response).assignments)) {
          throw new Error(
            `leases: no \`data.assignments\` array. Got ${truncate(response.raw)}`,
          );
        }
        return "assignments array present";
      },
      { method: "GET", path: `/api/leases/${leaseId}/assignments` },
    );
  } else {
    // Reported, not omitted. See `skipCheck`.
    const why =
      "no lease is in the Active state, so there is no {leaseId} to read. The `accounts: .../quarantine` boundary check terminates the seeded Active lease, so a second `local:verify` without a `local:reset` lands here.";
    skipCheck(context, "leases: GET /api/leases/{leaseId}", why, {
      method: "GET",
      path: "/api/leases/{leaseId}",
    });
    skipCheck(context, "leases: GET /api/leases/{leaseId}/assignments", why, {
      method: "GET",
      path: "/api/leases/{leaseId}/assignments",
    });
  }

  // --- leaseTemplates -----------------------------------------------------
  let templates: HttpResponse | undefined;
  await runCheck(
    context,
    "leaseTemplates: GET /api/leaseTemplates",
    "should-work",
    async () => {
      templates = await get(token, "/api/leaseTemplates");
      requireSuccess("leaseTemplates: GET /api/leaseTemplates", templates);
      const detail = validateList(
        "leaseTemplates: data.result[]",
        LEASE_TEMPLATE_SCHEMA,
        arrayField(templates, "result"),
      );
      // Every template, not just the first. The mutation walk picks one *by
      // `requiresApproval`*, because the two kinds of template drive different
      // code paths — the auto-approving one reaches Organizations and Identity
      // Center, which the local tier does not serve — and `result[0]` made that
      // choice depend on DynamoDB scan order.
      discovered.leaseTemplates = (
        arrayField(templates, "result") as Array<Record<string, unknown>>
      )
        .filter((template) => typeof template.uuid === "string")
        .map((template) => ({
          uuid: String(template.uuid),
          name: String(template.name ?? template.uuid),
          requiresApproval: template.requiresApproval === true,
        }));
      return detail;
    },
    { method: "GET", path: "/api/leaseTemplates" },
  );

  // Any template serves this read; the first is as good as another and this is
  // a `GET /{id}`, not a flow that branches on the template's own fields.
  if (discovered.leaseTemplates[0]) {
    const uuid = discovered.leaseTemplates[0].uuid;
    await runCheck(
      context,
      "leaseTemplates: GET /api/leaseTemplates/{id}",
      "should-work",
      async () => {
        const response = await get(token, `/api/leaseTemplates/${uuid}`);
        requireSuccess(
          "leaseTemplates: GET /api/leaseTemplates/{id}",
          response,
        );
        validate(
          "leaseTemplates: data",
          LEASE_TEMPLATE_SCHEMA,
          dataOf(response),
        );
        return `template ${uuid} matches the production schema`;
      },
      { method: "GET", path: `/api/leaseTemplates/${uuid}` },
    );
  } else {
    // The list check above already failed and said so; this is the consequence,
    // named rather than left as a hole in the count.
    skipCheck(
      context,
      "leaseTemplates: GET /api/leaseTemplates/{id}",
      "no lease template was returned by GET /api/leaseTemplates, so there is no {id} to read. The list check above reports why.",
      { method: "GET", path: "/api/leaseTemplates/{id}" },
    );
  }

  // --- blueprints ---------------------------------------------------------
  let blueprintList: HttpResponse | undefined;
  await runCheck(
    context,
    "blueprints: GET /api/blueprints",
    "should-work",
    async () => {
      blueprintList = await get(token, "/api/blueprints");
      requireSuccess("blueprints: GET /api/blueprints", blueprintList);
      const detail = validateList(
        "blueprints: data.blueprints[]",
        BLUEPRINT_LIST_ITEM_SCHEMA,
        arrayField(blueprintList, "blueprints"),
      );
      const first = arrayField(blueprintList, "blueprints")[0] as
        { blueprint?: { blueprintId?: string } } | undefined;
      if (first?.blueprint?.blueprintId) {
        discovered.blueprintId = String(first.blueprint.blueprintId);
      }
      return detail;
    },
    { method: "GET", path: "/api/blueprints" },
  );

  if (discovered.blueprintId) {
    const blueprintId = discovered.blueprintId;
    await runCheck(
      context,
      "blueprints: GET /api/blueprints/{id}",
      "should-work",
      async () => {
        const response = await get(token, `/api/blueprints/${blueprintId}`);
        requireSuccess("blueprints: GET /api/blueprints/{id}", response);
        validate("blueprints: data", BLUEPRINT_ITEM_SCHEMA, dataOf(response));
        return `blueprint ${blueprintId} matches BlueprintItemSchema`;
      },
      { method: "GET", path: `/api/blueprints/${blueprintId}` },
    );
  } else {
    skipCheck(
      context,
      "blueprints: GET /api/blueprints/{id}",
      "no blueprint was returned by GET /api/blueprints, so there is no {id} to read. The list check above reports why.",
      { method: "GET", path: "/api/blueprints/{id}" },
    );
  }

  await runCheck(
    context,
    "blueprints: GET /api/blueprints/stacksets",
    "should-work",
    async () => {
      const response = await get(token, "/api/blueprints/stacksets");
      requireSuccess("blueprints: GET /api/blueprints/stacksets", response);
      return `${arrayField(response, "result").length} stack set(s) from the blueprint table`;
    },
    { method: "GET", path: "/api/blueprints/stacksets" },
  );

  // --- accounts -----------------------------------------------------------
  await runCheck(
    context,
    "accounts: GET /api/accounts",
    "should-work",
    async () => {
      const response = await get(token, "/api/accounts");
      requireSuccess("accounts: GET /api/accounts", response);
      return validateList(
        "accounts: data.result[]",
        SANDBOX_ACCOUNT_SCHEMA,
        arrayField(response, "result"),
      );
    },
    { method: "GET", path: "/api/accounts" },
  );

  await runCheck(
    context,
    "accounts: GET /api/accounts/{id}",
    "should-work",
    async () => {
      const response = await get(token, "/api/accounts/111111111111");
      requireSuccess("accounts: GET /api/accounts/{id}", response);
      validate("accounts: data", SANDBOX_ACCOUNT_SCHEMA, dataOf(response));
      return "account 111111111111 matches the shared account schemas";
    },
    { method: "GET", path: "/api/accounts/111111111111" },
  );

  await runCheck(
    context,
    "accounts: GET /api/accounts/{id}/cleanup-reports",
    "should-work",
    async () => {
      const response = await get(
        token,
        "/api/accounts/111111111111/cleanup-reports",
      );
      requireSuccess(
        "accounts: GET /api/accounts/{id}/cleanup-reports",
        response,
      );
      return `${arrayField(response, "result").length} cleanup report(s); the cleanupReport table is readable`;
    },
    { method: "GET", path: "/api/accounts/111111111111/cleanup-reports" },
  );

  // --- configurations -----------------------------------------------------
  await runCheck(
    context,
    "configurations: GET /api/configurations",
    "should-work",
    async () => {
      const response = await get(token, "/api/configurations");
      requireSuccess("configurations: GET /api/configurations", response);
      return "the aggregate configuration read succeeded";
    },
    { method: "GET", path: "/api/configurations" },
  );

  for (const section of Object.keys(CONFIG_SECTION_SCHEMAS) as Array<
    keyof typeof CONFIG_SECTION_SCHEMAS
  >) {
    await runCheck(
      context,
      `configurations: GET /api/configurations/${section}`,
      "should-work",
      async () => {
        const response = await get(token, `/api/configurations/${section}`);
        requireSuccess(
          `configurations: GET /api/configurations/${section}`,
          response,
        );
        validate(
          `configurations: data (${section})`,
          CONFIG_SECTION_SCHEMAS[section],
          dataOf(response),
        );
        return `${section} matches ConfigSchemas.${section}`;
      },
      { method: "GET", path: `/api/configurations/${section}` },
    );
  }

  // --- principals ---------------------------------------------------------
  await runCheck(
    context,
    "principals: GET /api/principals/search?q=example.local",
    "should-work",
    async () => {
      const response = await get(
        token,
        "/api/principals/search?q=example.local",
      );
      requireSuccess("principals: GET /api/principals/search", response);
      const detail = validateList(
        "principals: data.principals[]",
        PRINCIPAL_SCHEMA,
        arrayField(response, "principals"),
      );
      const principals = arrayField(response, "principals") as Array<{
        principalId?: string;
      }>;
      if (
        !principals.some((p) => p.principalId === SEEDED_ADMIN_PRINCIPAL_ID)
      ) {
        throw new Error(
          `principals: the signed-in identity is ${SEEDED_ADMIN_PRINCIPAL_ID} but the typeahead did not return it, so the assignment picker could never offer the current user`,
        );
      }
      return detail;
    },
    { method: "GET", path: "/api/principals/search?q=example.local" },
  );
}

// ---------------------------------------------------------------------------
// Mutations
// ---------------------------------------------------------------------------

/**
 * One authenticated write per domain the design says supports CRUD, each a
 * round trip: write, read back, confirm the read shows the write. A write that
 * returns 200 but does not reach DynamoDB is exactly the failure a status-only
 * check would miss, and it is the one that makes a local profile feel haunted.
 *
 * Principals has no write in the contract at all (`SearchPrincipals` is its only
 * operation), so its read walk above is the whole domain.
 */
async function walkMutations(
  context: WalkContext,
  discovered: {
    leaseId?: string;
    leaseTemplates: DiscoveredLeaseTemplate[];
    blueprintId?: string;
  },
): Promise<void> {
  const { token } = context;
  const stamp = Date.now().toString(36);

  // --- blueprints: update -------------------------------------------------
  //
  // *Create* is deliberately not here. `blueprintDeploymentService.registerBlueprint`
  // calls `DescribeStackSet` before it writes anything, so creating a blueprint
  // needs CloudFormation StackSets even though the write itself is DynamoDB. The
  // design's table lists blueprints create as working; the handler says
  // otherwise, so it is checked as a boundary in `walkBoundaries` and the
  // mutation walk uses *update*, which is the write the design's claim reduces
  // to. `UpdateBlueprintRequestContent` carries no `regions`/`stackSetId` — those
  // belong to the StackSet item, not the blueprint — and the handler rejects the
  // extra keys, so the body is exactly the contract's members.
  const blueprintName = `verify-blueprint-${stamp}`;
  if (discovered.blueprintId) {
    const blueprintId = discovered.blueprintId;
    await runCheck(
      context,
      "blueprints: PUT /api/blueprints/{id} (update)",
      "should-work",
      async () => {
        const before = await get(token, `/api/blueprints/${blueprintId}`);
        requireSuccess("blueprints: GET before PUT", before);
        const existing = (dataMaybe(before).blueprint ??
          dataMaybe(before)) as Record<string, unknown>;
        const updatedName = `${blueprintName}-updated`;
        const put = (name: string) =>
          send(token, "PUT", `/api/blueprints/${blueprintId}`, {
            name,
            tags: { source: "local-verify" },
            deploymentTimeoutMinutes: 30,
            regionConcurrencyType: "SEQUENTIAL",
          });

        requireSuccess(
          "blueprints: PUT /api/blueprints/{id}",
          await put(updatedName),
        );
        const readBack = await get(token, `/api/blueprints/${blueprintId}`);
        requireSuccess("blueprints: GET after update", readBack);
        const blueprint = (dataMaybe(readBack).blueprint ??
          dataMaybe(readBack)) as Record<string, unknown>;
        if (blueprint.name !== updatedName) {
          throw new Error(
            `blueprints: the update returned 200 but the read shows name=${JSON.stringify(blueprint.name)}, not ${updatedName}. The write did not reach DynamoDB.`,
          );
        }
        // Put it back, so a `local:verify` run leaves the seed as it found it.
        requireSuccess(
          "blueprints: PUT restore",
          await put(String(existing.name)),
        );
        return `renamed ${String(existing.name)} -> ${updatedName} and back, confirmed on read`;
      },
      { method: "PUT", path: `/api/blueprints/${blueprintId}` },
    );
  }

  // --- leaseTemplates: create, delete -------------------------------------
  let createdTemplateUuid: string | undefined;
  const templateName = `verify-template-${stamp}`;
  await runCheck(
    context,
    "leaseTemplates: POST /api/leaseTemplates (create)",
    "should-work",
    async () => {
      const response = await send(token, "POST", "/api/leaseTemplates", {
        name: templateName,
        requiresApproval: false,
        maxSpend: 5,
        leaseDurationInHours: 4,
        budgetThresholds: [{ dollarsSpent: 4, action: "ALERT" }],
        durationThresholds: [{ hoursRemaining: 1, action: "ALERT" }],
        allowOwnerToShareLease: false,
      });
      requireSuccess(
        "leaseTemplates: POST /api/leaseTemplates",
        response,
        [200, 201],
      );
      const data = dataOf(response);
      const template = (data.leaseTemplate ?? data) as Record<string, unknown>;
      createdTemplateUuid =
        (template.uuid as string | undefined) ??
        (data.uuid as string | undefined);
      if (!createdTemplateUuid) {
        throw new Error(
          `leaseTemplates: no uuid in the create response. Got ${truncate(response.raw)}`,
        );
      }
      return `created ${createdTemplateUuid} (${templateName})`;
    },
    { method: "POST", path: "/api/leaseTemplates" },
  );

  if (createdTemplateUuid) {
    const uuid = createdTemplateUuid;
    await runCheck(
      context,
      "leaseTemplates: GET the template just created",
      "should-work",
      async () => {
        const response = await get(token, `/api/leaseTemplates/${uuid}`);
        requireSuccess("leaseTemplates: GET after create", response);
        validate(
          "leaseTemplates: data",
          LEASE_TEMPLATE_SCHEMA,
          dataOf(response),
        );
        if (dataOf(response).name !== templateName) {
          throw new Error(
            `leaseTemplates: the read shows name=${JSON.stringify(dataOf(response).name)}, not ${templateName}. The write did not reach DynamoDB.`,
          );
        }
        return `read back ${templateName} and it matches the production schema`;
      },
      { method: "GET", path: `/api/leaseTemplates/${uuid}` },
    );

    await runCheck(
      context,
      "leaseTemplates: DELETE /api/leaseTemplates/{id}",
      "should-work",
      async () => {
        const response = await send(
          token,
          "DELETE",
          `/api/leaseTemplates/${uuid}`,
        );
        requireSuccess("leaseTemplates: DELETE", response);
        return "deleted";
      },
      { method: "DELETE", path: `/api/leaseTemplates/${uuid}` },
    );
  }

  // --- leases: request, then review, then patch ----------------------------
  //
  // Two things are separated here that the walk previously ran together, and
  // the separation is the fix rather than a convenience.
  //
  // **The template is chosen by `requiresApproval`, not by list position.**
  // The seed ships one of each, and the old code took `result[0]` — which is
  // whichever the DynamoDB scan happened to return first, so the check silently
  // depended on scan order. On a clean profile that was the *auto-approving*
  // template, whose flow calls `IdcService.getUserFromEmail` and therefore
  // `identitystore: GetUserId`/`DescribeUser` — a service the LocalStack
  // Community (Hobby) tier does not serve, so the check failed at a boundary
  // rather than at anything in `local/`. The approval-*required* template's
  // request path is DynamoDB plus EventBridge, both of which LocalStack serves,
  // and it returns 201. That is the flow this check is for; the auto-approving
  // one is asserted as a boundary in `walkBoundaries`, which is where the
  // design's "Lease request, approval — No" row actually belongs.
  if (discovered.leaseTemplates.length) {
    const templates = discovered.leaseTemplates;
    const requiresApproval = templates.find(
      (template) => template.requiresApproval,
    );
    const autoApproves = templates.find(
      (template) => !template.requiresApproval,
    );
    if (!requiresApproval) {
      await runCheck(
        context,
        "leases: POST /api/leases (request)",
        "should-work",
        async () => {
          throw new Error(
            `no seeded lease template has \`requiresApproval: true\` (found ${templates.map((template) => `${template.name}=${String(template.requiresApproval)}`).join(", ")}), so the request path that does not need Identity Center cannot be exercised`,
          );
        },
        { method: "POST", path: "/api/leases" },
      );
      skipCheck(
        context,
        "leases: POST /api/leases/{leaseId}/review (deny, cleanup)",
        "no lease was created, so there is nothing to deny. The request check above reports why.",
        { method: "POST", path: "/api/leases/{leaseId}/review" },
      );
    } else {
      const templateUuid = requiresApproval.uuid;
      let requestedLeaseId: string | undefined;
      await runCheck(
        context,
        "leases: POST /api/leases (request)",
        "should-work",
        async () => {
          const response = await send(token, "POST", "/api/leases", {
            leaseTemplateUuid: templateUuid,
            comments: `requested by local:verify at ${stamp}`,
          });
          requireSuccess("leases: POST /api/leases", response, [200, 201]);
          const data = dataOf(response);
          const lease = (data.lease ?? data) as Record<string, unknown>;
          validate("leases: request response", LEASE_SCHEMA, lease);
          // The request path must leave the lease *pending*, not approved.
          // Asserted because an auto-approved lease means the request took the
          // `approveLease` branch, which reaches Organizations and Identity
          // Center — so a profile where that succeeded would be reporting a
          // boundary leak as a pass.
          if (lease.status !== "PendingApproval") {
            throw new Error(
              `leases: the request came back with status ${JSON.stringify(lease.status)}, not PendingApproval, so it went through approveLease rather than the approval queue`,
            );
          }
          const uuid = String(lease.uuid ?? "");
          const leases = await get(token, "/api/leases");
          requireSuccess("leases: GET after request", leases);
          const found = (
            arrayField(leases, "result") as Array<Record<string, unknown>>
          ).find((entry) => entry.uuid === uuid);
          if (!found) {
            throw new Error(
              `leases: POST returned 200 for ${uuid} but the list does not contain it. The write did not reach DynamoDB.`,
            );
          }
          requestedLeaseId = found.leaseId as string | undefined;
          return `created ${uuid} as PendingApproval from ${requiresApproval.name} and confirmed it in GET /api/leases`;
        },
        { method: "POST", path: "/api/leases" },
      );

      // **Deny the lease the walk just made.** Not cosmetic: `requestLease`
      // counts leases in `["Active", "PendingApproval", "Frozen",
      // "Provisioning"]` against `globalConfig.leases.maxLeasesPerUser` (3 by
      // default), and the seed already ships one PendingApproval and one Active.
      // Without this step a second `local:verify` on the same profile 409s with
      // "maximum number of active/pending leases allowed" — the walk would only
      // ever pass once per `local:up`, which is the kind of thing that reads as
      // a flaky profile rather than a leak in the walk. `Deny` is pure
      // DynamoDB plus an EventBridge event, and it moves the lease to
      // `ApprovalDenied`, which is outside the counted set.
      if (requestedLeaseId) {
        const leaseId = requestedLeaseId;
        await runCheck(
          context,
          "leases: POST /api/leases/{leaseId}/review (deny, cleanup)",
          "should-work",
          async () => {
            const response = await send(
              token,
              "POST",
              `/api/leases/${leaseId}/review`,
              { action: "Deny" },
            );
            requireSuccess("leases: review Deny", response);
            const leases = await get(token, "/api/leases");
            requireSuccess("leases: GET after review", leases);
            const found = (
              arrayField(leases, "result") as Array<Record<string, unknown>>
            ).find((entry) => entry.leaseId === leaseId);
            if (found?.status !== "ApprovalDenied") {
              throw new Error(
                `leases: review Deny returned 200 but the lease reads back as ${JSON.stringify(found?.status)}, not ApprovalDenied. The write did not reach DynamoDB.`,
              );
            }
            return "denied, and confirmed ApprovalDenied on read; the lease slot is released so the next run can request again";
          },
          { method: "POST", path: `/api/leases/${leaseId}/review` },
        );
      } else {
        // The request check above already reported the failure; this is its
        // consequence. Reported so the run does not silently shrink.
        skipCheck(
          context,
          "leases: POST /api/leases/{leaseId}/review (deny, cleanup)",
          "no lease was created, so there is nothing to deny. The request check above reports why.",
          { method: "POST", path: "/api/leases/{leaseId}/review" },
        );
      }
    }

    // Carried out of the branch above so the boundary list can name the
    // auto-approving template the walk deliberately did *not* use.
    context.autoApprovingTemplate = autoApproves;
  } else {
    // No templates at all. The list check above reports the empty list; these
    // are its consequences, named rather than dropped from the count.
    for (const [name, path] of [
      ["leases: POST /api/leases (request)", "/api/leases"],
      [
        "leases: POST /api/leases/{leaseId}/review (deny, cleanup)",
        "/api/leases/{leaseId}/review",
      ],
    ] as const) {
      skipCheck(
        context,
        name,
        "no lease template was returned by GET /api/leaseTemplates, so there is nothing to request from. The list check above reports why.",
        { method: "POST", path },
      );
    }
  }

  // The PATCH targets the seeded **Active** lease, not the one the walk just
  // created. Two reasons, both of which were failures:
  //
  //   - `updateLease` calls `isMonitoredLease(existingLease)` and 400s with
  //     "Can only update an active lease" on anything else, so patching the
  //     freshly-requested PendingApproval lease could never have worked.
  //   - `UpdateLeaseRequestContent` does not model `comments`. The retained Zod
  //     supplement is `.strict()`, so the old body — which sent `comments` — was
  //     rejected with `400 Unrecognized key: "comments"` before the handler ran.
  //     The contract's own members are `maxSpend`, `budgetThresholds`,
  //     `expirationDate`, `durationThresholds`, `costReportGroup`, and
  //     `allowOwnerToShareLease`; only `maxSpend` is sent.
  if (discovered.leaseId) {
    const leaseId = discovered.leaseId;
    await runCheck(
      context,
      "leases: PATCH /api/leases/{leaseId} (update)",
      "should-work",
      async () => {
        const before = await get(token, `/api/leases/${leaseId}`);
        requireSuccess("leases: GET before PATCH", before);
        const existing = dataMaybe(before) as Record<string, unknown>;
        const originalSpend = existing.maxSpend;
        const patched = await send(token, "PATCH", `/api/leases/${leaseId}`, {
          maxSpend: 9,
        });
        requireSuccess("leases: PATCH /api/leases/{leaseId}", patched);
        const data = dataOf(patched);
        const lease = (data.lease ?? data) as Record<string, unknown>;
        if (lease.maxSpend !== 9) {
          throw new Error(
            `leases: the patch returned 200 but maxSpend is ${JSON.stringify(lease.maxSpend)}, not 9`,
          );
        }
        // Read it back rather than trusting the response body: a write that
        // returns 200 and does not reach DynamoDB is exactly what this check
        // exists to catch, and the response echo would not show it.
        const readBack = await get(token, `/api/leases/${leaseId}`);
        requireSuccess("leases: GET after PATCH", readBack);
        if (dataMaybe(readBack).maxSpend !== 9) {
          throw new Error(
            `leases: the patch returned 200 but the read shows maxSpend=${JSON.stringify(dataMaybe(readBack).maxSpend)}, not 9. The write did not reach DynamoDB.`,
          );
        }
        // Put it back, so a `local:verify` run leaves the seed as it found it.
        if (originalSpend !== undefined) {
          requireSuccess(
            "leases: PATCH restore",
            await send(token, "PATCH", `/api/leases/${leaseId}`, {
              maxSpend: originalSpend,
            }),
          );
        }
        return `changed maxSpend ${String(originalSpend)} -> 9 -> ${String(originalSpend)} on the seeded Active lease, confirmed on read`;
      },
      { method: "PATCH", path: `/api/leases/${leaseId}` },
    );
  } else {
    skipCheck(
      context,
      "leases: PATCH /api/leases/{leaseId} (update)",
      'no lease is in the Active state, so there is nothing to update — `updateLease` 400s with "Can only update an active lease" for every other status. The `accounts: .../quarantine` boundary check terminates the seeded Active lease, so a second `local:verify` without a `local:reset` lands here.',
      { method: "PATCH", path: "/api/leases/{leaseId}" },
    );
  }

  // --- configurations: round-trip a section -------------------------------
  await runCheck(
    context,
    "configurations: PUT /api/configurations/leases (round trip)",
    "should-work",
    async () => {
      const before = await get(token, "/api/configurations/leases");
      requireSuccess("configurations: GET before PUT", before);
      const current = dataOf(before);
      // What a settings form sends: the section's own fields plus the
      // optimistic-concurrency token, and without the read-only audit envelope.
      // `ConfigPutBodySchemas` is strict and models `meta.lastEditTime`
      // explicitly, so this is the same shape the frontend builds — and omitting
      // the token is not an option, because the handler then rejects the write
      // with "Configuration was modified by another administrator".
      const {
        lastSavedBy: _lastSavedBy,
        meta: readMeta,
        ...fields
      } = current as Record<string, unknown>;
      const lastEditTime = (readMeta as { lastEditTime?: string } | undefined)
        ?.lastEditTime;
      if (!lastEditTime) {
        throw new Error(
          `configurations: the read carries no \`meta.lastEditTime\`, which is the optimistic-concurrency token the PUT requires. Got ${truncate(before.raw)}`,
        );
      }
      const body = { ...fields, meta: { lastEditTime } };
      const response = await send(
        token,
        "PUT",
        "/api/configurations/leases",
        body,
      );
      requireSuccess(
        "configurations: PUT /api/configurations/leases",
        response,
      );
      const after = await get(token, "/api/configurations/leases");
      requireSuccess("configurations: GET after PUT", after);
      const afterData = dataOf(after);
      validate(
        "configurations: data after PUT",
        CONFIG_SECTION_SCHEMAS.leases,
        afterData,
      );
      // `fields`, not `body`: the concurrency token is echoed back with a fresh
      // `lastEditTime`, so comparing it would report a drift that is the write
      // working correctly.
      const drift = Object.keys(fields).filter(
        (key) => afterData[key] !== fields[key],
      );
      if (drift.length) {
        throw new Error(
          `configurations: the PUT returned 200 but the read differs on ${drift.join(", ")}. The write did not reach DynamoDB.`,
        );
      }
      return `wrote and re-read ${Object.keys(fields).length} fields unchanged`;
    },
    { method: "PUT", path: "/api/configurations/leases" },
  );
}

// ---------------------------------------------------------------------------
// Boundaries: the flows that must fail at the real unsupported AWS call
// ---------------------------------------------------------------------------

interface Boundary {
  name: string;
  method: string;
  path: string;
  body?: unknown;
  /**
   * A service name, so the failure is attributed rather than merely counted.
   * Reported when the handler's own text names it.
   */
  service: string;
  /**
   * When set, the business precondition the seeded fixtures do not satisfy, and
   * the 409 the handler returns before it ever reaches the AWS call. Such a flow
   * is still `should-fail` — the unsupported call was not served — but it is
   * *not* evidence that the call fails at the service, and conflating the two
   * would overstate what has been verified. Checked and reported separately.
   */
  precondition?: string;
}

/**
 * The design's "What works locally, and what does not" table, as assertions.
 *
 * Every one of these must fail *at the AWS call* — in the handler, naming the
 * service — and none may be satisfied by the edge's 501. Two of the entries are
 * worth reading twice, because they are places the design's table is optimistic
 * and the handlers are not:
 *
 *   - `POST /blueprints` is listed as working CRUD, but
 *     `blueprintDeploymentService.registerBlueprint` calls `DescribeStackSet`
 *     before it writes anything, so creation needs CloudFormation StackSets.
 *   - `retryCleanup` and `skipCooldown` sit behind account-state preconditions
 *     the fixtures cannot satisfy, so they 409 long before Organizations.
 *
 * `leasesAutoApproval` is the fourth: the design's table lists "Lease request,
 * approval — the IDC config SSM parameter — No". The parameter now exists, and
 * the *request* half of that row works — `POST /leases` against a template with
 * `requiresApproval: true` returns 201 and is asserted as a working mutation.
 * The *approval* half does not, and for a different reason than the design
 * gives: `approveLease` runs `IdcService.getUserFromEmail`, which calls
 * `identitystore: GetUserId` and `DescribeUser`. That is not in the LocalStack
 * Community (Hobby) tier, so the failure is a licence boundary rather than a
 * missing parameter. Checking it as a boundary is what makes that distinction
 * visible instead of leaving it to be rediscovered as a mysterious 500.
 */
function boundaryChecks(leasesAutoApproval?: {
  uuid: string;
  name: string;
}): Boundary[] {
  const active = "/api/accounts/111111111111";
  return [
    {
      name: "accounts: GET /api/accounts/unregistered reaches Organizations",
      method: "GET",
      path: "/api/accounts/unregistered",
      service: "organizations",
    },
    {
      name: "accounts: POST /api/accounts reaches Organizations",
      method: "POST",
      path: "/api/accounts",
      body: { awsAccountId: "999999999999" },
      service: "organizations",
    },
    {
      name: "accounts: POST /api/accounts/{id}/quarantine reaches Organizations",
      method: "POST",
      path: `${active}/quarantine`,
      service: "organizations",
    },
    {
      name: "accounts: POST /api/accounts/{id}/eject reaches Organizations",
      method: "POST",
      path: `${active}/eject`,
      service: "organizations",
    },
    {
      name: "accounts: POST /api/accounts/{id}/retryCleanup reaches Organizations",
      method: "POST",
      path: `${active}/retryCleanup`,
      service: "organizations",
      // 111111111111 is Active, and the handler requires Quarantine or CleanUp.
      precondition: "the seeded Active account is not in Quarantine or CleanUp",
    },
    {
      name: "accounts: POST /api/accounts/{id}/skipCooldown reaches Organizations",
      method: "POST",
      path: `${active}/skipCooldown`,
      service: "organizations",
      // Requires an active cooldown, which no seeded account has.
      precondition: "no seeded account is in an active cleanup cooldown",
    },
    {
      name: "blueprints: POST /api/blueprints reaches CloudFormation StackSets",
      method: "POST",
      path: "/api/blueprints",
      body: {
        name: "verify-boundary-blueprint",
        regions: ["us-east-1"],
        stackSetId: "verify-boundary-stackset",
      },
      // `registerBlueprint` calls DescribeStackSet before writing, so creating a
      // blueprint needs StackSets even though the write itself is DynamoDB.
      service: "cloudformation",
    },
    // Conditional on the seed: a profile whose templates are all
    // `requiresApproval: true` has no auto-approving path to check, and a
    // boundary check that quietly disappears is worse than one that is absent.
    // The caller reports that case rather than it passing vacuously.
    ...(leasesAutoApproval
      ? [
          {
            name: `leases: POST /api/leases on an auto-approving template (${leasesAutoApproval.name}) reaches Identity Center`,
            method: "POST",
            path: "/api/leases",
            body: {
              leaseTemplateUuid: leasesAutoApproval.uuid,
              comments: "requested by local:verify boundary check",
            },
            // `approveLease` resolves the assignee with
            // `IdcService.getUserFromEmail` -> `identitystore: GetUserId`, which
            // the Community tier does not serve.
            service: "identitystore",
          },
        ]
      : []),
  ];
}

async function walkBoundaries(context: WalkContext): Promise<void> {
  for (const boundary of boundaryChecks(context.autoApprovingTemplate)) {
    await runCheck(
      context,
      boundary.name,
      "should-fail",
      async () => {
        const response = await send(
          context.token,
          boundary.method,
          boundary.path,
          boundary.body,
        );
        const evidence = inspectBoundary(response);

        // The three ways a boundary can be *broken* are all returns: the flow
        // succeeded, the edge refused it, or it failed but said nothing. Throwing
        // means the boundary held, and `runCheck` records a `should-fail` that did
        // not pass as a failure. A bare gateway 5xx is a fourth case, and the
        // only one worth retrying, so it gets its own error type.
        if (response.status < 400) {
          return `LEAKED: answered ${response.status} ${truncate(response.raw)}. LocalStack Hobby is not supposed to serve this.`;
        }
        if (evidence.fromEdge) {
          return `LEAKED: refused by the local edge with 501 "Not available in the local profile". The design requires this to fail at the real ${boundary.service} call so the developer sees which service is missing.`;
        }
        if (evidence.fromGateway) {
          throw new BoundaryUndetermined(
            `could not determine: every attempt got a bare ${response.status} ${truncate(response.raw)} with no JSend envelope, so the failure is API Gateway's or LocalStack's rather than the handler's. Read \`npm run local:logs\` for the Lambda's own log.`,
          );
        }
        if (!evidence.text) {
          return `LEAKED: failed with ${response.status} but said nothing, so there is no signal about which service was missing.`;
        }
        throw new Error(
          `failed at the real call with ${response.status}: ${evidence.text}` +
            (response.status === 409 && boundary.precondition
              ? ` (a 409 precondition, not the ${boundary.service} call: ${boundary.precondition})`
              : evidence.namesService
                ? ""
                : ` (the body does not name ${boundary.service}; the application returns a generic 500 by design, and the Lambda log is where the service appears)`),
        );
      },
      { method: boundary.method, path: boundary.path },
    );
  }
}

// ---------------------------------------------------------------------------
// The walk
// ---------------------------------------------------------------------------

/** The lease template facts the walk branches on, taken from the seeded list. */
export interface DiscoveredLeaseTemplate {
  uuid: string;
  name: string;
  requiresApproval: boolean;
}

export interface WalkOutcome {
  results: VerifyResult[];
  discovered: {
    /** The seeded Active lease, captured by the read walk. */
    leaseId?: string;
    /**
     * Every seeded template, so the mutation walk can pick by
     * `requiresApproval` rather than by list position.
     */
    leaseTemplates: DiscoveredLeaseTemplate[];
    blueprintId?: string;
  };
}

export async function walkApi(
  token: string,
  options: VerifyOptions,
): Promise<WalkOutcome> {
  const context: WalkContext = {
    token,
    options: {
      edgeUrl: options.edgeUrl ?? "",
      maxAttempts: options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS,
      retryDelayMs: options.retryDelayMs ?? 750,
    },
    results: [],
    /**
     * Set by the mutation walk, read by the boundary walk. Carried on the
     * context rather than recomputed so there is one place that decides which
     * template drives the request mutation and which drives the auto-approval
     * boundary — two decisions that have to disagree, and would not if each were
     * re-derived.
     */
    autoApprovingTemplate: undefined,
  };
  const discovered: WalkOutcome["discovered"] = { leaseTemplates: [] };

  await walkReads(context, discovered);
  await walkMutations(context, discovered);
  await walkBoundaries(context);

  return { results: context.results, discovered };
}

export { LOCAL_IDC_PRINCIPAL_ID };
