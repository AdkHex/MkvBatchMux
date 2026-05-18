import * as React from "react";
import { Search } from "lucide-react";
import { cn } from "@/shared/lib/utils";
import { TextField } from "./Fields";

interface CommandBarProps {
  title: string;
  searchPlaceholder?: string;
  onSearchChange?: (value: string) => void;
  searchValue?: string;
  filterValue?: string;
  onFilterChange?: (value: string) => void;
  sortValue?: string;
  onSortChange?: (value: string) => void;
  rightActions?: React.ReactNode;
  className?: string;
}

export function CommandBar({
  title,
  searchPlaceholder = "Search files...",
  onSearchChange,
  searchValue,
  filterValue = "all",
  onFilterChange,
  sortValue = "loaded",
  onSortChange,
  rightActions,
  className,
}: CommandBarProps) {
  return (
    <header className={cn("fluent-topbar h-[52px] flex items-center px-5 gap-3 shrink-0", className)}>
      <div className="flex items-center gap-3">
        <h2 className="text-[18px] font-semibold text-foreground tracking-tight">{title}</h2>
      </div>
      <div className="flex-1" />
      {onSearchChange ? (
        <div className="relative w-[260px] max-w-[40vw]">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
          <TextField
            value={searchValue}
            onChange={(event) => onSearchChange(event.target.value)}
            placeholder={searchPlaceholder}
            className="pl-9 h-8"
          />
        </div>
      ) : null}
      {onFilterChange ? (
        <select
          value={filterValue}
          onChange={(event) => onFilterChange(event.target.value)}
          className="h-8 rounded-md border border-panel-border bg-input px-2 text-xs text-foreground"
          aria-label="Filter loaded files"
        >
          <option value="all">All</option>
          <option value="linked">Linked</option>
          <option value="unlinked">Unlinked</option>
        </select>
      ) : null}
      {onSortChange ? (
        <select
          value={sortValue}
          onChange={(event) => onSortChange(event.target.value)}
          className="h-8 rounded-md border border-panel-border bg-input px-2 text-xs text-foreground"
          aria-label="Sort loaded files"
        >
          <option value="loaded">Loaded</option>
          <option value="name-asc">Name A-Z</option>
          <option value="name-desc">Name Z-A</option>
          <option value="size-desc">Size</option>
        </select>
      ) : null}
      {rightActions ? <div className="flex items-center gap-2">{rightActions}</div> : null}
    </header>
  );
}
