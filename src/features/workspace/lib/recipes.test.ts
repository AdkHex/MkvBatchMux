import { describe, expect, it } from "vitest";
import type { ExternalFile, MeasuredDelay, MuxSettings, OutputSettings, Track, VideoFile } from "@/shared/types";
import type { Recipe, TrackRule } from "@/shared/types/recipes";
import {
  DEFAULT_MEASUREMENT_POLICY,
  applyMeasurementPolicy,
  applyRecipeSettings,
  applyTrackRules,
  createRecipe,
  createRule,
  decideMeasured,
  formatEpisode,
  localEpisodeKey,
  normalizeLanguage,
  parseRecipesFile,
  planMeasurementPolicy,
  resolveOutputName,
  resolveOutputNames,
  serializeRecipes,
  showNameFrom,
  slotsFromTabState,
  slotsToTabState,
  usesEpisodeTokens,
  validateRecipe,
} from "./recipes";

const track = (id: string, type: Track["type"], language: string, name: string, codec: string, extra: Partial<Track> = {}): Track => ({
  id,
  type,
  language,
  name,
  codec,
  action: "keep",
  ...extra,
});

const episode = (): VideoFile => ({
  id: "v1",
  name: "Show.S01E01.mkv",
  path: "/tv/Show/Season 1/Show.S01E01.mkv",
  size: 1000,
  status: "pending",
  tracks: [
    track("0", "video", "und", "", "AVC/H.264/MPEG-4p10"),
    track("1", "audio", "eng", "Stereo", "FLAC", { isDefault: true, channels: 2 }),
    track("2", "audio", "eng", "Director's Commentary", "AAC", { isDefault: false, channels: 2 }),
    track("3", "audio", "hin", "", "E-AC-3", { isDefault: false, channels: 6 }),
    track("4", "audio", "jpn", "Japanese", "AC-3", { isDefault: false, channels: 6 }),
    track("5", "subtitle", "eng", "English", "SubRip/SRT", { isDefault: true }),
    track("6", "subtitle", "eng", "Commentary", "SubRip/SRT", { isDefault: false }),
  ],
});

const byId = (file: VideoFile, id: string) => file.tracks.find((t) => t.id === id)!;

const dropCommentary = createRule({ id: "drop", label: "Drop commentary", match: { nameRegex: "commentary" }, action: { keep: false } });
const hindiDefault = createRule({ id: "hindi", label: "Hindi dub default", match: { type: "audio", languages: ["hi"] }, action: { setDefault: true, rename: "Hindi {channels}" } });
const onlyHindiEnglish = createRule({ id: "langs", match: { type: "audio", excludeLanguages: ["hin", "eng"] }, action: { keep: false } });

describe("applyTrackRules", () => {
  it("drops commentary by name, on every track type", () => {
    const { file, changes } = applyTrackRules(episode(), [dropCommentary]);
    expect(byId(file, "2").action).toBe("remove");
    expect(byId(file, "6").action).toBe("remove");
    expect(byId(file, "1").action).toBe("keep");
    expect(changes.filter((c) => c.field === "keep").map((c) => c.trackId)).toEqual(["2", "6"]);
    expect(changes.every((c) => c.ruleId === "drop")).toBe(true);
  });

  it("makes the Hindi dub the only default and renames it from a template", () => {
    const { file, changes } = applyTrackRules(episode(), [hindiDefault]);
    expect(byId(file, "3")).toMatchObject({ isDefault: true, name: "Hindi 5.1", action: "modify" });
    expect(byId(file, "1").isDefault).toBe(false);
    expect(byId(file, "5").isDefault).toBe(true); // subtitles untouched
    const cleared = changes.find((c) => c.trackId === "1" && c.field === "default");
    expect(cleared).toMatchObject({ from: true, to: false });
    expect(cleared?.ruleId).toBeUndefined();
  });

  it("filters audio by language and keeps the original values for undo", () => {
    const { file } = applyTrackRules(episode(), [onlyHindiEnglish]);
    expect(byId(file, "4").action).toBe("remove");
    expect(byId(file, "3").action).toBe("keep");
    expect(byId(file, "4").originalLanguage).toBe("jpn");
  });

  it("runs rules in order on what earlier rules left, and is idempotent", () => {
    const rules: TrackRule[] = [
      createRule({ id: "tag", match: { type: "audio", codecRegex: "^E-AC-3$", languages: ["und", "hin"] }, action: { setLanguage: "hin" } }),
      dropCommentary,
      hindiDefault,
      onlyHindiEnglish,
    ];
    const once = applyTrackRules(episode(), rules);
    expect(once.changes.length).toBeGreaterThan(0);
    const twice = applyTrackRules(once.file, rules);
    expect(twice.changes).toEqual([]);
    expect(twice.file).toBe(once.file);
  });

  it("gives removed tracks no flags, and a later rule can keep them again", () => {
    const keepBack = createRule({ id: "back", match: { nameRegex: "^director" }, action: { keep: true, setDefault: true } });
    const { file } = applyTrackRules(episode(), [dropCommentary, keepBack]);
    expect(byId(file, "2")).toMatchObject({ action: "modify", isDefault: true });
    expect(byId(file, "6").action).toBe("remove");
  });

  it("skips disabled and invalid rules and leaves a video without matches as it was", () => {
    const original = episode();
    const disabled = { ...dropCommentary, enabled: false };
    const invalid = createRule({ match: { nameRegex: "(" }, action: { keep: false } });
    const result = applyTrackRules(original, [disabled, invalid]);
    expect(result.file).toBe(original);
    expect(result.changes).toEqual([]);
  });
});

