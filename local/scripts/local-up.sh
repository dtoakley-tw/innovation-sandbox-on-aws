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
# test instead of hanging on a connection to nothing.

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
  # LocalStack ever does. The deploy above overlaps most of that wait.
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
# `--require-approval never` because this is a throwaway stack in LocalStack and
# a prompt here would hang `npm run local:up`, which is run unattended by the
# verify script as well as by hand.
npx cdk deploy --app "npx tsx local/infrastructure/bin/local.ts" \
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
# `?? ""` so an absent key yields an empty string, which is what the guard
# below tests for. Without it a missing key reaches `process.stdout.write`,
# which throws on a non-string — loud, but a Node stack trace rather than the
# one line that says which output is missing.
api_id="$(node -e 'const o=require("./local/cdk.out/local-outputs.json");process.stdout.write(o.ApiGatewayRestApiId ?? "")')" || {
  echo "could not read ApiGatewayRestApiId from $outputs_file" >&2
  exit 1
}
if [ -z "$api_id" ]; then
  echo "no ApiGatewayRestApiId in $outputs_file; the edge cannot reach the API Gateway" >&2
  exit 1
fi

echo "==> restarting the local edge with API Gateway id $api_id"
docker compose -f local/compose.yaml up -d --force-recreate isb-local-edge
waitForLocalEdge

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
