/** Sessions: File › Save session / Open session (`.mbmux`), the autosave of
 *  the workspace to the app data folder, and the offer at launch to pick up
 *  where the last run left off.
 *
 *  - The autosave stays off until the launch offer is settled, so starting
 *    the app can never overwrite the last session with an empty one before
 *    the user had the chance to restore it. Loading anything counts as
 *    declining.
 *  - Mux options and output settings come back at every launch, whether or
 *    not the files are restored.
 *  - Files that went missing are listed before the session opens, never
 *    dropped without a word. Empty rows (a gap kept by pairing) aren't files
 *    and aren't listed. */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  buildSessionFile,
  createDebouncedSaver,
  findMissingFiles,
  isEmptySnapshot,
  parseSession,
  snapshotFingerprint,
} from "@/features/workspace/lib/session";
import {
  openSessionFile,
  pathsExist,
  pickSessionOpenPath,
  pickSessionSavePath,
  readAutosave,
  saveSessionFile,
  writeAutosave,
} from "@/shared/lib/workspaceStore";
import type { MuxSettings, OutputSettings } from "@/shared/types";
import type { LoadedSession, MissingFile, WorkspaceSnapshot } from "@/shared/types/recipes";
import { toast } from "@/ui/toast";

/** A failed call's message; null when it worked. (`strict` is off here, so `ok` alone doesn't narrow.) */
const failure = (result: { ok: boolean }): string | null => ("error" in result ? String((result as { error: unknown }).error) : null);

export const AUTOSAVE_DELAY_MS = 2000;

/** A session read and checked, waiting for the user to open it. */
export interface PendingSession {
  session: LoadedSession;
  /** "Show S01.mbmux", or "your last session". */
  label: string;
  savedAt: string | null;
  missing: MissingFile[];
  warnings: string[];
  /** Opening it replaces files that are loaded now. */
  replaces: boolean;
}

interface UseWorkspaceSessionInput {
  snapshot: WorkspaceSnapshot;
  /** Replace the workspace with a session. */
  apply: (session: LoadedSession) => void;
  /** Lay saved mux options and output settings over the current ones. */
  applySettings: (mux: Partial<MuxSettings>, output: Partial<OutputSettings>) => void;
  /** Wait for this before reading the autosave: the app's own settings
   *  (a preset's folders) must be in first, so the saved ones win. */
  ready: boolean;
  /** A batch, a measurement or a watch run is going: no session can open now. */
  busy: boolean;
  log: (line: string) => void;
  enabled?: boolean;
}

const fileName = (path: string) => path.replace(/^.*[\\/]/, "");
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** "16 videos, 32 audio files" for the restore offer. */
export function describeSession(session: Pick<LoadedSession, "videoFiles" | "audioFilesByTrack" | "subtitleFilesByTrack">): string {
  const real = (byTrack: LoadedSession["audioFilesByTrack"]) => Object.values(byTrack).reduce((sum, files) => sum + files.filter((file) => !file.placeholder).length, 0);
  const parts = [
    session.videoFiles.length ? plural(session.videoFiles.length, "video") : null,
    real(session.audioFilesByTrack) ? plural(real(session.audioFilesByTrack), "audio file") : null,
    real(session.subtitleFilesByTrack) ? plural(real(session.subtitleFilesByTrack), "subtitle") : null,
  ].filter(Boolean);
  return parts.length ? parts.join(", ") : "Files in the side pages";
}

const savedWhen = (iso: string | null) => {
  if (!iso) return "";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  const today = new Date().toDateString() === date.toDateString();
  return today ? `today at ${date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}` : date.toLocaleDateString([], { day: "numeric", month: "short" });
};

