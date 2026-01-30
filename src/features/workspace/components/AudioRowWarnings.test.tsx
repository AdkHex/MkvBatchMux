/** What an audio row actually tells the user about a problem.
 *
 *  The number that reaches mkvmerge is covered by `delayConversion.test.ts`.
 *  Covered here is the other half of the same bug: a row that showed "999/1000"
 *  and left the user to work out from a ratio alone which rate was being
 *  converted to which, and warning badges that named a problem without ever
 *  saying what to do about it. These assert the sentences, not the arithmetic.
 */

import { describe, expect, it, vi, afterEach, beforeEach } from "vitest";
import { render, screen, cleanup, fireEvent, act } from "@testing-library/react";
import type { MeasuredDelay } from "@/shared/types";
import { MeasuredDelayInfo } from "./MeasuredDelayInfo";
import { StretchToggle } from "./StretchToggle";
import { AudioFpsBadge } from "./AudioFpsBadge";

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

/** Open a tooltip the way the user does. Radix waits out its open delay before
 *  showing anything, so the timers have to be run forward. */
function hover(trigger: HTMLElement): string {
  fireEvent.pointerEnter(trigger, { pointerType: "mouse" });
  fireEvent.pointerMove(trigger, { pointerType: "mouse" });
  act(() => {
    vi.advanceTimersByTime(2000);
  });
  return document.body.textContent ?? "";
}

/** The case from the report: Amazon 24.000fps video, a dub timed at 23.976 --
 *  0.1% apart, the narrowest real conversion there is. */
const ntscMeasured = (overrides: Partial<MeasuredDelay> = {}): MeasuredDelay => ({
  engineDelayMs: -87.7,
  appliedMs: 88,
  confidence: 0.94,
  driftMsPerS: -1.0,
  hasSignificantDrift: true,
  isRateMismatch: true,
  isLikelyCut: false,
  // The engine's own convention: an atempo speed factor, video over audio.
  correctionRatio: 23.976 / 24,
  rateSourceFps: 24,
  rateTargetFps: 23.976,
  rateExplanation:
    "The audio was timed against a 24fps source, but this video is 23.976fps. Resampling the audio corrects it exactly.",
  referenceTrack: 0,
  primaryFps: 23.976,
  measuredAt: "2026-09-08T12:00:00.000Z",
  error: null,
  ...overrides,
});

describe("StretchToggle", () => {
  it("names both rates and the exact ratio instead of a bare fraction", () => {
    render(
      <StretchToggle
        id="stretch-1"
        measured={ntscMeasured()}
        value={undefined}
        onChange={vi.fn()}
      />,
    );
    const label = screen.getByText(/Correct frame rate/).closest("label")!;
    expect(label.textContent).toContain("24.000 → 23.976 fps");
    expect(label.textContent).toContain("1001/1000");
    // The approximation marker belongs only on a ratio that was not identified.
    expect(label.textContent).not.toContain("approx");
  });

  it("stores the ratio mkvmerge multiplies timestamps by", () => {
    const onChange = vi.fn();
    render(
      <StretchToggle id="stretch-1" measured={ntscMeasured()} value={undefined} onChange={onChange} />,
    );
    fireEvent.click(screen.getByRole("switch"));
    expect(onChange).toHaveBeenCalledWith({ num: 1001, den: 1000 });
  });

  it("re-stores a ratio saved by a build that had it inverted", () => {
    // 999/1000 is what the row used to offer: the engine's atempo factor,
    // rounded. Left alone it would still be muxed, silently doubling the drift.
    const onChange = vi.fn();
    render(
      <StretchToggle
        id="stretch-1"
        measured={ntscMeasured()}
        value={{ num: 999, den: 1000 }}
        onChange={onChange}
      />,
    );
    expect(onChange).toHaveBeenCalledWith({ num: 1001, den: 1000 });
  });
});

