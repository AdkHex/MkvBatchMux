import * as React from "react";
import { PanelLeft, PanelLeftClose } from "lucide-react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/shared/ui/tooltip";
import { cn } from "@/shared/lib/utils";

export interface SidebarNavItem {
  id: string;
  label: string;
  icon: React.ElementType;
}

interface SidebarNavProps {
  items: SidebarNavItem[];
  activeId: string;
  collapsed: boolean;
  onSelect: (id: string) => void;
  onToggleCollapse: () => void;
  brand?: React.ReactNode;
}

export function SidebarNav({ items, activeId, collapsed, onSelect, onToggleCollapse, brand }: SidebarNavProps) {
  return (
    <aside
      className={cn(
        "fluent-sidebar flex flex-col shrink-0 transition-all duration-200 ease-out",
        collapsed ? "w-12" : "w-44",
      )}
    >
      <div
        className={cn(
          "h-12 flex items-center shrink-0 px-1.5",
          collapsed ? "justify-center" : "justify-start",
        )}
      >
        {brand}
      </div>

      <nav className="flex-1 py-2 px-1.5">
        <div className="space-y-1">
          {items.map((item) => {
            const Icon = item.icon;
            const isActive = activeId === item.id;
            const button = (
              <button
                key={item.id}
                onClick={() => onSelect(item.id)}
                className={cn(
                  "fluent-sidebar-item border border-transparent",
                  collapsed ? "min-h-10 px-0 justify-center" : "min-h-10 px-3 justify-start gap-2",
                  isActive && "is-active",
                )}
                aria-label={item.label}
              >
                <Icon className="w-[18px] h-[18px] shrink-0" />
                {!collapsed && <span className="truncate text-xs font-medium">{item.label}</span>}
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

      <div className="py-2 border-t border-sidebar-border px-1.5">
        <button
          onClick={onToggleCollapse}
          className={cn(
            "fluent-sidebar-item border border-transparent",
            collapsed ? "min-h-10 px-0 justify-center" : "min-h-10 px-3 justify-start gap-2",
          )}
          aria-label="Toggle sidebar"
        >
          {collapsed ? <PanelLeft className="w-[18px] h-[18px]" /> : <PanelLeftClose className="w-[18px] h-[18px]" />}
          {!collapsed && <span className="truncate text-xs font-medium">Collapse</span>}
        </button>
      </div>
    </aside>
  );
}
