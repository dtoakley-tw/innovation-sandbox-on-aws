// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import type { ServerResponse } from "node:http";

import type { LocalIsbRole } from "../../shared/names.js";
import type { KeyPair } from "../jwks.js";
import { mintLocalIdToken } from "../mint-token.js";

/**
 * The single local identity. Roles come from this server-side constant and
 * never from request input, so a developer cannot escalate by editing a claim
 * in the browser — and there is no code path where a request could influence
 * what gets signed. `satisfies` ties the role to the production enum, so a
 * rename there is a compile error here rather than a 403 that reads like an
 * RBAC bug.
 */
const LOCAL_USER = {
  sub: "local-admin",
  email: "admin@example.local",
  roles: ["Admin"] satisfies readonly LocalIsbRole[],
};

/** Mints the ID token the frontend's local Amplify providers consume. */
export async function handleSession(
  _req: unknown,
  res: ServerResponse,
  keyPair: KeyPair,
): Promise<void> {
  const token = await mintLocalIdToken({ keyPair, ...LOCAL_USER });
  // The provider wants the claims object alongside the signed string, so it is
  // decoded from the token that was actually produced rather than rebuilt.
  const payload = JSON.parse(
    Buffer.from(token.split(".")[1], "base64url").toString("utf-8"),
  );
  res.writeHead(200, {
    "content-type": "application/json",
    "cache-control": "no-store",
  });
  res.end(JSON.stringify({ token, payload }));
}
