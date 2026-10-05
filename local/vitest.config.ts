// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export default defineConfig({
  test: {
    include: ["**/*.test.ts"],
    exclude: ["node_modules", "dist", "cdk.out"],
  },
  // The root config collects only `source/**/vitest.config.ts`, so this suite
  // needs its own view. The aliases resolve the `@amzn/*` workspace packages to
  // source, which keeps the `.js`-suffixed specifiers working against the
  // `.ts` files rather than depending on npm having linked the workspaces.
  // Each one points at the package root as npm installs it — `lib/` included
  // for the infrastructure package, so the specifiers in the local code are the
  // ones that resolve by plain file layout, with no `paths` mapping and no
  // tsconfig for `tsc` and `tsx` to have to agree about.
  resolve: {
    alias: {
      "@amzn/innovation-sandbox-commons": path.join(root, "source/common"),
      "@amzn/innovation-sandbox-shared": path.join(root, "source/shared"),
      "@amzn/innovation-sandbox-infrastructure": path.join(
        root,
        "source/infrastructure",
      ),
    },
  },
});
