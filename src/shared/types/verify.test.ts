import { describe, expect, it } from "vitest";
import { verificationOutcome, verificationProblems, type VerificationReport } from "./verify";

const report: VerificationReport = {
  ok: true,
  checks: [
    { id: "tracks", label: "Tracks", status: "pass", detail: "1 video, 2 audio tracks" },
    { id: "flags", label: "Names and flags", status: "warn", detail: "Audio 2 is not default" },
    { id: "sync", label: "Sync", status: "skip", detail: "Turned off" },
  ],
};

describe("verification outcome", () => {
  it("is verified, verified with warnings, or failed", () => {
    expect(verificationOutcome(undefined)).toBeNull();
    expect(verificationOutcome({ ...report, checks: [report.checks[0], report.checks[2]] })).toBe("verified");
    expect(verificationOutcome(report)).toBe("warnings");
    expect(verificationOutcome({ ...report, ok: false })).toBe("failed");
  });

  it("lists failures before warnings, and nothing that passed or was skipped", () => {
    const failed: VerificationReport = { ...report, ok: false, checks: [...report.checks, { id: "sync", label: "Sync", status: "fail", detail: "1317 ms late" }] };
    expect(verificationProblems(failed).map((check) => check.status)).toEqual(["fail", "warn"]);
    expect(verificationProblems(null)).toEqual([]);
  });
});
