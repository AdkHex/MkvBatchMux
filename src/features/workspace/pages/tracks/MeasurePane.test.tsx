/** What the Audio inspector tells the user about a measurement.
 *
 *  Ported from the old row readout's tests (AudioRowWarnings.test.tsx): the
 *  same cases and the same sentences, now asserted on the findings the
 *  inspector lists and on the pane itself. The number that reaches mkvmerge
 *  is covered by delayConversion.test.ts; covered here is the other half — a
 *  row that named a problem without ever saying what to do about it. */

import { describe, expect, it, vi, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import type { MeasuredDelay } from "@/shared/types";
import type { TimelineEdit } from "@/shared/types/audiosync";
import { formatAudioFps } from "@/features/workspace/lib/audioFps";
import { measureFindings, type Finding } from "@/features/workspace/lib/measureVerdict";

import { MeasureSection } from "./MeasurePane";

afterEach(cleanup);

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
  rateExplanation: "The audio was timed against a 24fps source, but this video is 23.976fps. Resampling the audio corrects it exactly.",
  referenceTrack: 0,
  primaryFps: 23.976,
  measuredAt: "2026-09-08T12:00:00.000Z",
  error: null,
  ...overrides,
});

const find = (findings: Finding[], word: string | RegExp) => {
  const hit = findings.find((finding) => (typeof word === "string" ? finding.word === word : word.test(finding.word)));
  if (!hit) throw new Error(`no finding ${String(word)} in ${findings.map((f) => f.word).join(", ")}`);
  return hit;
};
/** Everything opening a finding shows. */
const detail = (finding: Finding) => [finding.cause, ...(finding.list ?? []), finding.fix ? `What to do: ${finding.fix}` : ""].filter(Boolean).join("\n");

function renderPane(measured: MeasuredDelay, extra: Partial<Parameters<typeof MeasureSection>[0]> = {}) {
  const props = {
    measured,
    pending: true,
    stretch: undefined,
    onStretch: vi.fn(),
    busy: false,
    onApply: vi.fn(),
    onApplyAnyway: vi.fn(),
    onUseTimelineDelay: vi.fn(),
    ...extra,
  };
  render(<MeasureSection {...props} />);
  return props;
}

describe("Correct the frame rate", () => {
  it("names both rates and the exact ratio instead of a bare fraction", () => {
    renderPane(ntscMeasured());
    const row = screen.getByText("Correct the frame rate").closest(".trow")!;
    expect(row.textContent).toContain("24.000 → 23.976 fps");
    expect(row.textContent).toContain("1001/1000");
    // The approximation marker belongs only on a ratio that was not identified.
    expect(row.textContent).not.toContain("approximate");
  });

  it("stores the ratio mkvmerge multiplies timestamps by", () => {
    const { onStretch } = renderPane(ntscMeasured());
    fireEvent.click(screen.getByRole("switch", { name: "Correct the frame rate" }));
    expect(onStretch).toHaveBeenCalledWith({ num: 1001, den: 1000 });
  });

  it("re-stores a ratio saved by a build that had it inverted", () => {
    // 999/1000 is what the row used to offer: the engine's atempo factor,
    // rounded. Left alone it would still be muxed, silently doubling the drift.
    const { onStretch } = renderPane(ntscMeasured(), { stretch: { num: 999, den: 1000 } });
    expect(onStretch).toHaveBeenCalledWith({ num: 1001, den: 1000 });
  });
});

