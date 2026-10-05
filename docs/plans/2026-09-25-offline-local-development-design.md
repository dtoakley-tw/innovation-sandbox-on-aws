# Offline Local Development Profile — Design

- **Date:** 2026-09-25
- **Status:** Approved in brainstorming; pending implementation plan
- **Scope:** Milestone 1 — all six API domains, read and CRUD paths
- **Target runtime:** LocalStack (Hobby tier, free/non-commercial) + local-only tooling

## Summary

Add a local development profile that runs the Innovation Sandbox UI and API with no
AWS account, no AWS credentials, and no outbound calls to AWS. The profile runs the
real Lambda handlers, the real generated API contract, and the real DynamoDB data
model against LocalStack, and substitutes local-only tooling for the two things no
emulator reproduces: Cognito/IAM Identity Center authentication and the CloudFront
edge.

All six API domains are served. The unsupported AWS services are reached only from
specific deep flows — account lifecycle, blueprint deployment, permission-granting
assignment, cost reporting, and cleanup — so those fail at the real service call
while every read and CRUD path runs for real. See "What works locally, and what does
not".

The design is constrained above all by two requirements from the maintainer:

1. The patch against upstream AWS code must stay small, so pulling upstream updates
   is painless.
2. Developers must never maintain two versions of a change. Local and production
   must share one code path, selected by configuration.

Both are satisfied by a change surface of **three upstream files and roughly fifteen
lines**, with everything else living in new files under `local/`.

## Goals

- `npm run local:up` produces a working local environment with no AWS dependency.
- A developer can exercise all six API domains in a browser against real backend
  code, limited only by the AWS services LocalStack Hobby does not emulate.
- Production behavior with the patch applied is byte-for-byte identical to upstream.
- Pulling an upstream release is a rebase with at most three trivial conflict hunks.
- The profile can later be upgraded to LocalStack Base without redesign.

## Non-goals (Milestone 1)

- Blueprint deployment to sandbox accounts.
- Account provisioning, lifecycle management, Organizations moves, and account
  cleanup.
- Lease assignment completion, including the IAM Identity Center permission grants
  that accompany it.
- Real cost or usage data.
- Faithful CloudFront/WAF behavior, including CloudFront Functions.
- Gateway-level SigV4 enforcement.
- X-Ray tracing.
- Replacing the existing MSW-based unit tests, which remain the fast feedback loop
  and the home for edge-case states such as empty, error, and permission-denied
  responses.

## What works locally, and what does not

The unsupported services are reached only from specific deep flows, not from the
read and CRUD paths. This is the single most important finding shaping the scope,
so it is recorded explicitly.

Verified against the handlers:

| Surface                                            | Local dependency                                           | Works locally |
| -------------------------------------------------- | ---------------------------------------------------------- | ------------- |
| Accounts get, list                                 | `sandboxAccountStore` (DynamoDB)                           | Yes           |
| Cleanup report read                                | `cleanupReportStore` (DynamoDB)                            | Yes           |
| Blueprints get, list, create, update               | `blueprintStore` (DynamoDB)                                | Yes           |
| Leases, lease templates, configuration, principals | DynamoDB                                                   | Yes           |
| Account provisioning, deprovisioning, drift        | `orgsService`, `organizationsTaggingService`, `idcService` | No            |
| Blueprint deployment                               | `blueprintDeploymentService`, StackSets                    | No            |
| Lease assignment completion                        | `ssoAdminClient` permission grants                         | No            |
| Cost reporting                                     | `costExplorerClient`                                       | No            |
| Account cleanup                                    | CodeBuild, ECR, Organizations                              | No            |

Consequences:

- All six API domains are provisioned with real Lambdas and seeded tables.
- Failing flows fail at the actual unsupported service call, which is a far more
  useful signal than a blanket refusal. The developer sees a real error from a real
  code path rather than a synthetic "not available locally".
- A few write paths touch DynamoDB before calling the unsupported service, so a
  failed local write can leave partial state. `local:reset` is the remedy. This is
  acceptable for development and is not worth an app change.