export function useWorkspaceSession({ snapshot, apply, applySettings, ready, busy, log, enabled = true }: UseWorkspaceSessionInput) {
  const [pending, setPending] = useState<PendingSession | null>(null);
  const [lastPath, setLastPath] = useState<string | null>(null);
  /** False until the launch offer is settled: then the autosave keeps the workspace. */
  const [autosaveOn, setAutosaveOn] = useState(false);
  const empty = useMemo(() => isEmptySnapshot(snapshot), [snapshot]);
  const latest = useRef({ snapshot, empty, apply, applySettings, log, busy });
  latest.current = { snapshot, empty, apply, applySettings, log, busy };

  const saver = useMemo(
    () =>
      createDebouncedSaver<WorkspaceSnapshot>((value) => writeAutosave(buildSessionFile(value)).then((result) => {
        if (!result.ok) throw new Error(failure(result) ?? "");
      }), { delayMs: AUTOSAVE_DELAY_MS, fingerprint: snapshotFingerprint }),
    [],
  );

  // ------------------------------------------------------------ opening

  const commit = useCallback((session: PendingSession) => {
    if (latest.current.busy) {
      toast({ title: "Can't open a session now", description: "Wait for the batch, the measurement or the watch folder to finish." });
      return;
    }
    latest.current.apply(session.session);
    setPending(null);
    setAutosaveOn(true);
    const missing = session.missing.length;
    latest.current.log(`Opened ${session.label}: ${describeSession(session.session)}${missing ? `; ${plural(missing, "file")} missing` : ""}`);
    for (const file of session.missing) latest.current.log(`Warning: missing ${file.kind}: ${file.path}`);
    toast({ title: `Opened ${session.label}`, description: missing ? `${plural(missing, "file is", "files are")} missing; they stay listed until you remove them.` : describeSession(session.session) });
  }, []);

  /** Check a session's files and either open it straight away or hold it for the dialog. */
  const offer = useCallback(async (raw: unknown, label: string, { quiet = false }: { quiet?: boolean } = {}) => {
    const parsed = parseSession(raw);
    if (!parsed.ok) {
      toast({ title: `Couldn't open ${label}`, description: "error" in parsed ? parsed.error : undefined, variant: "destructive" });
      return;
    }
    const missing = await findMissingFiles(parsed.session, pathsExist);
    const next: PendingSession = { session: parsed.session, label, savedAt: parsed.savedAt, missing, warnings: parsed.warnings, replaces: !latest.current.empty };
    if (quiet && missing.length === 0 && parsed.warnings.length === 0 && !next.replaces) {
      commit(next);
      return;
    }
    setPending(next);
  }, [commit]);

  const cancel = useCallback(() => {
    setPending(null);
    setAutosaveOn(true);
  }, []);

  const open = useCallback(async () => {
    if (latest.current.busy) {
      toast({ title: "Can't open a session now", description: "Wait for the batch, the measurement or the watch folder to finish." });
      return;
    }
    const path = await pickSessionOpenPath();
    if (!path) return;
    const result = await openSessionFile(path);
    if (!result.ok) {
      toast({ title: `Couldn't open ${fileName(path)}`, description: failure(result), variant: "destructive" });
      return;
    }
    setLastPath(path);
    await offer(result.value, fileName(path), { quiet: true });
  }, [offer]);

  const save = useCallback(async () => {
    const path = await pickSessionSavePath(lastPath ?? undefined);
    if (!path) return;
    const result = await saveSessionFile(path, buildSessionFile(latest.current.snapshot));
    if (!result.ok) {
      toast({ title: "The session wasn't saved", description: failure(result), variant: "destructive" });
      return;
    }
    setLastPath(path);
    latest.current.log(`Saved the session as ${path}`);
    toast({ title: `Saved ${fileName(path)}`, description: describeSession(latest.current.snapshot) });
  }, [lastPath]);

  // ------------------------------------------------------------ launch

  const launched = useRef(false);
  const offered = useRef<LoadedSession | null>(null);
  useEffect(() => {
    if (!enabled || !ready || launched.current) return;
    launched.current = true;
    void readAutosave().then((result) => {
      if (!result.ok || result.value === null) {
        setAutosaveOn(true);
        return;
      }
      const parsed = parseSession(result.value);
      if (!parsed.ok) {
        setAutosaveOn(true);
        return;
      }
      latest.current.applySettings(parsed.session.muxSettings, parsed.session.outputSettings);
      if (isEmptySnapshot(parsed.session)) {
        setAutosaveOn(true);
        return;
      }
      offered.current = parsed.session;
      const when = savedWhen(parsed.savedAt);
      toast({
        title: "Pick up where you left off?",
        description: `${describeSession(parsed.session)}${when ? `, saved ${when}` : ""}.`,
        duration: 30000,
        action: {
          label: "Restore",
          onClick: () => {
            offered.current = null;
            void offer(result.value, "your last session", { quiet: true });
          },
        },
      });
    });
  }, [enabled, ready, offer]);

  // Loading files instead of restoring is the answer too: from then on the
  // autosave keeps the new workspace.
  useEffect(() => {
    if (!autosaveOn && offered.current && !empty) {
      offered.current = null;
      setAutosaveOn(true);
    }
  }, [empty, autosaveOn]);

  useEffect(() => {
    if (!enabled) return;
    if (autosaveOn) saver.schedule(snapshot);
    // While the last session is on offer, its files stay as they were saved
    // and only the options change, so a setting changed meanwhile survives.
    else if (offered.current) saver.schedule({ ...(offered.current as unknown as WorkspaceSnapshot), muxSettings: snapshot.muxSettings, outputSettings: snapshot.outputSettings });
  }, [enabled, autosaveOn, snapshot, saver]);

  // Whatever waits is written when the window goes.
  useEffect(() => {
    const flush = () => void saver.flush();
    window.addEventListener("beforeunload", flush);
    return () => {
      window.removeEventListener("beforeunload", flush);
      saver.cancel();
    };
  }, [saver]);

  return { pending, open, save, commit, cancel, autosaveOn };
}
