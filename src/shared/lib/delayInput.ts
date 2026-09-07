/** Validation for the delay fields.
 *
 *  Every delay box in the app used to be read with `Number(value) || 0`, which
 *  turns anything unparseable into zero without saying so -- type "1,5" meaning
 *  one and a half seconds and the mux silently runs with no delay at all. The
 *  platform guidance is explicit that a field with a numeric-only domain has to
 *  tell people when what they typed is not one, so parsing returns the reason
 *  it failed and callers surface it instead of guessing.
 */

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

/** Beyond this a value is a typo rather than a delay -- a day of offset is not
 *  something any track needs, and it usually means a stray digit. */
const MAX_ABS_SECONDS = 86_400;

export function parseDelayInput(raw: string | number | null | undefined): DelayParse {
  if (typeof raw === "number") {
    return Number.isFinite(raw) ? { valid: true, value: raw } : { valid: false, value: 0, error: "Enter a number of seconds." };
  }
  if (raw === null || raw === undefined) return EMPTY;

  const trimmed = raw.trim();
  if (trimmed === "") return EMPTY;

  // A comma decimal separator is what a lot of keyboards and locales produce;
  // accepting it costs nothing and silently zeroing it is the bug being fixed.
  const normalized = trimmed.replace(",", ".");

  // Deliberately stricter than Number(): that accepts "0x10", "1e5" and
  // whitespace-padded junk, none of which anyone means as a delay in seconds.
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
