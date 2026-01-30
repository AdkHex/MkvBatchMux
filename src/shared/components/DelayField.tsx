import * as React from "react";
import { Input } from "@/shared/ui/input";
import { cn } from "@/shared/lib/utils";
import { parseDelayInput } from "@/shared/lib/delayInput";

interface DelayFieldProps {
  value: string;
  onChange: (value: string) => void;
  label?: string;
  className?: string;
  disabled?: boolean;
  /** Shown under the field when the value is fine, for context like a hint. */
  hint?: React.ReactNode;
}

/**
 * A delay input that says so when the value cannot be used.
 *
 * Same markup and metrics as the plain inputs it replaces -- this adds the
 * error state those were missing, it does not restyle the field. The message
 * lives under the field rather than in an alert: the guidance is to keep alerts
 * for things that are actionable and interrupting, and a mistyped number is
 * neither once the field itself points at it.
 */
export function DelayField({
  value,
  onChange,
  label = "Delay (sec)",
  className,
  disabled,
  hint,
}: DelayFieldProps) {
  const fieldId = React.useId();
  const messageId = `${fieldId}-message`;
  const parsed = parseDelayInput(value);

  return (
    <div className="space-y-1.5">
      <label className="text-xs font-medium text-muted-foreground" htmlFor={fieldId}>
        {label}
      </label>
      <Input
        id={fieldId}
        value={value}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value)}
        aria-invalid={!parsed.valid}
        aria-describedby={!parsed.valid || hint ? messageId : undefined}
        className={cn(
          "h-[30px] font-mono",
          !parsed.valid && "border-destructive focus-visible:ring-destructive",
          className,
        )}
      />
      {!parsed.valid ? (
        <p id={messageId} role="alert" className="text-xs text-destructive">
          {parsed.error}
        </p>
      ) : hint ? (
        <p id={messageId} className="text-xs text-muted-foreground">
          {hint}
        </p>
      ) : null}
    </div>
  );
}

/** Whether every one of these delay strings can be used. For gating a Save. */
export function delayInputsAreValid(...values: Array<string | number | null | undefined>): boolean {
  return values.every((value) => parseDelayInput(value).valid);
}
