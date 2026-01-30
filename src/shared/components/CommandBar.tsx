import * as React from "react";
import { Search } from "lucide-react";
import { cn } from "@/shared/lib/utils";
import { TextField } from "./Fields";

interface CommandBarProps {
  title: string;
  /** Optional context line under the title, e.g. "24 files · 68.2 GB". */
  subtitle?: string;
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
  subtitle,
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
    <header className={cn("fluent-topbar flex items-center px-5 gap-2.5 shrink-0 py-3.5", className)}>
      <div className="min-w-0 flex-1">
        <h1 className="text-xl font-semibold text-foreground leading-7 tracking-[-0.01em] truncate">
          {title}
        </h1>
        {subtitle ? <p className="text-xs text-muted-foreground truncate mt-0.5">{subtitle}</p> : null}
      </div>
      {onSearchChange ? (
        <div className="relative w-[210px] max-w-[34vw]">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground pointer-events-none" />
          <TextField
            value={searchValue}
            onChange={(event) => onSearchChange(event.target.value)}
            placeholder={searchPlaceholder}
            className="pl-8"
            aria-label={searchPlaceholder}
          />
        </div>
      ) : null}
      {onFilterChange ? (
        <select
          value={filterValue}
          onChange={(event) => onFilterChange(event.target.value)}
          className="h-[30px] rounded border border-panel-border bg-input px-2 text-[12.5px] text-foreground"
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
          className="h-[30px] rounded border border-panel-border bg-input px-2 text-[12.5px] text-foreground"
          aria-label="Sort loaded files"
        >
          <option value="loaded">Loaded</option>
          <option value="name-asc">Name A-Z</option>
          <option value="name-desc">Name Z-A</option>
          <option value="size-desc">Size</option>
        </select>
      ) : null}
      {rightActions ? <div className="flex items-center gap-1.5">{rightActions}</div> : null}
    </header>
  );
}
