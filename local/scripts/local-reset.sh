#!/usr/bin/env bash
# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: Apache-2.0
#
# Drops all local state and rebuilds it. The documented remedy for the partial
# writes an unsupported deep flow can leave in DynamoDB, and for any state a
# failed `local:up` leaves behind. Down first, because the tables live inside
# the containers this removes.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

bash "$here/local-down.sh"
bash "$here/local-up.sh"
