/** useConform and useSubsync against a played engine: what they send, what
 *  they keep when a run fails or is stopped, and that each start ends in
 *  `onFinished` exactly once. */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";

import type { ExternalFile, VideoFile } from "@/shared/types";
import type { ConformRequest, SubsyncRequest } from "@/shared/types/engineFeatures";

const engine = vi.hoisted(() => {
  const handlers: Record<string, (payload: unknown) => unknown> = {};
  const listener = (name: string) => (handler: (payload: unknown) => unknown) => {
    handlers[name] = handler;
    return Promise.resolve(() => undefined);
  };
  return { handlers, listener, conform: vi.fn((_request: unknown) => Promise.resolve()), subsync: vi.fn((_request: unknown) => Promise.resolve()), cancel: vi.fn(() => Promise.resolve()) };
});

vi.mock("@/shared/lib/backend", () => ({
  audiosyncEngineStatus: () => Promise.resolve({ engineAvailable: true, ffmpegAvailable: true, enginePath: "engine", engineVersion: "test", message: null }),
  measureDelaysCancel: () => engine.cancel(),
}));
vi.mock("@/shared/lib/engineFeatures", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/shared/lib/engineFeatures")>()),
  conformDubsStart: (request: unknown) => engine.conform(request),
  subsyncStart: (request: unknown) => engine.subsync(request),
  listenConformProgress: engine.listener("conformProgress"),
  listenConformResult: engine.listener("conformResult"),
  listenConformDone: engine.listener("conformDone"),
  listenSubsyncProgress: engine.listener("syncProgress"),
  listenSubsyncResult: engine.listener("syncResult"),
  listenSubsyncDone: engine.listener("syncDone"),
}));

import { conformOptions, useConform } from "./useConform";
import { useSubsync } from "./useSubsync";

const video = (n: number, subtitles = false): VideoFile => ({
  id: `v${n}`,
  name: `Show.S01E0${n}.mkv`,
  path: `/m/Show.S01E0${n}.mkv`,
  size: 1,
  status: "pending",
  tracks: [{ id: "0", type: "video" }, { id: "1", type: "audio" }, ...(subtitles ? [{ id: "2", type: "subtitle" as const, codec: "SubRip/SRT", language: "eng" }] : [])],
});
const cutDub = (n: number): ExternalFile => ({
  id: `a${n}`,
  name: `Show.S01E0${n}.Hindi.eac3`,
  path: `/d/Show.S01E0${n}.Hindi.eac3`,
  type: "audio",
  matchedVideoId: `v${n}`,
  tracks: [{ id: "0", type: "audio" }],
  measuredDelay: {
    engineDelayMs: 840, appliedMs: -840, confidence: 0.98, driftMsPerS: null, hasSignificantDrift: false, isRateMismatch: false, isLikelyCut: true,
    correctionRatio: null, rateSourceFps: null, rateTargetFps: null, rateExplanation: null, referenceTrack: 0, primaryFps: null, measuredAt: "", error: null,
  },
});
const srt = (n: number): ExternalFile => ({ id: `s${n}`, name: `Show.S01E0${n}.en.srt`, path: `/s/Show.S01E0${n}.en.srt`, type: "subtitle", language: "eng", matchedVideoId: `v${n}` });

beforeEach(() => {
  engine.conform.mockClear();
  engine.subsync.mockClear();
  engine.cancel.mockClear();
});

