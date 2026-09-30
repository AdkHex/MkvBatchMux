/** History: the runs that finished — mux batches and delay measurements —
 *  kept in local storage and listed in the bottom dock. The same outcome
 *  words are used by the status display while a page is showing its result,
 *  so the two always agree. */

import type { St } from "@/ui/kit";
import type { MuxJob } from "@/shared/types";

export type HistoryPage = "mux" | "audio";

export interface HistoryEntry {
  id: string;
  page: HistoryPage;
  /** "Goblin.S01E01 and 15 more". */
  name: string;
  outcome: { tone: St; text: string };
  /** ISO 8601. */
  date: string;
  /** One line per file, for the run's report. */
  files?: { name: string; tone: St; text: string }[];
}

export const HISTORY_KEY = "mkvbatchmux.history";
export const MAX_HISTORY = 200;

export const PAGE_LABEL: Record<HistoryPage, string> = { mux: "Mux", audio: "Audio" };

type Store = Pick<Storage, "getItem" | "setItem">;

const storage = (): Store | null => {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
};

export function loadHistory(store: Store | null = storage()): HistoryEntry[] {
  try {
    const raw = store?.getItem(HISTORY_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (entry): entry is HistoryEntry =>
        !!entry &&
        typeof entry === "object" &&
        typeof (entry as HistoryEntry).id === "string" &&
        ((entry as HistoryEntry).page === "mux" || (entry as HistoryEntry).page === "audio") &&
        typeof (entry as HistoryEntry).date === "string",
    );
  } catch {
    return [];
  }
}

/** Save and return what was kept: the newest MAX_HISTORY runs. */
export function saveHistory(entries: HistoryEntry[], store: Store | null = storage()): HistoryEntry[] {
  const kept = entries.slice(0, MAX_HISTORY);
  try {
    store?.setItem(HISTORY_KEY, JSON.stringify(kept));
  } catch {
    // History is a convenience; a full or blocked storage must not stop a run.
  }
  return kept;
}

const stem = (name: string) => name.replace(/\.[^.]+$/, "");

/** A run's name: its first file, and how many more. */
export function runName(names: string[]): string {
  if (names.length === 0) return "Run";
  const first = stem(names[0]);
  return names.length > 1 ? `${first} and ${names.length - 1} more` : first;
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** What a mux batch did, as the status display and History say it. `parts`
 *  are joined with " · " on the display and ", " in History. */
export function muxOutcome(jobs: Pick<MuxJob, "status">[]): { tone: St; parts: string[] } {
  const count = (status: MuxJob["status"]) => jobs.filter((job) => job.status === status).length;
  const done = count("completed");
  const failed = count("error");
  const stopped = count("stopped");
  const waiting = count("queued") + count("processing");
  if (stopped > 0) {
    const parts = ["Stopped", `${done} muxed`];
    if (failed) parts.push(`${failed} failed`);
    return { tone: "warn", parts };
  }
  const parts = [`${done} muxed`];
  if (failed) parts.push(`${failed} failed`);
  if (waiting) parts.push(`${waiting} not finished`);
  return { tone: failed === 0 && waiting === 0 ? "ok" : done === 0 ? "bad" : "warn", parts };
}

/** When a run finished, as the dock writes it: "Today 11:05",
 *  "Yesterday 22:40", "Sep 26 09:30", "Sep 26 2025". */
export function whenText(value: string, now = new Date()): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Unknown date";
  const time = `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
  const day = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const days = Math.round((day(now) - day(date)) / 86_400_000);
  if (days === 0) return `Today ${time}`;
  if (days === 1) return `Yesterday ${time}`;
  const month = date.toLocaleString("en-US", { month: "short" });
  return date.getFullYear() === now.getFullYear() ? `${month} ${date.getDate()} ${time}` : `${month} ${date.getDate()} ${date.getFullYear()}`;
}

/** "1m 58s", "42 s", "1 h 4 m": how long a run took. */
export function tookText(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, "0")}s`;
  return `${Math.floor(m / 60)} h ${m % 60} m`;
}

/** "3 min left", "Under a minute left": the rest of a run, from how long the
 *  part already done took. Null until there is enough to go on. */
export function timeLeftText(elapsedMs: number, fraction: number): string | null {
  if (!(fraction > 0.02) || fraction >= 1 || elapsedMs < 3000) return null;
  const leftS = (elapsedMs / fraction - elapsedMs) / 1000;
  if (leftS < 60) return "Under a minute left";
  const minutes = Math.round(leftS / 60);
  if (minutes < 60) return `${minutes} min left`;
  return `${Math.floor(minutes / 60)} h ${minutes % 60} min left`;
}

export { plural };
