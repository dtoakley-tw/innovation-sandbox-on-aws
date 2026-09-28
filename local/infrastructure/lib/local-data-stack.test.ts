// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import { App } from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { beforeAll, describe, expect, it } from "vitest";

import {
  LOCAL_ACCOUNT_ID,
  LOCAL_REGION,
  LOCAL_TABLE_NAMES,
  localTableNames,
} from "../../shared/names.js";
import { LocalDataStack } from "./local-data-stack.js";

let stack: LocalDataStack;
let template: Template;

beforeAll(() => {
  const app = new App();
  stack = new LocalDataStack(app, "LocalData", {
    env: { account: LOCAL_ACCOUNT_ID, region: LOCAL_REGION },
  });
  template = Template.fromStack(stack);
});

const tables = () => template.findResources("AWS::DynamoDB::Table");

/** Index definitions keyed by name, flattened across the seven tables. */
const indexes = () =>
  Object.fromEntries(
    Object.values(tables()).flatMap((table) =>
      (table.Properties.GlobalSecondaryIndexes ?? []).map(
        (gsi: {
          IndexName: string;
          KeySchema: { AttributeName: string }[];
          Projection: { ProjectionType: string };
        }) => [
          gsi.IndexName,
          {
            keys: gsi.KeySchema.map((key) => key.AttributeName),
            projection: gsi.Projection.ProjectionType,
          },
        ],
      ),
    ),
  );

