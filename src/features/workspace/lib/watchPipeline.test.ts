import { describe, expect, it } from "vitest";

import type { ExternalFile, VideoFile } from "@/shared/types";
import type { ConformResultEvent } from "@/shared/types/engineFeatures";
import { createRecipe } from "./recipes";
import {
  INITIAL_PIPELINE,
  OutputRegistry,
  admitVideos,
  arrivalsToQueue,
  canBegin,
  conformVerdict,
  filesForNewVideos,
  fromTemplate,
  isWorkFile,
  pipelineReducer,
  placeFiles,
  slotIdFor,
  slotSources,
  videosWithoutFile,
  type PipelineAction,
  type PipelineState,
} from "./watchPipeline";

const video = (n: number, folder = "W:\\Show\\Season 1"): VideoFile => ({ id: `v${n}`, name: `Show.S01E0${n}.mkv`, path: `${folder}\\Show.S01E0${n}.mkv`, size: 1000, status: "pending", tracks: [] });
const dub = (n: number, over: Partial<ExternalFile> = {}): ExternalFile => ({ id: `d${n}`, name: `Show.S01E0${n}.Hindi.eac3`, path: `W:\\Dubs\\Show.S01E0${n}.Hindi.eac3`, type: "audio", ...over });
const run = (state: PipelineState, ...actions: PipelineAction[]) => actions.reduce(pipelineReducer, state);

describe("the watch pipeline's state machine", () => {
  it("queues new videos once, runs one watch's arrivals at a time, and goes back to idle", () => {
    let state = run(INITIAL_PIPELINE, { type: "arrive", watchId: "a", paths: ["W:\\in\\E01.mkv", "W:\\in\\E02.mkv"] }, { type: "arrive", watchId: "b", paths: ["X:\\E09.mkv"] });
    // The same file again (any case, either separator) is not queued twice.
    state = run(state, { type: "arrive", watchId: "a", paths: ["w:/in/e01.mkv", "W:\\in\\E03.mkv", "W:\\in\\E03.mkv"] });
    expect(state.queue.map((item) => item.path)).toEqual(["W:\\in\\E01.mkv", "W:\\in\\E02.mkv", "X:\\E09.mkv", "W:\\in\\E03.mkv"]);
    expect(canBegin(state, false)).toBe(false);
    expect(canBegin(state, true)).toBe(true);

    state = run(state, { type: "begin" });
    expect(state.phase).toBe("loading");
    expect(state.current).toMatchObject({ watchId: "a", paths: ["W:\\in\\E01.mkv", "W:\\in\\E02.mkv", "W:\\in\\E03.mkv"] });
    expect(state.queue).toEqual([{ watchId: "b", path: "X:\\E09.mkv" }]);
    // While it runs, a second begin does nothing and its files aren't queued again.
    expect(run(state, { type: "begin" })).toBe(state);
    expect(run(state, { type: "arrive", watchId: "a", paths: ["W:\\in\\E02.mkv"] })).toBe(state);
    expect(canBegin(state, true)).toBe(false);

    state = run(state, { type: "step", phase: "measuring", detail: "Measuring 3 dubs" }, { type: "step", phase: "muxing", detail: "Muxing 3 new episodes" });
    expect(state).toMatchObject({ phase: "muxing", current: { detail: "Muxing 3 new episodes" } });
    state = run(state, { type: "finish" });
    expect(state).toMatchObject({ phase: "idle", current: null });
    expect(canBegin(state, true)).toBe(true);
  });

  it("drops what a watch queued when it is turned off", () => {
    const state = run(INITIAL_PIPELINE, { type: "arrive", watchId: "a", paths: ["A.mkv"] }, { type: "arrive", watchId: "b", paths: ["B.mkv"] }, { type: "forget", watchId: "a" });
    expect(state.queue).toEqual([{ watchId: "b", path: "B.mkv" }]);
    expect(run(state, { type: "forget", watchId: "zzz" })).toBe(state);
  });
});

