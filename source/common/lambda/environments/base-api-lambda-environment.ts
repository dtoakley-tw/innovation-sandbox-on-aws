// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import { BaseLambdaEnvironmentSchema } from "@amzn/innovation-sandbox-commons/lambda/environments/base-lambda-environment.js";
import { NAMESPACE_PATTERN } from "@amzn/innovation-sandbox-commons/types/isb-types.js";
import { z } from "zod";

export const BaseApiLambdaEnvironmentSchema =
  BaseLambdaEnvironmentSchema.extend({
    COGNITO_USER_POOL_ID: z.string().min(1),
    COGNITO_APP_CLIENT_ID: z.string().min(1),
    ISB_NAMESPACE: z.string().regex(new RegExp(NAMESPACE_PATTERN)),
    /**
     * Local development only. When set, the identity verifier loads JWKS from
     * this URI instead of reaching cognito-idp.<region>.amazonaws.com, which is
     * unreachable in the offline LocalStack profile. Unset in every deployed
     * environment, where the verifier behaves exactly as before.
     */
    ISB_LOCAL_JWKS_URI: z.string().optional(),
  });

export type BaseApiLambdaEnvironment = z.infer<
  typeof BaseApiLambdaEnvironmentSchema
>;
