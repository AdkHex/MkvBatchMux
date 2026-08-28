import * as React from "react";
import { PanelLeft, PanelLeftClose } from "lucide-react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/shared/ui/tooltip";
import { cn } from "@/shared/lib/utils";

export interface SidebarNavItem {
  id: string;
  label: string;
  icon: React.ElementType;
  /** Item count shown at the trailing edge, e.g. number of loaded files. */
  count?: number;
  /** Renders the count in the warning colour, e.g. unlinked files need attention. */
  warn?: boolean;
}

interface SidebarNavProps {
  items: SidebarNavItem[];
  activeId: string;
  collapsed: boolean;
  onSelect: (id: string) => void;
  onToggleCollapse: () => void;
}

export function SidebarNav({ items, activeId, collapsed, onSelect, onToggleCollapse }: SidebarNavProps) {
  return (
    <aside
      className={cn(
        "fluent-sidebar flex flex-col shrink-0 transition-all duration-200 ease-out",
        collapsed ? "w-12" : "w-[196px]",
      )}
    >
      <nav className="flex-1 pt-1 px-2">
        <div className="space-y-1">
          {items.map((item) => {
            const Icon = item.icon;
            const isActive = activeId === item.id;
            const hasCount = typeof item.count === "number";
            const button = (
              <button
                key={item.id}
                onClick={() => onSelect(item.id)}
                className={cn(
                  "fluent-sidebar-item",
                  collapsed ? "px-0 justify-center" : "px-2.5 justify-start gap-2.5",
                  isActive && "is-active",
                )}
                aria-label={item.label}
                aria-current={isActive ? "page" : undefined}
              >
                <Icon className="w-4 h-4 shrink-0" />
                {!collapsed && (
                  <>
                    <span className="truncate">{item.label}</span>
                    {hasCount && (
                      <span
                        className={cn(
                          "fluent-sidebar-count",
                          item.warn && "fluent-sidebar-count--warn",
                        )}
                      >
                        {item.count}
                      </span>
                    )}
                  </>
                )}
              </button>
            );

            return collapsed ? (
              <Tooltip key={item.id}>
                <TooltipTrigger asChild>{button}</TooltipTrigger>
                <TooltipContent side="right" className="text-xs">
                  {item.label}
                </TooltipContent>
              </Tooltip>
            ) : (
              <React.Fragment key={item.id}>{button}</React.Fragment>
            );
          })}
        </div>
      </nav>

      <div className="py-2 px-2">
        <button
          onClick={onToggleCollapse}
          className={cn(
            "fluent-sidebar-item",
            collapsed ? "px-0 justify-center" : "px-2.5 justify-start gap-2.5",
          )}
          aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
        >
          {collapsed ? <PanelLeft className="w-4 h-4" /> : <PanelLeftClose className="w-4 h-4" />}
          {!collapsed && <span className="truncate">Collapse</span>}
        </button>
      </div>
    </aside>
  );
}
