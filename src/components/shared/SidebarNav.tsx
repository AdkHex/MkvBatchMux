import * as React from "react";
import { PanelLeft, PanelLeftClose } from "lucide-react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

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
    <aside className={cn("fluent-sidebar flex flex-col shrink-0 transition-all duration-300", collapsed ? "w-14" : "w-48")}>
      <div className={cn("h-14 flex items-center gap-2.5 shrink-0", collapsed ? "justify-center px-2" : "px-4")}>
        {brand}
      </div>

      <nav className={cn("flex-1 py-2", collapsed ? "px-2" : "px-3")}>
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
                  collapsed ? "justify-center px-0" : "px-3",
                  isActive && "is-active",
                )}
              >
                <Icon className="w-4 h-4 shrink-0" />
                {!collapsed && <span>{item.label}</span>}
              </button>
            );

            if (collapsed) {
              return (
                <Tooltip key={item.id}>
                  <TooltipTrigger asChild>{button}</TooltipTrigger>
                  <TooltipContent side="right" className="text-xs">
                    {item.label}
                  </TooltipContent>
                </Tooltip>
              );
            }

            return button;
          })}
        </div>
      </nav>

      <div className={cn("py-3 border-t border-sidebar-border", collapsed ? "px-2" : "px-3")}>
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              onClick={onToggleCollapse}
              className={cn(
                "flex items-center gap-2 py-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors w-full",
                collapsed ? "justify-center" : "px-3",
              )}
            >
              {collapsed ? (
                <PanelLeft className="w-4 h-4" />
              ) : (
                <>
                  <PanelLeftClose className="w-4 h-4" />
                  <span>Collapse</span>
                </>
              )}
            </button>
          </TooltipTrigger>
          <TooltipContent side="right" className="text-xs">
            {collapsed ? "Expand sidebar" : "Collapse sidebar"}
          </TooltipContent>
        </Tooltip>
      </div>
    </aside>
  );
}
