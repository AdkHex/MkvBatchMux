import { afterEach, describe, expect, it, vi } from "vitest";
import type { ExternalFile, MuxSettings, VideoFile } from "@/shared/types";
import type { WorkspaceSnapshot } from "@/shared/types/recipes";
import {
  SESSION_FORMAT,
  SESSION_VERSION,
  buildSessionFile,
  createDebouncedSaver,
  describeMissing,
  findMissingFiles,
  isEmptySnapshot,
  missingFiles,
  parseSession,
  sessionFileRefs,
} from "./session";

const muxSettings: MuxSettings = {
  destinationDir: "",
  outputNamingPattern: "{original_filename}",
  overwriteSource: false,
  addCrc: false,
  removeOldCrc: false,
  keepLogFile: false,
  abortOnErrors: false,
  maxParallelJobs: 0,
  onlyKeepAudiosEnabled: false,
  onlyKeepSubtitlesEnabled: false,
  onlyKeepAudioLanguages: [],
  onlyKeepSubtitleLanguages: [],
  discardOldChapters: false,
  discardOldAttachments: true,
  allowDuplicateAttachments: false,
  attachmentsExpertMode: false,
  removeGlobalTags: true,
  makeAudioDefaultLanguage: "hin",
  makeSubtitleDefaultLanguage: undefined,
  useMkvpropedit: false,
};

const video = (n: number, status: VideoFile["status"] = "pending"): VideoFile => ({
  id: `v${n}`,
  name: `Show.S01E0${n}.mkv`,
  path: `C:\\Shows\\Show\\Season 1\\Show.S01E0${n}.mkv`,
  size: 1000 + n,
  durationSeconds: 1800.5,
  status,
  tracks: [
    { id: "0", type: "video", codec: "AVC" },
    { id: "1", type: "audio", language: "eng", name: "Stereo", isDefault: true, action: "keep" },
  ],
});

const dub = (n: number, extra: Partial<ExternalFile> = {}): ExternalFile => ({
  id: `a${n}`,
  name: `Show.S01E0${n}.Hindi.eac3`,
  path: `D:\\Dubs\\Show.S01E0${n}.Hindi.eac3`,
  type: "audio",
  language: "hin",
  delay: 1.312,
  delayProvenance: "measured",
  trackOverrides: { 0: { delay: 1.312, pendingDelay: 0.84 } },
  ...extra,
});

/** The parsed session, failing the test when it didn't load. */
function loaded(input: unknown) {
  const parsed = parseSession(input);
  if (!("session" in parsed)) throw new Error((parsed as { error: string }).error);
  return parsed;
}

const snapshot = (): WorkspaceSnapshot => ({
  videoFiles: [video(1), video(2, "processing"), video(3, "completed")],
  audioFilesByTrack: { "1": [dub(1), dub(2), dub(3)], "2": [] },
  subtitleFilesByTrack: { "1": [{ id: "s1", name: "Show.S01E01.en.srt", path: "D:\\Subs\\Show.S01E01.en.srt", type: "subtitle", delay: 2.5 }] },
  chapterFiles: [{ id: "c1", name: "ch.xml", path: "D:\\Chapters\\ch.xml", type: "chapter" }],
  attachmentFiles: [],
  perVideoExternal: { v1: { audios: [dub(9, { id: "pv", source: "per-file" })], subtitles: [] } },
  tabState: {
    audioTracks: ["1", "2"],
    activeAudioTrack: "2",
    audioTrackConfigs: {
      "1": { sourceFolder: "D:\\Dubs", extension: "eac3", language: "hin", trackName: "Hindi", delay: "0.000", isDefault: true, isForced: false, muxAfter: "video" },
      "2": { sourceFolder: "", extension: "all", language: "tam", trackName: "", delay: "0.000", isDefault: false, isForced: false, muxAfter: "video" },
    },
    audioPresetApplied: true,
    subtitleTracks: ["1"],
    activeSubtitleTrack: "1",
    subtitleTrackConfigs: { "1": { sourceFolder: "", extension: "all", language: "eng", trackName: "", delay: "0.000", isDefault: true, isForced: false, muxAfter: "audio" } },
    subtitlePresetApplied: false,
    chapterTabState: { chaptersEnabled: true, sourceFolder: "D:\\Chapters", extension: "xml", discardOldChapters: false, delay: "0.000" },
    attachmentTabState: { attachmentsEnabled: false, sourceFolder: "", extension: "all", allowDuplicate: false, discardOld: false, expertMode: false },
  },
  muxSettings,
  outputSettings: { directory: "E:\\Out", namingPattern: "{show} - {episode}", overwriteExisting: false },
  recipeId: "recipe-1",
});

