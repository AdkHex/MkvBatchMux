import * as React from "react";
import { cn } from "@/lib/utils";

interface PageLayoutProps extends React.HTMLAttributes<HTMLDivElement> {}

export function PageLayout({ className, ...props }: PageLayoutProps) {
  return <div className={cn("flex flex-col h-full p-6 gap-6", className)} {...props} />;
}