describe("languages", () => {
  it("matches two- and three-letter codes", () => {
    expect(normalizeLanguage("hi")).toBe("hin");
    expect(normalizeLanguage("HIN")).toBe("hin");
    expect(normalizeLanguage("hi-IN")).toBe("hin");
    expect(normalizeLanguage("deu")).toBe("ger");
    expect(normalizeLanguage("")).toBe("und");
  });
});

describe("naming tokens", () => {
  const name = (path: string, pattern = "{show} - {episode}", show?: string) => {
    const file = path.split(/[\\/]/).pop()!;
    return resolveOutputName(pattern, { id: "x", name: file, path }, { show });
  };

  it.each([
    ["/tv/Show.S01E02.1080p.WEB-DL.DDP5.1.H.264-GRP.mkv", "Show - S01E02"],
    ["/tv/The.Office.US.S05E14E15.720p.HDTV.x264.mkv", "The Office US - S05E14-E15"],
    ["/tv/Show Name (2019) - S02E10 - The Title.mkv", "Show Name (2019) - S02E10"],
    ["/tv/Breaking Bad - 3x07 - One Minute.mkv", "Breaking Bad - S03E07"],
    ["/anime/Frieren/Season 1/[SubsPlease] Sousou no Frieren - 05 (1080p) [ABCD1234].mkv", "Sousou no Frieren - S01E05"],
    ["/tv/Some Show/Season 2/Episode 05.mkv", "Some Show - S02E05"],
    ["C:\\TV\\Show\\Specials\\Show.S00E01.Pilot.Extended.mkv", "Show - S00E01"],
    ["/anime/進撃の巨人/第12話.mkv", "進撃の巨人 - E12"],
    ["/tv/Show/S03/Show.ep07.mkv", "Show - S03E07"],
    ["/tv/Great Show/Specials/Great Show - 03.mkv", "Great Show - S00E03"],
    ["/tv/Great Show/Season 3/03.mkv", "Great Show - S03E03"],
  ])("%s → %s", (path, expected) => {
    expect(name(path)).toEqual({ stem: expected, missing: [] });
  });

  it("formats season and keeps the original name token", () => {
    expect(name("/tv/Show.S01E02.mkv", "{show} S{season} {original_filename}").stem).toBe("Show S01 Show.S01E02");
    expect(name("/tv/Show.S01E02.mkv", "{original_filename}").stem).toBe("Show.S01E02");
    expect(name("/tv/Show.S01E02.mkv", "{filename}.{extension}").stem).toBe("Show.S01E02.mkv");
  });

  it("uses the recipe's show name and cleans characters Windows refuses", () => {
    expect(name("/tv/show.s01e02.mkv", "{show}: {episode}", "My Show").stem).toBe("My Show_ S01E02");
  });

  it("falls back to the original name when a token can't be filled", () => {
    expect(name("/films/Movie.2019.1080p.mkv")).toEqual({ stem: "Movie.2019.1080p", missing: ["episode"] });
    expect(name("/tv/Show.1920x1080.mkv", "{show} {episode}").missing).toEqual(["episode"]);
  });

  it("reports names that would collide", () => {
    const videos = ["/tv/A.S01E01.mkv", "/tv/A.S01E02.mkv", "/tv/a.s01e01.v2.mkv"].map((path, i) => ({ id: `v${i}`, name: path.slice(4), path }));
    const { names, collisions } = resolveOutputNames(videos, "{show} {episode}");
    expect(names.v1.stem).toBe("A S01E02");
    expect(collisions).toEqual([["v0", "v2"]]);
  });

  it("knows which patterns main.rs can't render alone", () => {
    expect(usesEpisodeTokens("{show} - {episode}")).toBe(true);
    expect(usesEpisodeTokens("{original_filename}")).toBe(false);
    expect(usesEpisodeTokens(undefined)).toBe(false);
  });

  it("reads episode keys and show names", () => {
    expect(localEpisodeKey("/x/Show.S01E01-E02.mkv")).toMatchObject({ season: 1, episode: 1, episodeEnd: 2 });
    expect(formatEpisode({ season: 1, episode: 1, episodeEnd: 2, confidence: 1 })).toBe("S01E01-E02");
    expect(formatEpisode({ episode: 112, confidence: 1 })).toBe("E112");
    expect(formatEpisode({ confidence: 0 })).toBe("");
    expect(showNameFrom("/tv/Great Show/Season 3/03.mkv")).toBe("Great Show");
  });
});