describe("MeasuredDelayInfo", () => {
  it("puts the conversion on the badge, where it can be read without hovering", () => {
    render(<MeasuredDelayInfo measured={ntscMeasured()} />);
    expect(screen.getByText("24.000 → 23.976 fps")).toBeTruthy();
  });

  it("still offers a way through when the engine named no rates", () => {
    render(
      <MeasuredDelayInfo
        measured={ntscMeasured({
          rateSourceFps: null,
          rateTargetFps: null,
          correctionRatio: null,
        })}
      />,
    );
    expect(screen.getByText("Frame rate")).toBeTruthy();
  });

  it("offers Apply anyway on a withheld result, so the user is never stuck", () => {
    render(
      <MeasuredDelayInfo
        measured={ntscMeasured({ engineDelayMs: -14989.1, confidence: 0.29 })}
        onApplyAnyway={vi.fn()}
      />,
    );
    expect(screen.getByText("Implausible")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Apply anyway" })).toBeTruthy();
  });
});

describe("AudioFpsBadge", () => {
  it("names the change, not just the rate, when one is needed", () => {
    render(
      <AudioFpsBadge
        value={{ fps: 25, videoFps: 23.976, basis: "measured", ambiguous: false }}
      />,
    );
    expect(screen.getByText("25.000 → 23.976 fps")).toBeTruthy();
  });

  it("shows one rate when the audio already matches the video", () => {
    render(
      <AudioFpsBadge
        value={{ fps: 23.976, videoFps: 23.976, basis: "measured", ambiguous: false }}
      />,
    );
    expect(screen.getByText("23.976 fps")).toBeTruthy();
  });

  it("marks an estimate as one, so it is not read as a measurement", () => {
    render(
      <AudioFpsBadge value={{ fps: 25, videoFps: 23.976, basis: "estimated", ambiguous: false }} />,
    );
    expect(screen.getByText("~25.000 → 23.976 fps")).toBeTruthy();
  });
});

describe("hovering a warning", () => {
  /** Every badge, the state that produces it, and the thing the user is
   *  supposed to learn from hovering it. A badge that names a problem and stops
   *  there is the failure this table exists to catch. */
  const cases: Array<{ badge: string; measured: MeasuredDelay; cause: RegExp; fix: RegExp }> = [
    {
      badge: "Implausible",
      measured: ntscMeasured({
        engineDelayMs: -14989.1,
        confidence: 0.94,
        isRateMismatch: false,
      }),
      cause: /locked onto a repeated passage/,
      fix: /reference track that actually shares dialogue/,
    },
    {
      badge: "Weak match",
      measured: ntscMeasured({ confidence: 0.29, isRateMismatch: false }),
      cause: /never found a clear peak/,
      fix: /pick a reference track with dialogue/,
    },
    {
      badge: "Different cut",
      measured: ntscMeasured({ isLikelyCut: true, driftMsPerS: 62.5 }),
      cause: /scenes added or removed/,
      fix: /Pair this audio with the release it was made for/,
    },
    {
      badge: "24.000 → 23.976 fps",
      measured: ntscMeasured(),
      cause: /0\.10% too fast/,
      fix: /1001\/1000 stretch/,
    },
    {
      badge: "Drift",
      measured: ntscMeasured({
        isRateMismatch: false,
        hasSignificantDrift: true,
        driftMsPerS: 0.4,
      }),
      cause: /matches no standard frame-rate conversion/,
      fix: /measured at the start/,
    },
  ];

  it.each(cases)("$badge explains its cause and its fix", ({ badge, measured, cause, fix }) => {
    render(<MeasuredDelayInfo measured={measured} />);
    const text = hover(screen.getByText(badge));
    expect(text).toMatch(cause);
    expect(text).toContain("What to do:");
    expect(text).toMatch(fix);
  });

  it("explains a reference track that has moved on since the measurement", () => {
    render(<MeasuredDelayInfo measured={ntscMeasured()} currentReferenceTrack={2} />);
    const text = hover(screen.getByText("Reference changed"));
    expect(text).toMatch(/measured against audio track 1/);
    expect(text).toContain("What to do:");
    expect(text).toMatch(/Measure this row again/);
  });

  it("explains a measurement that never produced a number", () => {
    render(<MeasuredDelayInfo measured={ntscMeasured({ error: "ffprobe: no such file" })} />);
    const text = hover(screen.getByText(/Measurement failed/));
    expect(text).toMatch(/could not analyse this pair/);
    expect(text).toContain("What to do:");
    expect(text).toMatch(/ffmpeg can decode/);
  });
});
