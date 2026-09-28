// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import {
  type PersistedLeaseTemplate,
  PersistedLeaseTemplateSchema,
} from "@amzn/innovation-sandbox-commons/data/lease-template/lease-template.js";
import {
  type PersistedSandboxAccount,
  PersistedSandboxAccountSchema,
} from "@amzn/innovation-sandbox-commons/data/sandbox-account/sandbox-account.js";
import {
  type BlueprintItem,
  BlueprintItemSchema,
} from "@amzn/innovation-sandbox-shared/types/blueprint.js";
import {
  ConfigSchemas,
  type ConfigSection,
  type ConfigSectionFields,
} from "@amzn/innovation-sandbox-shared/types/configuration.js";
import {
  ExpiredLeaseSchema,
  type Lease,
  MonitoredLeaseSchema,
  PendingLeaseSchema,
} from "@amzn/innovation-sandbox-shared/types/lease.js";
import {
  type IdcPrincipal,
  IdcPrincipalSchema,
} from "@amzn/innovation-sandbox-shared/types/principal.js";

import { LOCAL_ACCOUNT_ID, LOCAL_REGION } from "../shared/names.js";

/**
 * The fixture data a developer sees on the first `local:up`.
 *
 * Every record is produced by parsing a pinned literal against the production
 * schema that describes it, and the type comes from that same schema. Parsing
 * rather than generating is the point: an upstream field that becomes required
 * makes `buildSeedFixtures` throw, and `fixtures.test.ts` fails naming the
 * field, instead of the seed quietly writing a record the application rejects
 * at request time. The repo's `generateSchemaData` helper cannot be used here.
 * It is random, so a value it invents differs on every `local:up` and breaks
 * the deep links this seed exists to make stable; and fed a discriminated union
 * it fills the first branch regardless of the `status` override, so an `Active`
 * lease comes out PendingApproval-shaped and fails its own schema.
 *
 * The split from `seed.ts` is deliberate. These are the business fields; the
 * DynamoDB key attributes and the `meta`/`lastSavedBy` envelopes are the
 * store's, and the shared schemas say so in their own doc comments — "DynamoDB
 * keys and frontend-only presentation fields belong in their owners" on
 * `BlueprintItemSchema`, "storage keys and UI normalization belong elsewhere"
 * on `IdcPrincipalSchema`. `seed.ts` adds them and its tests validate the
 * result against the persisted schemas.
 */

/** The instant the whole fixture set is written at, so `meta` is reproducible. */
export const SEED_TIME = "2026-01-15T12:00:00.000Z";

/**
 * The single identity `local/edge/routes/session.ts` signs in as. It owns every
 * seeded lease, because `getLeasesForUser` queries on the token's email and a
 * lease owned by anyone else never reaches the home page. It is also the audit
 * identity the config sections are attributed to.
 */
export const ADMIN_EMAIL = "admin@example.local";

const OWNER_EMAIL = ADMIN_EMAIL;

/**
 * An epoch far enough out that DynamoDB never reaps the records carrying it.
 * The lease and principal tables both declare `ttl` as their TTL attribute and
 * both schemas expect epoch seconds, so a pinned timestamp inside the TTL
 * window would delete the expired-lease and typeahead examples. Production
 * writes `now + leases.ttl days`; nothing schedules that here, so the value is
 * simply distant. 2100-01-01T00:00:00Z.
 */
export const DISTANT_FUTURE_TTL = 4_102_444_800;

export interface SeedFixtures {
  accounts: PersistedSandboxAccount[];
  leaseTemplates: PersistedLeaseTemplate[];
  blueprints: BlueprintItem[];
  principals: IdcPrincipal[];
  leases: Lease[];
  configSections: Record<ConfigSection, ConfigSectionFields<ConfigSection>>;
}

/**
 * The three personas a developer can act as. Roles are deliberately absent:
 * `IsbRoleSchema` is not part of any persisted schema, because the role is a
 * Cognito claim (`custom:isb_roles`) the Pre Token Generation Lambda injects
 * and `local/edge/mint-token.ts` signs locally. What the seed contributes is
 * the principal a lease can be shared with.
 *
 * The ids are UUIDs because `IdcPrincipalIdSchema` requires one. They
 * deliberately differ from the local edge's `sub` of `local-admin`, which that
 * schema would reject; nothing looks a principal up by the signed-in user's own
 * id, so the mismatch is inert today.
 */
