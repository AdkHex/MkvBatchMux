/** The shell's contract with the pages.
 *
 *  Every page (Videos, Subtitles, Audio, Chapters, Attachments, Mux) is its own
 *  container: it keeps its own state and stays mounted while hidden, so
 *  switching pages loses nothing. What the pages share lives here:
 *
 *  - the engine, which runs one command at a time. Measuring delays (Audio)
 *    and validating or muxing (Mux) each claim it for their run and release it
 *    after; while one page holds it, the other's run button is off and the
 *    page bar shows a spinner on the page that is running.
 *  - the menus, keyboard shortcuts and OS file drops, which act on the page
 *    that is showing, through the commands it registers.
 *  - the Output log, History, the dock's shared tabs, and Preferences. */

import { createContext, useContext, useEffect, useRef } from "react";

import type { StatusProps } from "@/ui/frame";
import type { HistoryEntry } from "./history";
import type { CommonDock } from "./dock";

export type PageId = "videos" | "subtitles" | "audio" | "chapters" | "attachments" | "mux";

/** A page that runs something that must not overlap another page's run. */
export type EnginePage = Extract<PageId, "audio" | "mux">;

/** What a page can be asked to do from outside it: the menu bar, the
 *  keyboard, and files dropped on the window. Any may be absent. */
export interface PageCommands {
  /** File › Choose folder (Ctrl+O). */
  chooseFolder?: () => void;
  /** File › Add files (Attachments). */
  addFiles?: () => void;
  /** File › Import from a video (Audio, Subtitles). */
  importFromVideo?: () => void;
  /** Edit › Select all (Ctrl+A). */
  selectAll?: () => void;
  /** Edit › Remove (Del). */
  removeSelected?: () => void;
  /** Edit › Clear the list. */
  clear?: () => void;
  /** Edit › Move up / down (Alt+↑ / Alt+↓). */
  moveUp?: () => void;
  moveDown?: () => void;
  /** Edit › New track / Duplicate track (Audio, Subtitles). */
  newTrack?: () => void;
  duplicateTrack?: () => void;
  /** Tools › Media info (Ctrl+I, Videos). */
  mediaInfo?: () => void;
  /** Enter: the page's run action (Measure delays, Start muxing). */
  start?: () => void;
  /** Esc while the page runs: stop it. */
  stop?: () => void;
  /** Paths dropped on the window while this page shows. */
  drop?: (paths: string[]) => void;
  /** Commands that exist but cannot act right now (nothing selected, a run
   *  going). Absent means available. */
  disabled?: Partial<Record<CommandKey, boolean>>;
}

export type CommandKey = Exclude<keyof PageCommands, "disabled">;

export interface Shell {
  /** The page showing. */
  active: PageId;
  show: (page: PageId) => void;
  /** Running in the desktop app, not a plain browser. */
  desktop: boolean;

  /** The page whose run holds the engine, or null when it is free. */
  enginePage: EnginePage | null;
  /** Take the engine for a run; false when another page holds it. */
  claimEngine: (page: EnginePage) => boolean;
  releaseEngine: (page: EnginePage) => void;

  /** A line for the Output dock. */
  log: (message: string) => void;
  /** Open the dock at Output. */
  openOutput: () => void;
  dock: CommonDock;

  addHistory: (entry: HistoryEntry) => void;

  setCommands: (page: PageId, commands: PageCommands | null) => void;

  /** What a page shows in the toolbar's status; null when idle. */
  publishStatus: (page: PageId, status: StatusProps | null) => void;
  /** The status of the run holding the engine (a measurement, a mux), for
   *  the pages that have nothing of their own to show. */
  runStatus: { page: PageId; status: StatusProps } | null;
  openPreferences: (tab?: "general" | "presets" | "measure" | "tools" | "updates") => void;
  /** Copy text to the clipboard, with a toast. */
  copy: (text: string) => void;
}

export const ShellContext = createContext<Shell | null>(null);

export function useShell(): Shell {
  const shell = useContext(ShellContext);
  if (!shell) throw new Error("useShell must be used inside the app shell");
  return shell;
}

const COMMAND_KEYS: CommandKey[] = [
  "chooseFolder",
  "addFiles",
  "importFromVideo",
  "selectAll",
  "removeSelected",
  "clear",
  "moveUp",
  "moveDown",
  "newTrack",
  "duplicateTrack",
  "mediaInfo",
  "start",
  "stop",
  "drop",
];

/** Register a page's commands with the shell for as long as it is mounted.
 *  The shell reads them live: a command the page offers only in some states
 *  (Stop while running) is there exactly when the page passes it. */
export function usePageCommands(page: PageId, commands: PageCommands) {
  const { setCommands } = useShell();
  const ref = useRef(commands);
  ref.current = commands;
  useEffect(() => {
    const live = {} as PageCommands;
    for (const key of COMMAND_KEYS) {
      Object.defineProperty(live, key, {
        enumerable: true,
        get: () => {
          const command = ref.current[key] as ((...a: unknown[]) => void) | undefined;
          return command ? (...args: unknown[]) => (ref.current[key] as ((...a: unknown[]) => void) | undefined)?.(...args) : undefined;
        },
      });
    }
    Object.defineProperty(live, "disabled", { enumerable: true, get: () => ref.current.disabled });
    setCommands(page, live);
    return () => setCommands(page, null);
    // Registered once per page; the getters read the latest commands.
  }, [page, setCommands]);
}

/** The status a page shows: its own while it has one; otherwise the run in
 *  progress elsewhere, which opens that page when clicked. */
export function useStatus(page: PageId, own: StatusProps | null): StatusProps | null {
  const { publishStatus, runStatus, show } = useShell();
  const key = own ? [own.icon, typeof own.text === "string" ? own.text : "", own.pct ?? "", typeof own.time === "string" ? own.time : "", own.detail ?? ""].join("|") : "";
  const ownRef = useRef(own);
  ownRef.current = own;
  useEffect(() => {
    publishStatus(page, ownRef.current);
  }, [page, key, publishStatus]);
  useEffect(() => () => publishStatus(page, null), [page, publishStatus]);
  if (own) return own;
  if (runStatus && runStatus.page !== page) return { ...runStatus.status, onClick: () => show(runStatus.page) };
  return null;
}
