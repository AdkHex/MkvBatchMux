import * as React from "react";
import { cn } from "@/lib/utils";

interface EmptyStateProps {
  icon?: React.ReactNode;
  title: string;
  description?: string;
  className?: string;
}

export function EmptyState({ icon, title, description, className }: EmptyStateProps) {
  return (
    <div className={cn("empty-state py-12", className)}>
      {icon ? <div className="w-12 h-12 rounded-lg bg-muted/50 flex items-center justify-center mb-3">{icon}</div> : null}
      <p className="text-sm font-medium text-foreground/90">{title}</p>
      {description ? <p className="text-xs text-muted-foreground mt-1">{description}</p> : null}
    </div>
  );
}
