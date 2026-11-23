import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";

import type { OptionsData } from "@/shared/types";

vi.mock("@/shared/lib/backend", () => ({ installDependency: vi.fn(), pickDirectory: vi.fn() }));

import { PreferencesWindow, type PreferencesProps } from "./Preferences";

const options: OptionsData = {
  Presets: [
    {
      Preset_Name: "Default",
      Default_Video_Directory: "",
      Default_Video_Extensions: ["mkv"],
      Default_Subtitle_Directory: "",
      Default_Subtitle_Extensions: ["srt"],
      Default_Subtitle_Language: "English",
      Default_Audio_Directory: "",
      Default_Audio_Extensions: ["eac3"],
      Default_Audio_Language: "Hindi",
      Default_Chapter_Directory: "",
      Default_Chapter_Extensions: ["xml"],
      Default_Attachment_Directory: "",
      Default_Destination_Directory: "",
      Default_Favorite_Subtitle_Languages: [],
      Default_Favorite_Audio_Languages: [],
    },
  ],
  // As an older setting.json has it: no conform settings at all.
  Measurement: { windowSeconds: 45, windowCount: 6, maxOffsetMs: 60000, fullTimeline: true },
  FavoritePresetId: 0,
  Dark_Mode: true,
  Attachment_Expert_Mode_Info_Message_Show: true,
  Choose_Preset_On_Startup: false,
};

const props = (onSave: PreferencesProps["onSave"]): PreferencesProps => ({
  tab: "measure",
  onTab: vi.fn(),
  options,
  onSave,
  onPreviewTheme: vi.fn(),
  onClose: vi.fn(),
  version: "1.70.0",
  tools: [],
  onRefreshTools: vi.fn(),
  update: null,
  onUpdateFound: vi.fn(),
  onInstallUpdate: vi.fn(),
  busy: false,
});

describe("Preferences › Measurement › Conforming", () => {
  it("defaults to re-encoding in the dub's codec beside the dub, and saves a change with the other settings", () => {
    const onSave = vi.fn();
    render(<PreferencesWindow {...props(onSave)} />);
    const how = screen.getByRole("radiogroup", { name: "How to conform" });
    expect(within(how).getByRole("radio", { name: "To the sample" })).toHaveAttribute("aria-checked", "true");
    expect(within(screen.getByRole("radiogroup", { name: "Codec of a conformed dub" })).getByRole("radio", { name: "Same as the dub" })).toHaveAttribute("aria-checked", "true");
    expect(screen.getByText('Not set: a "MKVBatchMux conformed" folder beside each dub.')).toBeInTheDocument();

    fireEvent.click(within(how).getByRole("radio", { name: "Lossless" }));
    fireEvent.click(screen.getByRole("radio", { name: "FLAC" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Conformed dubs folder" }), { target: { value: "  E:\\Conformed  " } });
    // Resetting the engine's settings leaves these alone.
    fireEvent.click(screen.getByRole("button", { name: "Reset to AudioSyncMaster's" }));
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(onSave).toHaveBeenCalledTimes(1);
    expect(onSave.mock.calls[0][0].Measurement).toEqual({
      windowSeconds: 45,
      windowCount: 6,
      maxOffsetMs: 60000,
      fullTimeline: true,
      conformMode: "lossless",
      conformCodec: "flac",
      conformOutputDir: "E:\\Conformed",
    });
  });
});