const PRINCIPALS = [
  {
    principalId: "0aaa0000-0000-4000-8000-000000000001",
    displayName: "Local Admin",
    email: OWNER_EMAIL,
  },
  {
    principalId: "0aaa0000-0000-4000-8000-000000000002",
    displayName: "Local Manager",
    email: "manager@example.local",
  },
  {
    principalId: "0aaa0000-0000-4000-8000-000000000003",
    displayName: "Local User",
    email: "user@example.local",
  },
] as const;

const BLUEPRINTS = [
  {
    blueprintId: "0bbb0000-0000-4000-8000-000000000001",
    name: "local-blueprint-baseline",
    tags: { environment: "local", owner: "platform" },
    totalHealthMetrics: {
      totalDeploymentCount: 2,
      totalSuccessfulCount: 2,
      lastDeploymentAt: "2026-01-16T11:45:00.000Z",
    },
  },
  {
    blueprintId: "0bbb0000-0000-4000-8000-000000000002",
    name: "local-blueprint-advanced",
    tags: { environment: "local", owner: "platform" },
    totalHealthMetrics: {
      totalDeploymentCount: 1,
      totalSuccessfulCount: 0,
      lastDeploymentAt: "2026-01-16T10:05:00.000Z",
    },
  },
] as const;

/**
 * Two templates, one requiring approval and one not, so the approvals queue and
 * the auto-approved path both have data. The spend and duration ceilings sit
 * under the seeded `leases` config defaults (`maxBudget: 50`,
 * `maxDurationHours: 168`), so a developer can still create a lease from them.
 */
const LEASE_TEMPLATES = [
  {
    uuid: "0ccc0000-0000-4000-8000-000000000001",
    name: "local-standard-lease",
    description: "Standard sandbox lease awaiting approval.",
    requiresApproval: true,
    blueprintId: BLUEPRINTS[0].blueprintId,
    blueprintName: BLUEPRINTS[0].name,
    allowOwnerToShareLease: true,
    maxSpend: 25,
    budgetThresholds: [{ dollarsSpent: 20, action: "ALERT" }],
    leaseDurationInHours: 24,
    durationThresholds: [{ hoursRemaining: 4, action: "ALERT" }],
    costReportGroup: "local",
  },
  {
    uuid: "0ccc0000-0000-4000-8000-000000000002",
    name: "local-exploratory-lease",
    description: "Short exploratory lease that skips approval.",
    requiresApproval: false,
    blueprintId: BLUEPRINTS[1].blueprintId,
    blueprintName: BLUEPRINTS[1].name,
    maxSpend: 10,
    budgetThresholds: [{ dollarsSpent: 8, action: "ALERT" }],
    leaseDurationInHours: 8,
    durationThresholds: [{ hoursRemaining: 2, action: "ALERT" }],
  },
] as const;

const ACCOUNTS = [
  {
    awsAccountId: "111111111111",
    name: "local-sandbox-active",
    email: "111111111111@sandbox.local",
    status: "Active",
  },
  {
    awsAccountId: "222222222222",
    name: "local-sandbox-available",
    email: "222222222222@sandbox.local",
    status: "Available",
  },
  {
    awsAccountId: "333333333333",
    name: "local-sandbox-cleaning",
    email: "333333333333@sandbox.local",
    status: "CleanUp",
    activeCleanup: {
      status: "INITIALIZING",
      executionArn: `arn:aws:states:${LOCAL_REGION}:${LOCAL_ACCOUNT_ID}:execution:isb-local-cleanup:local-sandbox-cleaning`,
      startedAt: "2026-01-17T10:00:00.000Z",
    },
  },
] as const;

