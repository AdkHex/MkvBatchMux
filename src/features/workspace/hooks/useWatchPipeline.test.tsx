import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { ExternalFile, MeasuredDelay, MuxJob, VideoFile } from "@/shared/types";
import type { SyncResult } from "@/shared/types/audiosync";
import type { ConformRequest, ConformResultEvent } from "@/shared/types/engineFeatures";
import type { Recipe, WatchFolderConfig } from "@/shared/types/recipes";

// No backend: the watcher's event and the engine's are played by the tests.
const { handlers, listener, measureDelaysStart, pathsExist, conformDubsStart } = vi.hoisted(() => {
  const handlers: Record<string, (payload: unknown) => unknown> = {};
  const listener = (name: string) => (handler: (payload: unknown) => unknown) => {
    handlers[name] = handler;
    return Promise.resolve(() => {
      if (handlers[name] === handler) delete handlers[name];
    });
  };
  const measureDelaysStart = vi.fn((_request: unknown) => Promise.resolve());
  const pathsExist = vi.fn((paths: string[]) => Promise.resolve(paths.map(() => true)));
  const conformDubsStart = vi.fn((_request: unknown) => Promise.resolve());
  return { handlers, listener, measureDelaysStart, pathsExist, conformDubsStart };
});

vi.mock("@/shared/lib/workspaceStore", () => ({
  listenWatchFiles: listener("watch-files"),
  pathsExist: (paths: string[]) => pathsExist(paths),
}));
vi.mock("@/shared/lib/backend", () => ({
  audiosyncEngineStatus: () => Promise.resolve({ engineAvailable: true, ffmpegAvailable: true, enginePath: "engine", engineVersion: "test", message: null }),
  inspectPaths: vi.fn(),
  scanMedia: vi.fn(),
  measureDelaysStart: (request: unknown) => measureDelaysStart(request),
  listenMeasureDelaysResult: listener("result"),
  listenMeasureDelaysDone: listener("done"),
  measureDelaysCancel: vi.fn(),
}));
vi.mock("@/shared/lib/engineFeatures", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/shared/lib/engineFeatures")>()),
  conformDubsStart: (request: unknown) => conformDubsStart(request),
  listenConformResult: listener("conform-result"),
  listenConformDone: listener("conform-done"),
}));

import { createRecipe, DEFAULT_SLOT } from "@/features/workspace/lib/recipes";
import type { WorkspaceLists } from "@/features/workspace/lib/watchPipeline";
import { conformWithEngine, measureWithEngine, runWatchEpisode, useWatchPipeline, type WatchIO } from "./useWatchPipeline";

const SHOW = "W:\\Incoming";
const video = (n: number): VideoFile => ({ id: `v${n}`, name: `Show.S01E0${n}.mkv`, path: `${SHOW}\\Show.S01E0${n}.mkv`, size: 1000, status: "pending", fps: 23.976, tracks: [{ id: "0", type: "video" }, { id: "1", type: "audio", language: "eng" }] });
const dub = (n: number): ExternalFile => ({ id: `d${n}`, name: `Show.S01E0${n}.Hindi.eac3`, path: `W:\\Dubs\\Show.S01E0${n}.Hindi.eac3`, type: "audio", tracks: [{ id: "0", type: "audio", codec: "E-AC-3" }] });

const clean = (over: Partial<MeasuredDelay> = {}): MeasuredDelay => ({
  engineDelayMs: -1312,
  appliedMs: 1312,
  confidence: 0.99,
  driftMsPerS: 0,
  hasSignificantDrift: false,
  isRateMismatch: false,
  isLikelyCut: false,
  correctionRatio: null,
  rateSourceFps: null,
  rateTargetFps: null,
  rateExplanation: null,
  referenceTrack: 0,
  primaryFps: 23.976,
  measuredAt: "2026-11-23T10:00:00.000Z",
  error: null,
  ...over,
});

const config: WatchFolderConfig = {
  id: "w1",
  enabled: true,
  recipeId: "r1",
  videoFolder: SHOW,
  videoExtensions: ["mkv"],
  recursive: false,
  audioFolder: "W:\\Dubs",
  subtitleFolder: "",
  chapterFolder: "",
  intervalSeconds: 10,
};
const recipe: Recipe = { ...createRecipe("Show"), id: "r1", audioSlots: [{ ...DEFAULT_SLOT, language: "hin", trackName: "Hindi", isDefault: true }] };

