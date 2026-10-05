// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import type { ServerResponse } from "node:http";

import { localEdgeConfig } from "../../shared/names.js";

/**
 * Serves the runtime config the frontend fetches before anything renders.
 * `main.tsx` refuses to mount unless all six Cognito fields are present, so the
 * payload is fully populated even though the local profile never contacts
 * Cognito.
 */
export function handleConfig(_req: unknown, res: ServerResponse): void {
  const body = JSON.stringify(localEdgeConfig());
  res.writeHead(200, {
    "content-type": "application/json",
    // The Vite proxy already serves same-origin, but no-store keeps a stale
    // config from surviving a restart.
    "cache-control": "no-store",
  });
  res.end(body);
}