describe("useConform", () => {
  it("sends Preferences' mode, codec and folder, keeps a failure off the file, and ends once", async () => {
    expect(conformOptions(undefined)).toEqual({ mode: "render", codec: "same", outputDir: null, maxWorkers: 2 });
    expect(conformOptions({ windowSeconds: 45, windowCount: 6, maxOffsetMs: 60000, conformMode: "lossless", conformCodec: "flac", conformOutputDir: " E:\\C " })).toEqual({ mode: "lossless", codec: "flac", outputDir: "E:\\C", maxWorkers: 2 });

    let files = [cutDub(1), cutDub(2)];
    const onFinished = vi.fn();
    const { result } = renderHook(() =>
      useConform({ videoFiles: [video(1), video(2)], audioFiles: files, onAudioFilesChange: (next) => (files = next), measurement: { windowSeconds: 45, windowCount: 6, maxOffsetMs: 60000, conformMode: "lossless" }, onFinished }),
    );
    await act(async () => void (await result.current.start(["a1", "a2"])));
    const request = engine.conform.mock.calls[0][0] as ConformRequest;
    expect(request.mode).toBe("lossless");
    expect(request.pairs.map((pair) => pair.key)).toEqual(["a1", "a2"]);
    expect(result.current.conforming).toBe(true);

    act(() => void engine.handlers.conformResult({ runId: request.runId, key: "a1", outputPath: null, mode: "lossless", codec: null, verified: null, verificationText: null, residualMs: null, plan: null, description: null, error: "The engine could not plan this pair.", fallbackReason: null }));
    act(() => void engine.handlers.conformResult({ runId: request.runId, key: "a2", outputPath: "/d/MKVBatchMux conformed/Show.S01E02.Hindi.conformed.mka", mode: "render", codec: "eac3", verified: true, verificationText: "Re-encoded instead of cut: another speed. Checked.", residualMs: 2.16, plan: null, description: null, error: null, fallbackReason: "The dub runs at another speed" }));
    // A late event of another run changes nothing.
    act(() => void engine.handlers.conformResult({ runId: "conform-0", key: "a1", outputPath: "/x.mka", mode: "render", codec: null, verified: true, verificationText: null, residualMs: null, plan: null, description: null, error: null, fallbackReason: null }));
    expect(result.current.failures).toEqual({ a1: "The engine could not plan this pair." });
    expect(files[0].conformed).toBeUndefined();
    expect(files[1].conformed).toMatchObject({ mode: "render", fallbackReason: "The dub runs at another speed", videoPath: "/m/Show.S01E02.mkv" });

    await act(async () => void (await result.current.cancel()));
    expect(engine.cancel).toHaveBeenCalledTimes(1);
    act(() => void engine.handlers.conformDone({ runId: request.runId, cancelled: true, error: null }));
    act(() => void engine.handlers.conformDone({ runId: request.runId, cancelled: true, error: null }));
    expect(onFinished).toHaveBeenCalledTimes(1);
    expect(onFinished.mock.calls[0][0]).toMatchObject({ cancelled: true, error: null });
    expect(onFinished.mock.calls[0][0].outcomes.map((o: { status: string }) => o.status)).toEqual(["failed", "verified"]);
    expect(result.current.conforming).toBe(false);
  });

  it("ends at once, with the reason, when nothing can be conformed", async () => {
    const onFinished = vi.fn();
    const many: ExternalFile = { ...cutDub(1), tracks: [{ id: "1", type: "audio" }, { id: "2", type: "audio" }], includedTrackIds: [1, 2] };
    const { result } = renderHook(() => useConform({ videoFiles: [video(1)], audioFiles: [many], onAudioFilesChange: vi.fn(), onFinished }));
    await act(async () => void (await result.current.start(["a1"])));
    expect(engine.conform).not.toHaveBeenCalled();
    expect(onFinished).toHaveBeenCalledTimes(1);
    expect(onFinished.mock.calls[0][0].skipped[0].reason).toMatch(/one audio track/);
  });
});

describe("useSubsync", () => {
  it("does not start the speech run after the subtitle-track run was stopped", async () => {
    let files = [srt(1), srt(2)];
    const onFinished = vi.fn();
    const { result } = renderHook(() => useSubsync({ videoFiles: [video(1, true), video(2)], subtitleFiles: files, onSubtitleFilesChange: (next) => (files = next), onFinished }));
    await waitFor(() => expect(result.current.engine?.engineAvailable).toBe(true));
    await act(async () => void (await result.current.start()));
    const first = engine.subsync.mock.calls[0][0] as SubsyncRequest;
    expect([first.engine, first.jobs.map((job) => job.key)]).toEqual(["subtitle", ["s1"]]);
    await act(async () => void (await engine.handlers.syncDone({ runId: first.runId, cancelled: true, error: null })));
    expect(engine.subsync).toHaveBeenCalledTimes(1);
    expect(onFinished).toHaveBeenCalledTimes(1);
    expect(onFinished.mock.calls[0][0]).toMatchObject({ cancelled: true });
    expect(result.current.syncing).toBe(false);
  });

  it("reports a command that could not start, once", async () => {
    engine.subsync.mockImplementationOnce(() => Promise.reject("FFmpeg was not found."));
    const onFinished = vi.fn();
    const { result } = renderHook(() => useSubsync({ videoFiles: [video(1)], subtitleFiles: [srt(1)], onSubtitleFilesChange: vi.fn(), onFinished }));
    await act(async () => void (await result.current.start()));
    expect(onFinished).toHaveBeenCalledTimes(1);
    expect(onFinished.mock.calls[0][0].error).toBe("FFmpeg was not found.");
    expect(result.current.syncing).toBe(false);
  });
});
