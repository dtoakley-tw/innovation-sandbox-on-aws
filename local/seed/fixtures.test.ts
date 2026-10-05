// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { PersistedLeaseTemplateSchema } from "@amzn/innovation-sandbox-commons/data/lease-template/lease-template.js";
import {
  PersistedSandboxAccountSchema,
  type PersistedSandboxAccount,
} from "@amzn/innovation-sandbox-commons/data/sandbox-account/sandbox-account.js";
import { BlueprintItemSchema } from "@amzn/innovation-sandbox-shared/types/blueprint.js";
import {
  ConfigSchemas,
  type ConfigSection,
} from "@amzn/innovation-sandbox-shared/types/configuration.js";
import {
  ExpiredLeaseSchema,
  isExpiredLease,
  isMonitoredLease,
  MonitoredLeaseSchema,
  PendingLeaseSchema,
  type Lease,
} from "@amzn/innovation-sandbox-shared/types/lease.js";
import { IdcPrincipalSchema } from "@amzn/innovation-sandbox-shared/types/principal.js";

import { LOCAL_IDC_PRINCIPAL_ID } from "../shared/names.js";
import { ADMIN_EMAIL, buildSeedFixtures } from "./fixtures.js";

/**
 * The branch of `LeaseSchema` a lease's `status` selects. Building a value from
 * the union alone fills whichever branch comes first regardless of the `status`
 * override, which is how a PendingApproval-shaped record ends up claiming
 * `status: "Active"`.
 */
const branchFor = (lease: Lease): z.ZodType =>
  lease.status === "PendingApproval"
    ? PendingLeaseSchema
    : isExpiredLease(lease)
      ? ExpiredLeaseSchema
      : MonitoredLeaseSchema;

const fixtures = buildSeedFixtures();

