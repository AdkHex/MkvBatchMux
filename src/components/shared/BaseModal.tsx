import * as React from "react";
import { X } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { IconButton } from "./IconButton";
import { cn } from "@/lib/utils";

interface BaseModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onClose?: () => void;
  title: string;
  subtitle?: string | React.ReactNode;
  icon?: React.ReactNode;
  children: React.ReactNode;
  footerLeft?: React.ReactNode;
  footerRight?: React.ReactNode;
  className?: string;
  bodyClassName?: string;
  variant?: "dialog" | "alert";
}

export function BaseModal({
  open,
  onOpenChange,
  onClose,
  title,
  subtitle,
  icon,
  children,
  footerLeft,
  footerRight,
  className,
  bodyClassName,
  variant = "dialog",
}: BaseModalProps) {
  const subtitleText = typeof subtitle === "string" ? subtitle : undefined;
  const handleClose = () => {
    onClose?.();
    onOpenChange(false);
  };

  const content = (
    <>
      {variant === "dialog" ? (
        <DialogHeader className="sr-only">
          <DialogTitle>{title}</DialogTitle>
          {subtitleText ? <DialogDescription>{subtitleText}</DialogDescription> : null}
        </DialogHeader>
      ) : (
        <AlertDialogHeader className="sr-only">
          <AlertDialogTitle>{title}</AlertDialogTitle>
          {subtitleText ? <AlertDialogDescription>{subtitleText}</AlertDialogDescription> : null}
        </AlertDialogHeader>
      )}
      <div className="base-modal__header">
        <div className="base-modal__heading">
          {icon ? <div className="base-modal__icon">{icon}</div> : null}
          <div className="base-modal__titles">
            <h2 className="base-modal__title">{title}</h2>
            {subtitle ? (
              <p className="base-modal__subtitle" title={subtitleText}>
                {subtitle}
              </p>
            ) : null}
          </div>
        </div>
        <IconButton
          aria-label="Close"
          onClick={handleClose}
          className="text-muted-foreground hover:text-foreground"
        >
          <X />
        </IconButton>
      </div>
      <div className={cn("base-modal__body", bodyClassName)}>{children}</div>
      {footerLeft || footerRight ? (
        <div className="base-modal__footer">
          <div className="base-modal__footer-left">{footerLeft}</div>
          <div className="base-modal__footer-right">{footerRight}</div>
        </div>
      ) : null}
    </>
  );

  if (variant === "alert") {
    return (
      <AlertDialog open={open} onOpenChange={onOpenChange}>
        <AlertDialogContent className={cn("base-modal p-0 !flex !flex-col !gap-0", className)}>
          {content}
        </AlertDialogContent>
      </AlertDialog>
    );
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent hideCloseButton className={cn("base-modal p-0 !flex !flex-col !gap-0", className)}>
        {content}
      </DialogContent>
    </Dialog>
  );
}
