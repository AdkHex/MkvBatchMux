import * as React from "react";
import { BaseModal } from "./BaseModal";
import { cn } from "@/lib/utils";

interface DialogShellProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: string;
  icon?: React.ReactNode;
  children: React.ReactNode;
  footer?: React.ReactNode;
  className?: string;
}

export function DialogShell({
  open,
  onOpenChange,
  title,
  description,
  icon,
  children,
  footer,
  className,
}: DialogShellProps) {
  return (
    <BaseModal
      open={open}
      onOpenChange={onOpenChange}
      title={title}
      subtitle={description}
      icon={icon}
      className={cn(className)}
      bodyClassName="p-0"
      footerRight={footer}
    >
      <div className="flex flex-col min-h-0">{children}</div>
    </BaseModal>
  );
}
