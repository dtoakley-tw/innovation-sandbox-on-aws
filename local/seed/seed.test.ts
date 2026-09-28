// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";

import {
  BlueprintSchemaVersion,
  PersistedBlueprintItemSchema,
} from "@amzn/innovation-sandbox-commons/data/blueprint/blueprint.js";
import { ConfigSchemaVersion } from "@amzn/innovation-sandbox-commons/data/config/config.js";
import {
  LeaseTemplateSchemaVersion,
  PersistedLeaseTemplateSchema,
} from "@amzn/innovation-sandbox-commons/data/lease-template/lease-template.js";
import {
  LeaseSchemaVersion,
  PersistedLeaseSchema,
} from "@amzn/innovation-sandbox-commons/data/lease/lease.js";
import {
  PersistedPrincipalCacheItemSchema,
  PrincipalSchemaVersion,
} from "@amzn/innovation-sandbox-commons/data/principal/principal.js";
import {
  PersistedSandboxAccountSchema,
  SandboxAccountSchemaVersion,
} from "@amzn/innovation-sandbox-commons/data/sandbox-account/sandbox-account.js";
import { ConfigSchemas } from "@amzn/innovation-sandbox-shared/types/configuration.js";

import { localTableNames } from "../shared/names.js";
import { SEED_TIME } from "./fixtures.js";
import { buildSeedWrites, summarizeWrites, type SeedWrite } from "./seed.js";

const writes = buildSeedWrites();
const itemsFor = (table: SeedWrite["table"]) =>
  writes.filter((write) => write.table === table).map((write) => write.item);

describe("seed records", () => {
  it("addresses every record the way the Dynamo stores address them", () => {
    for (const item of itemsFor("blueprint")) {
      // `IsbDataResources` gives the blueprint table a PK/SK key
      // (`isb-data-resources.ts:125`); a record that ignores this is invisible
      // to the read path, and `itemType` is the GSI partition key above it.
      expect(item.PK).toBe(`bp#${item.blueprintId}`);
      expect(item.SK).toBe("blueprint");
      expect(item.itemType).toBe("BLUEPRINT");
    }
    for (const item of itemsFor("principal")) {
      // `DynamoPrincipalStore` keys its typeahead cache on a fixed partition and
      // a prefixed sort key (`principal.ts:145`).
      expect(item.pk).toBe("principalCache");
      expect(item.sk).toBe(`user#${item.principalId}`);
    }
    for (const item of itemsFor("config")) {
      // One item per section, keyed `{ section, sk: "current" }`.
      expect(item.sk).toBe("current");
    }
    // The account, lease-template, and lease tables key on business fields the
    // fixture already carries, so nothing is added to address them. The test
    // below pins that for every table.
  });

  it("parses every seeded record against its persisted schema", () => {
    for (const item of itemsFor("sandboxAccount")) {
      expect(() => PersistedSandboxAccountSchema.parse(item)).not.toThrow();
    }
    for (const item of itemsFor("leaseTemplate")) {
      expect(() => PersistedLeaseTemplateSchema.parse(item)).not.toThrow();
    }
    for (const item of itemsFor("blueprint")) {
      expect(() => PersistedBlueprintItemSchema.parse(item)).not.toThrow();
    }
    for (const item of itemsFor("principal")) {
      expect(() => PersistedPrincipalCacheItemSchema.parse(item)).not.toThrow();
    }
    for (const item of itemsFor("lease")) {
      expect(() => PersistedLeaseSchema.parse(item)).not.toThrow();
    }
  });

  it("stamps the schema version every store's withMetadata decorator stamps", () => {
    const expected: Record<string, number> = {
      sandboxAccount: SandboxAccountSchemaVersion,
      leaseTemplate: LeaseTemplateSchemaVersion,
      blueprint: BlueprintSchemaVersion,
      principal: PrincipalSchemaVersion,
      lease: LeaseSchemaVersion,
    };
    for (const [table, schemaVersion] of Object.entries(expected)) {
      for (const item of itemsFor(table as SeedWrite["table"])) {
        expect(item.meta).toEqual({
          createdTime: SEED_TIME,
          lastEditTime: SEED_TIME,
          schemaVersion,
        });
      }
    }
  });

  it("writes config sections in the envelope DynamoConfigStore reads", () => {
    const sections = itemsFor("config");
    expect(sections).toHaveLength(Object.keys(ConfigSchemas).length);
    for (const item of sections) {
      expect(item.lastSavedBy).toEqual(expect.any(String));
      expect(item.meta).toEqual({
        createdTime: SEED_TIME,
        lastEditTime: SEED_TIME,
        schemaVersion: ConfigSchemaVersion,
      });

      // `DynamoConfigStore.toSectionData` drops the key and audit attributes
      // before validating, and `assembleGlobalConfig` drops the same pair again.
      // Reproducing that here proves the stored record survives the round trip
      // the Lambda performs on every cold start.
      const { section, sk, lastSavedBy, meta, ...fields } = item as Record<
        string,
        unknown
      >;
      expect(Object.keys(ConfigSchemas)).toContain(section);
      expect(() =>
        ConfigSchemas[section as keyof typeof ConfigSchemas].parse(fields),
      ).not.toThrow();
    }
  });

  it("keeps every TTL-bearing record past its expiry", () => {
    // The lease and principal tables both declare `ttl` as their TTL attribute,
    // and both schemas expect epoch seconds. A pinned timestamp in the past
    // means LocalStack reaps the record and the developer loses the example.
    const withTtl = [...itemsFor("lease"), ...itemsFor("principal")].filter(
      (item) => item.ttl !== undefined,
    );
    expect(withTtl.length).toBeGreaterThan(0);
    const now = Math.floor(Date.now() / 1000);
    for (const item of withTtl) {
      expect(item.ttl as number).toBeGreaterThan(now);
    }
  });

  it("gives every record the key attributes its table is declared with", () => {
    // Mirrors the key schemas in `local-data-stack.ts`. A record missing one is a
    // `ValidationException` at write time, and a duplicate key within a table is
    // the one thing the unconditional put loop exists to tolerate.
    const keyAttributes: Record<SeedWrite["table"], string[]> = {
      sandboxAccount: ["awsAccountId"],
      leaseTemplate: ["uuid"],
      lease: ["userEmail", "uuid"],
      blueprint: ["PK", "SK"],
      principal: ["pk", "sk"],
      cleanupReport: ["pk", "sk"],
      config: ["section", "sk"],
    };
    expect(Object.keys(keyAttributes).sort()).toEqual(
      Object.keys(localTableNames).sort(),
    );

    for (const [table, attributes] of Object.entries(keyAttributes)) {
      const items = itemsFor(table as SeedWrite["table"]);
      const keys = items.map((item) => attributes.map((name) => item[name]));
      for (const key of keys) {
        expect(key).not.toContain(undefined);
      }
      expect(new Set(keys.map((key) => JSON.stringify(key))).size).toBe(
        items.length,
      );
    }
  });

  it("reports one summary count per domain the fixtures cover", () => {
    expect(summarizeWrites(writes)).toEqual({
      accounts: itemsFor("sandboxAccount").length,
      leaseTemplates: itemsFor("leaseTemplate").length,
      blueprints: itemsFor("blueprint").length,
      principals: itemsFor("principal").length,
      leases: itemsFor("lease").length,
      configSections: itemsFor("config").length,
    });
  });
});
