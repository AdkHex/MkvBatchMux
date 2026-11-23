/** What checking a finished mux found (src-tauri/src/verify.rs), sent on the
 *  job's final `mux-progress` event. */

export type VerificationStatus = "pass" | "warn" | "fail" | "skip";

export interface VerificationCheck {
  /** "tracks", "added", "duration", "chapters", "attachments", "order",
   *  "flags", "audioLength", "sync" (and "sync-2"… for further added audio),
   *  or "readable" when mkvmerge could not read the output at all. */
  id: string;
  label: string;
  status: VerificationStatus;
  detail: string;
}

export interface VerificationReport {
  /** No check failed; warnings leave it true. */
  ok: boolean;
  checks: VerificationCheck[];
  /** The added audio track furthest from the source's audio, in ms; positive
   *  when it plays late. Null when nothing was measured. */
  residualMs?: number | null;
  syncConfidence?: number | null;
  /** Where a failed output was kept, as `<name>.unverified.mkv`. */
  keptPath?: string | null;
}

/** How a job's verification came out, for its Status and History. */
export type VerificationOutcome = "verified" | "warnings" | "failed";

export function verificationOutcome(report: VerificationReport | undefined | null): VerificationOutcome | null {
  if (!report) return null;
  if (!report.ok) return "failed";
  return report.checks.some((check) => check.status === "warn") ? "warnings" : "verified";
}

/** The checks worth reading first: failures, then warnings. */
export function verificationProblems(report: VerificationReport | undefined | null): VerificationCheck[] {
  if (!report) return [];
  return [...report.checks.filter((check) => check.status === "fail"), ...report.checks.filter((check) => check.status === "warn")];
}