/** A workspace in memory and fake I/O around it. */
function fakeIO({ loaded = [], dubs = [dub(1), dub(2)], measured = () => clean(), measureError = null as string | null } = {} as { loaded?: VideoFile[]; dubs?: ExternalFile[]; measured?: (file: ExternalFile) => MeasuredDelay | null; measureError?: string | null }) {
  let lists: WorkspaceLists = {
    videoFiles: loaded,
    audioFilesByTrack: { "1": [] },
    subtitleFilesByTrack: { "1": [] },
    chapterFiles: [],
    audioTracks: ["1"],
    audioTrackConfigs: { "1": { ...DEFAULT_SLOT } },
    subtitleTracks: ["1"],
    subtitleTrackConfigs: { "1": { ...DEFAULT_SLOT } },
  };
  const steps: string[] = [];
  const io: WatchIO = {
    read: () => lists,
    commit: (change) => {
      lists = change(lists);
    },
    inspectVideos: vi.fn(async (paths: string[]) => paths.map((path) => [video(1), video(2), video(3)].find((item) => item.path === path)!).filter(Boolean)),
    scanFolder: vi.fn(async () => dubs),
    measure: vi.fn(async (_videos: VideoFile[], files: ExternalFile[]) => ({
      files: files.map((file) => {
        const m = measured(file);
        return m ? { ...file, measuredDelay: m, pendingDelay: m.appliedMs / 1000 } : file;
      }),
      error: measureError,
    })),
    mux: vi.fn(async (ids: string[]) => ids.map((id): MuxJob => ({ id: `job-${id}`, videoFile: lists.videoFiles.find((item) => item.id === id)!, status: "completed", progress: 100 }))),
    step: (phase, detail) => steps.push(`${phase}: ${detail}`),
    log: vi.fn(),
  };
  return { io, lists: () => lists, steps };
}

const paths = (...n: number[]) => n.map((i) => video(i).path);

