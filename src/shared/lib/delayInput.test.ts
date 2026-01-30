import { describe, expect, it } from "vitest";
import { delaySecondsOrZero, parseDelayInput } from "./delayInput";

describe("parseDelayInput", () => {
  it("accepts plain and signed decimals", () => {
    expect(parseDelayInput("1.5")).toEqual({ valid: true, value: 1.5 });
    expect(parseDelayInput("-1.5")).toEqual({ valid: true, value: -1.5 });
    expect(parseDelayInput("+2")).toEqual({ valid: true, value: 2 });
    expect(parseDelayInput("0")).toEqual({ valid: true, value: 0 });
    expect(parseDelayInput(".5")).toEqual({ valid: true, value: 0.5 });
    expect(parseDelayInput("2.")).toEqual({ valid: true, value: 2 });
  });

  it("treats an empty field as no delay", () => {
    expect(parseDelayInput("")).toEqual({ valid: true, value: 0 });
    expect(parseDelayInput("   ")).toEqual({ valid: true, value: 0 });
    expect(parseDelayInput(null)).toEqual({ valid: true, value: 0 });
    expect(parseDelayInput(undefined)).toEqual({ valid: true, value: 0 });
  });

  it("accepts a comma decimal separator instead of silently reading it as zero", () => {
    // The bug this exists for: "1,5" used to mux as 0.
    expect(parseDelayInput("1,5")).toEqual({ valid: true, value: 1.5 });
    expect(parseDelayInput("-0,25")).toEqual({ valid: true, value: -0.25 });
  });

  it("rejects text rather than coercing it to zero", () => {
    for (const bad of ["abc", "1.2.3", "--1", "1 2", "one", "1s", "0x10", "1e5", "Infinity", "NaN"]) {
      const result = parseDelayInput(bad);
      expect(result.valid, `expected ${bad} to be rejected`).toBe(false);
      expect(result.error).toBeTruthy();
    }
  });

  it("rejects values too large to be a real delay", () => {
    expect(parseDelayInput("999999").valid).toBe(false);
    expect(parseDelayInput("86400").valid).toBe(true);
  });

  it("passes finite numbers through and rejects non-finite ones", () => {
    expect(parseDelayInput(2.25)).toEqual({ valid: true, value: 2.25 });
    expect(parseDelayInput(Number.NaN).valid).toBe(false);
    expect(parseDelayInput(Number.POSITIVE_INFINITY).valid).toBe(false);
  });
});

describe("delaySecondsOrZero", () => {
  it("returns the parsed value, or zero when the text is unusable", () => {
    expect(delaySecondsOrZero("1,5")).toBe(1.5);
    expect(delaySecondsOrZero("abc")).toBe(0);
    expect(delaySecondsOrZero("")).toBe(0);
  });
});
