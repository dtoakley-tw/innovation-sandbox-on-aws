#!/usr/bin/env bash
# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: Apache-2.0
#
# Brings up the offline local profile. Idempotent: every step either converges
# on the state it wants or fails, and `local:down` leaves nothing behind.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
root="$(cd "$here/../.." && pwd)"
cd "$root"

# The two endpoints below are the values of LOCAL_EDGE_PORT in
# local/shared/names.ts and LOCALSTACK_ENDPOINT in
# local/infrastructure/lib/lambda-environment.ts. They are literals here
# because compose and bash cannot import a TypeScript constant without a build
# step; `scripts.test.ts` asserts all three files agree, so a rename fails a
# test instead of hanging on a connection to nothing. The account id in
# `bootstrap_target` further down is a third such literal, for the same reason
# and with the same guard.

# Polls `$1` until it answers 2xx, at most `$2` times (default 60) `$3` seconds
# apart (default 2). Bounded, and loud on failure, because every step after the
# first one assumes the thing it waits for is up.
waitFor() {
  local url="$1"
  local attempts="${2:-60}"
  local delay_seconds="${3:-2}"
  for _ in $(seq 1 "$attempts"); do
    if curl -fsS "$url" >/dev/null 2>&1; then
      return 0
    fi
    sleep "$delay_seconds"
  done
  echo "timed out after $((attempts * delay_seconds))s waiting for $url" >&2
  return 1
}

waitForLocalStack() {
  waitFor "http://localhost:4566/_localstack/health"
}

waitForLocalEdge() {
  # Six minutes rather than two: on a cold image the edge container installs the
  # workspace's dependencies before it listens, which takes longer than
  # LocalStack ever does. The deploy above overlaps most of that wait. An
  # estimate, not a measurement — nothing has timed this yet, and the message on
  # expiry names the URL, so raising it is the fix if it is too short.
  waitFor "http://localhost:4599/healthz" 180
}

echo "==> starting LocalStack and the local edge"
docker compose -f local/compose.yaml up -d
waitForLocalStack

echo "==> deploying local resources"
# The CDK CLI resolves endpoints from its own environment, not from the Lambda
# environment local/infrastructure assembles. Without these it targets real AWS.
export AWS_ENDPOINT_URL="http://localhost:4566"
export AWS_ACCESS_KEY_ID="test"
export AWS_SECRET_ACCESS_KEY="test"
export AWS_REGION="us-east-1"
export AWS_DEFAULT_REGION="us-east-1"

# The CDK CLI cannot publish the six Lambda artifacts without its bootstrap stack
# in the target account, and a LocalStack container that has just started has
# none: `cdk deploy` stops with `Parameter /cdk-bootstrap/... not found` before
# creating a single resource, so a first `local:up` on a clean machine never got
# as far as deploying anything. Created here, once, and skipped once it is there
# so a re-run pays nothing for it.
#
# The account is a literal because bash cannot import a TypeScript constant
# without a build step. It is LOCAL_ACCOUNT_ID in local/shared/names.ts and the
# same account `local/infrastructure/bin/local.ts` pins both stacks to;
# `scripts.test.ts` asserts the two agree, because bootstrapping one account and
# deploying to another is a failure that looks like a missing bootstrap.
bootstrap_target="aws://000000000000/${AWS_REGION}"

# Asked of LocalStack directly, through the `awslocal` CLI its image ships,
# rather than inferred from whether a deploy succeeds: the toolkit stack is a
# fact about the account, and asking is both cheaper and clearer than
# discovering it by failing. `CDKToolkit` is the CDK default toolkit stack name.
is_bootstrapped() {
  docker compose -f local/compose.yaml exec -T localstack \
    awslocal cloudformation describe-stacks --stack-name CDKToolkit \
    >/dev/null 2>&1
}

bootstrap_cdk() {
  if is_bootstrapped; then
    echo "==> CDK is already bootstrapped in LocalStack"
    return 0
  fi
  echo "==> bootstrapping CDK in $bootstrap_target"
  # The env vars above are what make this reach LocalStack rather than real AWS,
  # and they are already exported by the time this runs.
  npx cdk bootstrap "$bootstrap_target" || {
    echo "cdk bootstrap failed for $bootstrap_target" >&2
    echo "  LocalStack may still be initialising. Retry, or run it by hand:" >&2
    echo "  AWS_ENDPOINT_URL=$AWS_ENDPOINT_URL npx cdk bootstrap $bootstrap_target" >&2
    exit 1
  }
}

