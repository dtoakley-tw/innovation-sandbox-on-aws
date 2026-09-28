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

  it("creates the GSIs the production stores query", () => {
    const indexNames = Object.values(tables()).flatMap((table) =>
      (table.Properties.GlobalSecondaryIndexes ?? []).map(
        (gsi: { IndexName: string }) => gsi.IndexName,
      ),
    );
    expect(indexNames).toEqual(
      expect.arrayContaining([
        "blueprintId-index",
        "StatusIndex",
        "itemType-blueprintId-index",
        "LeaseIndex",
        "GroupIndex",
      ]),
    );
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

  it("uses on-demand billing so seeding never waits on capacity", () => {
    template.hasResourceProperties("AWS::DynamoDB::Table", {
      BillingMode: "PAY_PER_REQUEST",
    });
  });

  // The Lambdas address the tables by name through buildLocalEnv, so the names
  // live in `localTableNames` and are asserted from there rather than restated.
  it("names every table the way localTableNames declares", () => {
    const names = Object.values(tables()).map(
      (table) => table.Properties.TableName,
    );
    expect(names.sort()).toEqual(Object.values(localTableNames).sort());
  });

  // The record the later tasks read rather than re-deriving names. The names
  // themselves are pinned against the template above, because `Table.tableName`
  // hands back the table's Ref, not the explicit name it was constructed with.
  it("exposes every table on the typed record the later tasks read", () => {
    expect(Object.keys(stack.tables).sort()).toEqual(
      [...LOCAL_TABLE_NAMES].sort(),
    );
    for (const name of LOCAL_TABLE_NAMES) {
      expect(stack.tables[name].node.id).toBe(`${name}Table`);
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

  // `IsbDataResources` also builds Cognito, identity pools, SAML, and SSM
  // parameters — none of which the Hobby tier of LocalStack serves. Importing
  // it is not an option, so its absence here is what keeps the duplication of
  // the table definitions honest rather than accidental.
  it("brings none of IsbDataResources' unsupported surface with it", () => {
    const types = Object.values(template.findResources("*")).map(
      (resource) => resource.Type,
    );
    for (const type of [
      "AWS::Cognito::UserPool",
      "AWS::SSM::Parameter",
      "AWS::IAM::ManagedPolicy",
      "AWS::Cognito::IdentityPool",
    ]) {
      expect(types, type).not.toContain(type);
    }
  });
});
