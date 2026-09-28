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
| `npm run local:seed`                                       | Re-writes the fixtures. Unconditional `Put`s, so it is safe to re-run.                                                                                                  |
| `npm run local:reset`                                      | `local:down` then `local:up`. **The remedy for partial writes** and for any state a failed run leaves behind.                                                           |
| `npm run local:verify`                                     | Walks every read path, one mutation per domain, and the flows that must fail; validates responses against the production Zod schemas. Exits non-zero on a real failure. |
| `npm run smoke --workspace @amzn/innovation-sandbox-local` | Fast health check. No Zod, no CDK, no workspace imports — only Node's `fetch`.                                                                                          |
| `npm run local:logs`                                       | Follows both containers' logs.                                                                                                                                          |
| `npm run local:down`                                       | Stops and removes the containers and the CDK output. Keeps `local/.keys`.                                                                                               |

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
| Account provisioning, deprovisioning, drift                 | `orgsService`, `organizationsTaggingService`, `idcService` | No            |
| Blueprint create                                            | `DescribeStackSet` (CloudFormation StackSets)              | No            |
| Blueprint deployment                                        | `blueprintDeploymentService`, StackSets                    | No            |
| Lease request, approval                                     | the IDC config SSM parameter                               | No            |
| Lease assignment completion                                 | `ssoAdminClient` permission grants                         | No            |
| Cost reporting                                              | `costExplorerClient`                                       | No            |
| Account cleanup                                             | CodeBuild, ECR, Organizations                              | No            |

Two rows differ from the design document's table, and both were found by running
the profile rather than by reading it. See "Known defects" below.

Failing flows are supposed to fail **at the real AWS call**, inside the Lambda,
naming the service — not behind a synthetic "not available locally" refusal. The
local edge's `501 Not Implemented Locally` exists only as a fallback for a path
that was genuinely not provisioned, and `local:verify` fails the run if any of
these flows is satisfied by it.

## Known defects

Found by the bring-up in Task 13. All are reported, not fixed; the first is in
`source/` and the rest are gaps in `local/`. Each is reproducible with the
commands shown.

**1. Every authenticated request fails. `aws-jwt-verify` cannot fetch an `http://`
JWKS.** `identity-token-verifier.ts` calls `fetchJwks` from
`aws-jwt-verify/jwk`, which is built on `node:https` and throws
`TypeError [ERR_INVALID_PROTOCOL]: Protocol "http:" not supported. Expected
"https:"`. `ISB_LOCAL_JWKS_URI` is `http://isb-local-edge:4599/...`, so the
fetch never happens and every request 500s.

This is **not** a network problem. From inside the Lambda container:

```
$ docker exec <lambda> node -e "fetch('http://isb-local-edge:4599/.well-known/jwks.json').then(r=>r.text()).then(t=>console.log('OK',t.slice(0,60)))"
OK {"keys":[{"kty":"RSA","alg":"RS256","use":"sig","kid":"YfybFdLGXnNZ_xAE","n":"uD…
```

The compose network, the container names, and the `COGNITO_USER_POOL_ID` /
`iss` match are all correct. Only the protocol is wrong, and the fix belongs in
`source/`.

**2. Two SSM parameters the Lambdas read are never created.**
`/isb/isbdev/account-pool/config` and `/isb/isbdev/idc/config` are named in
`buildLocalEnv` and read through `@aws-lambda-powertools/parameters`, but no
local resource creates them and the seed does not write them. This breaks
`GET /configurations`, `POST /leases`, and `POST /leases/{id}/review`, and it
_masks_ the account lifecycle boundary: `quarantine` and `eject` fail with
`GetParameterError` instead of reaching Organizations.

**3. `GET /leases/shared` is unreachable.** LocalStack's API Gateway matches
`/leases/{leaseId}` before the static `/leases/shared`, so the request reaches
`GetLease` and returns `400 LeaseId path parameter provided is invalid.` The
resources themselves are imported correctly — `awslocal apigateway get-resources`
shows both — so this is LocalStack's route precedence, not the spec transform.

