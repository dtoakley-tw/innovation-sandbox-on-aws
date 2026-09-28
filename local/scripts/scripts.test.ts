// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import {
  LOCAL_JWKS_URI,
  LOCALSTACK_ENDPOINT,
} from "../infrastructure/lib/lambda-environment.js";
import { LOCAL_EDGE_PORT, LOCAL_REGION } from "../shared/names.js";

const localDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = join(localDir, "..");
const read = (relative: string) =>
  readFileSync(join(localDir, relative), "utf-8");

const SCRIPT_NAMES = [
  "local-up.sh",
  "local-down.sh",
  "local-reset.sh",
  "local-logs.sh",
] as const;

/**
 * The text of one bash function definition, so a test can assert on its body
 * rather than on the whole file. Throws rather than returning undefined: a
 * renamed function should fail the test that needed it, loudly.
 */
const bashFunction = (body: string, name: string): string => {
  const match = body.match(new RegExp(`^${name}\\(\\) \\{[\\s\\S]*?^\\}`, "m"));
  if (!match) throw new Error(`no ${name}() function definition found`);
  return match[0];
};

/** The script with the named functions removed, so a rule about the rest holds. */
const withoutFunctions = (body: string, ...names: string[]): string =>
  names.reduce(
    (left, name) => left.replace(bashFunction(left, name), ""),
    body,
  );

describe("local compose profile", () => {
  it("declares LocalStack and the edge service the Lambdas address", () => {
    const compose = read("compose.yaml");
    expect(compose).toContain("localstack:");
    // The Lambdas resolve the edge by compose service name, so the host in
    // `LOCAL_JWKS_URI` has to name a service this file declares. Deriving the
    // expected name from the constant is what turns a rename there into a
    // failure here instead of a DNS error inside every cold-starting Lambda.
    const edgeService = new URL(LOCAL_JWKS_URI).hostname;
    expect(edgeService).not.toBe("localhost");
    expect(compose).toContain(`${edgeService}:`);
  });

  it("publishes the edge on the host port the Vite proxy targets", () => {
    expect(read("compose.yaml")).toContain(
      `"${LOCAL_EDGE_PORT}:${LOCAL_EDGE_PORT}"`,
    );
  });

  it("runs LocalStack without a persistent volume so reset is unambiguous", () => {
    const compose = read("compose.yaml");
    expect(compose).not.toMatch(/^\s*-\s*localstack-data:/m);
  });

  it("health-checks LocalStack on the endpoint local-up polls", () => {
    const compose = read("compose.yaml");
    const probed = compose.match(
      /healthcheck:[\s\S]*?test: \["CMD", "curl", "-f", "([^"]+)"\]/,
    )?.[1];
    expect(probed).toBe(`${LOCALSTACK_ENDPOINT}/_localstack/health`);
  });

  // Two addresses for one process, and getting this wrong breaks every Lambda
  // request while leaving the browser working — so it is pinned both ways.
  it("points the edge at LocalStack in-network, and not at the host port", () => {
    const invokeUrl = read("compose.yaml").match(
      /ISB_LOCAL_API_GATEWAY_INVOKE_URL: "([^"]+)"/,
    )?.[1];
    expect(invokeUrl).toBeDefined();
    expect(new URL(invokeUrl as string).hostname).toBe("localstack");
    expect(invokeUrl).not.toContain("localhost");
    // A placeholder id: the real one does not exist until `cdk deploy` runs in
    // local-up.sh, which recreates the edge with it or fails.
    expect(invokeUrl).toContain("/restapis/0/");
  });
});

