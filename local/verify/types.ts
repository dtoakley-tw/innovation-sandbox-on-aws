// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * What one check reports, and the two kinds of check.
 *
 * The distinction is load-bearing rather than cosmetic. A `should-work` check
 * that fails is a defect in the profile. A `should-fail` check that *passes*
 * is also a defect: it means a flow the design says LocalStack cannot serve is
 * either silently succeeding or being masked by a synthetic refusal. Both
 * outcomes have to be visible in the summary, and only the first may set a
 * non-zero exit.
 */
export type Expectation = "should-work" | "should-fail";

export interface VerifyResult {
  /** Human-readable and stable enough to grep for in CI output. */
  name: string;
  ok: boolean;
  /**
   * What actually happened, with the evidence in it: a status, a schema issue
   * path, the service an unsupported call named. A check that reports "failed"
   * without saying why is the failure mode this script exists to avoid.
   */
  detail: string;
  expectation: Expectation;
  /** The request that produced it, for reproducing a failure by hand. */
  request?: string;
  /**
   * Attempts spent, when more than one. Non-1 means a retry was needed, which
   * is itself a finding: it is how the LocalStack cold-start 502 shows up in the
   * output instead of hiding behind a retry that succeeded.
   */
  attempts?: number;
  /**
   * A `should-fail` check that could not determine its answer, because every
   * attempt came back as a bare gateway 5xx. Neither a leak nor a hold, and
   * reported separately so it is not mistaken for either. Counts towards the
   * exit code, because an unverified boundary is a real gap in what this script
   * has proven.
   */
  undetermined?: boolean;
}

export interface VerifyOptions {
  /** Edge origin. Defaults to `ISB_LOCAL_EDGE_URL`, then `localhost:4599`. */
  edgeUrl?: string;
  /**
   * Attempts per `should-work` check. LocalStack intermittently answers a
   * cold-starting Lambda with a fast, logless 502 `{"message": "Internal server
   * error"}`; a walker that treats that as a defect reports a broken profile
   * every run. Default 3.
   */
  maxAttempts?: number;
  /** Milliseconds between attempts. */
  retryDelayMs?: number;
}

export interface VerifyReport {
  results: VerifyResult[];
  /** `should-work` checks that did not pass. Drives the exit code. */
  failures: VerifyResult[];
  /** `should-fail` checks that passed, i.e. boundaries that are not holding. */
  brokenBoundaries: VerifyResult[];
  /** `should-fail` checks whose answer could not be determined. */
  undetermined: VerifyResult[];
  /** Everything that needed a second attempt, i.e. LocalStack flakiness. */
  retried: VerifyResult[];
}