describe("the app's own files are never new episodes", () => {
  it("knows the files the mux writes while working", () => {
    expect(isWorkFile("W:\\in\\Show.S01E01.unverified.mkv")).toBe(true);
    expect(isWorkFile("W:\\in\\Show.S01E01#1732370000123456789-4.mkv")).toBe(true);
    expect(isWorkFile("W:\\in\\Show.S01E01.mkv.mkvbatchmux-backup-20261123T101500")).toBe(true);
    expect(isWorkFile("/in/Show.S01E01.MKVBATCHMUX-BACKUP-1.mkv")).toBe(true);
    expect(isWorkFile("W:\\in\\Show #1 - S01E01.mkv")).toBe(false);
    expect(isWorkFile("W:\\in\\Show.S01E01.mkv")).toBe(false);
  });

  it("remembers this session's outputs, with or without the CRC the mux adds", () => {
    const outputs = new OutputRegistry();
    outputs.add("W:\\in\\", "Show - S01E01");
    expect(outputs.has("W:\\in\\Show - S01E01.mkv")).toBe(true);
    expect(outputs.has("w:/in/show - s01e01.MKV")).toBe(true);
    expect(outputs.has("W:\\in\\Show - S01E01 [1A2B3C4D].mkv")).toBe(true);
    expect(outputs.has("W:\\in\\Show - S01E02.mkv")).toBe(false);
    expect(outputs.has("W:\\other\\Show - S01E01.mkv")).toBe(false);
  });

  it("queues only what is new, not the app's, and still there", () => {
    const outputs = new OutputRegistry();
    outputs.add("W:\\in", "Show.S01E02");
    const paths = ["W:\\in\\Show.S01E01.mkv", "W:\\in\\Show.S01E02.mkv", "W:\\in\\Show.S01E03.unverified.mkv", "W:\\in\\Show.S01E04#17-0.mkv", "W:\\in\\Show.S01E05.mkv"];
    const { queue, ignored } = arrivalsToQueue(paths, [true, true, true, true, false], (path) => outputs.has(path));
    expect(queue).toEqual(["W:\\in\\Show.S01E01.mkv"]);
    expect(ignored.map((item) => item.reason)).toEqual(["an output of this app", "a file the mux writes while working", "a file the mux writes while working", "gone again"]);
  });
});

describe("a run's workspace steps", () => {
  it("admits new videos, skipping loaded ones and unreadable ones, with ids of their own", () => {
    const loaded = [video(1)];
    const inspected = [{ ...video(2), id: "v1" }, { ...video(3), status: "error" as const }];
    const result = admitVideos([video(1).path, video(2).path, video(3).path, "W:\\Show\\Season 1\\gone.mkv"], inspected, loaded);
    expect(result.videos.map((item) => [item.id, item.name])).toEqual([["v1~", "Show.S01E02.mkv"]]);
    expect(result.skipped).toEqual([{ name: "Show.S01E01.mkv", reason: "Already in the queue" }]);
    expect(result.failed.map((note) => note.name)).toEqual(["Show.S01E03.mkv", "gone.mkv"]);
  });

  it("takes the recipe's slots, the watch's folder standing in for the first", () => {
    const recipe = { ...createRecipe("Show"), audioSlots: [{ ...fromTemplateSlot("hin"), sourceFolder: "R:\\Hindi" }, { ...fromTemplateSlot("tam"), sourceFolder: "R:\\Tamil" }, fromTemplateSlot("tel")] };
    expect(slotSources(recipe, "W:\\Dubs", undefined, "audio").map((source) => [source.index, source.folder])).toEqual([[0, "W:\\Dubs"], [1, "R:\\Tamil"]]);
    expect(slotSources(recipe, "", undefined, "audio").map((source) => source.folder)).toEqual(["R:\\Hindi", "R:\\Tamil"]);
    expect(slotSources({ ...recipe, audioSlots: [] }, "W:\\Dubs", fromTemplateSlot("hin"), "audio")).toMatchObject([{ folder: "W:\\Dubs", template: { language: "hin" } }]);
    expect(slotSources(recipe, "", undefined, "subtitle")).toEqual([]);
  });

  it("finds the new videos' files and stamps them with the slot's settings", () => {
    const old = [video(1), video(2)];
    const fresh = [video(3)];
    const scanned = [dub(1), dub(2), dub(3, { tracks: [{ id: "0", type: "audio" }, { id: "1", type: "subtitle" }] }), dub(4)];
    const files = filesForNewVideos(scanned, fresh, [...old, ...fresh], [dub(2)]);
    expect(files.map((file) => file.id)).toEqual(["d3"]);
    const row = fromTemplate(files[0], { ...fromTemplateSlot("hin"), trackName: "Hindi", delay: "0.250", isDefault: true }, "audio");
    expect(row).toMatchObject({ language: "hin", trackName: "Hindi", delay: 0.25, isDefault: true, includedTrackIds: [0], includeSubtitles: true, includedSubtitleTrackIds: [1] });
  });

  it("places new files beside the new videos, by episode or by row, leaving the old rows alone", () => {
    const videos = [video(1), video(2), video(3)];
    // By episode: E02's dub hasn't arrived; E03's lands in its row.
    const list = [dub(1, { matchedVideoId: "v1" })];
    const placed = placeFiles(list, [dub(3)], videos, 2, "audio");
    expect(placed.map((file) => [file.id, file.matchedVideoId ?? null])).toEqual([["d1", "v1"], ["gap-v2", "v2"], ["d3", "v3"]]);
    expect(videosWithoutFile([videos[2]], placed)).toEqual([]);
    expect(videosWithoutFile([videos[1]], placed)).toEqual([videos[1]]);

    // By row (names that don't read): the old rows keep their places, padded to the old videos.
    const plain = (id: string, name: string): ExternalFile => ({ id, name, path: `W:\\Dubs\\${name}`, type: "audio" });
    const rows = placeFiles([plain("x", "first take.eac3")], [plain("y", "Show.S01E03.eac3")], videos, 2, "audio");
    expect(rows.map((file) => [file.id, file.matchedVideoId ?? null])).toEqual([["x", "v1"], ["gap-v2", "v2"], ["y", "v3"]]);
    expect(placeFiles(list, [], videos, 2, "audio")).toBe(list);
  });

  it("names slot ids after the workspace's, adding new ones past the end", () => {
    expect(slotIdFor(0, ["1", "2"])).toEqual({ id: "1", created: false });
    expect(slotIdFor(2, ["1", "2"])).toEqual({ id: "3", created: true });
    expect(slotIdFor(3, ["1", "4"])).toEqual({ id: "6", created: true });
    expect(slotIdFor(0, [])).toEqual({ id: "1", created: true });
  });
});

