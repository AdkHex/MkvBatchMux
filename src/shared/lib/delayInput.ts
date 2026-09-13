/** Validation for the delay fields; returns a reason on failure instead of silently coercing to 0. */

export interface DelayParse {
  /** Whether the text can be used as a delay. */
  valid: boolean;
  /** Seconds. Only meaningful when `valid`. */
  value: number;
  /** Why it was rejected, ready to show under the field. */
  error?: string;
}

/** Blank means "no delay", which is how an empty box has always behaved. */
const EMPTY: DelayParse = { valid: true, value: 0 };

/** Beyond this a value is a typo rather than a delay, not a real offset. */
const MAX_ABS_SECONDS = 86_400;

export function parseDelayInput(raw: string | number | null | undefined): DelayParse {
  if (typeof raw === "number") {
    return Number.isFinite(raw) ? { valid: true, value: raw } : { valid: false, value: 0, error: "Enter a number of seconds." };
  }
  if (raw === null || raw === undefined) return EMPTY;

  const trimmed = raw.trim();
  if (trimmed === "") return EMPTY;

  // Accept comma as a decimal separator (common on non-US keyboards/locales).
  const normalized = trimmed.replace(",", ".");

  // Stricter than Number(): rejects "0x10", "1e5", and padded junk.
  if (!/^[+-]?(\d+(\.\d*)?|\.\d+)$/.test(normalized)) {
    return { valid: false, value: 0, error: "Enter a number of seconds, for example -1.5" };
  }

  const value = Number(normalized);
  if (!Number.isFinite(value)) {
    return { valid: false, value: 0, error: "Enter a number of seconds, for example -1.5" };
  }
  if (Math.abs(value) > MAX_ABS_SECONDS) {
    return { valid: false, value: 0, error: "That is larger than any real delay. Check for a stray digit." };
  }

  return { valid: true, value };
}

/** Convenience for the many places that only need the number. */
export function delaySecondsOrZero(raw: string | number | null | undefined): number {
  return parseDelayInput(raw).value;
}
