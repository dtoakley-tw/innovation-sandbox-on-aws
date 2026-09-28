#!/usr/bin/env bash
# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: Apache-2.0
#
# Follows the logs of both services — LocalStack and the local edge — until
# interrupted. Ctrl-C stops following; the containers keep running.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
root="$(cd "$here/../.." && pwd)"
cd "$root"

docker compose -f local/compose.yaml logs -f
