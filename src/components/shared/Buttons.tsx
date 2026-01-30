import * as React from "react";
import { Button, type ButtonProps } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export function PrimaryButton({ className, ...props }: ButtonProps) {
  return <Button {...props} className={cn("fluent-button primary", className)} />;
}

export function SecondaryButton({ className, ...props }: ButtonProps) {
  return <Button {...props} variant="secondary" className={cn("fluent-button secondary", className)} />;
}

export function DestructiveButton({ className, ...props }: ButtonProps) {
  return <Button {...props} variant="destructive" className={cn("fluent-button destructive", className)} />;
}
