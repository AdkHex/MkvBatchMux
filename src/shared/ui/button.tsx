import * as React from "react";
import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "@/shared/lib/utils";

const buttonVariants = cva(
  // Disabled uses a flat muted fill rather than opacity: a translucent saturated
  // fill still reads as an enabled button.
  "inline-flex items-center justify-center gap-2 whitespace-nowrap rounded text-[12.5px] font-medium ring-offset-background transition-colors duration-100 ease-out focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 disabled:pointer-events-none disabled:!bg-muted disabled:!text-muted-foreground/50 disabled:!border-transparent disabled:!shadow-none [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0",
  {
    variants: {
      variant: {
        default:
          "bg-primary text-primary-foreground font-semibold hover:bg-[hsl(var(--primary-hover))] active:bg-[hsl(var(--primary-press))]",
        destructive:
          "bg-destructive text-destructive-foreground hover:bg-destructive/90 active:bg-destructive/80",
        outline:
          "border border-panel-border bg-[hsl(var(--control))] text-foreground hover:bg-[hsl(var(--control-hover))] active:bg-[hsl(var(--control-press))]",
        secondary:
          "border border-panel-border bg-[hsl(var(--control))] text-foreground hover:bg-[hsl(var(--control-hover))] active:bg-[hsl(var(--control-press))]",
        ghost:
          "bg-transparent text-muted-foreground hover:bg-[hsl(var(--hover))] hover:text-foreground",
        link: "text-primary underline-offset-4 hover:underline",
      },
      size: {
        default: "h-[30px] px-3",
        sm: "h-[26px] px-2.5 text-xs",
        lg: "h-[34px] px-4",
        icon: "h-[30px] w-[30px]",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  },
);

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
  asChild?: boolean;
}

const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, asChild = false, ...props }, ref) => {
    const Comp = asChild ? Slot : "button";
    return <Comp className={cn(buttonVariants({ variant, size, className }))} ref={ref} {...props} />;
  },
);
Button.displayName = "Button";

export { Button, buttonVariants };
