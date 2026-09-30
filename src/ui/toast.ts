/** Notifications, drawn as Fluent flyouts above the page bar (sonner, styled
 *  in ui.css). Keeps the call shape the pages already use:
 *  `toast({ title, description, variant: "destructive" })`. */

import { toast as sonner } from "sonner";

export interface ToastInput {
  title: string;
  description?: string;
  /** "destructive" is a failure: red icon, and it stays a little longer. */
  variant?: "default" | "destructive";
  duration?: number;
  action?: { label: string; onClick: () => void };
}

export function toast({ title, description, variant, duration, action }: ToastInput) {
  const options = {
    description,
    duration: duration ?? (variant === "destructive" ? 6000 : 4000),
    action: action ? { label: action.label, onClick: action.onClick } : undefined,
  };
  return variant === "destructive" ? sonner.error(title, options) : sonner(title, options);
}