describe("a watch folder's run", () => {
  it("loads the new episodes, pairs their dubs, applies clean delays and muxes only them", async () => {
    const { io, lists, steps } = fakeIO({ loaded: [{ ...video(3), id: "old" }] });
    const report = await runWatchEpisode({ config, recipe, paths: paths(1, 2) }, io);

    expect(lists().videoFiles.map((item) => item.id)).toEqual(["old", "v1", "v2"]);
    const slot = lists().audioFilesByTrack["1"];
    expect(slot.map((file) => [file.id, file.matchedVideoId])).toEqual([["gap-old", "old"], ["d1", "v1"], ["d2", "v2"]]);
    expect(slot[1]).toMatchObject({ language: "hin", trackName: "Hindi", isDefault: true, delay: 1.312, delayProvenance: "measured" });
    // The empty slot took the recipe's settings, so the Audio page shows what its files carry.
    expect(lists().audioTrackConfigs["1"]).toMatchObject({ language: "hin", sourceFolder: "W:\\Dubs" });
    expect(io.mux).toHaveBeenCalledWith(["v1", "v2"], recipe);
    expect(report.muxed.map((job) => job.status)).toEqual(["completed", "completed"]);
    expect(report.review).toEqual([]);
    expect(steps).toEqual(["measuring: Measuring 2 dubs", "muxing: Muxing 2 new episodes"]);
  });

  it("waits for a dub that hasn't arrived, and doesn't mux that episode", async () => {
    const { io } = fakeIO({ dubs: [dub(1)] });
    const report = await runWatchEpisode({ config, recipe, paths: paths(1, 2) }, io);
    expect(report.review).toEqual([{ name: "Show.S01E02.mkv", reason: "No file for it yet in Audio 1 (W:\\Dubs)" }]);
    expect(io.mux).toHaveBeenCalledWith(["v1"], recipe);
  });

  it("leaves delays the policy doesn't apply for the user, and stops those episodes", async () => {
    const { io, lists } = fakeIO({ measured: (file) => (file.id === "d2" ? clean({ confidence: 0.5 }) : clean({ isLikelyCut: true })) });
    const report = await runWatchEpisode({ config, recipe, paths: paths(1, 2) }, io);
    expect(report.review.map((note) => note.reason)).toEqual(["Delay to review in Audio 1: Different cut", "Delay to review in Audio 1: Confidence under 90%"]);
    expect(io.mux).not.toHaveBeenCalled();
    // Measured, not applied: the result waits on the Audio page.
    expect(lists().audioFilesByTrack["1"][1]).toMatchObject({ pendingDelay: 1.312, delay: 0 });
  });

  it("holds every episode the engine couldn't measure", async () => {
    const { io } = fakeIO({ measured: () => null, measureError: "the audio analysis engine isn't available" });
    const report = await runWatchEpisode({ config, recipe, paths: paths(1) }, io);
    expect(report.review[0].reason).toBe("Not measured: the audio analysis engine isn't available");
    expect(io.mux).not.toHaveBeenCalled();
  });

  it("muxes without measuring when the recipe doesn't measure", async () => {
    const { io } = fakeIO();
    await runWatchEpisode({ config, recipe: { ...recipe, measurement: { ...recipe.measurement, autoMeasure: false } }, paths: paths(1) }, io);
    expect(io.measure).not.toHaveBeenCalled();
    expect(io.mux).toHaveBeenCalledWith(["v1"], expect.anything());
  });

  it("stops cleanly when a step fails: unreadable videos, a dub folder offline, no recipe", async () => {
    const unreadable = fakeIO();
    vi.mocked(unreadable.io.inspectVideos).mockRejectedValueOnce(new Error("share offline"));
    const a = await runWatchEpisode({ config, recipe, paths: paths(1) }, unreadable.io);
    expect(a.failed).toEqual([{ name: "Show.S01E01.mkv", reason: "Couldn't be read: share offline" }]);
    expect(unreadable.lists().videoFiles).toEqual([]);

    const offline = fakeIO();
    vi.mocked(offline.io.scanFolder).mockRejectedValueOnce("The folder W:\\Dubs doesn't exist");
    const b = await runWatchEpisode({ config, recipe, paths: paths(1) }, offline.io);
    expect(b.review[0].reason).toBe("Couldn't read W:\\Dubs: The folder W:\\Dubs doesn't exist");
    expect(offline.io.mux).not.toHaveBeenCalled();

    const orphan = fakeIO();
    const c = await runWatchEpisode({ config, recipe: null, paths: paths(1) }, orphan.io);
    expect(c.failed[0].reason).toMatch(/no recipe/);
    expect(orphan.io.inspectVideos).not.toHaveBeenCalled();
  });

  it("skips a video already loaded", async () => {
    const { io } = fakeIO({ loaded: [video(1)] });
    const report = await runWatchEpisode({ config, recipe, paths: paths(1) }, io);
    expect(report.skipped).toEqual([{ name: "Show.S01E01.mkv", reason: "Already in the queue" }]);
    expect(io.scanFolder).not.toHaveBeenCalled();
  });
});

