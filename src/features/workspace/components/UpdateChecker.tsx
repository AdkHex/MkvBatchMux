import * as React from "react";
import { Download, RefreshCw } from "lucide-react";
import { Button } from "@/shared/ui/button";
import { toast } from "@/shared/hooks/use-toast";
import { installUpdateAndRestart } from "@/features/workspace/hooks/useAutoUpdate";
import { cn } from "@/shared/lib/utils";

type UpdateState =
  | { status: "idle" }
  | { status: "checking" }
  | { status: "available"; version: string; notes: string }
  | { status: "current" }
  | { status: "downloading" }
  | { status: "ready" }
  | { status: "error"; message: string };

/**
 * Check-for-updates control shown in Settings.
 *
 * Tauri's built-in updater dialog is disabled in tauri.conf.json so the flow
 * is visible here instead: a batch can run for several minutes, and a modal
 * that appears unprompted mid-run and offers to restart is the one thing this
 * app must never do.
 */
export function UpdateChecker() {
  const [state, setState] = React.useState<UpdateState>({ status: "idle" });

  const check = React.useCallback(async () => {
    setState({ status: "checking" });
    try {
      const { checkUpdate } = await import("@tauri-apps/api/updater");
      const result = await checkUpdate();
      if (result.shouldUpdate) {
        setState({
          status: "available",
          version: result.manifest?.version ?? "",
          notes: result.manifest?.body ?? "",
        });
      } else {
        setState({ status: "current" });
      }
    } catch (error) {
      setState({ status: "error", message: String(error) });
    }
  }, []);

  const install = React.useCallback(async () => {
    setState({ status: "downloading" });
    try {
      // Shared with the background offer, so both paths install and relaunch
      // identically.
      await installUpdateAndRestart();
      setState({ status: "ready" });
    } catch (error) {
      setState({ status: "error", message: String(error) });
      toast({
        title: "Update failed",
        description: String(error),
        variant: "destructive",
      });
    }
  }, []);

  const busy = state.status === "checking" || state.status === "downloading";

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-3 rounded border border-panel-border px-3 py-2">
        <div className="min-w-0 flex-1">
          <div className="text-[13px] text-foreground">Updates</div>
          <div className="text-xs text-muted-foreground truncate">
            {state.status === "checking" && "Checking for updates…"}
            {state.status === "downloading" && "Downloading update…"}
            {state.status === "current" && "You're on the latest version."}
            {state.status === "ready" && "Installed. Restarting…"}
            {state.status === "available" && `Version ${state.version} is available.`}
            {state.status === "error" && state.message}
            {state.status === "idle" && "Check whether a newer version is available."}
          </div>
        </div>
        {state.status === "available" ? (
          <Button variant="default" size="sm" className="gap-1.5 shrink-0" onClick={install}>
            <Download className="w-3.5 h-3.5" />
            Install
          </Button>
        ) : (
          <Button
            variant="secondary"
            size="sm"
            className="gap-1.5 shrink-0"
            onClick={check}
            disabled={busy}
          >
            <RefreshCw className={cn("w-3.5 h-3.5", busy && "animate-spin")} />
            Check now
          </Button>
        )}
      </div>

      {state.status === "available" && state.notes ? (
        <div className="rounded border border-panel-border px-3 py-2 text-xs text-muted-foreground whitespace-pre-line max-h-32 overflow-y-auto">
          {state.notes}
        </div>
      ) : null}
    </div>
  );
}