export function buildSeedFixtures(): SeedFixtures {
  const blueprints = BLUEPRINTS.map((blueprint) =>
    BlueprintItemSchema.parse({ ...blueprint, createdBy: OWNER_EMAIL }),
  );

  const leaseTemplates = LEASE_TEMPLATES.map((template) =>
    PersistedLeaseTemplateSchema.parse({
      ...template,
      createdBy: OWNER_EMAIL,
    }),
  );

  const principals = PRINCIPALS.map((principal) =>
    IdcPrincipalSchema.parse({ ...principal, principalType: "USER" }),
  );

  const [standard, exploratory] = leaseTemplates;

  // `LeaseSchema` is a discriminated union, so each lease is parsed against the
  // branch its `status` selects. Parsing the union itself would accept a
  // PendingApproval-shaped record labelled `status: "Active"`, or reject a
  // `PendingApproval` lease that still carries an `awsAccountId`.
  const pendingLease = PendingLeaseSchema.parse({
    uuid: "0ddd0000-0000-4000-8000-000000000001",
    userEmail: OWNER_EMAIL,
    status: "PendingApproval",
    originalLeaseTemplateUuid: standard.uuid,
    originalLeaseTemplateName: standard.name,
    createdBy: OWNER_EMAIL,
    blueprintId: standard.blueprintId,
    blueprintName: standard.blueprintName,
    comments:
      "Requested from the local seed; approve me from the approvals page.",
    allowOwnerToShareLease: standard.allowOwnerToShareLease,
    maxSpend: standard.maxSpend,
    budgetThresholds: standard.budgetThresholds,
    leaseDurationInHours: standard.leaseDurationInHours,
    durationThresholds: standard.durationThresholds,
    costReportGroup: standard.costReportGroup,
  });

  const activeLease = MonitoredLeaseSchema.parse({
    uuid: "0ddd0000-0000-4000-8000-000000000002",
    userEmail: OWNER_EMAIL,
    status: "Active",
    originalLeaseTemplateUuid: standard.uuid,
    originalLeaseTemplateName: standard.name,
    createdBy: OWNER_EMAIL,
    blueprintId: standard.blueprintId,
    blueprintName: standard.blueprintName,
    allowOwnerToShareLease: standard.allowOwnerToShareLease,
    maxSpend: standard.maxSpend,
    budgetThresholds: standard.budgetThresholds,
    leaseDurationInHours: standard.leaseDurationInHours,
    durationThresholds: standard.durationThresholds,
    costReportGroup: standard.costReportGroup,
    awsAccountId: ACCOUNTS[0].awsAccountId,
    approvedBy: "manager@example.local",
    startDate: SEED_TIME,
    lastCheckedDate: "2026-01-16T12:00:00.000Z",
    expirationDate: "2026-01-22T12:00:00.000Z",
    totalCostAccrued: 4.21,
  });

  const expiredLease = ExpiredLeaseSchema.parse({
    uuid: "0ddd0000-0000-4000-8000-000000000003",
    userEmail: OWNER_EMAIL,
    status: "Expired",
    originalLeaseTemplateUuid: exploratory.uuid,
    originalLeaseTemplateName: exploratory.name,
    createdBy: OWNER_EMAIL,
    blueprintId: exploratory.blueprintId,
    blueprintName: exploratory.blueprintName,
    allowOwnerToShareLease: exploratory.allowOwnerToShareLease,
    maxSpend: exploratory.maxSpend,
    budgetThresholds: exploratory.budgetThresholds,
    leaseDurationInHours: exploratory.leaseDurationInHours,
    durationThresholds: exploratory.durationThresholds,
    awsAccountId: ACCOUNTS[1].awsAccountId,
    approvedBy: "AUTO_APPROVED",
    startDate: SEED_TIME,
    lastCheckedDate: "2026-01-17T09:30:00.000Z",
    endDate: "2026-01-17T09:30:00.000Z",
    totalCostAccrued: 7.94,
    ttl: DISTANT_FUTURE_TTL,
  });

  // The account the active lease holds. `CurrentLease` is how the accounts list
  // links an account back to the lease that owns it.
  const accounts = ACCOUNTS.map((account) => {
    const held =
      account.awsAccountId === activeLease.awsAccountId
        ? activeLease
        : undefined;
    return PersistedSandboxAccountSchema.parse({
      ...account,
      ...(held && {
        currentLease: { leaseId: held.uuid, ownerEmail: held.userEmail },
      }),
    });
  });

  return {
    accounts,
    leaseTemplates,
    blueprints,
    principals,
    leases: [pendingLease, activeLease, expiredLease],
    // The code defaults are exactly what `isbConfigMiddleware` falls back to for
    // an absent section, so a seeded LocalStack and a fresh deployment hand the
    // application the same configuration. Deriving rather than hand-writing
    // means an upstream field change breaks here, not in the browser.
    configSections: Object.fromEntries(
      (Object.keys(ConfigSchemas) as ConfigSection[]).map((section) => [
        section,
        ConfigSchemas[section].parse({}),
      ]),
    ) as SeedFixtures["configSections"],
  };
}
