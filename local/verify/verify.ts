// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import { pathToFileURL } from "node:url";

import { LOCAL_EDGE_URL } from "./client.js";
import { runHarnessChecks } from "./harness.js";
import type { VerifyOptions, VerifyReport, VerifyResult } from "./types.js";
import { walkApi } from "./walk.js";

/**
 * `npm run local:verify` — walk the API surface through the local edge and
 * validate the responses against the production Zod schemas.
 *
 * The design's contract verification, and the drift protection MSW gives the
 * unit suite applied against the real backend instead of a fake: a local response
 * shape that no longer matches what the frontend expects fails here, naming the
 * field, rather than in a browser as an undefined value.
 *
 * The script **reports; it does not throw.** Every check runs even after an
 * earlier one fails, because a new local profile almost never has exactly one
 * problem, and a walker that stops at the first one makes the profile harder to
 * diagnose than no walker at all. The exit code is non-zero when a check that
 * should have worked did not, which is what makes it usable in a script or a CI
 * step.
 *
 * A second class of check is reported the other way round. The flows the design
 * says must fail at an un-emulated AWS call are checked for failing *there*: a
 * synthetic 501 from the local edge, or a bare gateway 5xx, is a **broken
 * boundary** and is called out separately, because both would look like a pass to
 * a status-only check while destroying the signal the profile exists to produce.
 */

export { runHarnessChecks } from "./harness.js";
export type {
  Expectation,
  VerifyOptions,
  VerifyReport,
  VerifyResult,
} from "./types.js";
export { inspectBoundary, walkApi } from "./walk.js";
export { LOCAL_EDGE_URL };

/**
 * Runs the harness checks, mints the local identity, and walks every read,
 * mutation, and boundary check. Never throws for a check failure; only a missing
 * profile throws, because there is nothing to report on.
 */
export async function runVerification(
  options: VerifyOptions = {},
): Promise<VerifyReport> {
  const { results, token } = await runHarnessChecks();
  if (!token) {
    return summarise(results);
  }
  const walk = await walkApi(token, options);
  return summarise([...results, ...walk.results]);
}

/** Partitions results into the three buckets the summary and exit code use. */
function summarise(results: VerifyResult[]): VerifyReport {
  return {
    results,
    failures: results.filter(
      (result) => !result.ok && result.expectation === "should-work",
    ),
    brokenBoundaries: results.filter(
      (result) => result.ok && result.expectation === "should-fail",
    ),
    undetermined: results.filter((result) => result.undetermined),
    retried: results.filter((result) => result.attempts && result.attempts > 1),
  };
}

const GREEN = "[32m";
const RED = "[31m";
const YELLOW = "[33m";
const DIM = "[2m";
const RESET = "[0m";

/**
 * The summary. Three groups, in the order a developer needs them: what broke,
 * then what should have broken and did not, then what needed a retry. The
 * retried group is printed even on an all-green run, because "every check passed
 * but five of them needed a second attempt" is a finding, not a pass.
 */
export function formatReport(report: VerifyReport): string {
  const lines: string[] = [];
  const line = (result: VerifyResult) => {
    const mark =
      result.ok && result.expectation === "should-fail"
        ? "LEAK"
        : result.ok
          ? "ok  "
          : "FAIL";
    const attempts =
      result.attempts && result.attempts > 1
        ? ` ${DIM}(attempt ${result.attempts})${RESET}`
        : "";
    lines.push(
      `  ${mark}  ${result.name}${attempts}\n        ${DIM}${result.detail}${RESET}`,
    );
  };

  const header = (title: string, colour: string) =>
    lines.push(`${colour}${title}${RESET}`);

  const worked = report.results.filter(
    (result) =>
      result.ok && result.expectation === "should-work" && !result.skipped,
  );
  const broke = report.results.filter(
    (result) => !result.ok && result.expectation === "should-work",
  );
  // Kept out of `worked` so a skipped check can never be counted as a pass. The
  // count of checks still includes them, so the two numbers together always add
  // up to what ran plus what was dropped.
  const skipped = report.results.filter((result) => result.skipped);
  const boundariesHeld = report.results.filter(
    (result) =>
      !result.ok &&
      result.expectation === "should-fail" &&
      !result.undetermined,
  );

  if (broke.length) {
    header(
      `FAILED — ${broke.length} check(s) that should have worked did not:`,
      RED,
    );
    broke.forEach(line);
  }
  if (report.brokenBoundaries.length) {
    header(
      `BOUNDARY LEAK — ${report.brokenBoundaries.length} flow(s) LocalStack should not serve answered successfully:`,
      RED,
    );
    report.brokenBoundaries.forEach(line);
  }
  if (report.undetermined.length) {
    header(
      `UNDETERMINED — ${report.undetermined.length} boundary check(s) got nothing but gateway 5xx, so neither leak nor hold:`,
      YELLOW,
    );
    report.undetermined.forEach(line);
  }
  if (skipped.length) {
    header(
      `skipped (${skipped.length}) — a check that depends on state an earlier check consumed. Not a pass, and not a failure either; \`npm run local:reset\` puts the profile back:`,
      YELLOW,
    );
    skipped.forEach(line);
  }
  if (boundariesHeld.length) {
    header(
      `held as designed (${boundariesHeld.length}) — failed at the real AWS call, not a synthetic refusal:`,
      GREEN,
    );
    boundariesHeld.forEach(line);
  }
  if (worked.length) {
    header(`passed (${worked.length}):`, GREEN);
    worked.forEach(line);
  }
  if (report.retried.length) {
    header(
      `needed a retry (${report.retried.length}) — LocalStack answered a cold-starting Lambda with a fast 502:`,
      YELLOW,
    );
    report.retried.forEach(line);
  }

  const clean =
    report.failures.length === 0 &&
    report.brokenBoundaries.length === 0 &&
    report.undetermined.length === 0;
  lines.push("");
  lines.push(
    `${clean ? GREEN : RED}` +
      `${report.results.length} checks: ${worked.length} passed, ${report.failures.length} failed, ` +
      `${skipped.length} skipped, ` +
      `${boundariesHeld.length} boundaries held, ${report.brokenBoundaries.length} boundary leaks, ` +
      `${report.undetermined.length} undetermined, ${report.retried.length} needed a retry.${RESET}`,
  );
  if (!clean) {
    lines.push(
      `${DIM}Reproduce any of these by hand, e.g.:${RESET}\n` +
        `${DIM}  curl -H "x-isb-identity: $(curl -s http://localhost:4599/session | jq -r .token)" http://localhost:4599/api/leases${RESET}`,
    );
  }
  return lines.join("\n");
}

// Only when invoked as a script, so importing this module from a test does not
// start a walk. An identity comparison rather than a substring match, for the
// reason `seed.ts` gives.
const invokedDirectly =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  console.info(`[local-verify] walking ${LOCAL_EDGE_URL}\n`);
  runVerification()
    .then((report) => {
      console.info(formatReport(report));
      // A boundary that could not be determined counts as a failure: an
      // unverified boundary is a gap in what this run has proven, and exiting 0
      // would claim otherwise.
      process.exit(
        report.failures.length ||
          report.brokenBoundaries.length ||
          report.undetermined.length
          ? 1
          : 0,
      );
    })
    .catch((error: unknown) => {
      console.error(
        `[local-verify] could not run: ${error instanceof Error ? error.message : String(error)}`,
      );
      process.exit(1);
    });
}
