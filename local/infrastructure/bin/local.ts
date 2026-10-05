// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import { App } from "aws-cdk-lib";

import { LocalComputeStack } from "../lib/local-compute-stack.js";
import { LocalDataStack } from "../lib/local-data-stack.js";

const app = new App();
// LocalStack answers to any account and region, and the Lambdas it runs address
// their tables by the names in `localTableNames` rather than through references,
// so one fixed account and region is all the profile needs — and pinning them
// keeps a deploy from landing in whatever account the developer's own AWS
// credentials point at.
const env = { account: "000000000000", region: "us-east-1" };

// Data first, so the compute stack is the one `cdk deploy` reports last and a
// failure there is the one a developer sees after the tables are in place.
new LocalDataStack(app, "IsbLocalData", { env });
new LocalComputeStack(app, "IsbLocalCompute", { env });

app.synth();
