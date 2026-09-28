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

docker compose -f local/compose.yaml down --remove-orphans
rm -rf "$root/local/cdk.out"