describe("conforming for a watch folder", () => {
  beforeEach(() => conformDubsStart.mockReset().mockImplementation(() => Promise.resolve()));

  const conforming: Recipe = { ...recipe, measurement: { ...recipe.measurement, autoConformCuts: true } };
  const cut = () => clean({ isLikelyCut: true, cutPositionS: 100, cutMagnitudeMs: -10000 });
  const conformResult = (runId: string, key: string, over: Partial<ConformResultEvent> = {}): ConformResultEvent => ({
    runId,
    key,
    outputPath: `W:\\Dubs\\MKVBatchMux conformed\\${key}.conformed.eac3`,
    mode: "render",
    codec: "eac3",
    verified: true,
    verificationText: "Checked against the video at 6 spots: all within 45 ms (largest -0.2 ms).",
    residualMs: -0.15,
    plan: null,
    description: null,
    error: null,
    fallbackReason: null,
    ...over,
  });

  /** A run whose dubs all measure as another cut, conformed through the engine (its events played below). */
  async function startRun(n: number[], { measurement, dubs }: { measurement?: Parameters<typeof conformWithEngine>[2]; dubs?: ExternalFile[] } = {}) {
    const fake = fakeIO({ measured: cut, dubs: dubs ?? [dub(1), dub(2)] });
    fake.io.conform = vi.fn((videos: VideoFile[], files: ExternalFile[]) => conformWithEngine(videos, files, measurement));
    const report = runWatchEpisode({ config, recipe: conforming, paths: paths(...n) }, fake.io);
    await waitFor(() => expect(conformDubsStart).toHaveBeenCalled());
    const request = conformDubsStart.mock.calls[0][0] as ConformRequest;
    await waitFor(() => expect(handlers["conform-done"]).toBeDefined());
    return { ...fake, report, request };
  }

  it("conforms a different cut with the user's settings and muxes it once the engine verified it", async () => {
    const { io, lists, steps, report, request } = await startRun([1], { measurement: { windowCount: 6, windowSeconds: 30, maxOffsetMs: 30000, conformMode: "lossless", conformCodec: "flac", conformOutputDir: "W:\\Conformed" } as never });
    expect(request).toMatchObject({ mode: "lossless", codec: "flac", outputDir: "W:\\Conformed", pairs: [{ primaryPath: video(1).path, secondaryPath: dub(1).path, secondaryTrack: 0 }] });
    // Another run's result is not this one's.
    handlers["conform-result"](conformResult("conform-1", request.pairs[0].key, { verified: false }));
    handlers["conform-result"](conformResult(request.runId, request.pairs[0].key));
    handlers["conform-done"]({ runId: request.runId, cancelled: false, error: null });
    const out = await report;

    expect(out.review).toEqual([]);
    expect(io.mux).toHaveBeenCalledWith(["v1"], conforming);
    expect(lists().audioFilesByTrack["1"][0].conformed).toMatchObject({ path: "W:\\Dubs\\MKVBatchMux conformed\\d1.conformed.eac3", verified: true, videoPath: video(1).path, sourceTrack: 0 });
    // The measured delay is not applied: the conformed track goes in at 0.
    expect(lists().audioFilesByTrack["1"][0]).toMatchObject({ delay: 0, pendingDelay: 1.312 });
    expect(steps).toEqual(["measuring: Measuring 1 dub", "conforming: Conforming 1 dub to a different cut", "muxing: Muxing 1 new episode"]);
    expect(handlers["conform-result"]).toBeUndefined();
  });

  it("holds an episode whose conformed dub failed its check, keeping the copy for the user to look at", async () => {
    const { io, lists, report, request } = await startRun([1]);
    handlers["conform-result"](conformResult(request.runId, request.pairs[0].key, { verified: false, verificationText: "checked against the video at 6 spots: 2 off by more than 45 ms (largest +120.0 ms).\n  12.0 s  +3.1 ms" }));
    handlers["conform-done"]({ runId: request.runId, cancelled: false, error: null });
    const out = await report;
    expect(out.review).toEqual([{ name: "Show.S01E01.mkv", reason: "Different cut in Audio 1: conformed, but the check failed. Checked against the video at 6 spots: 2 off by more than 45 ms (largest +120.0 ms)." }]);
    expect(io.mux).not.toHaveBeenCalled();
    expect(lists().audioFilesByTrack["1"][0].conformed?.verified).toBe(false);
  });

  it("holds an episode the engine couldn't check, or couldn't conform at all", async () => {
    const { io, report, request } = await startRun([1, 2]);
    const [first, second] = request.pairs;
    handlers["conform-result"](conformResult(request.runId, first.key, { verified: null, verificationText: null }));
    handlers["conform-result"](conformResult(request.runId, second.key, { outputPath: null, error: "The engine could not plan this pair." }));
    handlers["conform-done"]({ runId: request.runId, cancelled: false, error: null });
    const out = await report;
    expect(out.review.map((note) => note.reason)).toEqual(["Different cut in Audio 1: conformed, but it couldn't be checked.", "Different cut in Audio 1: conforming failed: The engine could not plan this pair."]);
    expect(io.mux).not.toHaveBeenCalled();
  });

  it("holds every episode when the engine errors, whether it can't start or the run ends in an error", async () => {
    conformDubsStart.mockImplementationOnce(() => Promise.reject("The audio analysis engine isn't available"));
    const fake = fakeIO({ measured: cut, dubs: [dub(1)] });
    fake.io.conform = (videos, files) => conformWithEngine(videos, files);
    const out = await runWatchEpisode({ config, recipe: conforming, paths: paths(1) }, fake.io);
    expect(out.review).toEqual([{ name: "Show.S01E01.mkv", reason: "Different cut in Audio 1: not conformed: The audio analysis engine isn't available" }]);
    expect(fake.io.mux).not.toHaveBeenCalled();
    expect(fake.lists().audioFilesByTrack["1"][0].conformed).toBeUndefined();

    conformDubsStart.mockClear();
    const { io, report, request } = await startRun([1]);
    handlers["conform-done"]({ runId: request.runId, cancelled: false, error: "engine exited (code 1)" });
    expect((await report).review[0].reason).toBe("Different cut in Audio 1: not conformed: engine exited (code 1)");
    expect(io.mux).not.toHaveBeenCalled();
  });

  it("muxes what was verified before a stop, and holds the rest", async () => {
    const { io, lists, report, request } = await startRun([1, 2]);
    handlers["conform-result"](conformResult(request.runId, request.pairs[0].key));
    handlers["conform-done"]({ runId: request.runId, cancelled: true, error: null });
    // A result after the end changes nothing.
    handlers["conform-result"]?.(conformResult(request.runId, request.pairs[1].key));
    const out = await report;
    expect(out.review).toEqual([{ name: "Show.S01E02.mkv", reason: "Different cut in Audio 1: conforming was stopped" }]);
    expect(io.mux).toHaveBeenCalledWith(["v1"], conforming);
    expect(lists().audioFilesByTrack["1"][1].conformed).toBeUndefined();
  });

  it("leaves a cut for the user when the recipe doesn't conform, or the dub brings subtitles a conformed copy would drop", async () => {
    const off = fakeIO({ measured: cut, dubs: [dub(1)] });
    off.io.conform = vi.fn();
    const a = await runWatchEpisode({ config, recipe, paths: paths(1) }, off.io);
    expect(a.review[0].reason).toBe("Delay to review in Audio 1: Different cut");
    expect(off.io.conform).not.toHaveBeenCalled();

    const withSubs: ExternalFile = { ...dub(1), tracks: [{ id: "0", type: "audio", codec: "E-AC-3" }, { id: "1", type: "subtitle", codec: "SubRip/SRT" }] };
    const subs = fakeIO({ measured: cut, dubs: [withSubs] });
    subs.io.conform = vi.fn();
    const b = await runWatchEpisode({ config, recipe: conforming, paths: paths(1) }, subs.io);
    expect(b.review[0].reason).toMatch(/^Delay to review in Audio 1: Different cut\. This file also brings a subtitle track into the mux/);
    expect(subs.io.conform).not.toHaveBeenCalled();
    expect(subs.io.mux).not.toHaveBeenCalled();

    // A run without a conform step (no engine wiring) holds the cut as before.
    const bare = fakeIO({ measured: cut, dubs: [dub(1)] });
    const c = await runWatchEpisode({ config, recipe: conforming, paths: paths(1) }, bare.io);
    expect(c.review[0].reason).toBe("Different cut in Audio 1: conform it on the Audio page");
  });
});