describe("seed fixtures", () => {
  it("builds the same fixtures on every run", () => {
    // Every value is pinned rather than generated, so an upstream field the
    // seed has not been taught to fill shows up here instead of changing on
    // every `local:up` and quietly breaking a deep link.
    expect(JSON.stringify(buildSeedFixtures())).toBe(
      JSON.stringify(buildSeedFixtures()),
    );
  });

  it("populates every domain the local environment renders", () => {
    // Without this, an emptied domain would pass every other test here: each of
    // the loops below iterates a fixture array, so an empty array is vacuously
    // conformant and cross-reference-free. The brief called for this and its
    // version only covered four of the six domains.
    expect(fixtures.accounts.length).toBeGreaterThan(0);
    expect(fixtures.blueprints.length).toBeGreaterThan(0);
    expect(fixtures.leaseTemplates.length).toBeGreaterThan(0);
    expect(fixtures.principals.length).toBeGreaterThan(0);
    expect(fixtures.leases.length).toBeGreaterThan(0);
    expect(Object.keys(fixtures.configSections).length).toBeGreaterThan(0);
  });

  it("parses every fixture against the production schema that describes it", () => {
    // Compared against the parse result rather than merely checked not to throw,
    // so a fixture carrying a field its schema does not declare is caught even
    // where that schema is not strict.
    const cases: [z.ZodType, unknown[]][] = [
      [PersistedSandboxAccountSchema, fixtures.accounts],
      [PersistedLeaseTemplateSchema, fixtures.leaseTemplates],
      [BlueprintItemSchema, fixtures.blueprints],
      [IdcPrincipalSchema, fixtures.principals],
    ];
    for (const [schema, values] of cases) {
      expect(values.length).toBeGreaterThan(0);
      for (const value of values) {
        expect(schema.parse(value)).toEqual(value);
      }
    }
  });

  it("builds every lease against the branch its status selects", () => {
    for (const lease of fixtures.leases) {
      // `toEqual` against the parse result also proves the fixture carries no
      // field the branch does not declare: a PendingApproval lease holding an
      // `awsAccountId` would be stripped by the parse and fail here.
      expect(branchFor(lease).parse(lease)).toEqual(lease);
    }
    const pending = fixtures.leases.find(
      (lease) => lease.status === "PendingApproval",
    );
    expect(pending).toBeDefined();
    expect(pending).not.toHaveProperty("awsAccountId");
  });

  it("covers the lease lifecycle a developer lands on first", () => {
    const statuses = new Set(fixtures.leases.map((lease) => lease.status));
    expect(statuses).toEqual(
      new Set<Lease["status"]>(["PendingApproval", "Active", "Expired"]),
    );
  });

  it("gives the accounts list three states to render differently", () => {
    expect(new Set(fixtures.accounts.map((a) => a.status))).toEqual(
      new Set<PersistedSandboxAccount["status"]>([
        "Active",
        "Available",
        "CleanUp",
      ]),
    );
  });

  it("seeds a principal for each of the three role personas", () => {
    // Roles are not persisted anywhere — they are a Cognito claim
    // (`custom:isb_roles`) minted by `local/edge/mint-token.ts` from the
    // server-side allowlist — so what the seed can offer is a principal per
    // persona to assign and search for, which is what this asserts.
    expect(
      fixtures.principals.map((principal) => principal.email).sort(),
    ).toEqual([
      "admin@example.local",
      "manager@example.local",
      "user@example.local",
    ]);
    for (const principal of fixtures.principals) {
      expect(principal.principalType).toBe("USER");
    }
  });

  it("gives every record a distinct identifier for a deep link to address", () => {
    const uuids = fixtures.leases.map((lease) => lease.uuid);
    expect(new Set(uuids).size).toBe(uuids.length);
    expect(
      new Set(fixtures.blueprints.map((blueprint) => blueprint.blueprintId))
        .size,
    ).toBe(fixtures.blueprints.length);
    expect(
      new Set(fixtures.leaseTemplates.map((template) => template.uuid)).size,
    ).toBe(fixtures.leaseTemplates.length);
  });

  it("resolves every cross-reference to a record in this same fixture set", () => {
    const blueprints = new Map(
      fixtures.blueprints.map((blueprint) => [
        blueprint.blueprintId,
        blueprint,
      ]),
    );
    const templates = new Map(
      fixtures.leaseTemplates.map((template) => [template.uuid, template]),
    );
    const accounts = new Set(
      fixtures.accounts.map((account) => account.awsAccountId),
    );
    const leases = new Set(fixtures.leases.map((lease) => lease.uuid));

    for (const template of fixtures.leaseTemplates) {
      const blueprintId = template.blueprintId ?? undefined;
      const blueprint =
        blueprintId === undefined ? undefined : blueprints.get(blueprintId);
      expect(blueprint).toBeDefined();
      expect(template.blueprintName).toBe(blueprint?.name);
    }

    for (const lease of fixtures.leases) {
      const template = templates.get(lease.originalLeaseTemplateUuid);
      expect(template).toBeDefined();
      expect(lease.originalLeaseTemplateName).toBe(template?.name);

      const blueprintId = lease.blueprintId ?? undefined;
      const blueprint =
        blueprintId === undefined ? undefined : blueprints.get(blueprintId);
      expect(blueprint).toBeDefined();
      expect(lease.blueprintName).toBe(blueprint?.name);

      if (isMonitoredLease(lease)) {
        expect(accounts.has(lease.awsAccountId)).toBe(true);
      }
    }

    for (const account of fixtures.accounts) {
      const current = account.currentLease;
      if (current === undefined) continue;
      expect(leases.has(current.leaseId)).toBe(true);
      const lease = fixtures.leases.find(
        (candidate) => candidate.uuid === current.leaseId,
      );
      expect(lease).toBeDefined();
      const heldBy =
        lease && isMonitoredLease(lease) ? lease.awsAccountId : undefined;
      expect(heldBy).toBe(account.awsAccountId);
    }
  });

  // Two of the six sections differ from the code defaults, and both departures
  // exist so the seed agrees with *itself*: `buildConfigSections` explains why,
  // and the check here is that nothing else has drifted. Asserted as an explicit
  // allow-list of overrides rather than as a blanket equality, because a blanket
  // equality is what let the seed ship records its own API refuses to create —
  // every seeded template and lease carried `allowOwnerToShareLease: true` and
  // `costReportGroup: "local"` while the configuration forbade both, so every
  // write to a seeded record 400'd before the handler ran.
  it("derives every configuration section from the production defaults", () => {
    const sections = Object.keys(ConfigSchemas) as ConfigSection[];
    expect(Object.keys(fixtures.configSections).sort()).toEqual(
      sections.sort(),
    );
    // The only two sections that may differ, and the only field in each.
    const OVERRIDES: Partial<Record<ConfigSection, string[]>> = {
      leases: ["leaseSharingEnabled"],
      costReporting: ["costReportGroups"],
    };
    for (const section of sections) {
      const defaults = ConfigSchemas[section].parse({}) as Record<
        string,
        unknown
      >;
      const actual = fixtures.configSections[section] as Record<
        string,
        unknown
      >;
      // Same key set as the defaults, so an upstream section that gains a field
      // still arrives here through `ConfigSchemas[section].parse({})` rather
      // than being silently absent from the seed.
      expect(Object.keys(actual).sort()).toEqual(Object.keys(defaults).sort());
      const overridden = OVERRIDES[section] ?? [];
      for (const [key, value] of Object.entries(defaults)) {
        if (overridden.includes(key)) continue;
        expect(actual[key], `${section}.${key}`).toEqual(value);
      }
    }
  });

  // The two overrides are not free choices: each one makes a field the seed's
  // own records already use legal, and the API rejects them otherwise. Observed
  // against a profile seeded with the pure defaults:
  //   POST /api/leaseTemplates (the seeded template verbatim)
  //     -> 400 "Cannot enable allowOwnerToShareLease because lease sharing is
  //            not available."
  //   PATCH /api/leases/{id} -> 400 "Invalid cost report group"
  it("seeds a configuration its own lease and template records are legal under", () => {
    const leases = fixtures.configSections.leases as {
      leaseSharingEnabled: boolean;
    };
    const costReporting = fixtures.configSections.costReporting as {
      costReportGroups: string[];
    };
    // `validateLeaseSharingEnabled` rejects any lease or template with
    // `allowOwnerToShareLease: true` while the flag is off.
    expect(leases.leaseSharingEnabled).toBe(true);
    for (const template of fixtures.leaseTemplates) {
      if (template.allowOwnerToShareLease) {
        expect(leases.leaseSharingEnabled, template.name).toBe(true);
      }
    }
    for (const lease of fixtures.leases) {
      if (lease.allowOwnerToShareLease) {
        expect(leases.leaseSharingEnabled, lease.uuid).toBe(true);
      }
    }
    // `validateCostReportGroup` checks membership whenever the field is set,
    // on create and on update alike.
    for (const template of fixtures.leaseTemplates) {
      if (template.costReportGroup !== undefined) {
        expect(
          costReporting.costReportGroups,
          `${template.name}.costReportGroup=${template.costReportGroup}`,
        ).toContain(template.costReportGroup);
      }
    }
    for (const lease of fixtures.leases) {
      if (lease.costReportGroup !== undefined) {
        expect(
          costReporting.costReportGroups,
          `${lease.uuid}.costReportGroup=${lease.costReportGroup}`,
        ).toContain(lease.costReportGroup);
      }
    }
  });

  it("keeps every lease owned by the identity the local edge signs in as", () => {
    // `local/edge/routes/session.ts` mints one token for one email, and
    // `getLeasesForUser` queries on the token's email. A lease owned by anyone
    // else is invisible on the home page.
    const owner = "admin@example.local";
    expect(
      fixtures.leases.filter((lease) => lease.userEmail === owner),
    ).toHaveLength(fixtures.leases.length);
  });

  // The email alone is not the join. The edge mints `custom:idc_user_id` from
  // its own `sub`, the shared-leases and group-membership lookups key on that
  // id, and the API rejects it with a 400 unless it parses as an IDC principal
  // id — so the seeded admin has to be reachable by the id the token carries.
  it("seeds the admin principal under the id the local edge signs in as", () => {
    const admin = fixtures.principals.find(
      (principal) => principal.email === ADMIN_EMAIL,
    );
    expect(admin).toBeDefined();
    expect(admin?.principalId).toBe(LOCAL_IDC_PRINCIPAL_ID);
  });

  // The other two personas are never signed in as, so a collision with the local
  // identity's id would make one principal two people.
  it("keeps every seeded principal id distinct", () => {
    const ids = fixtures.principals.map((principal) => principal.principalId);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
