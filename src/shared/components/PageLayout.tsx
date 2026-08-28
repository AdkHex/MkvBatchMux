import * as React from "react";
import { cn } from "@/shared/lib/utils";

type PageLayoutProps = React.HTMLAttributes<HTMLDivElement>;

export function PageLayout({ className, ...props }: PageLayoutProps) {
  return <div className={cn("flex flex-col h-full px-6 pb-4 gap-3", className)} {...props} />;
}