describe("measuring for a watch folder", () => {
  beforeEach(() => measureDelaysStart.mockClear());

  const result = (over: Partial<SyncResult> = {}): SyncResult => ({ videoFile: "Show.S01E01.mkv", audioFile: "Show.S01E01.Hindi.eac3", delayMs: -1312, delayAtStartMs: null, confidence: 0.99, driftMsPerS: null, totalDriftMs: null, hasSignificantDrift: false, startDelayMs: null, endDelayMs: null, windowsUsed: 6, windowsTotal: 6, error: null, elapsedMs: 100, primaryFps: 23.976, ...over });

  it("runs one pass under its own run id and writes the results as pending", async () => {
    const files = [{ ...dub(1), matchedVideoId: "v1" }];
    const done = measureWithEngine([video(1)], files);
    await waitFor(() => expect(measureDelaysStart).toHaveBeenCalled());
    const request = measureDelaysStart.mock.calls[0][0] as { runId: string; pairs: { key: string }[]; fast: boolean; timeline: boolean };
    expect(request).toMatchObject({ fast: false, timeline: false, findCuts: true });
    // Another run's events are not this one's.
    handlers.result({ runId: "measure-1", key: request.pairs[0].key, result: result({ delayMs: 5000 }) });
    handlers.result({ runId: request.runId, key: request.pairs[0].key, result: result() });
    handlers.done({ runId: request.runId, cancelled: false, error: null });
    const out = await done;
    expect(out.error).toBeNull();
    expect(out.files[0].measuredDelay?.confidence).toBe(0.99);
    expect(out.files[0].pendingDelay).toBeCloseTo(1.312, 3);
    expect(handlers.result).toBeUndefined();
  });
});

