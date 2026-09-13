/** Tauri's own updater dialog is disabled; this checks quietly and only ever offers. */

import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "@/shared/hooks/use-toast";

const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;

const STARTUP_DELAY_MS = 8000;

/** Module-level so both the toast action and the Settings button see the same
 *  state; an install restarts the app so this must never be stale. */
let muxBatchRunning = false;

interface UseAutoUpdateInput {
  /** Nothing is offered while a batch is running, since installing restarts the app. */
  isBusy: boolean;
  /** Called when the user accepts, so the caller can show its own UI. */
  onUpdateAvailable: (version: string, notes: string) => void;
}

export function useAutoUpdate({ isBusy, onUpdateAvailable }: UseAutoUpdateInput) {
  const [checking, setChecking] = useState(false);
  // Ref avoids tearing down/rebuilding the interval when busyness changes.
  const isBusyRef = useRef(isBusy);
  isBusyRef.current = isBusy;
  // One offer per version per session, so a declined release doesn't nag again.
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
      // A batch may have started while the check was in flight; re-check before offering.
      if (isBusyRef.current) return;

      const version = result.manifest?.version ?? "";
      if (offeredRef.current === version) return;
      offeredRef.current = version;

      onAvailableRef.current(version, result.manifest?.body ?? "");
    } catch {
      // Silent failure; the Settings panel reports errors when checked directly.
    } finally {
      setChecking(false);
    }
  }, []);

  // Set after commit, not during render, so a discarded render can't leave a stale flag.
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

/** Download and install, then restart. Shared by the toast action and the Settings button. */
export async function installUpdateAndRestart(): Promise<void> {
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