describe("session round trip", () => {
  it("saves and reads back everything, with a muxing video back to pending", () => {
    const file = buildSessionFile(snapshot(), new Date("2026-11-20T12:00:00Z"));
    expect(file).toMatchObject({ format: SESSION_FORMAT, version: SESSION_VERSION, savedAt: "2026-11-20T12:00:00.000Z" });
    const parsed = loaded(JSON.stringify(file));
    expect(parsed.warnings).toEqual([]);
    expect(parsed.savedAt).toBe("2026-11-20T12:00:00.000Z");
    const expected = snapshot();
    expected.videoFiles[1].status = "pending";
    expect(parsed.session).toEqual(expected);
  });

  it("accepts the object session_open returns as well as text", () => {
    expect(parseSession(JSON.parse(JSON.stringify(buildSessionFile(snapshot())))).ok).toBe(true);
  });

  it("knows an empty workspace", () => {
    expect(isEmptySnapshot(snapshot())).toBe(false);
    expect(isEmptySnapshot({ videoFiles: [], audioFilesByTrack: { "1": [] }, subtitleFilesByTrack: {}, chapterFiles: [], attachmentFiles: [], perVideoExternal: { v: { audios: [], subtitles: [] } } })).toBe(true);
  });
});

describe("reading older and damaged sessions", () => {
  it("migrates a bare version-0 workspace with flat file lists", () => {
    const parsed = loaded({
      videoFiles: [{ path: "/tv/Show.S01E01.mkv" }],
      audioFiles: [{ path: "/dubs/Show.S01E01.eac3" }],
      subtitleFiles: [{ path: "/subs/Show.S01E01.srt", id: "s" }],
    });
    expect(parsed.version).toBe(0);
    const { session } = parsed;
    expect(session.videoFiles[0]).toMatchObject({ id: "/tv/Show.S01E01.mkv", name: "Show.S01E01.mkv", size: 0, status: "pending", tracks: [] });
    expect(session.audioFilesByTrack["1"][0]).toMatchObject({ name: "Show.S01E01.eac3", type: "audio" });
    expect(session.subtitleFilesByTrack["1"][0]).toMatchObject({ id: "s", type: "subtitle" });
    // Every list of files gets a slot to show it in.
    expect(session.tabState).toMatchObject({ audioTracks: ["1"], activeAudioTrack: "1", subtitleTracks: ["1"] });
    expect(session.muxSettings).toEqual({});
    expect(session.chapterFiles).toEqual([]);
  });

  it("drops what is unreadable and says so", () => {
    const parsed = loaded({
      format: SESSION_FORMAT,
      version: 1,
      videoFiles: [{ path: "/a.mkv", id: "x" }, { name: "no path" }, 7, { path: "/b.mkv", id: "x", status: "weird", tracks: [{ type: "nope" }, { type: "audio" }] }],
      audioFilesByTrack: { "1": [{ path: "/d.eac3" }, null, { placeholder: true, id: "gap" }] },
      perVideoExternal: { gone: { audios: [{ path: "/p.eac3" }], subtitles: [] } },
      muxSettings: { addCrc: "yes", removeGlobalTags: false, maxParallelJobs: Infinity, onlyKeepAudioLanguages: ["hin", 3], makeAudioDefaultLanguage: null, futureOption: 5 },
      outputSettings: { directory: 4, namingPattern: "{show}" },
      tabState: { audioTracks: ["1", 2], activeAudioTrack: "9", audioTrackConfigs: { "1": { language: "hin", delay: 1.5 }, "7": { language: "x" } } },
    });
    const { session, warnings } = parsed;
    expect(session.videoFiles.map((v) => v.id)).toEqual(["x", "x~"]);
    expect(session.videoFiles[1]).toMatchObject({ status: "pending", tracks: [{ id: "x~-0", type: "audio" }] });
    // A gap keeps its place so the files after it stay paired.
    expect(session.audioFilesByTrack["1"].map((f) => f.id)).toEqual(["audio-0-/d.eac3", "gap"]);
    expect(session.perVideoExternal).toEqual({});
    expect(session.muxSettings).toEqual({ removeGlobalTags: false, makeAudioDefaultLanguage: undefined, futureOption: 5 });
    expect(session.outputSettings).toEqual({ namingPattern: "{show}" });
    expect(session.tabState.audioTracks).toEqual(["1"]);
    expect(session.tabState.activeAudioTrack).toBe("1");
    expect(session.tabState.audioTrackConfigs).toEqual({ "1": expect.objectContaining({ language: "hin", delay: "1.500", extension: "all" }) });
    expect(warnings).toEqual([
      "3 entries were unreadable and left out.",
      "1 per-video file belonged to a video that isn't in the session and was left out.",
      "3 mux options were unreadable and kept at their current value: addCrc, maxParallelJobs, onlyKeepAudioLanguages.",
      "1 output setting was unreadable and kept at its current value: directory.",
    ]);
  });

  it("loads a newer version with a warning", () => {
    const parsed = loaded({ ...buildSessionFile(snapshot()), version: SESSION_VERSION + 1 });
    expect(parsed.ok && parsed.warnings[0]).toMatch(/newer version/);
  });

  it("refuses what is not a session", () => {
    expect(parseSession("{not json")).toEqual({ ok: false, error: "This file is damaged or is not a MKVBatchMux session." });
    expect(parseSession("[1,2]").ok).toBe(false);
    expect(parseSession({ recipes: [] }).ok).toBe(false);
    expect(parseSession({ format: "something-else", videoFiles: [] }).ok).toBe(false);
    expect(parseSession(null).ok).toBe(false);
    expect(parseSession({ videoFiles: Array.from({ length: 50_001 }, (_, i) => ({ path: `/${i}.mkv` })) }).ok).toBe(false);
  });
});