describe("useWatchPipeline", () => {
  beforeEach(() => {
    pathsExist.mockClear();
  });

  function setup({ idle = true, own = (_path: string): boolean => false } = {}) {
    const { io } = fakeIO();
    const onReport = vi.fn();
    const claim = vi.fn(() => true);
    const release = vi.fn();
    const hook = renderHook((props: { idle: boolean }) => useWatchPipeline({ watches: [config], recipes: [recipe], idle: props.idle, claim, release, io, onReport, isOwnOutput: own }), { initialProps: { idle } });
    return { hook, io, onReport, claim, release };
  }

  it("queues new videos from a watch that is on and runs them once the app is idle", async () => {
    const { hook, io, onReport, claim, release } = setup({ idle: false });
    await waitFor(() => expect(handlers["watch-files"]).toBeDefined());
    await act(async () => {
      await handlers["watch-files"]({ id: "w1", paths: paths(1) });
      await handlers["watch-files"]({ id: "someone-else", paths: paths(2) });
    });
    expect(hook.result.current.queue).toEqual([{ watchId: "w1", path: paths(1)[0] }]);
    // A batch or a measurement holds the app: nothing starts.
    expect(claim).not.toHaveBeenCalled();

    hook.rerender({ idle: true });
    await waitFor(() => expect(onReport).toHaveBeenCalled());
    expect(claim).toHaveBeenCalledTimes(1);
    expect(io.mux).toHaveBeenCalledWith(["v1"], recipe);
    expect(onReport.mock.calls[0][0]).toMatchObject({ watchId: "w1", loaded: [{ id: "v1" }] });
    await waitFor(() => expect(hook.result.current.phase).toBe("idle"));
    expect(release).toHaveBeenCalled();
    expect(hook.result.current.queue).toEqual([]);
  });

  it("never queues the app's own outputs, its work files, or files gone again", async () => {
    const mine = `${SHOW}\\Show - S01E01.mkv`;
    const { hook, io } = setup({ idle: false, own: (path) => path === mine });
    await waitFor(() => expect(handlers["watch-files"]).toBeDefined());
    pathsExist.mockImplementationOnce(async (list: string[]) => list.map((path) => !path.endsWith("E05.mkv")));
    await act(async () => {
      await handlers["watch-files"]({
        id: "w1",
        paths: [mine, `${SHOW}\\Show.S01E01.unverified.mkv`, `${SHOW}\\Show.S01E02#1732370000-0.mkv`, `${SHOW}\\Show.S01E03.mkv.mkvbatchmux-backup-20261123`, `${SHOW}\\Show.S01E05.mkv`, `${SHOW}\\Show.S01E04.mkv`],
      });
    });
    expect(hook.result.current.queue.map((item) => item.path)).toEqual([`${SHOW}\\Show.S01E04.mkv`]);
    const logged = vi.mocked(io.log).mock.calls.map(([line]) => line).join("\n");
    expect(logged).toContain("an output of this app");
    expect(logged).toContain("gone again");
  });

  it("doesn't start when the engine was taken meanwhile", async () => {
    const { hook, claim, onReport } = setup();
    claim.mockReturnValue(false);
    await waitFor(() => expect(handlers["watch-files"]).toBeDefined());
    await act(async () => {
      await handlers["watch-files"]({ id: "w1", paths: paths(1) });
    });
    expect(claim).toHaveBeenCalled();
    expect(hook.result.current.phase).toBe("idle");
    expect(hook.result.current.queue).toHaveLength(1);
    expect(onReport).not.toHaveBeenCalled();
  });
});
