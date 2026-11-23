import { describe, expect, it, vi, beforeEach } from "vitest";
import { act, renderHook } from "@testing-library/react";

import type { ExternalFile, VideoFile } from "@/shared/types";
import { audioMatchJobs, pairByEpisode } from "@/features/workspace/lib/smartPairing";

// The engine is played by the test: listeners hand back their handlers.
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
  measureDelaysStart: (request: unknown) => measureDelaysStart(request),
  measureDelaysCancel: vi.fn(() => Promise.resolve()),
  listenMeasureDelaysProgress: listener("progress"),
  listenMeasureDelaysResult: listener("result"),
  listenMeasureDelaysDone: listener("done"),
}));

import { AUDIO_MATCH_WINDOWS, useAudioMatch, type AudioMatchSummary } from "./useAudioMatch";

const track = { id: "0", type: "audio" as const };
const video = (n: number): VideoFile => ({ id: `v${n}`, name: `Show.S01E0${n}.mkv`, path: `/tv/Show.S01E0${n}.mkv`, size: 1, status: "pending", tracks: [track], durationSeconds: 2700 });
const dub = (name: string): ExternalFile => ({ id: name, name, path: `/dubs/${name}`, type: "audio", tracks: [track], durationSeconds: 2650 });

describe("useAudioMatch", () => {
  beforeEach(() => measureDelaysStart.mockClear());

  it("listens on its own run with two short windows, then places the surest file and leaves the unsure one", async () => {
    const videos = [video(1), video(2), video(3), video(4), video(5)];
    const arranged = pairByEpisode([dub("Show.S01E01.eac3"), dub("Show.S01E04.eac3"), dub("Show.S01E05.eac3"), dub("Track 2.eac3"), dub("Unknown.eac3")], videos);
    let files = arranged.files;
    const onFilesChange = vi.fn((next: ExternalFile[]) => (files = next));
    const finished: AudioMatchSummary[] = [];
    const hook = renderHook(() => useAudioMatch({ videoFiles: videos, files, onFilesChange, referenceTrackByVideoId: {}, onFinished: (summary) => finished.push(summary) }));
    await act(async () => undefined);

    const jobs = audioMatchJobs(files, videos, arranged);
    expect(jobs.map((job) => [job.file.name, job.videos.map((v) => v.id)])).toEqual([
      ["Track 2.eac3", ["v2", "v3"]],
      ["Unknown.eac3", ["v2", "v3"]],
    ]);
    await act(async () => {
      expect(await hook.result.current.start(jobs)).toBe(true);
    });
    const request = measureDelaysStart.mock.calls[0][0] as { runId: string; pairs: { key: string; primaryPath: string; secondaryPath: string }[]; windowCount: number; windowSeconds: number; fast: boolean; timeline: boolean };
    expect(request.runId).toMatch(/^match-/);
    expect(request).toMatchObject({ ...AUDIO_MATCH_WINDOWS, fast: true, timeline: false });
    expect(request.pairs).toHaveLength(4);
    expect(hook.result.current.matching).toBe(true);

    const heard = (secondary: string, primary: string, confidence: number) => {
      const pair = request.pairs.find((p) => p.secondaryPath.endsWith(secondary) && p.primaryPath.endsWith(primary))!;
      handlers.result({ runId: request.runId, key: pair.key, result: { confidence, error: null } });
    };
    act(() => {
      // Another run's result is not this one's.
      handlers.result({ runId: "measure-1", key: request.pairs[0].key, result: { confidence: 1, error: null } });
      heard("Track 2.eac3", "Show.S01E02.mkv", 0.18);
      heard("Track 2.eac3", "Show.S01E03.mkv", 0.97);
      heard("Unknown.eac3", "Show.S01E02.mkv", 0.41);
      heard("Unknown.eac3", "Show.S01E03.mkv", 0.52);
      handlers.done({ runId: request.runId, cancelled: false, error: null });
    });

    expect(hook.result.current.matching).toBe(false);
    expect(files.map((file) => (file.placeholder ? "—" : file.name))).toEqual(["Show.S01E01.eac3", "—", "Track 2.eac3", "Show.S01E04.eac3", "Show.S01E05.eac3", "Unknown.eac3"]);
    expect(files[2]).toMatchObject({ matchedVideoId: "v3", audioMatch: { videoId: "v3", confidence: 0.97 } });
    expect(finished[0].matched).toEqual([expect.objectContaining({ fileId: "Track 2.eac3", videoId: "v3", confidence: 0.97 })]);
    expect(finished[0].unmatched).toEqual(["Unknown.eac3"]);
    // Arranged again by episode, the heard file stays.
    expect(pairByEpisode(files, videos).files).toBe(files);
  });

  it("starts nothing when there is nothing to listen to", async () => {
    const hook = renderHook(() => useAudioMatch({ videoFiles: [], files: [], onFilesChange: vi.fn(), referenceTrackByVideoId: {}, onFinished: vi.fn() }));
    await act(async () => {
      expect(await hook.result.current.start([])).toBe(false);
    });
    expect(measureDelaysStart).not.toHaveBeenCalled();
  });
});