- The local edge still returns `501 Not Implemented Locally` for any path that was
  genuinely not provisioned, as a fallback rather than as the primary mechanism.

## Why there is no browser MSW layer

The repository already uses MSW, and it was considered as a way to cover the
domains LocalStack Hobby cannot serve. It was deliberately rejected for this
milestone.

1. **It creates a mixed real/fake environment.** LocalStack-backed domains would
   hit real Lambdas and real DynamoDB while MSW-backed domains return
   browser-generated data. An account shown by MSW would not exist in the local
   `sandboxAccountStore`, so any cross-domain view becomes fiction.
2. **It would require a second fixture set.** The existing handlers use
   `generateSchemaData`, which produces random values per call. That is correct for
   tests and wrong for interactive development, where identifiers must survive a
   page reload. Making them stable means a second curated fixture set living
   alongside the seed, and two sets that must agree.
3. **It hides backend breakage.** A service worker intercepts before the request
   leaves the browser, so the entire server path goes untested for that domain.
   Running LocalStack is precisely to exercise the real contract.
4. **It would add a third upstream hunk.** The worker must register before
   application code runs, which means a Vite plugin using `transformIndexHtml` or an
   edit to `index.html`.
5. **It is not where the gap is.** The accounts and blueprints read paths are
   DynamoDB-backed and work for real. The states MSW is best at are already covered
   by 3,825 passing tests, which is the correct home for them.

If interactive access to error and empty states later proves painful, the
disciplined version is a strictly opt-in Vite dev plugin that reuses the existing
handlers, backed by the same fixture modules the seed uses, gated on an environment
variable so production never loads it. That is a deliberate follow-up decision, to
be made after measuring the six-domain path, not part of this milestone.

## Constraints

| Constraint                                  | Consequence                                                                                                                   |
| ------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| LocalStack Hobby is free but non-commercial | No Cognito, CloudFront, WAF, Organizations, Identity Center, CodeBuild, ECR, AppConfig, Cost Explorer, RAM, CloudTrail, X-Ray |
| Upstream updates are pulled regularly       | Diff against `source/` must stay minimal and additive                                                                         |
| No duplicated logic between local and prod  | All differences must be configuration or deployment artifacts, never branches in domain logic                                 |
| No AWS account or network                   | Every AWS call must resolve to LocalStack or fail locally                                                                     |

## The one-path rule

This is the organizing principle of the design. Every rule below exists to enforce it.

1. **One code path.** Any local-vs-production difference is a configuration value or a
   deployment artifact. There is no `if (isLocal)` in domain, data, or API logic.
2. **Production default is unchanged.** Every new setting is optional and inert unless
   set. With the patch applied and no local configuration, behavior matches upstream.
3. **New files over edited lines.** Conflicts arise where we add a line, not where we
   add a path.
4. **No restated definitions.** Local infrastructure and seed data import the
   production CDK constructs and Zod schemas rather than duplicating them, so an
   upstream change to a table or config field is picked up automatically.

## Architecture

```
┌────────────────────────────────────────────────────────────────┐
│ Browser — unmodified ISB frontend (Vite dev server, :5173)      │
│   • loads /config.json from the local edge                       │
│   • Amplify session supplied by local token/credential providers │
│   • generated Smithy client signs and sets x-isb-identity        │
└───────────────────────────┬────────────────────────────────────┘
                            │ /api/*  and  /config.json
                            ▼
┌────────────────────────────────────────────────────────────────┐
│ Local edge  (local/edge — one small Node service)               │
│   • serves /config.json generated for the local profile         │
│   • strips /api, prepends stage, forwards to API Gateway        │
│   • 501 fallback for genuinely unprovisioned paths               │
│   • mints local ID tokens; publishes /.well-known/jwks.json      │
└──────┬─────────────────────────────────────┬───────────────────┘
       │                                     │
       │ invoke                               │ fetch JWKS (cold start)
       ▼                                     │
┌──────────────────────────────┐             │
│ LocalStack (Docker)          │◀────────────┘
│   API Gateway REST           │
│   Lambda  (real handlers)    │
│   DynamoDB  SQS  EventBridge │
│   Step Functions  SSM  KMS   │
│   CloudFormation  STS        │
└──────────────────────────────┘
```

