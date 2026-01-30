import * as React from "react";
import { cn } from "@/lib/utils";

interface AppShellProps {
  sidebar: React.ReactNode;
  topbar: React.ReactNode;
  children: React.ReactNode;
  className?: string;
}

export function AppShell({ sidebar, topbar, children, className }: AppShellProps) {
  return (
    <div className={cn("h-screen flex bg-background overflow-hidden", className)}>
      {sidebar}
      <div className="flex-1 flex flex-col min-w-0">
        {topbar}
        <main className="flex-1 overflow-hidden">{children}</main>
      </div>
    </div>
  );
}