**4. The first request to each Lambda answers 502.** After the
`LAMBDA_RUNTIME_ENVIRONMENT_TIMEOUT` of 60 s reaps an execution environment, the
next request returns `502 {"message": "Internal server error"}` in 13–46 ms
with no Lambda log at all, and the one after it succeeds after a 5–9 s cold
start. Reproducible 5/5. This is the first page load after every `local:up`.

**5. `/session` is cross-origin and the edge sends no CORS headers.** The Vite
proxy only forwards `/api` and `/config.json`
(`PROXIED_PATHS` in `source/frontend/vite/resolve-proxy-target.ts`), so the
documented `VITE_LOCAL_SESSION_ENDPOINT=http://localhost:4599/session` is a
different origin from `http://localhost:5173`. The edge's `/session` response
carries no `access-control-allow-origin`, so a browser will block it,
`loadSession()` will return `null`, and the app will render logged out. **Not
confirmed in a browser** — see "Not verified" below.

**6. LocalStack's gateway process dies partway through a full walk, and the
container keeps reporting `healthy`.** Reproduced three times in one session,
including twice on a completely clean start. The symptom is always the same: the
log stops mid-line, port 4566 accepts nothing
(`ECONNREFUSED 172.19.0.2:4566` from the edge, `curl: (52) Empty reply from
server` from the host), `ps` inside the container shows the supervisor alive but
no gateway process, and the edge reports
`Local edge could not reach the LocalStack API Gateway: fetch failed`.
`docker compose ps` still says `(healthy)`.

The likely cause is memory. Each Lambda container settles at 360–430 MB
(`docker stats`), six of them plus the two compose services is ~2.6 GB, and
Docker's total limit on this machine is 1.91 GB. `local/compose.yaml` bounds
`LAMBDA_RUNTIME_ENVIRONMENT_TIMEOUT` but not the number of concurrently running
Lambda containers, and a full six-domain walk starts all six at once.

Recovery is not `local:reset` on its own. When the gateway dies, its Lambda
containers are orphaned, stay `Up`, and keep `isb-local` attached, so
`docker compose down` prints `Network isb-local Resource is still in use` and
the next `local:up` inherits the orphans and does not come back. What works:

```bash
npm run local:down
docker ps -aq --filter "name=local-localstack-1-lambda-" | xargs -r docker rm -f
docker network rm isb-local
npm run local:up
```

**7. `local:down` cannot always complete.** It aborts on
`set -euo pipefail` when `docker compose down` hits the "Resource is still in
use" above, before `rm -rf local/cdk.out`, so a stale `cdk.out` survives and the
next `local:up` may read stale outputs. The orphan cleanup above avoids it.

## `local:reset` and partial writes

Some unsupported flows write to DynamoDB before reaching the un-emulated
service, so a failed local write leaves partial state. This is expected and is
the documented design decision, not a bug. `local:verify` will trigger it: its
`quarantine` boundary check turns the seeded Active lease into
`AccountQuarantined` before failing. `npm run local:reset` is the remedy, and
`npm run local:seed` is enough on its own when only records are involved.

## Not verified

- **The browser.** No desktop browser was connected to the Task 13 session, so
  no page was rendered and no console was read. The Vite proxy path was
  exercised with `curl` instead — `/config.json` and an authenticated
  `/api/leases` both return the expected data through `http://localhost:5173` —
  but that does not exercise `fetchAuthSession()`, the React tree, or CORS.
  Defect 5 is predicted from the response headers, not observed.
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
  infrastructure/     a reduced CDK app reusing the upstream constructs
  seed/               schema-derived fixtures, written with unconditional Puts
  verify/             `local:verify` — the API walk
  e2e/smoke.ts        the fast health check
  scripts/            local:up / down / reset / logs
  shared/names.ts     every local resource name, in one place
```