const measured = (over: Partial<MeasuredDelay> = {}): MeasuredDelay => ({
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
  measuredAt: "2026-11-20T10:00:00.000Z",
  error: null,
  ...over,
});

const dub = (id: string, over: Partial<ExternalFile> = {}): ExternalFile => ({ id, name: `${id}.eac3`, path: `/dubs/${id}.eac3`, type: "audio", ...over });

describe("measurement policy", () => {
  const policy = DEFAULT_MEASUREMENT_POLICY;

  it("applies only clean results at or over the threshold", () => {
    expect(decideMeasured(measured(), 1.312, policy)).toEqual({ kind: "apply" });
    expect(decideMeasured(measured({ confidence: 0.9 }), 1.312, policy)).toEqual({ kind: "apply" });
    expect(decideMeasured(measured({ confidence: 0.89 }), 1.312, policy)).toMatchObject({ kind: "review", reason: "Confidence under 90%" });
    expect(decideMeasured(measured({ isRateMismatch: true }), 1.312, policy)).toMatchObject({ kind: "review" });
    expect(decideMeasured(measured({ warnings: ["Same file twice"] }), 1.312, policy)).toEqual({ kind: "review", reason: "Same file twice" });
    expect(decideMeasured(measured({ error: "boom" }), undefined, policy)).toMatchObject({ kind: "review" });
    expect(decideMeasured(measured(), undefined, policy)).toMatchObject({ kind: "skip" });
    expect(decideMeasured(undefined, undefined, policy)).toMatchObject({ kind: "skip" });
    expect(decideMeasured(measured(), 1.312, { ...policy, autoApply: false })).toMatchObject({ kind: "review", reason: "Waiting for Apply" });
  });

  it("conforms a cut only when the policy says so, and a minor slip is not a cut", () => {
    const cut = measured({ isLikelyCut: true });
    expect(decideMeasured(cut, undefined, policy)).toEqual({ kind: "review", reason: "Different cut" });
    expect(decideMeasured(cut, undefined, { ...policy, autoConformCuts: true })).toEqual({ kind: "conform" });
    expect(decideMeasured(measured({ isLikelyCut: true, isMinorSlip: true }), 1.312, policy)).toEqual({ kind: "apply" });
  });

  it("plans and applies per file and per track, skipping gaps", () => {
    const files: ExternalFile[] = [
      dub("e01", { measuredDelay: measured(), pendingDelay: 1.312 }),
      dub("e02", { measuredDelay: measured({ isLikelyCut: true }) }),
      dub("e03", { measuredDelay: measured({ confidence: 0.6 }), pendingDelay: 2 }),
      dub("multi", {
        tracks: [track("0", "audio", "hin", "", "E-AC-3"), track("1", "audio", "tam", "", "E-AC-3")],
        trackOverrides: { 0: { measuredDelay: measured(), pendingDelay: 0.5 }, 1: { measuredDelay: measured({ isLikelyCut: true }) } },
      }),
      { ...dub("gap", { measuredDelay: measured(), pendingDelay: 1 }), path: "", placeholder: true } as ExternalFile,
    ];
    const plan = planMeasurementPolicy(files, { ...policy, autoConformCuts: true });
    expect(plan.apply).toEqual([{ fileId: "e01", trackId: null }, { fileId: "multi", trackId: 0 }]);
    expect(plan.conform).toEqual(["e02"]);
    expect(plan.review.map((r) => [r.fileId, r.trackId])).toEqual([["e03", null], ["multi", 1]]);

    // A cut in a file that also brings subtitles is left for the user: its conformed copy would drop them.
    const subs = dub("subs", { tracks: [track("0", "audio", "hin", "", "E-AC-3"), track("1", "subtitle", "hin", "", "SubRip/SRT")], includeSubtitles: true, includedSubtitleTrackIds: [1], measuredDelay: measured({ isLikelyCut: true }) });
    const withSubs = planMeasurementPolicy([subs], { ...policy, autoConformCuts: true });
    expect(withSubs.conform).toEqual([]);
    expect(withSubs.review[0].reason).toMatch(/^Different cut\. This file also brings a subtitle track into the mux/);

    const applied = applyMeasurementPolicy(files, policy);
    expect(applied.files[0]).toMatchObject({ delay: 1.312, delayProvenance: "measured", pendingDelay: undefined });
    expect(applied.files[3].trackOverrides?.[0]).toMatchObject({ delay: 0.5, delayProvenance: "measured" });
    expect(applied.files[2]).toBe(files[2]);
  });
});

