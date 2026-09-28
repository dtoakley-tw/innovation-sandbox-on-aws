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

import { buildSeedFixtures } from "./fixtures.js";

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

  it("derives every configuration section from the production defaults", () => {
    const sections = Object.keys(ConfigSchemas) as ConfigSection[];
    expect(Object.keys(fixtures.configSections).sort()).toEqual(
      sections.sort(),
    );
    for (const section of sections) {
      // Equal to the defaults the Lambda middleware falls back to for an absent
      // section, so the local environment and a fresh deployment agree.
      expect(fixtures.configSections[section]).toEqual(
        ConfigSchemas[section].parse({}),
      );
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
});
