import { useId, type ReactNode } from "react";

import { parseDelayInput } from "@/shared/lib/delayInput";
import { TBox, cx } from "@/ui/kit";

interface DelayFieldProps {
  value: string;
  onChange: (value: string) => void;
  label?: string;
  disabled?: boolean;
  /** Shown under the field when the value is fine, for context like a hint. */
  hint?: ReactNode;
  w?: number | string;
}

/** A delay in seconds, labelled above like every inspector field, that says
 *  why a value cannot be used instead of silently treating it as zero. */
export function DelayField({ value, onChange, label = "Delay", disabled, hint, w }: DelayFieldProps) {
  const messageId = `${useId()}-message`;
  const parsed = parseDelayInput(value);
  return (
    <div className="fld">
      <span className="lb" aria-hidden>{label}</span>
      <TBox
        className={cx(!parsed.valid && "invalid")}
        label={label}
        mono
        unit="s"
        w={w}
        value={value}
        disabled={disabled}
        spellCheck={false}
        onChange={onChange}
        aria-invalid={!parsed.valid}
        aria-describedby={!parsed.valid || hint ? messageId : undefined}
      />
      {!parsed.valid ? (
        <span id={messageId} role="alert" className="sm bad">{parsed.error}</span>
      ) : hint ? (
        <span id={messageId} className="sm t3">{hint}</span>
      ) : null}
    </div>
  );
}

/** Whether every one of these delay strings can be used. For gating a Save. */
export function delayInputsAreValid(...values: Array<string | number | null | undefined>): boolean {
  return values.every((value) => parseDelayInput(value).valid);
}
