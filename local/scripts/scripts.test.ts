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

import { localKeyDir } from "../edge/key-store.js";
import {
  LOCAL_JWKS_URI,
  LOCALSTACK_ENDPOINT,
} from "../infrastructure/lib/lambda-environment.js";
import {
  LOCAL_ACCOUNT_ID,
  LOCAL_EDGE_PORT,
  LOCAL_EDGE_SERVICE_NAME,
  LOCAL_EDGE_TLS_PORT,
  LOCAL_REGION,
  LOCAL_STAGE,
} from "../shared/names.js";

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

/**
 * The text of one compose service, so a rule about "the localstack service"
 * cannot be satisfied by a line belonging to some other service. Compose
 * indents a service name two spaces and its keys four, so a service ends at the
 * next line indented by fewer — the next service, or the next top-level key.
 */
const composeService = (name: string): string => {
  const compose = read("compose.yaml");
  const start = compose.match(new RegExp(`^ {2}${name}:\\n`, "m"))?.index;
  if (start === undefined) {
    throw new Error(`no ${name} service in compose.yaml`);
  }
  const rest = compose.slice(start + `  ${name}:`.length);
  const end = rest.search(/^ {0,2}\S/m);
  return rest.slice(0, end === -1 ? undefined : end);
};

/** The networks one service is attached to, by the names the file gives them. */
const serviceNetworks = (name: string): string[] =>
  composeList(name, "networks");

/**
 * The `node -e` expression the up script uses to read one named output out of
 * the CDK outputs file, found by the output it asks for. There is one per value
 * the script needs, and each is a standalone program a test can run.
 */
const outputsRead = (outputName: string): string => {
  const expression = read("scripts/local-up.sh").match(
    new RegExp(`node -e '([^']*${outputName}[^']*)'`),
  )?.[1];
  if (expression === undefined) {
    throw new Error(`no node -e read of ${outputName} in local-up.sh`);
  }
  return expression;
};

/**
 * The entries of a compose list key — `networks:`, `volumes:` — inside one
 * service. Comment lines between the key and its entries belong to the block, so
 * they are walked rather than mistaken for the end of it, and a following key is
 * not one of them because it is neither a comment nor a `- ` entry.
 */
const composeList = (service: string, key: string): string[] => {
  const entries = composeService(service)
    .match(new RegExp(`^ {4}${key}:\\n((?: {4,}(?:#.*|- .+)\\n?)+)`, "m"))?.[1]
    ?.match(/^ {4,}- (\S+)/gm);
  if (entries === undefined) {
    throw new Error(`no ${key} list on the ${service} service`);
  }
  return entries.map((entry) => entry.replace(/^ *- /, ""));
};

