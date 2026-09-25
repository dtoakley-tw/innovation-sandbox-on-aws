// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import type { ResourcesConfig } from "aws-amplify";
import { Amplify } from "aws-amplify";
import { cognitoUserPoolsTokenProvider } from "aws-amplify/auth/cognito";
import { sessionStorage } from "aws-amplify/utils";

import { localSessionLibraryOptions } from "@amzn/innovation-sandbox-frontend/helpers/local/amplify-local-session";

export interface CognitoConfig {
  userPoolId: string;
  appClientId: string;
  identityPoolId: string;
  domain: string;
  region: string;
  awsAccessPortalUrl: string;
}

/**
 * Configures Amplify Auth with Cognito User Pool and OAuth settings.
 * Uses sessionStorage so tokens are cleared when the browser tab is closed.
 */
export function configureAmplifyAuth(cognitoConfig: CognitoConfig): void {
  const currentOrigin = globalThis.location.origin;

  // Dev-only and unset in every deployment; trimmed so an empty .env.local entry reads as unset.
  const localSessionEndpoint = (
    import.meta.env.VITE_LOCAL_SESSION_ENDPOINT as string | undefined
  )?.trim();

  // Annotated because out of argument position `responseType` widens to string.
  const resources: ResourcesConfig = {
    Auth: {
      Cognito: {
        userPoolId: cognitoConfig.userPoolId,
        userPoolClientId: cognitoConfig.appClientId,
        identityPoolId: cognitoConfig.identityPoolId,
        loginWith: {
          oauth: {
            domain: `${cognitoConfig.domain}.auth.${cognitoConfig.region}.amazoncognito.com`,
            scopes: ["openid", "email", "profile"],
            redirectSignIn: [`${currentOrigin}/callback`],
            // Sign-out lands on the IDC access portal, not an in-app page —
            // clearing the Cognito session alone can't end the IDC SAML session,
            // so we hand off to the portal where the user can finish signing out.
            redirectSignOut: [cognitoConfig.awsAccessPortalUrl],
            responseType: "code",
            providers: [{ custom: "IAMIdentityCenter" }],
          },
        },
      },
    },
  };

  // Two calls rather than one call with a second argument that is sometimes
  // undefined: the deployed path stays the single-argument call it has always
  // been, so nothing about it can drift with the local profile.
  if (localSessionEndpoint) {
    Amplify.configure(
      resources,
      localSessionLibraryOptions(localSessionEndpoint),
    );
  } else {
    Amplify.configure(resources);
  }

  cognitoUserPoolsTokenProvider.setKeyValueStorage(sessionStorage);
}