function fromTemplateSlot(language: string) {
  return { sourceFolder: "", extension: "all", language, trackName: "", delay: "0.000", isDefault: false, isForced: false, muxAfter: "video" };
}

describe("whether a conformed dub's episode may be muxed", () => {
  const result = (over: Partial<ConformResultEvent> = {}): ConformResultEvent => ({
    runId: "watch-conform-1",
    key: "d1",
    outputPath: "W:\\Dubs\\MKVBatchMux conformed\\d1.conformed.eac3",
    mode: "render",
    codec: "eac3",
    verified: true,
    verificationText: "checked at 6 spots: all within 45 ms.\n  12.0 s  +3.1 ms",
    residualMs: 3.1,
    plan: null,
    description: null,
    error: null,
    fallbackReason: null,
    ...over,
  });
  const ended = { cancelled: false, error: null };

  it("only when the engine checked it and it passed", () => {
    expect(conformVerdict(result(), ended)).toBeNull();
    // Even a run stopped or failed later keeps a result it verified before.
    expect(conformVerdict(result(), { cancelled: true, error: "boom" })).toBeNull();
    expect(conformVerdict(result({ verified: false }), ended)).toBe("conformed, but the check failed. Checked at 6 spots: all within 45 ms.");
    expect(conformVerdict(result({ verified: null, verificationText: null }), ended)).toBe("conformed, but it couldn't be checked.");
    expect(conformVerdict(result({ outputPath: null, error: "No plan" }), ended)).toBe("conforming failed: No plan");
    expect(conformVerdict(result({ outputPath: null }), ended)).toBe("conforming failed: nothing was written");
  });

  it("not when no result came: stopped, an engine error, or nothing at all", () => {
    expect(conformVerdict(undefined, { cancelled: true, error: null })).toBe("conforming was stopped");
    expect(conformVerdict(undefined, { cancelled: false, error: "engine exited" })).toBe("not conformed: engine exited");
    expect(conformVerdict(undefined, ended)).toBe("the engine sent no conform result for it");
  });

  it("is a step of a run like the others", () => {
    const state = run(INITIAL_PIPELINE, { type: "arrive", watchId: "a", paths: ["W:\\in\\E01.mkv"] }, { type: "begin" }, { type: "step", phase: "conforming", detail: "Conforming 1 dub to a different cut" });
    expect(state).toMatchObject({ phase: "conforming", current: { detail: "Conforming 1 dub to a different cut" } });
    expect(run(state, { type: "finish" }).phase).toBe("idle");
  });
});
