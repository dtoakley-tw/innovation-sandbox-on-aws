// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import { z, type ZodType } from "zod";

import { BlueprintWithStackSetsSchema } from "@amzn/innovation-sandbox-shared/types/blueprint.js";
import { ConfigSchemas } from "@amzn/innovation-sandbox-shared/types/configuration.js";
import {
  LeaseTemplateMetadataSchema,
  LeaseTemplateWritableSchema,
} from "@amzn/innovation-sandbox-shared/types/lease-template.js";
import { LeaseSchema } from "@amzn/innovation-sandbox-shared/types/lease.js";
import { IdcPrincipalSchema } from "@amzn/innovation-sandbox-shared/types/principal.js";
import {
  ActiveCleanupSchema,
  CurrentLeaseSchema,
  SandboxAccountStatusSchema,
} from "@amzn/innovation-sandbox-shared/types/sandbox-account.js";

import { LOCAL_IDC_PRINCIPAL_ID } from "../shared/names.js";

/**
 * The shape checks `verify.ts` runs against live responses, and nothing else.
 *
 * Every schema here is the production one, imported rather than restated, so an
 * upstream field that changes breaks this walker at the point the contract
 * moved instead of letting a local-only divergence accumulate. That is the
 * whole drift protection the design asks for: LocalStack-backed responses have
 * to satisfy the same contracts the frontend is written against.
 *
 * What is *not* here is a restatement of the wire envelope. The JSend wrapper
 * and the per-operation `data` projections are checked structurally (see
 * `jsend.ts`) because the generated API contract already owns them and a second
 * copy would be exactly the duplication the one-path rule forbids.
 */

/** `GET /blueprints` -> `data.blueprints[]`. */
export const BLUEPRINT_LIST_ITEM_SCHEMA = BlueprintWithStackSetsSchema;

/** `GET /blueprints/{id}` -> `data.blueprint`. */
export const BLUEPRINT_ITEM_SCHEMA =
  BlueprintWithStackSetsSchema.shape.blueprint;

/** Every `Lease` in a leases read path, keyed by its `status` branch. */
export const LEASE_SCHEMA: ZodType = LeaseSchema;

/**
 * `GET /leaseTemplates` -> `data.result[]`, and `GET
 * /leaseTemplates/{id}` -> `data`.
 *
 * `LeaseTemplateWritableSchema` is only the client-writable subset and is
 * `strictObject`, so it rejects the server-owned members a read legitimately
 * returns (`uuid`, `createdBy`, `blueprintName`, `meta`). The read projection is
 * therefore the writable shape *extended* with exactly the members the generated
 * contract adds — derived from production schemas, not restated: `uuid` and
 * `createdBy` are the identity the store owns, and `meta` is
 * `LeaseTemplateMetadataSchema`, the same envelope `seed.ts` stamps.
 */
export const LEASE_TEMPLATE_SCHEMA: ZodType =
  LeaseTemplateWritableSchema.extend({
    uuid: z.uuid(),
    createdBy: z.email(),
    blueprintName: z.string().optional(),
    meta: LeaseTemplateMetadataSchema.optional(),
  });

/** `GET /principals/search` -> `data.principals[]`. */
export const PRINCIPAL_SCHEMA: ZodType = IdcPrincipalSchema;

/** `GET /configurations/{section}` -> `data`, per section. */
export const CONFIG_SECTION_SCHEMAS = ConfigSchemas;

/**
 * `GET /accounts` -> `data.result[]` and `GET /accounts/{id}` -> `data`.
 *
 * Assembled from the shared pieces rather than imported whole, because
 * `source/shared/types/sandbox-account.ts` publishes the fields and not a schema
 * for the record: `PersistedSandboxAccountSchema` in `source/common` is strict
 * and expects the store's DynamoDB keys, which the API projection does not
 * carry. Every enum and nested object below is still a production schema, so
 * the values are checked against the same definitions the application uses;
 * only the envelope is this file's. `meta` is deliberately `.passthrough()`
 * because it is `AccountMetadata` in the contract and has no Zod counterpart.
 */
export const SANDBOX_ACCOUNT_SCHEMA: ZodType = z.looseObject({
  awsAccountId: z.string().regex(/^[0-9]{12}$/),
  status: SandboxAccountStatusSchema,
  name: z.string().max(50).optional(),
  email: z.email().optional(),
  activeCleanup: ActiveCleanupSchema.optional(),
  currentLease: CurrentLeaseSchema.optional(),
});

/**
 * The `Lease` union has one branch per status, so a read that returns a
 * `status` the seed never wrote would still be a *schema-valid* record. The
 * local seed is pinned to these three, and any other status is a signal the
 * store projected something the fixtures did not describe.
 */
export const SEEDED_LEASE_STATUSES = [
  "PendingApproval",
  "Active",
  "Expired",
] as const;

/** The admin principal the local edge signs in as; the seed writes it. */
export const SEEDED_ADMIN_PRINCIPAL_ID = LOCAL_IDC_PRINCIPAL_ID;