describe("the measurement's findings", () => {
  it("puts the conversion in the status word, where it can be read at a glance", () => {
    expect(find(measureFindings(ntscMeasured()), "24 → 23.976 fps").line).toContain("24.000 → 23.976 fps");
  });

  it("still offers a way through when the engine named no rates", () => {
    expect(find(measureFindings(ntscMeasured({ rateSourceFps: null, rateTargetFps: null, correctionRatio: null })), "Frame rate")).toBeTruthy();
  });

  it("offers Apply anyway on a withheld result, so the user is never stuck", () => {
    renderPane(ntscMeasured({ engineDelayMs: -360041, confidence: 0.29 }), { pending: false });
    expect(screen.getAllByText(/Implausible/).length).toBeGreaterThan(0);
    expect(screen.getByRole("button", { name: "Apply anyway" })).toBeTruthy();
  });

  /** Every warning, the state that produces it, and what the user is supposed
   *  to learn from opening it. A warning that names a problem and stops there
   *  is the failure this table exists to catch. */
  const cases: Array<{ word: string; measured: MeasuredDelay; cause: RegExp; fix: RegExp }> = [
    { word: "Implausible", measured: ntscMeasured({ engineDelayMs: -360041, confidence: 0.94, isRateMismatch: false }), cause: /locked onto a repeated passage/, fix: /reference track that actually shares dialogue/ },
    { word: "Weak match", measured: ntscMeasured({ confidence: 0.29, isRateMismatch: false }), cause: /never found a clear peak/, fix: /pick a reference track with dialogue/ },
    { word: "Different cut", measured: ntscMeasured({ isLikelyCut: true, driftMsPerS: 62.5 }), cause: /scenes added or removed/, fix: /Pair this audio with the release it was made for/ },
    { word: "24 → 23.976 fps", measured: ntscMeasured(), cause: /0\.10% too fast/, fix: /1001\/1000 stretch/ },
    { word: "Drift", measured: ntscMeasured({ isRateMismatch: false, hasSignificantDrift: true, driftMsPerS: 0.4 }), cause: /matches no standard frame-rate conversion/, fix: /measured at the start/ },
  ];

  it.each(cases)("$word explains its cause and its fix", ({ word, measured, cause, fix }) => {
    const text = detail(find(measureFindings(measured), word));
    expect(text).toMatch(cause);
    expect(text).toContain("What to do:");
    expect(text).toMatch(fix);
  });

  it("opens a finding in the pane to show why and what to do", () => {
    renderPane(ntscMeasured({ confidence: 0.29, isRateMismatch: false }), { pending: false });
    const finding = screen.getAllByRole("button", { expanded: false }).find((b) => b.textContent?.startsWith("Weak match"))!;
    fireEvent.click(finding);
    expect(screen.getByText(/never found a clear peak/)).toBeTruthy();
    expect(screen.getByText("What to do:")).toBeTruthy();
  });

  it("explains a reference track that has moved on since the measurement", () => {
    const text = detail(find(measureFindings(ntscMeasured(), 2), "Reference changed"));
    expect(text).toMatch(/measured against audio track 1/);
    expect(text).toContain("What to do:");
    expect(text).toMatch(/Measure this row again/);
  });

  it("explains a measurement that never produced a number", () => {
    const text = detail(find(measureFindings(ntscMeasured({ error: "ffprobe: no such file" })), "Failed"));
    expect(text).toMatch(/could not analyse this pair/);
    expect(text).toContain("What to do:");
    expect(text).toMatch(/ffmpeg can decode/);
  });
});

describe("the frame rate a dub was timed at", () => {
  it("names the change, not just the rate, when one is needed", () => {
    expect(formatAudioFps({ fps: 25, videoFps: 23.976, basis: "measured", ambiguous: false })).toBe("25.000 → 23.976 fps");
  });
  it("shows one rate when the audio already matches the video", () => {
    expect(formatAudioFps({ fps: 23.976, videoFps: 23.976, basis: "measured", ambiguous: false })).toBe("23.976 fps");
  });
  it("marks an estimate as one, so it is not read as a measurement", () => {
    expect(formatAudioFps({ fps: 25, videoFps: 23.976, basis: "estimated", ambiguous: false })).toBe("~25.000 → 23.976 fps");
  });
});