bootstrap_cdk

# `--require-approval never` because this is a throwaway stack in LocalStack and
# a prompt here would hang `npm run local:up`, which is run unattended by the
# verify script as well as by hand.
# `--all` because the app registers two stacks, `IsbLocalData` and
# `IsbLocalCompute`, and they are independent of each other — nothing in the
# compute stack references a resource in the data stack, because the Lambdas
# address the tables by name from `localTableNames` rather than through
# references. A bare `cdk deploy` refuses to choose between them ("Since this app
# includes more than a single stack, specify which stacks to use"), so one stack
# would go undeployed and the profile would be half up. `--all` also matches how
# the outputs are read below: every stack's outputs are scanned, and the API id
# and invoke URL come from the one stack that carries them.
npx cdk deploy --all --app "npx tsx local/infrastructure/bin/local.ts" \
  --require-approval never \
  --outputs-file local/cdk.out/local-outputs.json || {
  echo "local resource deployment failed; run \`npm run local:logs\` for the LocalStack view" >&2
  exit 1
}

outputs_file="local/cdk.out/local-outputs.json"
if [ ! -f "$outputs_file" ]; then
  echo "cdk deploy reported success but wrote no $outputs_file" >&2
  exit 1
fi
# `cdk deploy --outputs-file` nests the outputs under the stack name — the CLI
# writes `{ "<StackName>": { "<OutputName>": "value" } }` — so each value is read
# out of whichever stack object carries it, and is empty when none does, which
# is what the guards below test for. Read off the top level, as though the file
# were flat, they would be undefined on every deploy.
api_id="$(node -e 'const o=require("./local/cdk.out/local-outputs.json");const ids=Object.values(o).map(s=>s?.ApiGatewayRestApiId).filter(Boolean);process.stdout.write(ids[0]??"")')" || {
  echo "could not read ApiGatewayRestApiId from $outputs_file" >&2
  exit 1
}
if [ -z "$api_id" ]; then
  echo "no ApiGatewayRestApiId in $outputs_file; the edge cannot reach the API Gateway" >&2
  exit 1
fi

# The URL, not the id, because the stack builds it. Assembling
# `http://localstack:4566/restapis/$api_id/local/_user_request_` here would be
# a second place the URL's shape is decided, and the two could disagree.
invoke_url="$(node -e 'const o=require("./local/cdk.out/local-outputs.json");const urls=Object.values(o).map(s=>s?.ApiGatewayInvokeUrl).filter(Boolean);process.stdout.write(urls[0]??"")')" || {
  echo "could not read ApiGatewayInvokeUrl from $outputs_file" >&2
  exit 1
}
if [ -z "$invoke_url" ]; then
  echo "no ApiGatewayInvokeUrl in $outputs_file; the edge cannot reach the API Gateway" >&2
  exit 1
fi

# Compose renders this into the edge container's environment as it recreates the
# service, so exporting it is what makes the recreate mean anything. Without the
# export the container restarts with the same placeholder, /healthz answers 200,
# and every /api request 404s — a failure none of the checks below would see.
export ISB_LOCAL_API_GATEWAY_INVOKE_URL="$invoke_url"
echo "==> restarting the local edge with API Gateway id $api_id"
docker compose -f local/compose.yaml up -d --force-recreate isb-local-edge
waitForLocalEdge

# Asked rather than assumed: interpolation that silently does not fire, or a
# container that kept its old environment, both leave a healthy edge serving the
# placeholder behind a green run.
container_url="$(docker compose -f local/compose.yaml exec -T isb-local-edge printenv ISB_LOCAL_API_GATEWAY_INVOKE_URL)"
if [ "$container_url" != "$invoke_url" ]; then
  echo "the edge container has ISB_LOCAL_API_GATEWAY_INVOKE_URL='$container_url', not '$invoke_url'" >&2
  exit 1
fi

echo "==> seeding fixtures"
npm run local:seed

echo
echo "Local profile is ready."
echo "  edge:       http://localhost:4599"
echo "  localstack: http://localhost:4566"
echo
echo "Add these to the repository-root .env, then start the frontend:"
echo "  VITE_API_PROXY_TARGET=http://localhost:4599"
echo "  VITE_LOCAL_SESSION_ENDPOINT=http://localhost:4599/session"
echo
echo "  npm run dev --workspace @amzn/innovation-sandbox-frontend"
