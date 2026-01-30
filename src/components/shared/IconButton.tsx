import * as React from "react";
import { Button, type ButtonProps } from "@/components/ui/button";
import { cn } from "@/lib/utils";

interface IconButtonProps extends ButtonProps {
  iconSizeClassName?: string;
}

export function IconButton({ className, iconSizeClassName, ...props }: IconButtonProps) {
  return (
    <Button
      {...props}
      variant={props.variant ?? "ghost"}
      size={props.size ?? "icon"}
      className={cn(
        "fluent-icon-button h-9 w-9",
        "[&_svg]:h-5 [&_svg]:w-5",
        iconSizeClassName,
        className,
      )}
    />
  );
}