describe("local scripts", () => {
  // The cheapest assertion that catches the failure every text assertion in
  // this file misses: a script that cannot parse at all. An `if` block closed
  // with `}` satisfied all of the below, and the suite stayed green.
  it("parse as bash", () => {
    for (const name of SCRIPT_NAMES) {
      const path = join(localDir, "scripts", name);
      expect(
        () => execFileSync("bash", ["-n", path]),
        `${name} is not valid bash`,
      ).not.toThrow();
    }
  });

  it("are executable, and open with a shebang, a comment, and strict mode", () => {
    for (const name of SCRIPT_NAMES) {
      const path = join(localDir, "scripts", name);
      // `npm run local:*` shells out with `bash`, so the bit is about a
      // developer running the script directly, not about the npm entry point.
      expect(
        statSync(path).mode & 0o111,
        `${name} is not executable`,
      ).toBeGreaterThan(0);
      const body = readFileSync(path, "utf-8");
      expect(body.startsWith("#!/usr/bin/env bash\n")).toBe(true);
      expect(body.slice(0, body.indexOf("set -euo pipefail"))).toMatch(
        /^# .+$/m,
      );
      expect(body).toContain("set -euo pipefail");
    }
  });

  it("resolve the compose file's location rather than the working directory", () => {
    for (const name of SCRIPT_NAMES) {
      const body = readFileSync(join(localDir, "scripts", name), "utf-8");
      if (!body.includes("compose.yaml")) continue;
      expect(
        body,
        `${name} reaches for compose without resolving its own path`,
      ).toContain("BASH_SOURCE[0]");
    }
  });

  it("waits for health instead of sleeping", () => {
    const up = read("scripts/local-up.sh");
    expect(up).not.toMatch(/\bsleep 30\b/);
    // Defined *and* called: a definition nobody calls is a green test and a
    // deploy that starts before its dependency is up.
    for (const [name, url] of [
      ["waitForLocalStack", `${LOCALSTACK_ENDPOINT}/_localstack/health`],
      ["waitForLocalEdge", `http://localhost:${LOCAL_EDGE_PORT}/healthz`],
    ] as const) {
      expect(bashFunction(up, name)).toContain(url);
      expect(
        up.match(new RegExp(`\\b${name}\\b`, "g"))?.length,
      ).toBeGreaterThan(1);
    }
    // The polling itself: a bounded number of attempts, a request that only
    // passes on a 2xx, and a loud failure rather than an open wait.
    const poll = bashFunction(up, "waitFor");
    expect(poll).toMatch(/for .* in \$\(seq 1 "\$attempts"\)/);
    expect(poll).toContain('curl -fsS "$url"');
    expect(poll).toMatch(/return 1/);
    // The only sleep in the script is the retry delay inside that loop; a fixed
    // startup sleep anywhere else is what this rules out.
    expect(
      withoutFunctions(up, "waitFor", "waitForLocalStack", "waitForLocalEdge"),
    ).not.toMatch(/\bsleep\b/);
  });

  // The health gate is what a later task depends on when it reads "the script
  // returned", and no text assertion can tell a working retry loop from one
  // that never gives up. So the function is executed here against a stub `curl`
  // that fails a fixed number of times before answering.
  it("returns success only once the url answers, and gives up when it does not", () => {
    const poll = bashFunction(read("scripts/local-up.sh"), "waitFor");
    const dir = mkdtempSync(join(tmpdir(), "isb-local-wait-"));
    const bin = join(dir, "bin");
    mkdirSync(bin);
    const count = join(dir, "attempts");
    writeFileSync(
      join(bin, "curl"),
      `#!/bin/sh
n=$(cat "$ISB_FAKE_CURL_COUNT" 2>/dev/null || echo 0)
n=$((n + 1))
printf '%s' "$n" > "$ISB_FAKE_CURL_COUNT"
[ "$n" -ge "$ISB_FAKE_CURL_HEALTHY_AT" ] && exit 0
exit 7
`,
      { mode: 0o755 },
    );
    const run = (
      url: string,
      healthyAt: number,
    ): { status: number; stdout: string; stderr: string } => {
      rmSync(count, { force: true });
      try {
        const stdout = execFileSync(
          "bash",
          [
            "-c",
            `PATH="${bin}:$PATH"
${poll}
waitFor "${url}" 5 0
status=$?
echo "attempts=$(cat "$ISB_FAKE_CURL_COUNT")"
exit $status`,
          ],
          {
            encoding: "utf-8",
            // Without this, a failing child writes straight to the test
            // runner's stderr and the suite's output is not pristine.
            stdio: ["ignore", "pipe", "pipe"],
            env: {
              ...process.env,
              ISB_FAKE_CURL_COUNT: count,
              ISB_FAKE_CURL_HEALTHY_AT: `${healthyAt}`,
            },
          },
        );
        return { status: 0, stdout, stderr: "" };
      } catch (error) {
        const failure = error as {
          status: number;
          stdout: string;
          stderr: string;
        };
        return {
          status: failure.status,
          stdout: failure.stdout,
          stderr: failure.stderr,
        };
      }
    };
    const healthy = run("http://example.test/healthz", 3);
    expect(healthy.status).toBe(0);
    expect(healthy.stdout).toContain("attempts=3");
    // Never answers within the attempts allowed.
    const dead = run("http://example.test/never", 99);
    // Non-zero, so `set -e` aborts the caller, and the message names the URL
    // that never answered rather than leaving the developer to guess.
    expect(dead.status).toBe(1);
    expect(dead.stdout).toContain("attempts=5");
    expect(dead.stderr).toContain("http://example.test/never");
  });

  it("exports the CDK CLI's endpoint and credentials before it deploys", () => {
    const up = read("scripts/local-up.sh");
    // The CLI resolves endpoints from its own environment, not from the Lambda
    // environment local/infrastructure assembles.
    expect(up).toContain(`export AWS_ENDPOINT_URL="${LOCALSTACK_ENDPOINT}"`);
    expect(up).toContain(`export AWS_REGION="${LOCAL_REGION}"`);
    expect(up).toMatch(/export AWS_ACCESS_KEY_ID="test"/);
    expect(up).toMatch(/export AWS_SECRET_ACCESS_KEY="test"/);
    expect(up.indexOf("export AWS_ENDPOINT_URL")).toBeLessThan(
      up.indexOf("cdk deploy"),
    );
  });

  it("restarts the edge with the deployed API Gateway id", () => {
    const up = read("scripts/local-up.sh");
    expect(up).toContain("local/cdk.out/local-outputs.json");
    expect(up).toMatch(
      /docker compose [^\n]*up -d --force-recreate isb-local-edge/,
    );
    // Recreated only after the id is known, so the edge never serves the
    // placeholder for longer than the deploy takes.
    expect(up.indexOf("api_id=")).toBeLessThan(
      up.indexOf("--force-recreate isb-local-edge"),
    );
    expect(up.indexOf("exit 1")).toBeLessThan(
      up.indexOf("--force-recreate isb-local-edge"),
    );
  });

  it("aborts rather than leaving the placeholder id in place", () => {
    const up = read("scripts/local-up.sh");
    expect(up).toMatch(/if \[ ! -f "\$[a-z_]+" \]; then/);
    expect(up).toMatch(/if \[ -z "\$api_id" \]; then/);
  });

  // The text assertions above cannot tell an expression that finds the id from
  // one that looks in the wrong place and finds nothing, so the expression is
  // executed here, in a temp directory, against the shape the CDK CLI actually
  // writes: outputs nested under the stack name
  // (`node_modules/aws-cdk/lib/index.js`, `stackOutputs[stack.stackName] = ...`).
  it("reads the API Gateway id out of the nested outputs, or reads nothing", () => {
    const expression = read("scripts/local-up.sh").match(
      /node -e '([^']+)'/,
    )?.[1];
    expect(expression).toBeDefined();
    const runWith = (outputs: unknown): string => {
      const dir = mkdtempSync(join(tmpdir(), "isb-local-outputs-"));
      mkdirSync(join(dir, "local", "cdk.out"), { recursive: true });
      writeFileSync(
        join(dir, "local", "cdk.out", "local-outputs.json"),
        JSON.stringify(outputs),
      );
      return execFileSync("node", ["-e", expression as string], {
        cwd: dir,
        encoding: "utf-8",
      });
    };
    expect(
      runWith({ IsbLocalCompute: { ApiGatewayRestApiId: "abc123" } }),
    ).toBe("abc123");
    // Whichever stack carries the output, so the app is not tied to a stack
    // name before it exists.
    expect(
      runWith({
        IsbLocalData: { SomeOtherOutput: "1" },
        IsbLocalCompute: { ApiGatewayRestApiId: "def456" },
      }),
    ).toBe("def456");
    // Nothing to read: the guard's subject must be empty so `[ -z ]` fires
    // rather than the edge running against a URL that cannot resolve.
    expect(runWith({})).toBe("");
    expect(runWith({ IsbLocalCompute: {} })).toBe("");
    expect(runWith({ IsbLocalCompute: { ApiGatewayRestApiId: null } })).toBe(
      "",
    );
  });

  it("seeds only once the edge is healthy", () => {
    const up = read("scripts/local-up.sh");
    expect(up).toContain("npm run local:seed");
    expect(up.indexOf("waitForLocalEdge")).toBeLessThan(
      up.indexOf("npm run local:seed"),
    );
  });

  it("takes the containers and the CDK output down together", () => {
    const down = read("scripts/local-down.sh");
    expect(down).toMatch(/docker compose [^\n]*\bdown\b/);
    expect(down).toMatch(/rm -rf .*local\/cdk\.out/);
  });

  it("resets by tearing down before bringing the profile back up", () => {
    const reset = read("scripts/local-reset.sh");
    expect(reset).toMatch(/bash "\$here\/local-down\.sh"/);
    expect(reset).toMatch(/bash "\$here\/local-up\.sh"/);
    expect(reset.indexOf("local-down.sh")).toBeLessThan(
      reset.indexOf("local-up.sh"),
    );
  });

  it("tails the logs of both services", () => {
    expect(read("scripts/local-logs.sh")).toMatch(
      /docker compose [^\n]*logs -f/,
    );
  });

  it("are the targets the root npm scripts name", () => {
    const root = JSON.parse(
      readFileSync(join(repoRoot, "package.json"), "utf-8"),
    ) as { scripts: Record<string, string> };
    for (const name of ["up", "down", "reset", "logs"]) {
      const target = root.scripts[`local:${name}`];
      expect(target).toBe(`bash local/scripts/local-${name}.sh`);
      expect(
        existsSync(join(repoRoot, target.replace("bash ", ""))),
        `local:${name} points at a file that does not exist`,
      ).toBe(true);
    }
  });
});
