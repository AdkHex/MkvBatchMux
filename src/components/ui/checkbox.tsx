import * as React from "react";
import * as SwitchPrimitives from "@radix-ui/react-switch";

import { cn } from "@/lib/utils";

const Checkbox = React.forwardRef<
  React.ElementRef<typeof SwitchPrimitives.Root>,
  React.ComponentPropsWithoutRef<typeof SwitchPrimitives.Root>
>(({ className, ...props }, ref) => (
    <SwitchPrimitives.Root
      ref={ref}
      className={cn(
      "peer toggle-switch inline-flex h-3.5 w-7 shrink-0 cursor-pointer items-center rounded-full border border-panel-border ring-offset-background transition-all duration-[120ms] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60 focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50",
      className,
    )}
    {...props}
  >
    <SwitchPrimitives.Thumb
      className={cn(
        "toggle-thumb pointer-events-none block h-3 w-3 rounded-full ring-0 transition-transform duration-[120ms] data-[state=checked]:translate-x-3.5 data-[state=unchecked]:translate-x-0",
      )}
    />
  </SwitchPrimitives.Root>
));
Checkbox.displayName = SwitchPrimitives.Root.displayName;

export { Checkbox };
