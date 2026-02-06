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
    <header className={cn("fluent-topbar h-12 flex items-center px-5 gap-3 shrink-0", className)}>
      <div className="flex items-center gap-3">
        <h2 className="text-lg font-semibold text-foreground">{title}</h2>
      </div>
      <div className="flex-1" />
      <div className="relative w-64">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
        <TextField
          value={searchValue}
          onChange={(event) => onSearchChange?.(event.target.value)}
          placeholder={searchPlaceholder}
          className="pl-9"
        />
      </div>
      {rightActions ? <div className="flex items-center gap-4">{rightActions}</div> : null}
    </header>
  );
}