All AWS SDK clients inside the Lambdas resolve to `http://localstack:4566` through
`AWS_ENDPOINT_URL` and the standard `AWS_*` environment variables. No code reads
those variables; the AWS SDK does.

## Change surface against upstream

Three files, one small change each. This is the complete list.

| File                                                               | Change                                                                  | Size      |
| ------------------------------------------------------------------ | ----------------------------------------------------------------------- | --------- |
| `source/common/lambda/environments/base-api-lambda-environment.ts` | Declare optional `ISB_LOCAL_JWKS_URI`                                   | 1 line    |
| `source/common/lambda/auth/identity-token-verifier.ts`             | Inject a local JWKS when `ISB_LOCAL_JWKS_URI` is set                    | ~10 lines |
| `source/frontend/src/helpers/cognito-config.ts`                    | Pass Amplify `libraryOptions` when `VITE_LOCAL_SESSION_ENDPOINT` is set | ~3 lines  |

One trivial root change: add `"local"` to the `workspaces` array in the root
`package.json` so the local tooling can import `@amzn/innovation-sandbox-*`
packages and share their path aliases.

New files, none of which collide with upstream paths:

```
local/
  compose.yaml               LocalStack + local edge services
  edge/                      the local edge and identity service
  infrastructure/            reduced CDK app reusing upstream constructs
  seed/                      schema-derived fixture seeding
  config/                    local config.json template
  README.md                  developer workflow
```

New files inside upstream directories, chosen over a cross-package dependency
because they avoid editing a second upstream file:

```
source/frontend/src/helpers/local/amplify-local-session.ts
```

## Change 1 — backend key source (two files)

`source/common/lambda/auth/identity-token-verifier.ts` builds a
`CognitoJwtVerifier` from the user pool ID, which hardcodes the JWKS URI to
`https://cognito-idp.<region>.amazonaws.com/<pool>/.well-known/jwks.json`. There is
no environment override, so offline key retrieval fails and every request 401s.

`aws-jwt-verify` exposes a public key-injection API
(`cognito-verifier.d.ts`, `static cacheJwks(jwks, userPoolId?)`). The local profile
injects the key set at cold start, so the network fetch never happens.

This keeps the **same verifier class**, so `iss`, `aud`, and `token_use` validation
and the entire RBAC pipeline behave exactly as in production. Substituting a
different verifier would have created a second verification path; this does not.

The new setting must be declared in the environment schema, not read from
`process.env`. `environment-validator.ts:47` assigns the **Zod-parsed** environment
to the request context, and the schemas are plain `z.object({...})`, so Zod strips
unrecognized keys. A variable read from `process.env` inside the verifier would
work while violating the codebase's one convention for environment access, and a
variable added to the validated `env` object without being declared in a schema
would be silently `undefined`. Declaring it in the schema is both correct and
idiomatic, and it is the same pattern every other environment variable already
follows.

let localJwksReady: Promise<void> | null = null;

// Populates the verifier's in-memory JWKS cache when a local JWKS endpoint is
// configured, so verification never reaches for cognito-idp.<region>.amazonaws.com.
async function ensureLocalJwks(env: IdentityVerifierEnv): Promise<void> {
if (!env.ISB_LOCAL_JWKS_URI) return;
localJwksReady ??= fetchJwks(env.ISB_LOCAL_JWKS_URI)
.then((jwks) => {
getVerifier(env).cacheJwks(jwks);
})
.catch((error) => {
localJwksReady = null; // allow a retry on the next request
throw error;
});
await localJwksReady;
}

````

`await ensureLocalJwks(env)` is called at the top of `verifyAndExtractClaims`, which
is already async. `fetchJwks` is exported from the `aws-jwt-verify/jwk` subpath and
performs both the fetch and shape validation. `fetch` is available globally in the
Node 24 Lambda runtime.

Local values, set by the local CDK app: `COGNITO_USER_POOL_ID=us-east-1_localdev`,
and locally minted tokens carry a matching `iss`.