/** The real Docker network name a top-level network is created with. */
const declaredNetworkName = (key: string): string => {
  const name = read("compose.yaml").match(
    new RegExp(
      `^ {2}${key}:\\n(?: {4}.+\\n)*? {4}name:\\s*"?([^"\\n]+)"?`,
      "m",
    ),
  )?.[1];
  if (name === undefined) {
    throw new Error(`no top-level network named ${key}`);
  }
  return name;
};

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

  // The TLS listener exists for the Lambdas, and the Lambdas are the only things
  // on the `isb-local` network that have any reason to reach it. Publishing it
  // would put a TLS endpoint on the developer's `localhost` for no benefit — and
  // it would make the port reachable from anything running on the host, which is
  // a wider surface than the one that needs it. Pinned because the file's only
  // `ports:` entry for the edge is the HTTP one, and a `4600:4600` added later
  // would pass every other test in this file.
  it("does not publish the edge's TLS port to the host", () => {
    const service = composeService(LOCAL_EDGE_SERVICE_NAME);
    const published = (service.match(/^\s+- "([^"]+)"/gm) ?? []).map((line) =>
      line.replace(/^\s+- "/, "").replace(/"$/, ""),
    );
    expect(published).toEqual([`${LOCAL_EDGE_PORT}:${LOCAL_EDGE_PORT}`]);
    // The JWKS endpoint the Lambdas use names a port nothing on the host
    // publishes, and the file has no mapping for it at all.
    expect(new URL(LOCAL_JWKS_URI).port).toBe(String(LOCAL_EDGE_TLS_PORT));
    expect(read("compose.yaml")).not.toContain(
      `${LOCAL_EDGE_TLS_PORT}:${LOCAL_EDGE_TLS_PORT}`,
    );
    // And it is a distinct port, so "published" cannot be satisfied by the
    // browser's port being renamed into it.
    expect(LOCAL_EDGE_TLS_PORT).not.toBe(LOCAL_EDGE_PORT);
  });

  // The key directory is shared state between the edge container and the host,
  // and the TLS material in it has to be the *same* material on both sides: the
  // edge serves a leaf and the CDK synth copies the CA that signed it into six
  // Lambda bundles. Two directories would mean two CAs and a TLS error in every
  // authenticated request.
  it("points the edge container at the same key directory the synth resolves", () => {
    const declared = composeService(LOCAL_EDGE_SERVICE_NAME).match(
      /ISB_LOCAL_KEY_DIR:\s*"([^"]+)"/,
    )?.[1];
    expect(declared).toBeDefined();
    // The compose file already gives the container's path absolutely, and
    // `/workspace` is the repository root inside it (`..:/workspace`), so this
    // names `local/.keys` on both sides rather than only in the container.
    const inContainer = declared as string;
    expect(inContainer).toBe("/workspace/local/.keys");
    // The host side is what `key-store.ts` resolves when the variable is unset:
    // `local/.keys` beside `local/edge/`. Cross-checked against the resolved
    // value rather than spelled out again.
    const resolved = localKeyDir();
    expect(resolved.endsWith(join("local", ".keys"))).toBe(true);
    expect(inContainer.endsWith(join("local", ".keys"))).toBe(true);
  });

  // `waitForLocalEdge` polls the HTTP port because that is what the host can
  // reach. If the edge came up its HTTP listener and then failed the TLS
  // self-check, the wait would pass and `local:up` would report success with
  // every authenticated request broken — so the edge is expected to be fatal on
  // that failure rather than to log and carry on, and the wait is the only thing
  // standing between a broken edge and a green `local:up`.
  it("waits on the health port, and the edge treats a TLS failure as fatal", () => {
    const up = read("scripts/local-up.sh");
    expect(bashFunction(up, "waitForLocalEdge")).toContain(
      `http://localhost:${LOCAL_EDGE_PORT}/healthz`,
    );
    // Not a silent log line: the startup handler has to exit non-zero.
    expect(read("edge/server.ts")).toMatch(
      /await assertLocalJwksOverTls\(credentials\)/,
    );
    expect(read("edge/server.ts")).toMatch(/process\.exit\(1\)/);
  });

  // The edge installs its dependencies into the working tree it is bind-mounted,
  // which means the host's. Running Linux, npm prunes the host's
  // platform-specific optional dependencies — `node_modules/@esbuild` loses its
  // `darwin-*` package — and every host-side tool that shells out to one of them
  // fails afterwards with "You installed esbuild for another platform". Observed
  // directly: a clean `local:up` deployed nothing and left the host's esbuild
  // unusable, which is the worst possible outcome for a script whose whole job
  // is to leave a working profile behind.
  it("keeps the edge's dependency install out of the host's working tree", () => {
    const compose = read("compose.yaml");
    const mounts = composeList("isb-local-edge", "volumes");
    // The repository, so edits take effect without a rebuild — that part is the
    // point of the mount and has to stay.
    expect(mounts).toContain("..:/workspace");
    // And a volume shadowing the dependency tree inside it.
    const shadow = mounts.find((mount) =>
      mount.endsWith("/workspace/node_modules"),
    );
    expect(shadow).toBeDefined();
    // A named volume, not an anonymous one: an anonymous volume cannot be
    // addressed, and compose would accumulate one per recreate.
    const [name] = (shadow as string).split(":");
    expect(name).toBe("edge-node-modules");
    // Declared at the top level, or compose treats the service reference as a
    // bind mount of a path that does not exist on the host.
    expect(compose).toMatch(/^volumes:\n {2}edge-node-modules:/m);
    // And nothing else in the file mounts state into a container.
    for (const service of ["localstack", "isb-local-edge"]) {
      expect(
        composeList(service, "volumes").filter((mount) =>
          /^\.\..*node_modules/.test(mount),
        ),
        service,
      ).toEqual([]);
    }
  });

  it("runs LocalStack without a persistent volume so reset is unambiguous", () => {
    const compose = read("compose.yaml");
    // Not "no volumes at all": the Docker socket bind is a volume too, and a
    // legitimate one. The property is that LocalStack's *state* is not mounted,
    // so `local:reset` means "recreate the containers" unambiguously.
    expect(compose).not.toMatch(/\/var\/lib\/localstack/);
    const targets = composeList("localstack", "volumes").map(
      (mount) => mount.split(":").pop() as string,
    );
    expect(targets).toEqual(["/var/run/docker.sock"]);
  });

  // LocalStack starts real Lambda containers on the host daemon, and there is
  // no non-Docker fallback executor in the current provider. Without this bind
  // no Lambda starts at all, and the profile fails at the first API call.
  it("gives LocalStack the Docker socket it needs to execute Lambda", () => {
    expect(composeList("localstack", "volumes")).toContain(
      "/var/run/docker.sock:/var/run/docker.sock",
    );
  });

  // The network name is untyped in a compose file: a typo passes every other
  // check in this file and fails only when a Lambda tries to resolve the edge
  // by name. So the occurrences are cross-checked against each other rather
  // than against a literal — the assertion is about consistency, not spelling.
  it("puts the Lambda containers on the network the edge is attached to", () => {
    const network = composeService("localstack").match(
      /LAMBDA_DOCKER_NETWORK:\s*"?([^"\n]+)"?/,
    )?.[1];
    expect(network).toBeDefined();
    expect(serviceNetworks("localstack")).toContain(network);
    expect(serviceNetworks("isb-local-edge")).toContain(network);
    expect(declaredNetworkName(network as string)).toBe(network);
  });

  it("health-checks LocalStack on the endpoint local-up polls", () => {
    const compose = read("compose.yaml");
    const probed = compose.match(
      /healthcheck:[\s\S]*?test: \["CMD", "curl", "-f", "([^"]+)"\]/,
    )?.[1];
    expect(probed).toBe(`${LOCALSTACK_ENDPOINT}/_localstack/health`);
  });

  // Two addresses for one process, and getting this wrong breaks every Lambda
  // request while leaving the browser working — so the placeholder the compose
  // file falls back to is pinned both ways, along with the variable the real
  // value arrives through.
  it("interpolates the invoke URL, defaulting to an in-network placeholder", () => {
    const interpolated = read("compose.yaml").match(
      /ISB_LOCAL_API_GATEWAY_INVOKE_URL:\s*"\$\{([A-Z_]+):-([^}]+)\}"/,
    );
    expect(interpolated?.[1]).toBe("ISB_LOCAL_API_GATEWAY_INVOKE_URL");
    const placeholder = new URL(interpolated?.[2] as string);
    // In-network: the browser never sees this, only the Lambdas do. The host is
    // the LocalStack service the first test proves this file declares, and the
    // port the one constant that does describe this endpoint from the host side,
    // `LOCALSTACK_ENDPOINT` — which also says "not localhost".
    expect(placeholder.hostname).toBe("localstack");
    expect(placeholder.port).toBe(new URL(LOCALSTACK_ENDPOINT).port);
    expect(interpolated?.[2]).not.toContain("localhost");
    // A placeholder id, and the stage Task 12's stack names. Either changing
    // means the two sides disagree about the URL shape, which only shows up as
    // a 404 from a Lambda call.
    expect(placeholder.pathname).toContain("/restapis/0/");
    expect(placeholder.pathname).toContain(`/${LOCAL_STAGE}/_user_request_`);
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

  it("are executable, and open with a shebang, the licence, and strict mode", () => {
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
      // The pre-commit `insert-license` hook matches `ts|js|tsx|jsx|scss`, so
      // these four files get no licence check anywhere else. The header is
      // asserted by content rather than by "there is a comment here", which any
      // line satisfied.
      expect(body).toContain(
        "# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.\n# SPDX-License-Identifier: Apache-2.0\n",
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
    // Anchored to the deploy command line, not to the first mention of the words:
    // the bootstrap comment above it also says `cdk deploy`, and an indexOf on
    // the phrase would silently start comparing against prose.
    expect(up.indexOf("export AWS_ENDPOINT_URL")).toBeLessThan(
      up.search(/^npx cdk deploy /m),
    );
  });

  // The CDK CLI needs its bootstrap stack in the target account before it can
  // publish the six Lambda artifacts, and a LocalStack container that has just
  // started has none. Without this, a first `local:up` on a clean machine stops
  // at `cdk deploy` with `Parameter /cdk-bootstrap/... not found`, having
  // created nothing. Three things have to hold, and each is a separate way the
  // bootstrap could be got wrong while looking correct.
  describe("bootstrapping CDK in LocalStack", () => {
    it("bootstraps the same account and region the stacks deploy to", () => {
      const up = read("scripts/local-up.sh");
      const target = up.match(/^bootstrap_target="([^"]+)"/m)?.[1];
      expect(target).toBe(`aws://${LOCAL_ACCOUNT_ID}/\${AWS_REGION}`);
      // The region is the exported one rather than a second literal, so the two
      // cannot name different regions.
      expect(up.indexOf(`bootstrap_target=`)).toBeGreaterThan(
        up.indexOf(`export AWS_REGION="${LOCAL_REGION}"`),
      );
      // And the app itself pins both stacks to that same account, or the CLI
      // would bootstrap one account and deploy to another — which surfaces as
      // the same "not found" it was supposed to fix.
      const app = read("infrastructure/bin/local.ts");
      expect(app).toContain(`account: "${LOCAL_ACCOUNT_ID}"`);
      expect(app).toContain(`region: "${LOCAL_REGION}"`);
    });

    it("bootstraps before it deploys, and skips the work when it is already there", () => {
      const up = read("scripts/local-up.sh");
      const body = bashFunction(up, "bootstrap_cdk");
      // Asked, not assumed: the toolkit stack either is in the account or is not,
      // and LocalStack is the only thing that knows.
      expect(bashFunction(up, "is_bootstrapped")).toMatch(
        /awslocal cloudformation describe-stacks --stack-name CDKToolkit/,
      );
      expect(body).toContain("if is_bootstrapped; then");
      // A re-run must not pay for the bootstrap, so the guard returns before the
      // CLI is ever invoked rather than invoking it and hoping it is cheap.
      expect(body.indexOf("if is_bootstrapped")).toBeLessThan(
        body.indexOf("cdk bootstrap"),
      );
      // And it happens before the deploy, not after a failure. Anchored to the
      // two command lines, because the prose above each of them names the other.
      const callAt = up.search(/^bootstrap_cdk$/m);
      const deployAt = up.search(/^npx cdk deploy /m);
      expect(callAt).toBeGreaterThan(-1);
      expect(deployAt).toBeGreaterThan(-1);
      expect(callAt).toBeLessThan(deployAt);
    });

    // `cdk bootstrap` reaching real AWS is the worst outcome this script could
    // have, so the endpoint it inherits has to be the LocalStack one — which is
    // only true because the exports above it run first. The index comparison is
    // the assertion; a duplicated literal would pass a `toContain`.
    it("inherits the LocalStack endpoint, never real AWS", () => {
      const up = read("scripts/local-up.sh");
      const call = up.indexOf('cdk bootstrap "$bootstrap_target"');
      expect(call).toBeGreaterThan(-1);
      expect(
        up.indexOf(`export AWS_ENDPOINT_URL="${LOCALSTACK_ENDPOINT}"`),
      ).toBeLessThan(call);
    });

    // A bootstrap that fails says so and says what to do. `set -e` would abort
    // on a bare `npx cdk bootstrap` with the CLI's own message and nothing else,
    // which does not mention the endpoint or the fact that LocalStack may simply
    // not be ready.
    it("explains a bootstrap failure instead of aborting silently", () => {
      const body = bashFunction(read("scripts/local-up.sh"), "bootstrap_cdk");
      expect(body).toMatch(/npx cdk bootstrap "\$bootstrap_target" \|\| \{/);
      expect(body).toContain("cdk bootstrap failed for $bootstrap_target");
      // The hand-run line a developer can copy, and it names the endpoint so the
      // copy does not silently go to AWS.
      expect(body).toContain(
        "AWS_ENDPOINT_URL=$AWS_ENDPOINT_URL npx cdk bootstrap $bootstrap_target",
      );
    });
  });

  // The app registers two independent stacks — nothing in the compute stack
  // references a resource in the data stack — so the CLI cannot pick one. A bare
  // `cdk deploy` refuses outright ("Since this app includes more than a single
  // stack, specify which stacks to use"), which left `local:up` unable to deploy
  // anything at all.
  it("deploys every stack the app registers", () => {
    const up = read("scripts/local-up.sh");
    expect(up).toMatch(/npx cdk deploy --all --app/);
    // The app really does register two, or `--all` is claiming something false.
    const app = read("infrastructure/bin/local.ts");
    expect(app).toContain(`new LocalDataStack(app, "IsbLocalData"`);
    expect(app).toContain(`new LocalComputeStack(app, "IsbLocalCompute"`);
    // And the outputs are read across every stack, so `--all` writing both
    // stacks' outputs into one file is what the read expects.
    const id = up.match(/ApiGatewayRestApiId/g) ?? [];
    expect(id.length).toBeGreaterThan(0);
    expect(up).toMatch(
      /Object\.values\(o\)\.map\(s=>s\?\.ApiGatewayRestApiId\)/,
    );
  });

  it("restarts the edge only after the id is known", () => {
    const up = read("scripts/local-up.sh");
    expect(up).toContain("local/cdk.out/local-outputs.json");
    expect(up).toMatch(
      /docker compose [^\n]*up -d --force-recreate isb-local-edge/,
    );
    // Anchored to the guards themselves. This used to assert
    // `indexOf("exit 1") < indexOf("--force-recreate")`, which resolved to the
    // cdk deploy guard three statements earlier, stayed green with the id
    // guard deleted, and carried a comment claiming otherwise.
    for (const guard of [
      'if [ -z "$api_id" ]; then',
      'if [ -z "$invoke_url" ]; then',
    ]) {
      expect(up).toContain(guard);
      expect(up.indexOf(guard)).toBeLessThan(
        up.indexOf("--force-recreate isb-local-edge"),
      );
    }
  });

  // The id does nothing until it crosses a process boundary: compose reads it
  // from the environment when it renders the file, and the container only gets
  // what compose hands it. A `--force-recreate` with no export re-renders the
  // same placeholder and restarts the edge against an API that does not exist —
  // which is invisible until a request 404s, not until the script fails.
  // Both ends are cross-checked against each other, never against a literal.
  it("exports the invoke URL for the recreate that needs it", () => {
    const compose = read("compose.yaml");
    const name = compose.match(
      /ISB_LOCAL_API_GATEWAY_INVOKE_URL:\s*"\$\{([A-Z_]+):-/,
    )?.[1];
    expect(name).toBe("ISB_LOCAL_API_GATEWAY_INVOKE_URL");
    const up = read("scripts/local-up.sh");
    const exported = up.match(new RegExp(`export ${name}="\\$([a-z_]+)"`))?.[1];
    expect(exported).toBeDefined();
    // Before the recreate, which is the only step that re-renders the
    // container's environment.
    expect(up.indexOf(`export ${name}=`)).toBeLessThan(
      up.indexOf("--force-recreate isb-local-edge"),
    );
    // What is exported is the variable the guard already proved non-empty, and
    // that variable is the stack output verbatim — not a URL assembled in bash,
    // which is how the two could end up disagreeing about its shape.
    expect(up).toContain(`if [ -z "$${exported}" ]; then`);
    expect(up).toMatch(new RegExp(`^${exported}="\\$\\(node -e '`, "m"));
    expect(outputsRead("ApiGatewayInvokeUrl")).toContain("ApiGatewayInvokeUrl");
  });

  // Compose substituting a variable is not the same as the value arriving: a
  // renamed service or a malformed interpolation renders the placeholder again,
  // silently. So the container is asked what it actually has, before anything
  // downstream depends on the answer.
  it("asks the edge container what it received, before seeding", () => {
    const up = read("scripts/local-up.sh");
    expect(up).toContain(
      "exec -T isb-local-edge printenv ISB_LOCAL_API_GATEWAY_INVOKE_URL",
    );
    expect(up.indexOf("printenv")).toBeGreaterThan(
      up.indexOf("--force-recreate isb-local-edge"),
    );
    expect(up.indexOf("printenv")).toBeLessThan(
      up.indexOf("npm run local:seed"),
    );
    // Compared against the same value that was exported, not a re-derivation.
    expect(up).toMatch(/if \[ "\$container_url" != "\$invoke_url" \]; then/);
  });

  it("aborts rather than leaving the placeholder in place", () => {
    const up = read("scripts/local-up.sh");
    expect(up).toMatch(/if \[ ! -f "\$[a-z_]+" \]; then/);
    for (const value of ["api_id", "invoke_url"]) {
      expect(up).toContain(`if [ -z "$${value}" ]; then`);
    }
  });

  // The text assertions above cannot tell an expression that finds the value
  // from one that looks in the wrong place and finds nothing, so each is
  // executed here, in a temp directory, against the shape the CDK CLI actually
  // writes: outputs nested under the stack name
  // (`node_modules/aws-cdk/lib/index.js`, `stackOutputs[stack.stackName] = ...`).
  it("reads the id and the invoke URL out of the nested outputs, or nothing", () => {
    const readId = outputsRead("ApiGatewayRestApiId");
    const readUrl = outputsRead("ApiGatewayInvokeUrl");
    const runWith = (expression: string, outputs: unknown): string => {
      const dir = mkdtempSync(join(tmpdir(), "isb-local-outputs-"));
      mkdirSync(join(dir, "local", "cdk.out"), { recursive: true });
      writeFileSync(
        join(dir, "local", "cdk.out", "local-outputs.json"),
        JSON.stringify(outputs),
      );
      return execFileSync("node", ["-e", expression], {
        cwd: dir,
        encoding: "utf-8",
      });
    };
    const DEPLOYED = {
      IsbLocalCompute: {
        ApiGatewayRestApiId: "abc123",
        ApiGatewayInvokeUrl:
          "http://localstack:4566/restapis/abc123/local/_user_request_",
      },
    };
    expect(runWith(readId, DEPLOYED)).toBe("abc123");
    expect(runWith(readUrl, DEPLOYED)).toBe(
      DEPLOYED.IsbLocalCompute.ApiGatewayInvokeUrl,
    );
    // Whichever stack carries the outputs, so the app is not tied to a stack
    // name before it exists.
    expect(
      runWith(readId, {
        IsbLocalData: { SomeOtherOutput: "1" },
        ...DEPLOYED,
      }),
    ).toBe("abc123");
    // Nothing to read: the guards' subjects must be empty so `[ -z ]` fires
    // rather than the edge running against a URL that cannot resolve.
    for (const expression of [readId, readUrl]) {
      expect(runWith(expression, {})).toBe("");
      expect(runWith(expression, { IsbLocalCompute: {} })).toBe("");
      expect(
        runWith(expression, {
          IsbLocalCompute: {
            ApiGatewayRestApiId: null,
            ApiGatewayInvokeUrl: null,
          },
        }),
      ).toBe("");
    }
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

  // `local:down` used to abort on `set -euo pipefail` when `docker compose down`
  // hit "Network isb-local Resource is still in use" — which is exactly what
  // happens after LocalStack's gateway dies mid-walk and orphans the Lambda
  // containers it started — leaving a stale `cdk.out` behind. `local-up.sh` then
  // reads that stale file for the API Gateway id, so the failure surfaced one
  // whole command later as an edge pointed at an API that did not exist.
  //
  // Both halves are asserted: the orphans are removed *first* (so compose can
  // take the network), and the `rm -rf` runs *last and unconditionally*.
  describe("tearing down when LocalStack has orphaned Lambda containers", () => {
    it("removes the orphans before compose tries to take the network", () => {
      const down = read("scripts/local-down.sh");
      const sweep = down.indexOf("remove_orphaned_lambdas\n");
      const compose = down.search(/^docker compose .*\bdown\b/m);
      expect(sweep).toBeGreaterThan(-1);
      expect(compose).toBeGreaterThan(-1);
      expect(sweep).toBeLessThan(compose);
    });

    it("only sweeps containers on the profile's own network and the Lambda image", () => {
      // A `docker rm -f $(docker ps -aq)` with no filters would remove whatever
      // else the developer is running. Both filters are required: the network is
      // what the orphans are holding, and the image is what distinguishes a
      // Lambda container from a compose-managed one.
      const body = bashFunction(
        read("scripts/local-down.sh"),
        "remove_orphaned_lambdas",
      );
      expect(body).toContain("--filter");
      expect(body).toMatch(/network=\$network/);
      expect(body).toMatch(/ancestor=public\.ecr\.aws\/lambda\/nodejs:24/);
      // `-a`, not the default: a stopped container still holds the network, and
      // the orphans are frequently already exited.
      expect(body).toMatch(/docker ps -aq/);
    });

    it("sweeps the network the compose file declares, not a restated one", () => {
      // `isb-local` is a literal in the script, for the same reason the port and
      // account id are in local-up.sh: bash cannot import a TypeScript constant.
      // The cross-check is the test — a rename in compose.yaml fails here rather
      // than leaving the script sweeping nothing. `LAMBDA_DOCKER_NETWORK` on the
      // localstack service is what LocalStack itself attaches them to, so that is
      // the value the sweep has to agree with.
      const down = read("scripts/local-down.sh");
      expect(down).toMatch(/^network="isb-local"$/m);
      const lambdaNetwork = composeService("localstack").match(
        /LAMBDA_DOCKER_NETWORK:\s*"?([^"\n]+)"?/,
      )?.[1];
      expect(lambdaNetwork).toBe("isb-local");
      expect(declaredNetworkName(lambdaNetwork as string)).toBe(
        lambdaNetwork as string,
      );
    });

    it("does not let a compose failure skip the cdk.out removal", () => {
      // The `|| echo` rather than a bare command: under `set -e` a failing
      // `docker compose down` ends the script, and everything after it — which
      // is the `rm -rf` that is the whole point of the check above — never runs.
      const down = read("scripts/local-down.sh");
      const compose = down.search(/^docker compose .*\bdown\b/m);
      // `lastIndexOf`, not `indexOf`: the file *comments* the `rm -rf` it
      // explains, and an `indexOf` resolved to that prose and compared it
      // against the compose call — the same mistake the "restarts the edge only
      // after the id is known" test documents. The comparison has to be against
      // the command, not a mention of it.
      const rm = down.lastIndexOf('rm -rf "$root/local/cdk.out"');
      expect(compose).toBeGreaterThan(-1);
      expect(rm).toBeGreaterThan(compose);
      // Anchored to the guard itself, not to the word "||" appearing anywhere:
      // the compose invocation and the continuation have to be one statement.
      expect(down).toMatch(
        /^docker compose .*\bdown\b[^\n]*\|\| \\?\n?\s*echo /m,
      );
    });

    it("still ends with the unconditional cdk.out removal", () => {
      // Anchored to the end of the file, so nothing can be appended after it and
      // become a step that a future failure could skip.
      const down = read("scripts/local-down.sh").trimEnd();
      expect(down.endsWith('rm -rf "$root/local/cdk.out"')).toBe(true);
    });
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