describe("LocalDataStack", () => {
  it("creates exactly seven tables", () => {
    template.resourceCountIs("AWS::DynamoDB::Table", LOCAL_TABLE_NAMES.length);
  });

  it("keys the lease table by userEmail with a uuid sort key and a ttl attribute", () => {
    template.hasResourceProperties("AWS::DynamoDB::Table", {
      KeySchema: [
        { AttributeName: "userEmail", KeyType: "HASH" },
        { AttributeName: "uuid", KeyType: "RANGE" },
      ],
      TimeToLiveSpecification: { AttributeName: "ttl" },
    });
  });

  it("keys the blueprint table by PK/SK", () => {
    template.hasResourceProperties("AWS::DynamoDB::Table", {
      KeySchema: [
        { AttributeName: "PK", KeyType: "HASH" },
        { AttributeName: "SK", KeyType: "RANGE" },
      ],
    });
  });

  // Pinned exactly, not just "contains these": a GSI dropped, renamed, or
  // given the wrong sort key synthesizes cleanly and only fails as a query that
  // quietly returns nothing.
  it("creates exactly the GSIs the production stores query", () => {
    expect(indexes()).toEqual({
      "blueprintId-index": { keys: ["blueprintId"], projection: "KEYS_ONLY" },
      StatusIndex: {
        keys: ["status", "originalLeaseTemplateUuid"],
        projection: "ALL",
      },
      "itemType-blueprintId-index": {
        keys: ["itemType", "blueprintId"],
        projection: "ALL",
      },
      LeaseIndex: { keys: ["leaseId", "pk"], projection: "ALL" },
      GroupIndex: { keys: ["groupId"], projection: "KEYS_ONLY" },
    });
  });

  it("keys the config table by section/sk as the ConfigStore expects", () => {
    template.hasResourceProperties("AWS::DynamoDB::Table", {
      KeySchema: [
        { AttributeName: "section", KeyType: "HASH" },
        { AttributeName: "sk", KeyType: "RANGE" },
      ],
    });
  });

  it("keys the sandbox account table by awsAccountId alone", () => {
    template.hasResourceProperties("AWS::DynamoDB::Table", {
      KeySchema: [{ AttributeName: "awsAccountId", KeyType: "HASH" }],
    });
  });

  it("keys the principal and cleanup report tables by pk/sk", () => {
    const pkKeyed = Object.values(tables()).filter(
      (table) => table.Properties.KeySchema?.[0]?.AttributeName === "pk",
    );
    expect(pkKeyed).toHaveLength(2);
    for (const table of pkKeyed) {
      expect(table.Properties.KeySchema).toEqual([
        { AttributeName: "pk", KeyType: "HASH" },
        { AttributeName: "sk", KeyType: "RANGE" },
      ]);
    }
  });

  it("encrypts every table with the one local KMS key", () => {
    const keyIds = Object.keys(template.findResources("AWS::KMS::Key"));
    expect(keyIds).toHaveLength(1);
    for (const [id, table] of Object.entries(tables())) {
      expect(table.Properties.SSESpecification, id).toEqual({
        // Asserts the key, not merely some key: a table pointed at a different
        // KMS key would synthesize cleanly and fail every read at runtime.
        KMSMasterKeyId: { "Fn::GetAtt": [keyIds[0], "Arn"] },
        SSEEnabled: true,
        SSEType: "KMS",
      });
    }
  });

  it("puts every table on on-demand billing so seeding never waits on capacity", () => {
    for (const [id, table] of Object.entries(tables())) {
      expect(table.Properties.BillingMode, id).toBe("PAY_PER_REQUEST");
    }
  });

  // The Lambdas address the tables by name through buildLocalEnv, so the names
  // live in `localTableNames` and are asserted from there rather than restated.
  it("names every table the way localTableNames declares", () => {
    const names = Object.values(tables()).map(
      (table) => table.Properties.TableName,
    );
    expect(names.sort()).toEqual(Object.values(localTableNames).sort());
  });

  // The record the later tasks read. Asserted against the template rather than
  // against `Table.tableName`, which hands back the table's Ref token.
  it("exposes every table on the typed record the later tasks read", () => {
    expect(Object.keys(stack.tables).sort()).toEqual(
      [...LOCAL_TABLE_NAMES].sort(),
    );
    for (const name of LOCAL_TABLE_NAMES) {
      const ref = stack.resolve(stack.tables[name].tableName) as {
        Ref: string;
      };
      expect(tables()[ref.Ref]?.Properties.TableName, name).toBe(
        localTableNames[name],
      );
    }
  });

  // Production sets point-in-time recovery and deletion protection on every
  // table and keeps them on RETAIN outside dev mode. The local profile is a
  // single ephemeral deployment behind `local:reset`, so recovery has nothing
  // to recover and a retained table would only block the next deploy.
  it("keeps the tables ephemeral rather than durable or protected", () => {
    for (const [id, table] of Object.entries(tables())) {
      expect(
        table.Properties.PointInTimeRecoverySpecification,
        id,
      ).toBeUndefined();
      expect(table.Properties.DeletionProtectionEnabled, id).toBeUndefined();
      expect(table.DeletionPolicy, id).toBe("Delete");
    }
    for (const [id, key] of Object.entries(
      template.findResources("AWS::KMS::Key"),
    )) {
      expect(key.DeletionPolicy, id).toBe("Delete");
    }
  });

  // `IsbDataResources` also builds Cognito user and identity pools, a SAML
  // provider, AppConfig, an IAM policy, and an SSM parameter — none of which
  // the LocalStack Community (Hobby) tier serves. Importing it is not an
  // option, so pinning the whole resource list is what keeps the duplication of
  // the table definitions honest rather than accidental. Read from the
  // synthesized template directly: `findResources("*")` matches nothing.
  it("creates only the key and the seven tables", () => {
    const resources = Object.values(
      template.toJSON().Resources as Record<string, { Type: string }>,
    );
    const counts = resources.reduce<Record<string, number>>((acc, resource) => {
      acc[resource.Type] = (acc[resource.Type] ?? 0) + 1;
      return acc;
    }, {});
    expect(counts).toEqual({
      "AWS::DynamoDB::Table": LOCAL_TABLE_NAMES.length,
      "AWS::KMS::Key": 1,
    });
  });
});
