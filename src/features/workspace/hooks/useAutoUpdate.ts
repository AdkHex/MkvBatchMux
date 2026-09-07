/** Background update checking.
 *
 *  Tauri's own updater dialog is disabled in tauri.conf.json, because it can
 *  appear unprompted in the middle of a batch and offer to restart. This does
 *  the same job on the app's terms: it checks quietly, and only ever *offers*.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "@/shared/hooks/use-toast";

/** Long enough that a day-long session still notices a release, short enough
 *  that it is not effectively launch-only. */
const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;

/** A moment after launch, so the check never competes with first paint or with
 *  the initial folder scan. */
const STARTUP_DELAY_MS = 8000;

/** Whether a mux batch is running right now.
 *
 *  Module level on purpose. An install relaunches the app, and both entry
 *  points to it -- the background offer's toast action and the Settings
 *  button -- sit outside the component that knows about the queue. Checking a
 *  shared flag at the moment of install is what makes "never restart mid-batch"
 *  true regardless of which button is pressed, and regardless of the batch
 *  having started after the offer was raised.
 */
let muxBatchRunning = false;

interface UseAutoUpdateInput {
  /** True while a mux batch is running. Nothing is offered during one: a batch
   *  can run for many minutes and an install means a restart. */
  isBusy: boolean;
  /** Called when the user accepts, so the caller can show its own UI. */
  onUpdateAvailable: (version: string, notes: string) => void;
}

export function useAutoUpdate({ isBusy, onUpdateAvailable }: UseAutoUpdateInput) {
  const [checking, setChecking] = useState(false);
  // Read through a ref so the interval closure never captures a stale value
  // and never has to be torn down and rebuilt when busyness changes.
  const isBusyRef = useRef(isBusy);
  isBusyRef.current = isBusy;
  // One offer per version per session. Without this the interval would raise
  // the same toast every few hours for a release the user already declined.
  const offeredRef = useRef<string | null>(null);
  const onAvailableRef = useRef(onUpdateAvailable);
  onAvailableRef.current = onUpdateAvailable;

  const check = useCallback(async () => {
    if (isBusyRef.current) return;
    setChecking(true);
    try {
      const { checkUpdate } = await import("@tauri-apps/api/updater");
      const result = await checkUpdate();
      if (!result.shouldUpdate) return;
      // A batch can start while the check above is in flight. Offering now
      // would put an Install button in front of someone mid-run, so drop the
      // result and let the next scheduled check raise it when things are idle.
      if (isBusyRef.current) return;

      const version = result.manifest?.version ?? "";
      if (offeredRef.current === version) return;
      offeredRef.current = version;

      onAvailableRef.current(version, result.manifest?.body ?? "");
    } catch {
      // A failed check is not worth interrupting anyone over: no network, or
      // GitHub is down. The Settings panel reports failures when asked
      // directly, which is where someone looking for an update will go.
    } finally {
      setChecking(false);
    }
  }, []);

  // Mirrored into module scope after commit rather than during render, so a
  // render React throws away can never leave the flag describing a batch that
  // is not actually running.
  useEffect(() => {
    muxBatchRunning = isBusy;
  }, [isBusy]);

  useEffect(() => {
    const startup = setTimeout(check, STARTUP_DELAY_MS);
    const interval = setInterval(check, CHECK_INTERVAL_MS);
    return () => {
      clearTimeout(startup);
      clearInterval(interval);
    };
  }, [check]);

  return { checking, checkNow: check };
}

/** Download and install, then restart.
 *
 *  Exported so the toast action and the Settings button share one path --
 *  two copies of an install-and-relaunch sequence is one too many.
 */
export async function installUpdateAndRestart(): Promise<void> {
  // The last line of defence. An offer raised while idle stays on screen for
  // 30 seconds and the Settings button is always live, so the batch state at
  // the moment of the click is the only one that counts.
  if (muxBatchRunning) {
    throw new Error(
      "A mux batch is running. Installing restarts the app, so finish or stop the batch first.",
    );
  }
  const { installUpdate } = await import("@tauri-apps/api/updater");
  await installUpdate();
  toast({
    title: "Update installed",
    description: "Restarting…",
  });
  const { relaunch } = await import("@tauri-apps/api/process");
  await relaunch();
}
