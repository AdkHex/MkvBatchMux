import * as React from "react";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import { Switch } from "@/components/ui/switch";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { SelectTrigger, SelectContent } from "@/components/ui/select";
import { cn } from "@/lib/utils";

export const TextField = React.forwardRef<HTMLInputElement, React.ComponentProps<typeof Input>>(
  ({ className, ...props }, ref) => (
    <Input ref={ref} className={cn("fluent-input", className)} {...props} />
  ),
);
TextField.displayName = "TextField";

export const DropdownTrigger = React.forwardRef<
  React.ElementRef<typeof SelectTrigger>,
  React.ComponentPropsWithoutRef<typeof SelectTrigger>
>(({ className, ...props }, ref) => (
  <SelectTrigger ref={ref} className={cn("fluent-input justify-between", className)} {...props} />
));
DropdownTrigger.displayName = "DropdownTrigger";

export const DropdownContent = React.forwardRef<
  React.ElementRef<typeof SelectContent>,
  React.ComponentPropsWithoutRef<typeof SelectContent>
>(({ className, ...props }, ref) => (
  <SelectContent ref={ref} className={cn("border-panel-border bg-popover shadow-xl", className)} {...props} />
));
DropdownContent.displayName = "DropdownContent";

export function Toggle({ className, ...props }: React.ComponentProps<typeof Switch>) {
  return <Switch className={cn("data-[state=checked]:bg-primary", className)} {...props} />;
}

export function CheckboxField({ className, ...props }: React.ComponentProps<typeof Checkbox>) {
  return <Checkbox className={cn("border-input data-[state=checked]:bg-primary data-[state=checked]:border-primary", className)} {...props} />;
}

export function Radio({ className, ...props }: React.ComponentProps<typeof RadioGroup>) {
  return <RadioGroup className={cn("gap-2", className)} {...props} />;
}

export function RadioItem({ className, ...props }: React.ComponentProps<typeof RadioGroupItem>) {
  return (
    <RadioGroupItem
      className={cn("border-input text-primary data-[state=checked]:border-primary", className)}
      {...props}
    />
  );
}
