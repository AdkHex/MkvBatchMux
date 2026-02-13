import * as React from "react";
import { Search } from "lucide-react";
import { cn } from "@/lib/utils";
import { TextField } from "./Fields";

interface CommandBarProps {
  title: string;
  searchPlaceholder?: string;
  onSearchChange?: (value: string) => void;
  searchValue?: string;
  rightActions?: React.ReactNode;
  className?: string;
}

export function CommandBar({
  title,
  searchPlaceholder = "Search files...",
  onSearchChange,
  searchValue,
  rightActions,
  className,
}: CommandBarProps) {
  return (
    <header className={cn("fluent-topbar h-[52px] flex items-center px-5 gap-3 shrink-0", className)}>
      <div className="flex items-center gap-3">
        <h2 className="text-[18px] font-semibold text-foreground tracking-tight">{title}</h2>
      </div>
      <div className="flex-1" />
      <div className="relative w-[260px] max-w-[40vw]">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
        <TextField
          value={searchValue}
          onChange={(event) => onSearchChange?.(event.target.value)}
          placeholder={searchPlaceholder}
          className="pl-9 h-8"
        />
      </div>
      {rightActions ? <div className="flex items-center gap-2">{rightActions}</div> : null}
    </header>
  );
}
