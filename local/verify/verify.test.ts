// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";

import type { VerifyReport, VerifyResult } from "./types.js";
import { formatReport } from "./verify.js";

/**
 * The summary is the only thing a developer reads, and `local:verify` is
 * supposed to be a gate. These tests pin the two properties that make it
 * trustworthy: a check that did not run is *said so*, and a run that did less
 * work cannot be mistaken for a run that had fewer problems.
 *
 * They are cheap and they are here because the failure they cover was real. The
 * `quarantine` boundary check terminates the seeded Active lease, so a second
 * `local:verify` had no lease to `GET` or `PATCH`. Those two checks were guarded
 * by an `if` that simply did not emit them, and the run reported 39 checks
 * instead of 42 — all of them passing. A reader comparing that against a previous
 * 42-check run sees two fewer checks and no failures, which is exactly the
 * shape of good news.
 */

const result = (over: Partial<VerifyResult> = {}): VerifyResult => ({
  name: "a check",
  ok: true,
  detail: "did the thing",
  expectation: "should-work",
  ...over,
});

const report = (results: VerifyResult[]): VerifyReport => ({
  results,
  failures: results.filter((r) => !r.ok && r.expectation === "should-work"),
  brokenBoundaries: results.filter(
    (r) => r.ok && r.expectation === "should-fail",
  ),
  undetermined: results.filter((r) => r.undetermined),
  retried: results.filter((r) => r.attempts && r.attempts > 1),
});

/** The ANSI-stripped summary, so assertions read as prose. */
const plain = (text: string): string => text.replace(/\[\d+m/g, "");

describe("verify summary", () => {
  it("counts a skipped check as neither a pass nor a failure", () => {
    const output = plain(
      formatReport(
        report([
          result({ name: "ran and passed" }),
          result({
            name: "could not run",
            skipped: true,
            detail: "skipped: nothing to do",
          }),
        ]),
      ),
    );
    expect(output).toContain("2 checks: 1 passed, 0 failed, 1 skipped");
    // The whole point: the skip is visible as its own line, not folded into the
    // pass count where a smaller total would be the only clue.
    expect(output).toContain("skipped (1)");
    expect(output).toContain("could not run");
  });

  it("names why a check was skipped, not merely that it was", () => {
    const output = plain(
      formatReport(
        report([
          result({
            name: "leases: PATCH /api/leases/{leaseId} (update)",
            skipped: true,
            detail:
              "skipped: no lease is in the Active state, so there is nothing to update",
          }),
        ]),
      ),
    );
    expect(output).toContain("no lease is in the Active state");
    // And the remedy, so a reader is not left with a fact and no next step.
    expect(output).toContain("local:reset");
  });

  it("does not set a failing exit state for a skip", () => {
    // A skip is a consequence of a boundary check that reported itself, not a
    // defect. `formatReport` owns the exit code through the word "clean" only by
    // the absence of failures/leaks/undetermined, so this asserts the two
    // buckets a skip must stay out of.
    const skipped = result({ skipped: true });
    const summary = report([skipped]);
    expect(summary.failures).toEqual([]);
    expect(summary.brokenBoundaries).toEqual([]);
    expect(summary.undetermined).toEqual([]);
  });

  it("still counts a real failure, alongside a skip", () => {
    const output = plain(
      formatReport(
        report([
          result({ name: "ok" }),
          result({
            name: "could not run",
            skipped: true,
            detail: "skipped: why",
          }),
          result({ name: "broke", ok: false, detail: "500" }),
        ]),
      ),
    );
    expect(output).toContain("3 checks: 1 passed, 1 failed, 1 skipped");
    expect(output).toContain("broke");
  });

  it("keeps a boundary that held out of the pass and skip counts", () => {
    // The three buckets must not blur: a `should-fail` check that held is
    // evidence, and it is evidence of a different kind than a working read.
    const output = plain(
      formatReport(
        report([
          result({ name: "a read" }),
          result({
            name: "a boundary",
            ok: false,
            expectation: "should-fail",
            detail: "failed at the real call",
          }),
        ]),
      ),
    );
    expect(output).toContain(
      "2 checks: 1 passed, 0 failed, 0 skipped, 1 boundaries held",
    );
  });

  it("never reports a boundary leak as clean", () => {
    // The inverse of the above, and the one that matters most: a `should-fail`
    // check that *passed* means the profile served something it must not. It is
    // the worst outcome available and it has to be unmissable in the output.
    const output = plain(
      formatReport(
        report([
          result({
            name: "a boundary that leaked",
            expectation: "should-fail",
            detail: "LEAKED: answered 200",
          }),
        ]),
      ),
    );
    expect(output).toContain("BOUNDARY LEAK");
    expect(output).toContain("1 boundary leaks");
  });
});
