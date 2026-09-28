// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import { RemovalPolicy, Stack, type StackProps } from "aws-cdk-lib";
import {
  AttributeType,
  BillingMode,
  ProjectionType,
  Table,
  TableEncryption,
} from "aws-cdk-lib/aws-dynamodb";
import { Key } from "aws-cdk-lib/aws-kms";
import type { Construct } from "constructs";

import { localTableNames, type LocalTableName } from "../../shared/names.js";

export interface LocalDataStackProps extends StackProps {
  env: { account: string; region: string };
}

/**
 * The seven tables the real Lambda stores address, plus the key they are
 * encrypted with.
 *
 * The definitions below duplicate `IsbDataResources` in
 * `source/infrastructure/lib/isb-data-resources.ts` rather than importing it,
 * and that is deliberate: the production construct also creates Cognito user
 * and identity pools, a SAML provider, AppConfig, an IAM policy, and an SSM
 * parameter, none of which the LocalStack Community (Hobby) tier serves.
 * Importing it would drag that whole unsupported surface into a profile whose
 * entire purpose is to run unmodified application code against local doubles.
 * The duplication is confined to the table definitions, and the tests pin every
 * one of them, so a local edit to a key schema or an index fails here instead
 * of surfacing as a query that quietly returns nothing. Drift from upstream is
 * still a manual check: nothing compares this file to
 * `isb-data-resources.ts` automatically.
 *
 * Production names no table, letting CloudFormation generate one so a retry
 * after a rolled-back deploy cannot collide with a RETAINed table. The local
 * profile is the opposite case — ephemeral, single-deployment, and addressed by
 * name from the Lambda environment — so `localTableNames` supplies one.
 *
 * Production sets point-in-time recovery and deletion protection on every
 * table and retains them outside dev mode. The local profile is one ephemeral
 * deployment torn down wholesale by `local:reset`, so recovery has nothing to
 * recover and a retained table would only block the next deploy.
 */
export class LocalDataStack extends Stack {
  public readonly tables: Record<LocalTableName, Table>;
  public readonly kmsKey: Key;

  constructor(scope: Construct, id: string, props: LocalDataStackProps) {
    super(scope, id, props);
    // LocalStack's KMS is a stub, so customer-managed encryption costs nothing
    // here and keeps the template honest about what production deploys.
    this.kmsKey = new Key(this, "LocalKey", {
      enableKeyRotation: false,
      removalPolicy: RemovalPolicy.DESTROY,
    });

    const table = (
      name: LocalTableName,
      key: {
        partitionKey: { name: string; type: AttributeType };
        sortKey?: { name: string; type: AttributeType };
        ttl?: string;
      },
    ) =>
      new Table(this, `${name}Table`, {
        // The name the Lambdas read from buildLocalEnv, not a generated one.
        tableName: localTableNames[name],
        partitionKey: key.partitionKey,
        ...(key.sortKey ? { sortKey: key.sortKey } : {}),
        ...(key.ttl ? { timeToLiveAttribute: key.ttl } : {}),
        billingMode: BillingMode.PAY_PER_REQUEST,
        removalPolicy: RemovalPolicy.DESTROY,
        encryption: TableEncryption.CUSTOMER_MANAGED,
        encryptionKey: this.kmsKey,
      });

    this.tables = {
      sandboxAccount: table("sandboxAccount", {
        partitionKey: { name: "awsAccountId", type: AttributeType.STRING },
      }),
      leaseTemplate: table("leaseTemplate", {
        partitionKey: { name: "uuid", type: AttributeType.STRING },
      }),
      lease: table("lease", {
        partitionKey: { name: "userEmail", type: AttributeType.STRING },
        sortKey: { name: "uuid", type: AttributeType.STRING },
        ttl: "ttl",
      }),
      blueprint: table("blueprint", {
        // "bp#{blueprintId}" | "blueprint" | "stackset#{stackSetId}" |
        // "deployment#{timestamp}#{operationId}"
        partitionKey: { name: "PK", type: AttributeType.STRING },
        sortKey: { name: "SK", type: AttributeType.STRING },
        ttl: "ttl",
      }),
      principal: table("principal", {
        // "user#<userId>" | "group#<groupId>"
        // "lease#<leaseId>" | "groupMembership"
        partitionKey: { name: "pk", type: AttributeType.STRING },
        sortKey: { name: "sk", type: AttributeType.STRING },
        ttl: "ttl",
      }),
      cleanupReport: table("cleanupReport", {
        partitionKey: { name: "pk", type: AttributeType.STRING },
        sortKey: { name: "sk", type: AttributeType.STRING },
        ttl: "ttl",
      }),
      // One item per configuration section, keyed by { section, sk: "current" }.
      config: table("config", {
        partitionKey: { name: "section", type: AttributeType.STRING },
        sortKey: { name: "sk", type: AttributeType.STRING },
      }),
    };

    // The GSIs the production stores query. Declared separately so each table's
    // creation above stays a one-liner.
    this.tables.leaseTemplate.addGlobalSecondaryIndex({
      indexName: "blueprintId-index",
      partitionKey: { name: "blueprintId", type: AttributeType.STRING },
      projectionType: ProjectionType.KEYS_ONLY,
    });
    this.tables.lease.addGlobalSecondaryIndex({
      indexName: "StatusIndex",
      partitionKey: { name: "status", type: AttributeType.STRING },
      sortKey: {
        name: "originalLeaseTemplateUuid",
        type: AttributeType.STRING,
      },
    });
    this.tables.blueprint.addGlobalSecondaryIndex({
      indexName: "itemType-blueprintId-index",
      partitionKey: { name: "itemType", type: AttributeType.STRING },
      sortKey: { name: "blueprintId", type: AttributeType.STRING },
      projectionType: ProjectionType.ALL,
    });
    this.tables.principal.addGlobalSecondaryIndex({
      indexName: "LeaseIndex",
      partitionKey: { name: "leaseId", type: AttributeType.STRING },
      sortKey: { name: "pk", type: AttributeType.STRING },
      projectionType: ProjectionType.ALL,
    });
    this.tables.principal.addGlobalSecondaryIndex({
      indexName: "GroupIndex",
      partitionKey: { name: "groupId", type: AttributeType.STRING },
      projectionType: ProjectionType.KEYS_ONLY,
    });
  }
}
