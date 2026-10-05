#!/usr/bin/env bash
# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: Apache-2.0
#
# Stops the local profile. The AWS-shaped state is ephemeral by design, so none
# of it is preserved: LocalStack keeps no volume and the CDK output is deleted.
# The local signing key under local/.keys is kept, so tokens a browser already
# holds stay valid across a restart.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
root="$(cd "$here/../.." && pwd)"
cd "$root"

# The compose file and the network name it declares. `isb-local` is a literal
# here for the same reason the port and account id in local-up.sh are: compose
# and bash cannot import a TypeScript constant without a build step, and
# `scripts.test.ts` asserts this value against the compose file, so a rename
# there fails a test instead of silently sweeping nothing.
network="isb-local"

# Removes the containers LocalStack started for the Lambdas, which compose does
# not own and `down --remove-orphans` cannot see.
#
# This exists because of what happens when LocalStack's gateway process dies
# mid-walk (README, "Known defects"): the Lambda containers it started are
# orphaned, stay `Up`, and keep `isb-local` attached. `docker compose down`
# then fails with "Network isb-local Resource is still in use", and under
# `set -e` that aborted this script *before* `rm -rf local/cdk.out` — so a
# stale `cdk.out` survived and the next `local:up` could read stale outputs
# from it. Removing them first is what lets the teardown finish, and the
# `cdk.out` removal below is unconditional so it happens either way.
#
# Only containers attached to the profile's own network are touched, and only
# ones whose image is the Lambda runtime image. A container the developer
# started by hand on that network is not one this profile created, and
# `docker compose down` is already about to report anything it owns.
remove_orphaned_lambdas() {
  local ids
  # `-a` so stopped containers go too: they still hold the network even when
  # exited, which is why `docker compose down` fails on a profile whose
  # containers were never cleanly reaped. Filtered on the network *and* the
  # runtime image so this cannot remove a LocalStack or edge container.
  ids="$(docker ps -aq \
    --filter "network=$network" \
    --filter "ancestor=public.ecr.aws/lambda/nodejs:24")" || return 0
  [ -n "$ids" ] || return 0
  echo "==> removing $(echo "$ids" | wc -l | tr -d ' ') orphaned Lambda container(s) holding $network"
  # Word splitting is intended: `docker rm` takes a list of ids, and the ids
  # come from `docker ps -q`, so there is nothing to word-split in the value.
  # shellcheck disable=SC2086
  docker rm -f $ids >/dev/null 2>&1 || true
}

remove_orphaned_lambdas

# `|| true` rather than letting `set -e` abort here. The two ways this can fail
# are a Docker daemon that is not running — in which case there is nothing to
# tear down and the `cdk.out` removal is still owed — and the network-still-in-use
# case above, which the sweep reduces on a second attempt. Neither should cost
# the `rm -rf` below, and neither is silent: the removal runs regardless, and
# `scripts.test.ts` pins that ordering.
docker compose -f local/compose.yaml down --remove-orphans || \
  echo "  docker compose down reported a problem; see above" >&2

# Unconditional, and the reason it is: every failure mode above leaves the CDK
# output behind, and stale outputs in `local/cdk.out` are what `local-up.sh`
# reads for the API Gateway id and invoke URL. A stale file there is a later
# `local:up` that deploys nothing and points the edge at an API that does not
# exist — a failure with no message at the point it happens.
rm -rf "$root/local/cdk.out"