The failure path resets the cached promise so a transient edge outage does not
permanently poison token verification for the life of the execution environment.

## Change 2 — browser session

`source/frontend/src/helpers/cognito-config.ts` configures Amplify with a Cognito
OAuth login, which redirects to `<domain>.auth.<region>.amazoncognito.com`
federating to IAM Identity Center. Amplify constructs that hostname itself, so
`config.json` cannot redirect it, and no LocalStack tier reproduces that flow.

`aws-amplify` 6.16.4 already exposes the intended extension point:

```ts
configure(resourcesConfig: ResourcesConfig | LegacyConfig, libraryOptions?: LibraryOptions): void

interface LibraryOptions { Auth?: LibraryAuthOptions }

interface LibraryAuthOptions {
  tokenProvider?: TokenProvider;                            // getTokens() => AuthTokens | null
  credentialsProvider?: CredentialsAndIdentityIdProvider;
}
````

The local profile passes these providers; production omits the second argument
entirely, leaving `Amplify.configure(config)` exactly as today.

Shape of the change:

```ts
const localSessionEndpoint = import.meta.env.VITE_LOCAL_SESSION_ENDPOINT as
  string | undefined;

Amplify.configure(
  { Auth: { Cognito: {/* unchanged */} } },
  localSessionEndpoint
    ? { Auth: localSessionLibraryOptions(localSessionEndpoint) }
    : undefined,
);
```

`import.meta.env.VITE_LOCAL_SESSION_ENDPOINT` follows the pattern already used by
`config.ts:35` (`VITE_API_URL`), so no type declaration change is needed. The value
is read from the repo-root `.env`, which the Vite config already loads.

The new `source/frontend/src/helpers/local/amplify-local-session.ts` provides:

- a `tokenProvider` that fetches a pre-signed ID token from the local edge, decodes
  its payload, and returns it as `{ payload, toString() }`. `JWT` is type-only in
  this Amplify build, so a structural object satisfies `AuthTokens` and no new
  dependency is required.
- a `credentialsProvider` returning dummy SigV4 credentials plus an identity ID.
- in-memory caching with refetch after expiry.

The private key never reaches the browser; the local edge signs tokens.

Everything downstream is untouched: `CognitoAuthService` still calls
`fetchAuthSession()`, still extracts `email` and `custom:idc_user_id`, still signs
requests, and still sets `x-isb-identity`. The locally minted token carries the
claims the application already consumes:

```
email, cognito:username, custom:idc_user_id, custom:isb_roles,
sub, aud, iss, token_use, iat, exp
```

## The local edge

One small Node service in `local/edge/`, run as a compose service alongside
LocalStack. It exists because the Vite dev server proxies `/api` and `/config.json`
to a single `VITE_API_PROXY_TARGET` origin with no path rewriting
(`source/frontend/vite/resolve-proxy-target.ts:16,85`), and no single LocalStack
origin serves both naturally.

Responsibilities:

- `GET /config.json` — generated from `local/config/`, containing all nine
  `ConfigData` fields. `ApiUrl` is `/api`; `CognitoUserPoolId` is `us-east-1_localdev`.
- `ALL /api/*` — strip the `/api` prefix, prepend the local stage, forward to the
  LocalStack API Gateway invoke URL. This mirrors the CloudFront path behavior.
- `GET /session` — return a freshly minted local ID token and its claims.
- `GET /.well-known/jwks.json` — publish the public half of the local key pair.
- `501 Not Implemented Locally` for any path that was genuinely not provisioned, as
  a fallback signal.

The edge is also the isolation point for a later decision: if API Gateway proves
unreliable in LocalStack, the edge can invoke Lambdas directly without touching
anything else.

Reachable two ways from one process: the browser uses the published host port, the
Lambda uses the compose network service name.

## AWS client redirection — no code

Every AWS SDK v3 client honors `AWS_ENDPOINT_URL` and `AWS_ENDPOINT_URL_<SERVICE>`.
The local CDK app sets these in each function's environment, along with fixed
credentials, region, and account ID. No application code reads them.

## Local infrastructure

A reduced CDK app in `local/infrastructure/` that imports the upstream constructs
rather than restating them:

- `IsbLambdaFunction` for the domain Lambdas, so esbuild packaging and the externals
  list are identical to production.
- The upstream DynamoDB table, queue, event bus, and Step Functions definitions.
- The same generated OpenAPI contract and the same
  `prepareApiGatewaySpec` logic, so the wire contract, validation settings, and
  JSend error envelopes are the real ones.

All six API domains are created: `accounts`, `blueprints`, `configurations`,
`leases`, `leaseTemplates`, and `principals`. Their read and CRUD paths are
DynamoDB-backed and work for real. The unsupported AWS services are reached only
from the deeper flows listed under "What works locally, and what does not", so those
fail at the real call rather than being hidden behind a synthetic error.

Gateway authorization in the local profile is `NONE` rather than `awsSigv4`.
Authentication is still enforced by the Lambda middleware, which is where the
application actually checks identity and RBAC. This trades gateway signing parity —
which is testable against a real deployment — for reliability, since LocalStack's
IAM enforcement cannot be depended on. Re-signing at the edge is a possible later
fidelity upgrade.

The local CDK app is deployed to LocalStack's CloudFormation. If OpenAPI import
proves unreliable, the fallback is direct SDK-based provisioning from the same
resource definitions.

## Seed and reset

`local/seed/` populates a small, realistic fixture set: accounts in mixed states,
principals covering Admin, Manager, and User, lease templates, blueprints, a default
configuration document, and leases in PendingApproval, Active, and Expired states.

Seeding derives shapes from the production Zod schemas rather than hand-written
JSON, following the existing idiom in `isb-config-middleware.ts:36`, where
`ConfigSchemas[section].parse({})` supplies defaults. When upstream adds a
configuration field, local picks it up with no edit.

Reset drops LocalStack state and re-seeds. LocalStack runs without a persistent
volume so the reset is unambiguous. Because some failing write paths persist state
before reaching an unsupported service, reset is also the remedy for partial writes.

## Contract verification

`local:verify` walks the API surface through the local edge and validates every
response against the production Zod schemas.

This is the drift protection that MSW provides in the test suite, applied against
the real backend instead of a fake. It is pure tooling, adds no upstream surface,
and catches the specific risk this milestone creates: a local response shape that
no longer matches what the frontend expects.

## Configuration reference

| Variable                         | Set by                     | Purpose                                                 |
| -------------------------------- | -------------------------- | ------------------------------------------------------- |
| `ISB_LOCAL_JWKS_URI`             | local CDK app → Lambda env | Local JWKS endpoint; unset in production                |
| `VITE_LOCAL_SESSION_ENDPOINT`    | repo-root `.env`           | Local session endpoint for Amplify; unset in production |
| `VITE_API_PROXY_TARGET`          | repo-root `.env`           | Points the Vite proxy at the local edge                 |
| `AWS_ENDPOINT_URL`               | local CDK app → Lambda env | LocalStack endpoint for all SDK clients                 |
| `POWERTOOLS_TRACE_ENABLED=false` | local CDK app → Lambda env | Disables X-Ray, unavailable on Hobby                    |
| `VITE_API_URL`                   | repo-root `.env`           | Optional; defaults to `/api`                            |

## Developer workflow

```
npm run local:up        start LocalStack and the local edge, wait for health,
                        deploy local resources, seed data
npm run local:seed      re-seed fixtures
npm run local:reset     drop state and re-seed
npm run local:verify    walk the API surface and validate responses against the
                        production Zod schemas
npm run local:logs      tail LocalStack and Lambda logs
npm run local:down      stop and remove containers
npm run dev --workspace @amzn/innovation-sandbox-frontend
```

The frontend runs as a normal Vite dev server. No build flags, no alternate
entrypoint, no local-only bundle.

## Definition of done for Milestone 1

1. `npm run local:up` succeeds on a machine with no AWS credentials configured.
2. The UI loads in a browser with no console errors and shows a signed-in local Admin.
3. All six API domains — accounts, blueprints, configurations, leases,
   leaseTemplates, principals — serve their read and CRUD paths against real Lambdas
   and real DynamoDB.
4. A lease request publishes its event and drives the event-driven path as far as
   the local profile supports.
5. The unsupported flows listed under "What works locally, and what does not" fail at
   the real service call with a visible error in the UI and in the local logs, rather
   than silently succeeding or being masked by a synthetic error.
6. `npm run local:verify` passes against the seeded environment.
7. `npm test` and `npm run build` still pass with the patch applied.
8. With no local configuration set, the frontend and backend behave exactly as
   upstream.

## Validation plan

These are ordered by risk. Each is retired before building on it.

1. **Amplify custom `tokenProvider`.** Confirm `fetchAuthSession()` returns the
   supplied tokens and that the app reaches an authenticated UI. This is the one
   assumption resting on library behavior rather than on this repository.
2. **`cacheJwks` injection.** Confirm a locally minted token verifies through the
   unmodified `CognitoJwtVerifier` and that no request reaches
   `cognito-idp.us-east-1.amazonaws.com`.
3. **LocalStack reachability from inside a Lambda.** Confirm a containerized Lambda
   can reach both LocalStack and the local edge over the compose network.
4. **OpenAPI import and Lambda invoke.** Confirm the imported spec routes correctly
   and the Lambdas receive well-formed proxy events.
5. **SigV4 bypass.** Confirm the frontend's signed requests succeed against a
   `NONE`-authorized local gateway.
6. **Powertools tracing off.** Confirm `IsbEventBridgeClient`'s `TraceHeader`
   construction does not break `PutEvents` when tracing is disabled.
7. **Seed round-trip.** Confirm seeded records deserialize against the current
   Zod schemas and appear in the UI.
8. **Domain independence.** Confirm the accounts and blueprints read paths complete
   without touching Organizations, Identity Center, or StackSets, which is the
   premise that justifies the widened scope.

## Upgrade path to LocalStack Base

The profile is designed so that Base is additive, not a redesign:

- Enable Cognito, CloudFront, and AppConfig in the LocalStack compose file.
- Replace the local edge's `/session` endpoint with LocalStack Cognito and stop
  passing Amplify `libraryOptions`; change 2 becomes inert.
- Point the edge's `/api` forwarding at LocalStack CloudFront and drop the
  `NONE` authorization; change 1 becomes inert once the pool's JWKS is reachable.
- Provision the Organizations, Identity Center, and StackSets paths so account
  lifecycle, blueprint deployment, and permission-granting assignment complete.

Both changes are individually removable, and neither is load-bearing for the other.

## Upstream merge strategy

Three files, one small additive change each, in stable locations. All are optional
configuration read from the environment, so a future upstream refactor of the
surrounding code is a normal three-way merge. A rebase is at most three small
conflict resolutions.

The `local/` directory and the frontend local-session helper are additive paths
that upstream is unlikely to introduce, and they are excluded from the deployed
distribution.

## Known local-only rough edges

Accepted, documented, and not worth app changes:

- Sign-out does not clear the local Amplify session; a page reload restores it.
- Gateway-level SigV4 enforcement is not exercised.
- Account lifecycle, blueprint deployment, permission-granting assignment, cost
  reporting, and account cleanup fail at the real unsupported service call. These
  are read and CRUD paths that work normally.
- A write that fails partway may leave partial state in LocalStack. `local:reset`
  clears it.
- LocalStack is non-commercial for the Hobby tier; this profile is for local
  development only.
- X-Ray traces are unavailable.
- Interactive error and empty states are covered by the test suite rather than by a
  browser mock. See "Why there is no browser MSW layer".

## Open questions

- Whether the local CDK app can publish the same logical resource names the Lambda
  environment contract expects, or whether the contract is parameterized. Resolve
  during implementation by reading `BaseLambdaEnvironment` and the data stack.
- Whether LocalStack DynamoDB streams and TTL behave sufficiently for the lease
  monitoring path. Resolve during the seed round-trip validation.
