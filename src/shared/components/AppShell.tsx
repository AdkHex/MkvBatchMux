import * as React from "react";
import { Minus, Square, X } from "lucide-react";
import { cn } from "@/shared/lib/utils";
import { IconButton } from "./IconButton";

interface AppShellProps {
  sidebar: React.ReactNode;
  topbar: React.ReactNode;
  children: React.ReactNode;
  className?: string;
}

export function AppShell({ sidebar, topbar, children, className }: AppShellProps) {
  const [isMaximized, setIsMaximized] = React.useState(false);

  const isTauri =
    typeof window !== "undefined" && "__TAURI_IPC__" in window;

  const withWindow = React.useCallback(
    async (action: (win: { minimize: () => Promise<void>; toggleMaximize: () => Promise<void>; close: () => Promise<void>; isMaximized: () => Promise<boolean> }) => Promise<void>) => {
      if (!isTauri) return;
      const { appWindow } = await import("@tauri-apps/api/window");
      await action(appWindow);
    },
    [isTauri],
  );

  React.useEffect(() => {
    if (!isTauri) return;
    withWindow(async (win) => {
      setIsMaximized(await win.isMaximized());
    }).catch(() => undefined);

    // Keep the caption button in sync when the window is resized or snapped
    // from outside the app (drag to edge, Win+Up, double-click title bar).
    let unlisten: (() => void) | undefined;
    let cancelled = false;
    import("@tauri-apps/api/window")
      .then(({ appWindow }) =>
        appWindow.onResized(async () => {
          setIsMaximized(await appWindow.isMaximized());
        }),
      )
      .then((fn) => {
        if (cancelled) {
          fn();
          return;
        }
        unlisten = fn;
      })
      .catch(() => undefined);

    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [isTauri, withWindow]);

  return (
    // Title bar spans the full window width above the sidebar, as on Windows 11.
    <div className={cn("h-screen flex flex-col bg-background overflow-hidden", className)}>
      <div className="fluent-windowbar">
        <div className="fluent-windowbar__drag" data-tauri-drag-region>
          <span className="fluent-windowbar__title">MKVBatchMux</span>
          <span className="fluent-windowbar__byline">by Ionicboy</span>
        </div>
        <div className="fluent-windowbar__controls">
          <IconButton
            aria-label="Minimize"
            className="fluent-window-control"
            onClick={() => withWindow(async (win) => win.minimize())}
          >
            <Minus className="w-3.5 h-3.5" />
          </IconButton>
          <IconButton
            aria-label={isMaximized ? "Restore" : "Maximize"}
            className="fluent-window-control"
            onClick={() =>
              withWindow(async (win) => {
                await win.toggleMaximize();
                setIsMaximized(await win.isMaximized());
              })
            }
          >
            <Square className="w-3 h-3" />
          </IconButton>
          <IconButton
            aria-label="Close"
            className="fluent-window-control fluent-window-control--close"
            onClick={() => withWindow(async (win) => win.close())}
          >
            <X className="w-3.5 h-3.5" />
          </IconButton>
        </div>
      </div>
      <div className="flex-1 flex min-h-0">
        {sidebar}
        <div className="flex-1 flex flex-col min-w-0">
          {topbar}
          <main className="flex-1 overflow-hidden">{children}</main>
        </div>
      </div>
    </div>
  );
}