describe("recipes file", () => {
  it("round-trips and validates", () => {
    const recipe: Recipe = { ...createRecipe("Show — Hindi"), show: "Show", trackRules: [dropCommentary, hindiDefault], namingPattern: "{show} - {episode}" };
    const { recipes, skipped, error } = parseRecipesFile(JSON.parse(JSON.stringify(serializeRecipes([recipe]))));
    expect(error).toBeNull();
    expect(skipped).toBe(0);
    expect(recipes).toEqual([recipe]);
    expect(validateRecipe(recipe)).toEqual([]);
  });

  it("leaves checking every new file off when a version that had it on by default saved it", () => {
    const recipe: Recipe = { ...createRecipe("Show"), muxOptions: { verifyOutput: true, addCrc: true } };
    expect(parseRecipesFile({ version: 1, recipes: [recipe] }).recipes[0].muxOptions).toEqual({ addCrc: true });
    expect(parseRecipesFile(JSON.parse(JSON.stringify(serializeRecipes([recipe])))).recipes[0].muxOptions).toEqual({ verifyOutput: true, addCrc: true });
  });

  it("tolerates old and broken entries", () => {
    const { recipes, skipped } = parseRecipesFile([{ name: "Bare" }, { nope: 1 }, "x", { name: "Bad conf", measurement: { autoApplyMinConfidence: 7 } }]);
    expect(skipped).toBe(2);
    expect(recipes[0]).toMatchObject({ name: "Bare", trackRules: [], measurement: DEFAULT_MEASUREMENT_POLICY });
    expect(recipes[1].measurement.autoApplyMinConfidence).toBe(0.9);
    expect(parseRecipesFile(null)).toEqual({ recipes: [], skipped: 0, error: null });
    expect(parseRecipesFile({ junk: true }).error).toMatch(/damaged/);
  });

  it("names what is wrong with a recipe", () => {
    const recipe: Recipe = {
      ...createRecipe(" "),
      trackRules: [createRule({ match: { nameRegex: "(" }, action: {} }), createRule({ match: {}, action: { setLanguage: "Hindi" } })],
      namingPattern: "Shows/{show}",
    };
    expect(validateRecipe(recipe)).toHaveLength(5);
  });
});

describe("slots and settings", () => {
  it("turns slot templates into slot state and back", () => {
    const hindi = { sourceFolder: "/dubs", extension: "eac3", language: "hin", trackName: "Hindi", delay: "0.000", isDefault: true, isForced: false, muxAfter: "video" };
    const state = slotsToTabState([hindi]);
    expect(state).toEqual({ tracks: ["1"], configs: { "1": hindi }, active: "1" });
    expect(slotsFromTabState(state.tracks, state.configs)).toEqual([hindi]);
    expect(slotsToTabState([]).tracks).toEqual(["1"]);
  });

  it("lays the recipe's options over the current ones", () => {
    const recipe: Recipe = { ...createRecipe("R"), namingPattern: "{show} {episode}", destination: "/out", muxOptions: { removeGlobalTags: false, makeAudioDefaultLanguage: "hin" } };
    const mux = { removeGlobalTags: true, addCrc: true } as MuxSettings;
    const output: OutputSettings = { directory: "", namingPattern: "{original_filename}", overwriteExisting: false };
    const next = applyRecipeSettings(recipe, mux, output);
    expect(next.muxSettings).toMatchObject({ removeGlobalTags: false, addCrc: true, makeAudioDefaultLanguage: "hin" });
    expect(next.outputSettings).toEqual({ directory: "/out", namingPattern: "{show} {episode}", overwriteExisting: false });
  });
});