describe("the full-timeline scan", () => {
  const clean: MeasuredDelay["timeline"] = {
    scannedAt: "2026-09-28T00:00:00.000Z",
    error: null,
    startOffsetMs: -87.7,
    cuts: [],
    unverified: [],
    tailS: 0,
    videoFps: 23.976,
    dubRate: 23.976,
    speed: 1,
    rateConfirmed: true,
    dubUsedShare: 0.99,
    videoDurationS: 3600,
    description: "1 stretch of dub",
  };
  const matched = (timeline: MeasuredDelay["timeline"]) => ntscMeasured({ isRateMismatch: false, hasSignificantDrift: false, driftMsPerS: 0, timeline });

  it("says a dub that follows the video in one piece has no cuts", () => {
    expect(detail(find(measureFindings(matched(clean)), "No cuts"))).toMatch(/follows the video in one piece at \+87\.7 ms/);
  });

  it("lists every cut with where it is and what to do", () => {
    const findings = measureFindings(
      matched({
        ...clean,
        cuts: [
          { atS: 1230, jumpMs: -7500, missingS: 7.5, uncertaintyS: 0, offsetAfterMs: -7587.7 },
          { atS: 2400, jumpMs: 42, missingS: 0, uncertaintyS: 0, offsetAfterMs: -7545.7 },
        ],
      }),
    );
    const text = detail(find(findings, "2 cuts"));
    expect(text).toMatch(/0:20:30\.000: the dub lacks 7\.5s of the video here/);
    expect(text).toMatch(/0:40:00\.000: from here the dub plays 42 ms late/);
    expect(text).toContain("What to do:");
    expect(text).toMatch(/only lines up the part before 0:20:30\.000/);
    expect(findings.some((f) => f.word === "No cuts")).toBe(false);
  });

  it("names a frame-rate change by both rates", () => {
    const text = detail(find(measureFindings(matched({ ...clean, speed: 25 / 23.976, dubRate: 25 })), "FPS 25.000 → 23.976"));
    expect(text).toMatch(/video runs at 23\.976 fps, but the dub was mastered at 25\.000 fps/);
    expect(text).toContain("What to do:");
  });

  it("lists the engine's own edits, graded, with the doubtful ones marked", () => {
    const edit = (index: number, overrides: Partial<TimelineEdit>): TimelineEdit => ({
      index, kind: "missing", severity: "moderate", videoS: 600, videoEndS: 605, dubS: 602.6, dubEndS: 602.6,
      jumpMs: -5000, sizeMs: 5000, missingS: 5, extraS: 0, frames: 120, uncertaintyS: 0, offsetBeforeMs: 2600,
      offsetAfterMs: -2400, shortestStretchS: 600, check: false, description: "", ...overrides,
    });
    const findings = measureFindings(
      matched({
        ...clean,
        cuts: [{ atS: 600, jumpMs: -5000, missingS: 5, uncertaintyS: 0, offsetAfterMs: -2400 }],
        edits: [
          edit(1, { description: "0:10:00.000: the dub is missing 5.000 s (120 frames) of the video; from here it plays 5.000 s early." }),
          edit(2, { severity: "major", videoS: 1400, check: true, description: "0:23:20.000: the dub is missing 39.445 s of the video." }),
        ],
      }),
    );
    const text = detail(find(findings, "2 edits · 1 major · 1 to check"));
    expect(text).toContain("the dub is missing 5.000 s (120 frames) of the video; from here it plays 5.000 s early.");
    expect(text).toContain("(check) 0:23:20.000: the dub is missing 39.445 s of the video.");
    expect(text).toMatch(/only lines up the part before 0:10:00\.000/);
  });

  it("says which rate to convert the dub from and to, with the command and the delay after", () => {
    const guide = {
      videoFps: 23.976, dubFps: 25, fromFps: 25, toFps: 23.976, fromLabel: "25 fps (PAL)", toLabel: "23.976 fps (NTSC film)",
      named: true, alternatives: [], confirmed: true, speed: 1001 / 960, stretch: { num: 1001, den: 960 },
      tempo: 960 / 1001, tempoPercent: -4.096, lengthPercent: 4.271, pitchSemitones: -0.72, driftPerHourS: 147.5,
      dubDurationS: 5400, convertedDurationS: 5630.6, delayWithStretchMs: 2600, sampleRate: 48000,
      resampleFilter: "aresample=48048,asetrate=46080,aresample=48000", atempoFilter: "atempo=0.959040959",
      ffmpegFilter: "aresample=48048,asetrate=46080,aresample=48000", pitchNote: "Resampling is sample-exact.",
      stretchNote: "", instruction: "Convert the dub from 25 fps to 23.976 fps: slow it down by 4.096%.",
    };
    const text = detail(find(measureFindings(matched({ ...clean, speed: 1001 / 960, dubRate: 25, rateGuide: guide })), "FPS 25.000 → 23.976"));
    expect(text).toContain("Convert the dub from 25 fps to 23.976 fps: slow it down by 4.096%.");
    expect(text).toContain("-af aresample=48048,asetrate=46080,aresample=48000");
    expect(text).toMatch(/then use a delay of -2600\.0 ms/);
  });

  it("shows the engine's notes on the measurement itself", () => {
    const measured = { ...matched(clean), warnings: ["corrupt.mka is damaged: FFmpeg hit 5 decoding errors reading it."] };
    expect(detail(find(measureFindings(measured), "1 note"))).toContain("corrupt.mka is damaged");
  });

  it("offers the timeline's delay when it and the measurement are visibly apart", () => {
    const measured = matched({ ...clean, startOffsetMs: -2633 });
    expect(detail(find(measureFindings(measured), "Lip-sync check"))).toMatch(/2545 ms apart/);
    const { onUseTimelineDelay } = renderPane(measured);
    fireEvent.click(screen.getByRole("button", { name: /Use timeline delay \(\+2633\.0 ms\)/ }));
    expect(onUseTimelineDelay).toHaveBeenCalledOnce();
  });
});
