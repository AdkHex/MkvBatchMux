import { describe, expect, it, vi, beforeEach } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";

import type { ExternalFile, MeasurementSettings, VideoFile } from "@/shared/types";
import type { MeasureStartRequest } from "@/shared/types/audiosync";

// The engine is not here: every backend call is a mock, and the event
// listeners hand back their handlers so a test can play the engine.
const { handlers, listener, measureDelaysStart } = vi.hoisted(() => {
  const handlers: Record<string, (payload: unknown) => void> = {};
  const listener = (name: string) => (handler: (payload: unknown) => void) => {
    handlers[name] = handler;
    return Promise.resolve(() => undefined);
  };
  const measureDelaysStart = vi.fn((_request: unknown) => Promise.resolve());
  return { handlers, listener, measureDelaysStart };
});

vi.mock("@/shared/lib/backend", () => ({
  audiosyncEngineStatus: () => Promise.resolve({ engineAvailable: true, ffmpegAvailable: true, enginePath: "engine", engineVersion: "test", message: null }),
  measureDelaysStart: (request: unknown) => measureDelaysStart(request),
  measureDelaysCancel: vi.fn(() => Promise.resolve()),
  scanTimelineStart: vi.fn(() => Promise.resolve()),
  listenMeasureDelaysProgress: listener("progress"),
  listenMeasureDelaysFile: listener("file"),
  listenMeasureDelaysResult: listener("result"),
  listenMeasureDelaysDone: listener("done"),
  listenTimelineScanProgress: listener("scanProgress"),
  listenTimelineScanResult: listener("scanResult"),
  listenTimelineScanDone: listener("scanDone"),
}));
vi.mock("@/ui/toast", () => ({ toast: vi.fn() }));

import { useMeasureDelays } from "./useMeasureDelays";

const audioTrack = { id: "1", type: "audio" as const, codec: "DTS", language: "eng" };
const video = (id: string, path: string): VideoFile => ({ id, name: path.split("\\").pop()!, path, size: 1, status: "pending", fps: 23.976, tracks: [audioTrack] });
const dub = (id: string, path: string, videoId: string): ExternalFile => ({ id, name: path.split("\\").pop()!, path, type: "audio", matchedVideoId: videoId, tracks: [audioTrack] });

function setup(videos: VideoFile[], files: ExternalFile[], measurement?: MeasurementSettings) {
  let current = files;
  const onAudioFilesChange = vi.fn((next: ExternalFile[]) => {
    current = next;
  });
  const hook = renderHook(() => useMeasureDelays({ videoFiles: videos, audioFiles: current, onAudioFilesChange, referenceTrackByVideoId: {}, measurement }));
  return { hook, onAudioFilesChange, files: () => current };
}

describe("useMeasureDelays", () => {
  beforeEach(() => {
    measureDelaysStart.mockClear();
  });

  it("never sends an empty row (a placeholder) to the engine", async () => {
    const gap: ExternalFile = { id: "gap-v1", name: "", path: "", type: "audio", placeholder: true, matchedVideoId: "v1" };
    const { hook } = setup([video("v1", "H:\\Shows\\E01.mkv"), video("v2", "H:\\Shows\\E02.mkv")], [gap, dub("a2", "H:\\Dubs\\E02.hin.mka", "v2")]);
    await waitFor(() => expect(hook.result.current.engine?.engineAvailable).toBe(true));
    await act(() => hook.result.current.start({ force: true }));
    const request = measureDelaysStart.mock.calls[0][0] as { pairs: { key: string; secondaryPath: string }[] };
    expect(request.pairs.map((pair) => [pair.key, pair.secondaryPath])).toEqual([["a2", "H:\\Dubs\\E02.hin.mka"]]);
  });

  it("sends the cut check, and no more windows than AudioSyncMaster can be set to", async () => {
    const start = async (measurement?: MeasurementSettings) => {
      measureDelaysStart.mockClear();
      const { hook } = setup([video("v1", "H:\\Shows\\E01.mkv")], [dub("a1", "H:\\Dubs\\E01.hin.mka", "v1")], measurement);
      await waitFor(() => expect(hook.result.current.engine?.engineAvailable).toBe(true));
      await act(() => hook.result.current.start({ force: true }));
      return measureDelaysStart.mock.calls[0][0] as MeasureStartRequest;
    };
    expect(await start()).toMatchObject({ windowCount: 6, findCuts: true });
    // 20 was the most until the limit followed AudioSyncMaster's, and is still in setting.json.
    expect(await start({ windowSeconds: 45, windowCount: 20, maxOffsetMs: 60000 })).toMatchObject({ windowCount: 12, findCuts: true });
    expect(await start({ windowSeconds: 45, windowCount: 12, maxOffsetMs: 60000, cutCheck: false })).toMatchObject({ windowCount: 12, findCuts: false });
  });

  it("answers an audio file that is the video itself without asking the engine", async () => {
    const remux = "H:\\Films\\Some.Like.It.Hot.2160p.mkv";
    const { hook, files } = setup([video("v1", remux)], [dub("a1", remux, "v1")]);
    await waitFor(() => expect(hook.result.current.engine?.engineAvailable).toBe(true));

    await act(() => hook.result.current.start());

    expect(measureDelaysStart).not.toHaveBeenCalled();
    expect(files()[0].pendingDelay ?? files()[0].delay).toBe(0);
    expect(files()[0].measuredDelay?.confidence).toBe(1);
    expect(hook.result.current.isMeasuring).toBe(false);
  });

  it("sends only the other pairs, and tracks every one in flight by its video", async () => {
    const remux = "H:\\Films\\A.mkv";
    const { hook } = setup(
      [video("v1", remux), video("v2", "H:\\Films\\B.mkv"), video("v3", "H:\\Films\\C.mkv")],
      [dub("a1", remux, "v1"), dub("a2", "H:\\Dubs\\B.hin.mka", "v2"), dub("a3", "H:\\Dubs\\C.hin.mka", "v3")],
    );
    await waitFor(() => expect(hook.result.current.engine?.engineAvailable).toBe(true));
    await act(() => hook.result.current.start());

    const request = measureDelaysStart.mock.calls[0][0] as { runId: string; pairs: { secondaryPath: string }[] };
    expect(request.pairs.map((pair) => pair.secondaryPath)).toEqual(["H:\\Dubs\\B.hin.mka", "H:\\Dubs\\C.hin.mka"]);

    act(() => {
      handlers.file({ runId: request.runId, file: "B.mkv", percent: 0 });
      handlers.file({ runId: request.runId, file: "C.mkv", percent: 30 });
    });
    expect(hook.result.current.progress?.active).toEqual({ "B.mkv": 0, "C.mkv": 30 });

    // The engine's progress names the pair that just finished.
    act(() => handlers.progress({ runId: request.runId, processed: 1, total: 2, current: "B.mkv" }));
    expect(hook.result.current.progress?.active).toEqual({ "C.mkv": 30 });
    expect(hook.result.current.progress?.processed).toBe(1);
  });
});