describe("missing files", () => {
  it("lists every referenced file once and the ones that are gone", async () => {
    const parsed = loaded(buildSessionFile(snapshot()));
    const refs = sessionFileRefs(parsed.session);
    expect(refs.map((r) => r.kind)).toEqual(["video", "video", "video", "audio", "audio", "audio", "subtitle", "chapter", "audio"]);
    expect(refs[8]).toMatchObject({ slot: "v1", name: "Show.S01E09.Hindi.eac3" });
    const gone = new Set([refs[1].path, refs[4].path, refs[7].path]);
    const exists = vi.fn(async (paths: string[]) => paths.map((p) => !gone.has(p)));
    const missing = await findMissingFiles(parsed.session, exists);
    expect(exists).toHaveBeenCalledTimes(1);
    expect(missing.map((m) => m.name)).toEqual(["Show.S01E02.mkv", "Show.S01E02.Hindi.eac3", "ch.xml"]);
    expect(describeMissing(missing)).toBe("1 video, 1 audio file and 1 chapter file are missing");
    expect(describeMissing(missing.slice(0, 1))).toBe("1 video is missing");
    expect(missingFiles(refs, refs.map(() => true))).toEqual([]);
  });
});

describe("conformed and re-timed copies", () => {
  it("are checked on open like the files they replace, and survive the round trip", async () => {
    const base = snapshot();
    const conformed = dub(2, {
      conformed: { path: "D:\\Dubs\\MKVBatchMux conformed\\Show.S01E02.Hindi.conformed.eac3", mode: "render", codec: "eac3", verified: true, verificationText: "ok", residualMs: -0.15, sourceTrack: 0, createdAt: "2026-11-23T10:00:00.000Z", videoPath: video(2).path },
    });
    const subtitle: ExternalFile = {
      id: "s1",
      name: "Show.S01E01.en.srt",
      path: "D:\\Subs\\Show.S01E01.en.srt",
      type: "subtitle",
      retimed: { path: "D:\\Subs\\MKVBatchMux synced\\Show.S01E01.en.srt", offsetS: -0.07, ratio: 1.0427, splits: 0, score: 1 },
    };
    const parsed = loaded(buildSessionFile({ ...base, audioFilesByTrack: { "1": [dub(1), conformed, dub(3)], "2": [] }, subtitleFilesByTrack: { "1": [subtitle] } }));
    expect(parsed.session.audioFilesByTrack["1"][1].conformed?.path).toBe(conformed.conformed!.path);
    expect(parsed.session.subtitleFilesByTrack["1"][0].retimed?.ratio).toBe(1.0427);
    const refs = sessionFileRefs(parsed.session);
    expect(refs.filter((ref) => ref.name.endsWith("(conformed)"))).toEqual([{ path: conformed.conformed!.path, kind: "audio", name: "Show.S01E02.Hindi.eac3 (conformed)", slot: "1" }]);
    expect(refs.filter((ref) => ref.name.endsWith("(re-timed copy)")).map((ref) => [ref.kind, ref.path])).toEqual([["subtitle", subtitle.retimed!.path]]);
    const missing = await findMissingFiles(parsed.session, async (paths) => paths.map((path) => !path.includes("MKVBatchMux conformed")));
    expect(missing.map((m) => m.name)).toEqual(["Show.S01E02.Hindi.eac3 (conformed)"]);
  });
});

describe("autosave", () => {
  afterEach(() => vi.useRealTimers());

  it("writes once after changes stop, and not again when nothing changed", async () => {
    vi.useFakeTimers();
    const write = vi.fn(async () => undefined);
    const saver = createDebouncedSaver<{ n: number }>(write, { delayMs: 1000 });
    saver.schedule({ n: 1 });
    vi.advanceTimersByTime(500);
    saver.schedule({ n: 2 });
    vi.advanceTimersByTime(999);
    expect(write).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(write).toHaveBeenCalledTimes(1);
    expect(write).toHaveBeenLastCalledWith({ n: 2 });
    saver.schedule({ n: 2 });
    await vi.advanceTimersByTimeAsync(1000);
    expect(write).toHaveBeenCalledTimes(1);
    saver.schedule({ n: 3 });
    await saver.flush();
    expect(write).toHaveBeenLastCalledWith({ n: 3 });
    saver.schedule({ n: 4 });
    saver.cancel();
    await vi.advanceTimersByTimeAsync(2000);
    expect(write).toHaveBeenCalledTimes(2);
  });

  it("tries again after a failed write", async () => {
    const write = vi.fn().mockRejectedValueOnce(new Error("disk full")).mockResolvedValue(undefined);
    const saver = createDebouncedSaver<number>(write, { delayMs: 10 });
    saver.schedule(1);
    await saver.flush();
    saver.schedule(1);
    await saver.flush();
    expect(write).toHaveBeenCalledTimes(2);
  });
});
