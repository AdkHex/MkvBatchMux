import { describe, expect, it } from "vitest";

import type { MuxSettings, OutputSettings, VideoFile } from "@/shared/types";
import type { Recipe } from "@/shared/types/recipes";
import { DEFAULT_SLOT, createRecipe, createRule } from "./recipes";
import { planRecipe, type RecipeWorkspace } from "./recipeApply";

const video = (n: number): VideoFile => ({
  id: `v${n}`,
  name: `Show.S01E0${n}.mkv`,
  path: `W:\\Show\\Season 1\\Show.S01E0${n}.mkv`,
  size: 1,
  status: "pending",
  tracks: [
    { id: "0", type: "video", codec: "AVC" },
    { id: "1", type: "audio", language: "eng", name: "Stereo", codec: "FLAC", isDefault: true, action: "keep" },
    { id: "2", type: "audio", language: "eng", name: "Commentary", codec: "AAC", action: "keep" },
  ],
});

const mux = { verifyOutput: true, removeGlobalTags: true, addCrc: false } as MuxSettings;
const output: OutputSettings = { directory: "", namingPattern: "{original_filename}", overwriteExisting: false };

const workspace = (over: Partial<RecipeWorkspace> = {}): RecipeWorkspace => ({
  videoFiles: [video(1), video(2)],
  audioTracks: ["1"],
  audioTrackConfigs: { "1": { ...DEFAULT_SLOT, language: "hin" } },
  subtitleTracks: ["1"],
  subtitleTrackConfigs: { "1": { ...DEFAULT_SLOT } },
  audioFileCounts: { "1": 0 },
  subtitleFileCounts: {},
  muxSettings: mux,
  outputSettings: output,
  ...over,
});

const recipe = (over: Partial<Recipe> = {}): Recipe => ({ ...createRecipe("Show"), ...over });

describe("applying a recipe", () => {
  it("lists every change before anything changes", () => {
    const plan = planRecipe(
      recipe({
        trackRules: [createRule({ id: "drop", match: { nameRegex: "commentary" }, action: { keep: false } })],
        audioSlots: [{ ...DEFAULT_SLOT, language: "hin", sourceFolder: "W:\\Dubs" }, { ...DEFAULT_SLOT, language: "tam" }],
        namingPattern: "{show} - {episode}",
        destination: "W:\\Out",
        muxOptions: { addCrc: true, removeGlobalTags: true },
      }),
      workspace(),
    );
    expect(plan.ruleChanges).toHaveLength(2);
    expect(plan.videoFiles[0].tracks[2].action).toBe("remove");
    expect(Object.fromEntries(plan.sections.map((section) => [section.title, section.lines]))).toEqual({
      Tracks: ["Show.S01E01 · Audio 2 (Commentary, eng): removed", "Show.S01E02 · Audio 2 (Commentary, eng): removed"],
      Slots: ["Audio 1: hin, W:\\Dubs (its files are loaded from the folder)", "Audio 2 is added: tam"],
      "Mux options and output": ["Add a CRC to each name: off → on", "Output name: {original_filename} → {show} - {episode}", "Output folder: beside each source → W:\\Out"],
      "Output names": ["Show.S01E01.mkv → Show - S01E01.mkv", "Show.S01E02.mkv → Show - S01E02.mkv"],
    });
    expect(plan.slots.map((slot) => [slot.slot, slot.created, slot.scan])).toEqual([["1", false, true], ["2", true, false]]);
    expect(plan.muxSettings).toMatchObject({ addCrc: true, verifyOutput: true });
    expect(plan.outputSettings).toEqual({ directory: "W:\\Out", namingPattern: "{show} - {episode}", overwriteExisting: false });
    expect(plan.empty).toBe(false);
  });

  it("says when there is nothing to do, and finds names two episodes would share", () => {
    expect(planRecipe(recipe(), workspace()).empty).toBe(true);
    // A slot with files keeps them: the folder isn't scanned again.
    const filled = planRecipe(recipe({ audioSlots: [{ ...DEFAULT_SLOT, language: "hin", sourceFolder: "W:\\Dubs" }] }), workspace({ audioFileCounts: { "1": 2 } }));
    expect(filled.slots[0]).toMatchObject({ slot: "1", scan: false });
    const clash = planRecipe(recipe({ namingPattern: "{show}" }), workspace());
    expect(clash.collisions).toEqual([["Show.S01E01.mkv", "Show.S01E02.mkv"]]);
  });
});
