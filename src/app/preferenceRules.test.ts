import { describe, expect, it } from "vitest";
import type { Preset } from "@/shared/types";
import { clampMeasurement, clampWindowCount, differsFromEngine, fileTypeLabel, formFromPreset, presetFromForm, toExtensions, withFavoriteFirst } from "./preferenceRules";

const preset: Preset = {
  Preset_Name: "Default",
  Default_Video_Directory: "D:\\Shows",
  Default_Video_Extensions: ["MKV", "MP4"],
  Default_Subtitle_Directory: "",
  Default_Subtitle_Extensions: ["SRT"],
  Default_Subtitle_Language: "eng",
  Default_Audio_Directory: "",
  Default_Audio_Extensions: ["AC3"],
  Default_Audio_Language: "hin",
  Default_Chapter_Directory: "",
  Default_Chapter_Extensions: ["XML"],
  Default_Attachment_Directory: "",
  Default_Destination_Directory: "D:\\Out",
  Default_Favorite_Subtitle_Languages: ["jpn", "eng"],
  Default_Favorite_Audio_Languages: ["hin"],
};

describe("measurement limits", () => {
  it("clamps to the engine's limits and falls back on nonsense", () => {
    expect(clampWindowCount(0)).toBe(1);
    expect(clampWindowCount(50)).toBe(20);
    expect(clampWindowCount("abc")).toBe(6);
    expect(clampMeasurement({ windowCount: 6, windowSeconds: 1000, maxOffsetMs: 900_000 })).toEqual({ windowCount: 6, windowSeconds: 600, maxOffsetMs: 600_000, fullTimeline: false });
  });

  it("notices a difference from AudioSyncMaster's defaults", () => {
    expect(differsFromEngine({ windowCount: 6, windowSeconds: 45, maxOffsetMs: 60_000 })).toBe(false);
    expect(differsFromEngine({ windowCount: 8, windowSeconds: 45, maxOffsetMs: 60_000 })).toBe(true);
  });
});

describe("presets", () => {
  it("round-trips a preset through the form, saving file types upper case", () => {
    const form = formFromPreset(preset);
    expect(form.videoExtensions).toBe("mkv,mp4");
    const saved = presetFromForm(preset, { ...form, videoExtensions: "mkv, avi ,", subtitleLanguage: "eng" });
    expect(saved.Default_Video_Extensions).toEqual(["MKV", "AVI"]);
    expect(saved.Default_Destination_Directory).toBe("D:\\Out");
  });

  it("moves the default language to the front of its favourites", () => {
    expect(withFavoriteFirst("eng", ["jpn", "eng"])).toEqual(["eng", "jpn"]);
    expect(presetFromForm(preset, formFromPreset(preset)).Default_Favorite_Subtitle_Languages).toEqual(["eng", "jpn"]);
  });

  it("labels and saves file-type choices the old way", () => {
    expect(fileTypeLabel("mkv,avi,mp4")).toBe("MKV, AVI, MP4");
    expect(toExtensions("xml")).toEqual(["XML"]);
  });
});
