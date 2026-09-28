// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, PutCommand } from "@aws-sdk/lib-dynamodb";
import { pathToFileURL } from "node:url";

import { BlueprintSchemaVersion } from "@amzn/innovation-sandbox-commons/data/blueprint/blueprint.js";
import { ConfigSchemaVersion } from "@amzn/innovation-sandbox-commons/data/config/config.js";
import { LeaseTemplateSchemaVersion } from "@amzn/innovation-sandbox-commons/data/lease-template/lease-template.js";
import { LeaseSchemaVersion } from "@amzn/innovation-sandbox-commons/data/lease/lease.js";
import { PrincipalSchemaVersion } from "@amzn/innovation-sandbox-commons/data/principal/principal.js";
import { SandboxAccountSchemaVersion } from "@amzn/innovation-sandbox-commons/data/sandbox-account/sandbox-account.js";

import { LOCALSTACK_ENDPOINT } from "../infrastructure/lib/lambda-environment.js";
import {
  LOCAL_REGION,
  localTableNames,
  type LocalTableName,
} from "../shared/names.js";
import {
  ADMIN_EMAIL,
  buildSeedFixtures,
  DISTANT_FUTURE_TTL,
  SEED_TIME,
} from "./fixtures.js";

/**
 * Where the schema-derived fixtures stop and the store's addressing begins.
 * `fixtures.ts` produces the business fields; this module adds what the real
 * stores add when they persist them — the DynamoDB key attributes the key
 * schemas declare, and the `meta` envelope each store's `@withMetadata`
 * decorator stamps. `seed.test.ts` validates the result against the persisted
 * schemas, so a key that stops matching its store's key schema fails there.
 */

/** One unconditional `PutItem`, already addressed to its table. */
export interface SeedWrite {
  table: LocalTableName;
  item: Record<string, unknown>;
}

export interface SeedSummary {
  accounts: number;
  leaseTemplates: number;
  blueprints: number;
  principals: number;
  leases: number;
  configSections: number;
}

export interface SeedOptions {
  endpoint?: string;
  region?: string;
}

/** The `meta` the stores' `@withMetadata` decorators stamp on a write. */
const metadata = (schemaVersion: number) => ({
  createdTime: SEED_TIME,
  lastEditTime: SEED_TIME,
  schemaVersion,
});

/**
 * The principal table's typeahead cache, keyed the way `DynamoPrincipalStore`
 * builds its keys (`principal.ts:145`): a fixed partition and a prefixed sort
 * key. The lease, account, and template tables key on business fields the
 * fixture already carries, so they need no added attributes.
 */
const principalCacheKey = (principalId: string) => ({
  pk: "principalCache",
  sk: `user#${principalId}`,
});

/**
 * Assembles every record the seed writes, addressed and enveloped. Kept pure
 * and separate from the writes themselves so the addressing is testable without
 * a running LocalStack.
 */
export function buildSeedWrites(): SeedWrite[] {
  const fixtures = buildSeedFixtures();

  return [
    ...fixtures.accounts.map((item) => ({
      table: "sandboxAccount" as const,
      item: { ...item, meta: metadata(SandboxAccountSchemaVersion) },
    })),
    ...fixtures.leaseTemplates.map((item) => ({
      table: "leaseTemplate" as const,
      item: { ...item, meta: metadata(LeaseTemplateSchemaVersion) },
    })),
    ...fixtures.blueprints.map((item) => ({
      table: "blueprint" as const,
      item: {
        ...item,
        PK: `bp#${item.blueprintId}`,
        SK: "blueprint",
        itemType: "BLUEPRINT",
        meta: metadata(BlueprintSchemaVersion),
      },
    })),
    ...fixtures.principals.map((item) => ({
      table: "principal" as const,
      item: {
        ...item,
        ...principalCacheKey(item.principalId),
        syncedAt: SEED_TIME,
        ttl: DISTANT_FUTURE_TTL,
        meta: metadata(PrincipalSchemaVersion),
      },
    })),
    ...fixtures.leases.map((item) => ({
      table: "lease" as const,
      item: { ...item, meta: metadata(LeaseSchemaVersion) },
    })),
    // The envelope `DynamoConfigStore` reads: keyed `{ section, sk: "current" }`
    // with the section's fields, the audit identity, and the three meta fields
    // `toSectionData` refuses to read without.
    ...Object.entries(fixtures.configSections).map(([section, fields]) => ({
      table: "config" as const,
      item: {
        section,
        sk: "current",
        ...fields,
        lastSavedBy: ADMIN_EMAIL,
        meta: metadata(ConfigSchemaVersion),
      },
    })),
  ];
}

/** Counts what the seed wrote, one entry per domain the fixtures cover. */
export function summarizeWrites(writes: SeedWrite[]): SeedSummary {
  const count = (table: LocalTableName) =>
    writes.filter((write) => write.table === table).length;
  return {
    accounts: count("sandboxAccount"),
    leaseTemplates: count("leaseTemplate"),
    blueprints: count("blueprint"),
    principals: count("principal"),
    leases: count("lease"),
    configSections: count("config"),
  };
}

/** Document client pointed at LocalStack; no AWS credentials are ever needed. */
export function createLocalDocumentClient(options: SeedOptions = {}) {
  return DynamoDBDocumentClient.from(
    new DynamoDBClient({
      region: options.region ?? LOCAL_REGION,
      endpoint: options.endpoint ?? LOCALSTACK_ENDPOINT,
      credentials: { accessKeyId: "test", secretAccessKey: "test" },
    }),
    { marshallOptions: { removeUndefinedValues: true } },
  );
}

/**
 * Writes the fixture set into LocalStack. Idempotent: every write is an
 * unconditional `PutCommand` keyed by the record's own identifier, so re-running
 * after a partial deep-flow failure restores a known-good state without dropping
 * the tables. This is the documented remedy for the partial writes that the
 * unsupported services can leave behind.
 */
export async function seedLocalEnvironment(
  options: SeedOptions = {},
): Promise<SeedSummary> {
  const writes = buildSeedWrites();
  const client = createLocalDocumentClient(options);

  // Unconditional puts, one item at a time. `BatchWriteCommand` would be faster
  // but rejects duplicate keys within a batch, and re-running the seed must
  // overwrite in place rather than fail on items that already exist.
  for (const { table, item } of writes) {
    await client.send(
      new PutCommand({ TableName: localTableNames[table], Item: item }),
    );
  }

  return summarizeWrites(writes);
}

// Only when invoked as a script. `seed.test.ts` imports this module, and
// `process.argv[1]` there is the test runner's path, so the check has to be an
// identity comparison rather than a substring match.
const invokedDirectly =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  seedLocalEnvironment()
    .then((summary) => {
      console.info("[local-seed] seeded", summary);
    })
    .catch((error: unknown) => {
      console.error("[local-seed] failed", error);
      process.exit(1);
    });
}
