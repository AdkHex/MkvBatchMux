import * as React from "react";
import { Minus, Square, X } from "lucide-react";
import { cn } from "@/lib/utils";
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
  }, [isTauri, withWindow]);

  return (
    <div className={cn("h-screen flex bg-background overflow-hidden", className)}>
      {sidebar}
      <div className="flex-1 flex flex-col min-w-0">
        <div className="fluent-windowbar">
          <div className="fluent-windowbar__drag" data-tauri-drag-region>
            <div className="fluent-windowbar__title-wrap">
              <span className="fluent-windowbar__title">MKVBatchMux</span>
              <span className="fluent-windowbar__subtitle">By Ionicboy</span>
            </div>
          </div>
          <div className="fluent-windowbar__controls">
            <IconButton
              aria-label="Minimize"
              className="fluent-window-control"
              onClick={() => withWindow(async (win) => win.minimize())}
            >
              <Minus className="w-4 h-4" />
            </IconButton>
            <IconButton
              aria-label="Maximize"
              className="fluent-window-control"
              onClick={() =>
                withWindow(async (win) => {
                  await win.toggleMaximize();
                  setIsMaximized(await win.isMaximized());
                })
              }
            >
              <Square className={cn("w-3.5 h-3.5", isMaximized && "scale-90")} />
            </IconButton>
            <IconButton
              aria-label="Close"
              className="fluent-window-control fluent-window-control--close"
              onClick={() => withWindow(async (win) => win.close())}
            >
              <X className="w-4 h-4" />
            </IconButton>
          </div>
        </div>
        {topbar}
        <main className="flex-1 overflow-hidden">{children}</main>
      </div>
    </div>
  );
}
