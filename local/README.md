# Offline local development profile

Runs the Innovation Sandbox UI and API with **no AWS account, no AWS
credentials, and no outbound calls to AWS**. The real Lambda handlers, the real
generated API contract, and the real DynamoDB data model run against
[LocalStack](https://localstack.cloud); only the two things no emulator
reproduces — Cognito/IAM Identity Center authentication and the CloudFront edge
— are substituted with local-only tooling.

The design is in
[`docs/plans/2026-09-25-offline-local-development-design.md`](../docs/plans/2026-09-25-offline-local-development-design.md).

## Prerequisites

| Requirement                     | Why                                                                       |
| ------------------------------- | ------------------------------------------------------------------------- |
| Docker, with the daemon running | LocalStack executes Lambda by starting real containers on the host daemon |
| Node 24, npm 10                 | Matches the repository's `engines` and the Lambda runtime                 |

Verified on **macOS/arm64 with Homebrew LocalStack** (`localstack/localstack:4`).
Linux should behave the same; the one platform-sensitive thing is that the edge
container shadows `node_modules` with a named volume precisely so it cannot
prune the host's platform-specific esbuild (see `local/compose.yaml`).

## Quick start

```bash
npm run local:up        # start LocalStack + the local edge, deploy, seed
npm run smoke --workspace @amzn/innovation-sandbox-local   # is it up?
npm run local:verify    # walk the API surface and validate every response
```

Then add two lines to the repository-root `.env` — the same two documented in
[`.env.example`](../.env.example), where they ship **commented out**:

```bash
VITE_API_PROXY_TARGET="http://localhost:4599"
VITE_LOCAL_SESSION_ENDPOINT="http://localhost:4599/session"
```

and start the frontend as an ordinary Vite dev server:

```bash
npm run dev --workspace @amzn/innovation-sandbox-frontend
# http://localhost:5173
```

**Comment those two lines back out when you are done.** With them unset, the
frontend behaves exactly as it does in a deployed environment. That is the whole
"production unchanged" property, and it depends on nothing else.

## Commands

| Command                                                    | What it does                                                                                                                                                            |
| ---------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `npm run local:up`                                         | Starts both containers, waits for health, bootstraps CDK if needed, deploys both stacks, restarts the edge with the real API Gateway id, and seeds. Idempotent.         |
| `npm run local:seed`                                       | Re-writes the fixtures and the two SSM parameters. Unconditional `Put`s and `Overwrite`, so it is safe to re-run.                                                       |
| `npm run local:reset`                                      | `local:down` then `local:up`. **The remedy for partial writes** and for any state a failed run leaves behind.                                                           |
| `npm run local:verify`                                     | Walks every read path, one mutation per domain, and the flows that must fail; validates responses against the production Zod schemas. Exits non-zero on a real failure. |
| `npm run smoke --workspace @amzn/innovation-sandbox-local` | Fast health check. No Zod, no CDK, no workspace imports — only Node's `fetch`.                                                                                          |
| `npm run local:logs`                                       | Follows both containers' logs.                                                                                                                                          |
| `npm run local:down`                                       | Stops and removes the containers, the orphaned Lambda containers, and the CDK output. Keeps `local/.keys`. Idempotent.                                                  |

`local:up` needs no AWS credentials and makes none. If you ever need to run
`cdk deploy` by hand — the only case `local:up` does not already cover — the
invocation is:

```bash
AWS_ENDPOINT_URL=http://localhost:4566 \
AWS_ACCESS_KEY_ID=test AWS_SECRET_ACCESS_KEY=test \
AWS_REGION=us-east-1 AWS_DEFAULT_REGION=us-east-1 \
npx cdk deploy --all --app "npx tsx local/infrastructure/bin/local.ts" \
  --require-approval never \
  --outputs-file local/cdk.out/local-outputs.json
```

`--all` is required: the app registers two stacks, and a bare `cdk deploy`
refuses to choose. `AWS_ENDPOINT_URL` must be in the **CDK CLI's** environment;
it is not inherited from the Lambda environment the app assembles.

## What works locally, and what does not

From the design document, against the handlers.

| Surface                                                     | Local dependency                                           | Works locally |
| ----------------------------------------------------------- | ---------------------------------------------------------- | ------------- |
| Accounts get, list                                          | `sandboxAccountStore` (DynamoDB)                           | Yes           |
| Cleanup report read                                         | `cleanupReportStore` (DynamoDB)                            | Yes           |
| Blueprints get, list, update                                | `blueprintStore` (DynamoDB)                                | Yes           |
| Leases, lease templates, configuration sections, principals | DynamoDB                                                   | Yes           |
| Lease **request** (leaves the lease `PendingApproval`)      | DynamoDB, EventBridge                                      | Yes           |
| Account provisioning, deprovisioning, drift                 | `orgsService`, `organizationsTaggingService`, `idcService` | No            |
| Blueprint create                                            | `DescribeStackSet` (CloudFormation StackSets)              | No            |
| Blueprint deployment                                        | `blueprintDeploymentService`, StackSets                    | No            |
| Lease **approval** (auto-approve, or `review` with Approve) | `identitystore` via `IdcService.getUserFromEmail`          | No            |
| Lease assignment completion                                 | `ssoAdminClient` permission grants                         | No            |
| Cost reporting                                              | `costExplorerClient`                                       | No            |
| Account cleanup                                             | CodeBuild, ECR, Organizations                              | No            |

Three rows differ from the design document's table, and all three were found by
running the profile rather than by reading it.

- **"Lease request, approval — No" is now two rows.** The design gave the
  dependency as the IDC config SSM parameter, and the seed now writes it, so the
  _request_ half works: `POST /api/leases` against a template with
  `requiresApproval: true` returns 201 and a `PendingApproval` lease. What does
  not work is _approval_, including auto-approval, and for a different reason
  than the design gives — `approveLease` calls `IdcService.getUserFromEmail`,
  which needs `identitystore`, and that is outside the LocalStack Community
  (Hobby) tier rather than missing from the profile. `local:verify` checks the
  request as a working mutation and the auto-approval as a boundary.
- **"Blueprint create"** calls `DescribeStackSet` before it writes anything
  (`blueprintDeploymentService.registerBlueprint`), so creation needs StackSets
  even though the write itself is DynamoDB.
- **`retryCleanup` and `skipCooldown`** sit behind account-state preconditions
  the seeded fixtures cannot satisfy, so they 409 long before Organizations.

Failing flows are supposed to fail **at the real AWS call**, inside the Lambda,
naming the service — not behind a synthetic "not available locally" refusal. The
local edge's `501 Not Implemented Locally` exists only as a fallback for a path
that was genuinely not provisioned, and `local:verify` fails the run if any of
these flows is satisfied by it.

## How the Lambdas reach the edge

The edge has **two listeners in one process**.

| Listener            | Port   | Reached by                      | Serves                                     |
| ------------------- | ------ | ------------------------------- | ------------------------------------------ |
| Browser-facing HTTP | `4599` | the browser, via the Vite proxy | `/config.json`, `/api/*`, `/session`       |
| Lambdas' TLS        | `4600` | the Lambdas, on `isb-local`     | `/.well-known/jwks.json`, and nothing else |

The second one exists because `aws-jwt-verify@4.0.1` fetches the JWKS through
`node:https.request` and has no code path down to plain `http:` — on an `http://`
URI it throws `ERR_INVALID_PROTOCOL` before a packet is sent, so
`source/common/lambda/auth/identity-token-verifier.ts`'s `ensureLocalJwks` could
never load the key set and every authenticated request failed at key retrieval.
The other way to fix that is a change under `source/`, which this profile exists
to avoid.

`4599` stays plain HTTP because the browser reaches it directly and a certificate
there would mean a trust prompt on every page load. `4600` is **not published to
the host** (`local/compose.yaml`): only the Lambdas, on the `isb-local` network,
have any reason to reach it, and nothing about the browser needs a TLS endpoint
on `localhost`.

Trust is established with a development CA (`local/edge/dev-ca.ts`), which has to
exist in two places at two different moments, in processes that do not start
together: `cdk deploy` copies it into each Lambda artifact at bundle time, and
the edge serves a leaf it signed. Whichever side gets there first mints it and
the other reads it back. Both call the same idempotent function and the create is
atomic, so the race resolves to one CA rather than two. Each Lambda is given
`NODE_EXTRA_CA_CERTS=/var/task/isb-local-ca.pem`, which Node reads once at
process start and adds to the default root store — so `https.request` trusts the
edge without a line changed under `source/`.

The CA and the leaf are deliberately different documents. The edge hands its
certificate to every caller of the JWKS route, so if that document were also the
trust anchor, anything that had read it off the wire could impersonate the edge
to every Lambda.

### CORS

`/session` is the only cross-origin request the browser makes: the Vite proxy
forwards `/api` and `/config.json` (`PROXIED_PATHS` in
`source/frontend/vite/resolve-proxy-target.ts`), but `/session` is not on that
list and the frontend fetches `VITE_LOCAL_SESSION_ENDPOINT` as an absolute URL.
The edge echoes `Access-Control-Allow-Origin` for **loopback origins only**
(`http://localhost`, `http://127.0.0.1` or `http://[::1]`, any port — Vite moves
to 5174 when 5173 is taken) and sends nothing for anything else. A wildcard would
work and would also let any page a developer visits authorize itself to read a
signed identity token out of their browser. See `local/edge/routes/cors.ts`.

## Known defects

**1. The first request to each Lambda answers 502.** After the
`LAMBDA_RUNTIME_ENVIRONMENT_TIMEOUT` of 60 s reaps an execution environment, the
next request returns `502 {"message": "Internal server error"}` in 13–46 ms
with no Lambda log at all, and the one after it succeeds after a 5–9 s cold
start. Reproducible 5/5. This is the first page load after every `local:up`.
`local:verify` retries on exactly this shape, which is why a first run may report
"needed a retry".

**2. LocalStack's gateway process dies partway through a full walk, and the
container keeps reporting `healthy`.** Reproduced three times in one session,
including twice on a completely clean start. The symptom is always the same: the
log stops mid-line, port 4566 accepts nothing
(`ECONNREFUSED 172.19.0.2:4566` from the edge, `curl: (52) Empty reply from
server` from the host), `ps` inside the container shows the supervisor alive but
no gateway process, and the edge reports
`Local edge could not reach the LocalStack API Gateway: fetch failed`.
`docker compose ps` still says `(healthy)`.

Confirmed to be memory, not LocalStack: with Docker capped at 1.91 GB the
LocalStack container reports `OOMKilled: true` and the walk collapses to 502s
across every domain. Giving the Docker VM more room (`colima start --memory 6
--cpu 4`) makes it disappear, so the memory bound — not the profile — is what the
walk runs into. `local/compose.yaml` bounds `LAMBDA_RUNTIME_ENVIRONMENT_TIMEOUT`
but not the number of concurrently running Lambda containers, and a full
six-domain walk starts all six at once. That is a real gap in `compose.yaml` and
is not fixed here; the remedy is to give Docker more memory.

`local:down` now recovers from the orphaned containers a dead gateway leaves
behind — see "Teardown" below — so the documented recovery is just
`npm run local:down && npm run local:up`.

## Teardown

`local:down` removes the containers LocalStack started for the Lambdas before
handing the rest to `docker compose down`, and removes `local/cdk.out`
unconditionally.

Both are there because of defect 2. When the gateway dies, the Lambda containers
it started are orphaned: `docker compose down` does not own them, so
`--remove-orphans` cannot see them, and while they are attached to `isb-local`
the command fails with `Network isb-local Resource is still in use`. Under
`set -euo pipefail` that ended the script _before_ `rm -rf local/cdk.out`, so a
stale CDK output survived — and `local-up.sh` reads that file for the API Gateway
id, which turned the failure into a later `local:up` that deployed nothing and
pointed the edge at an API that did not exist.

The sweep is filtered twice, on the `isb-local` network and on the Lambda runtime
image, so it cannot remove a container this profile did not start. The `rm -rf`
is last and unconditional: a `local:down` that cannot reach Docker still owes the
developer a clean tree.

## The two SSM parameters

`/isb/isbdev/account-pool/config` and `/isb/isbdev/idc/config` are written by
`local/seed/ssm-parameters.ts`, not by a CDK stack. In production neither belongs
to the data stack either — the account pool stack writes the first and the IDC
stack the second — and the local profile deploys neither, so the seed is what
stands in for both.

They have to be right in a way a table's key schema does not: the stores do
`JSON.parse(value)` and _then_ `Schema.parse(...)`, so a parameter that parses as
JSON can still be the wrong shape. `AccountPoolConfigSchema` transforms
`isbManagedRegions` from a comma-separated string into `string[]`, which means the
bytes written must be the schema's **input**, not its output — serialising the
parsed result would put an array where the store calls `.split(",")`, and every
read would fail on a type error with nothing in the response to explain it.

Both are validated against the production schemas on every build, so an upstream
field that becomes required fails the seed rather than a request at runtime.

## `local:reset` and partial writes

Some unsupported flows write to DynamoDB before reaching the un-emulated
service, so a failed local write leaves partial state. This is expected and is
the documented design decision, not a bug. `local:verify` will trigger it: its
`quarantine` boundary check turns the seeded Active lease into
`AccountQuarantined` before failing. `npm run local:reset` is the remedy, and
`npm run local:seed` is enough on its own when only records are involved.

One consequence is worth naming, because it looks like a different bug: a
**second** `local:verify` on the same profile has no Active lease left, so the
two checks that read and update one are skipped. They are reported as `skipped`
with the reason and the remedy, and the summary counts them separately from both
the passes and the failures — a run that did less work should never look like a
run with fewer problems.

The lease _request_ check is not affected: the walk denies the lease it creates,
which moves it to `ApprovalDenied` and releases the slot it takes against
`globalConfig.leases.maxLeasesPerUser`. Without that, the walk could only ever
pass once per `local:up`.

## Not verified

- **The browser.** No desktop browser has been connected to this session, so no
  page has been rendered and no console has been read. What _was_ exercised
  against a running Vite dev server on `http://localhost:5173`: `/config.json` and
  an authenticated `/api/leases` both return the expected data through the proxy,
  and a `GET /session` carrying `Origin: http://localhost:5173` returns
  `access-control-allow-origin: http://localhost:5173` with a usable token, while
  `https://evil.example`, `http://localhost.evil.test:5173` and
  `https://localhost:5173` get no CORS header at all. That is the header contract
  a browser enforces, from a real client — but it does not exercise
  `fetchAuthSession()`, the React tree, or a real CORS check. Treat the app
  rendering signed-in as unconfirmed.
- **Cost reporting and account cleanup.** Neither is reachable through the six
  API domains: cost reporting is a separate scheduled Lambda the profile does
  not deploy, and cleanup is driven by CodeBuild and ECR. They are out of scope
  for the six-domain walk rather than untested within it.
- **X-Ray**, gateway-level SigV4, and DynamoDB stream behaviour.

## Layout

```
local/
  compose.yaml        LocalStack + the local edge
  edge/               the local edge: /config.json, /api/*, /session, JWKS, 501
    dev-ca.ts           the development CA and the edge's certificate
    key-store.ts        where key material lives, and how it is written
    routes/cors.ts      the loopback-only CORS policy for /session
  infrastructure/     a reduced CDK app reusing the upstream constructs
  seed/               schema-derived fixtures, written with unconditional Puts
    ssm-parameters.ts   the two SSM parameters the Lambdas read, from the production schemas
  verify/             `local:verify` — the API walk
  e2e/smoke.ts        the fast health check
  scripts/            local:up / down / reset / logs
  shared/names.ts     every local resource name, in one place
  .keys/              the signing key and the CA — gitignored, kept by local:down
```

`local/.keys` holds the two pieces of state that must agree between processes:
the JWKS signing key the edge uses, and the development CA the synth bundles and
the edge serves a leaf from. `local:down` keeps it, like the `node_modules`
volume, because a trust anchor is a cache and not a distributed artifact. Remove
it by hand to rotate; `local:up` mints whatever is missing, and mints it
identically from either side.
