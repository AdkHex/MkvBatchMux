import { useEffect, useState } from "react";
import { FolderOpen, Settings, Info, RotateCcw, Download, Copy, Moon, X, SlidersHorizontal, Folder, FileType2, Languages, Plug } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Select, SelectItem, SelectValue } from "@/components/ui/select";
import type { OptionsData, Preset } from "@/types";
import { pickDirectory } from "@/lib/backend";
import { open as openExternal } from "@tauri-apps/api/shell";
import { BaseModal } from "@/components/shared/BaseModal";
import { TextField, CheckboxField, DropdownTrigger, DropdownContent, Toggle } from "@/components/shared/Fields";
import { LanguageSelect } from "@/components/LanguageSelect";

interface OptionsDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  options: OptionsData | null;
  onSave: (options: OptionsData) => void;
}

export function OptionsDialog({ open, onOpenChange, options, onSave }: OptionsDialogProps) {
  const [presetIndex, setPresetIndex] = useState(0);
  const [askForPreset, setAskForPreset] = useState(false);
  const [darkMode, setDarkMode] = useState(false);
  const [videosDir, setVideosDir] = useState("");
  const [subtitlesDir, setSubtitlesDir] = useState("");
  const [audiosDir, setAudiosDir] = useState("");
  const [chaptersDir, setChaptersDir] = useState("");
  const [attachmentsDir, setAttachmentsDir] = useState("");
  const [destinationDir, setDestinationDir] = useState("");
  const [videoExtensions, setVideoExtensions] = useState("mkv,avi,mp4,m4v,mov");
  const [subtitleExtensions, setSubtitleExtensions] = useState("ass,srt,ssa,sup,pgs");
  const [audioExtensions, setAudioExtensions] = useState("aac,ac3,flac,eac3,mka");
  const [chapterExtensions, setChapterExtensions] = useState("xml");
  const [subtitleLanguage, setSubtitleLanguage] = useState("eng");
  const [audioLanguage, setAudioLanguage] = useState("hin");

  useEffect(() => {
    if (!options) return;
    const index = options.FavoritePresetId ?? 0;
    const preset = options.Presets[index] || options.Presets[0];
    setPresetIndex(index);
    setAskForPreset(Boolean(options.Choose_Preset_On_Startup));
    setDarkMode(Boolean(options.Dark_Mode));
    hydrateFromPreset(preset);
  }, [options]);

  useEffect(() => {
    const root = document.documentElement;
    if (darkMode) {
      root.classList.add("dark");
    } else {
      root.classList.remove("dark");
    }
  }, [darkMode]);

  useEffect(() => {
    if (!open && options) {
      setDarkMode(Boolean(options.Dark_Mode));
    }
  }, [open, options]);

  const hydrateFromPreset = (preset: Preset) => {
    setVideosDir(preset.Default_Video_Directory || "");
    setSubtitlesDir(preset.Default_Subtitle_Directory || "");
    setAudiosDir(preset.Default_Audio_Directory || "");
    setChaptersDir(preset.Default_Chapter_Directory || "");
    setAttachmentsDir(preset.Default_Attachment_Directory || "");
    setDestinationDir(preset.Default_Destination_Directory || "");
    setVideoExtensions((preset.Default_Video_Extensions || []).join(",").toLowerCase());
    setSubtitleExtensions((preset.Default_Subtitle_Extensions || []).join(",").toLowerCase());
    setAudioExtensions((preset.Default_Audio_Extensions || []).join(",").toLowerCase());
    setChapterExtensions((preset.Default_Chapter_Extensions || []).join(",").toLowerCase());
    setSubtitleLanguage(preset.Default_Subtitle_Language || "eng");
    setAudioLanguage(preset.Default_Audio_Language || "hin");
  };

  const buildPreset = (existing: Preset): Preset => {
    const normalizeFavorites = (value: string, list: string[]) => {
      const filtered = list.filter((item) => item !== value);
      return [value, ...filtered];
    };

    return {
      ...existing,
      Default_Video_Directory: videosDir,
      Default_Subtitle_Directory: subtitlesDir,
      Default_Audio_Directory: audiosDir,
      Default_Chapter_Directory: chaptersDir,
      Default_Attachment_Directory: attachmentsDir,
      Default_Destination_Directory: destinationDir,
      Default_Video_Extensions: videoExtensions
        .split(",")
        .map((ext) => ext.trim().toUpperCase())
        .filter(Boolean),
      Default_Subtitle_Extensions: subtitleExtensions
        .split(",")
        .map((ext) => ext.trim().toUpperCase())
        .filter(Boolean),
      Default_Audio_Extensions: audioExtensions
        .split(",")
        .map((ext) => ext.trim().toUpperCase())
        .filter(Boolean),
      Default_Chapter_Extensions: chapterExtensions
        .split(",")
        .map((ext) => ext.trim().toUpperCase())
        .filter(Boolean),
      Default_Subtitle_Language: subtitleLanguage,
      Default_Audio_Language: audioLanguage,
      Default_Favorite_Subtitle_Languages: normalizeFavorites(
        subtitleLanguage,
        existing.Default_Favorite_Subtitle_Languages || [],
      ),
      Default_Favorite_Audio_Languages: normalizeFavorites(
        audioLanguage,
        existing.Default_Favorite_Audio_Languages || [],
      ),
    };
  };

  const directoryFields = [
    { label: "Videos Directory", value: videosDir, onChange: setVideosDir },
    { label: "Subtitles Directory", value: subtitlesDir, onChange: setSubtitlesDir },
    { label: "Audios Directory", value: audiosDir, onChange: setAudiosDir },
    { label: "Chapters Directory", value: chaptersDir, onChange: setChaptersDir },
    { label: "Attachments Directory", value: attachmentsDir, onChange: setAttachmentsDir },
    { label: "Destination Directory", value: destinationDir, onChange: setDestinationDir },
  ];
  const prereqLinks = [
    {
      name: "Node.js 18 LTS (x64)",
      url: "https://nodejs.org/dist/v18.20.3/node-v18.20.3-x64.msi",
      note: "Required for frontend builds",
    },
    {
      name: "Rustup (x64)",
      url: "https://win.rustup.rs/x86_64",
      note: "Required for Tauri backend builds",
    },
    {
      name: "MSVC Build Tools",
      url: "https://aka.ms/vs/17/release/vs_BuildTools.exe",
      note: "C++ build tools + Windows SDK",
    },
    {
      name: "WebView2 Runtime",
      url: "https://go.microsoft.com/fwlink/p/?LinkId=2124703",
      note: "Required to run the app UI",
    },
    {
      name: "MKVToolNix (x64)",
      url: "https://mkvtoolnix.download/windows/releases/83.0/mkvtoolnix-64-bit-83.0-setup.exe",
      note: "Provides mkvmerge/mkvpropedit",
    },
    {
      name: "MediaInfo CLI (x64)",
      url: "https://mediaarea.net/download/binary/mediainfo/24.06/MediaInfo_CLI_24.06_Windows_x64.zip",
      note: "Provides mediainfo command",
    },
  ];

  const copyToClipboard = async (text: string) => {
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
        return;
      }
    } catch {
      // Fallback below.
    }
    const textarea = document.createElement("textarea");
    textarea.value = text;
    textarea.setAttribute("readonly", "true");
    textarea.style.position = "absolute";
    textarea.style.left = "-9999px";
    document.body.appendChild(textarea);
    textarea.select();
    document.execCommand("copy");
    textarea.remove();
  };

  const openAllPrereqs = async () => {
    for (const item of prereqLinks) {
      await openExternal(item.url);
    }
    await copyToClipboard(prereqLinks.map((item) => `${item.name}: ${item.url}`).join("\n"));
  };

  return (
    <BaseModal
      open={open}
      onOpenChange={onOpenChange}
      title="Options"
      subtitle="Configure application preferences"
      icon={<Settings className="w-5 h-5 text-primary" />}
      className="max-w-3xl"
      bodyClassName="p-0"
      footerRight={
        <>
          <Button variant="outline" className="h-9 px-4 text-sm text-muted-foreground hover:text-foreground" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            className="h-9 px-6 text-sm"
            onClick={() => {
              if (!options) {
                onOpenChange(false);
                return;
              }
              const updatedPresets = [...options.Presets];
              const target = updatedPresets[presetIndex];
              updatedPresets[presetIndex] = buildPreset(target);
              onSave({
                ...options,
                Presets: updatedPresets,
                FavoritePresetId: presetIndex,
                Choose_Preset_On_Startup: askForPreset,
                Dark_Mode: darkMode,
              });
              onOpenChange(false);
            }}
          >
            Save Changes
          </Button>
        </>
      }
    >
      <div className="p-3 space-y-4">
        <section className="fluent-surface--flat p-3 space-y-3">
          <div className="flex items-center justify-between">
            <div>
              <div className="flex items-center gap-2">
                <SlidersHorizontal className="w-4 h-4 text-muted-foreground" />
                <h3 className="text-[12px] font-semibold uppercase tracking-wider text-muted-foreground">Presets</h3>
              </div>
              <p className="text-xs text-muted-foreground mt-1">Manage presets and startup behavior.</p>
            </div>
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <Moon className="w-4 h-4" />
              Theme
              <Toggle checked={darkMode} onCheckedChange={setDarkMode} />
            </div>
          </div>
          <div className="flex items-center gap-3 flex-wrap">
            <Select
              value={String(presetIndex)}
              onValueChange={(value) => {
                const index = Number(value);
                setPresetIndex(index);
                if (options?.Presets?.[index]) {
                  hydrateFromPreset(options.Presets[index]);
                }
              }}
            >
              <DropdownTrigger className="w-40">
                <SelectValue />
              </DropdownTrigger>
              <DropdownContent>
                {(options?.Presets || []).map((presetOption, index) => (
                  <SelectItem key={presetOption.Preset_Name + index} value={String(index)}>
                    {presetOption.Preset_Name}
                  </SelectItem>
                ))}
              </DropdownContent>
            </Select>

            <Button
              variant="ghost"
              size="sm"
              className="text-muted-foreground hover:text-foreground"
              onClick={() => {
                if (!options) return;
                const updatedPresets = [...options.Presets];
                const target = updatedPresets[presetIndex];
                updatedPresets[presetIndex] = buildPreset(target);
                onSave({
                  ...options,
                  Presets: updatedPresets,
                  Choose_Preset_On_Startup: askForPreset,
                  Dark_Mode: darkMode,
                });
              }}
            >
              Save
            </Button>
            <Button
              variant="ghost"
              size="sm"
              className="text-muted-foreground hover:text-foreground"
              onClick={() => {
                if (!options) return;
                onSave({
                  ...options,
                  FavoritePresetId: presetIndex,
                  Choose_Preset_On_Startup: askForPreset,
                  Dark_Mode: darkMode,
                });
              }}
            >
              Set Default
            </Button>
            <Button
              variant="ghost"
              size="sm"
              className="gap-1.5 text-muted-foreground hover:text-foreground"
              onClick={() => {
                if (!options) return;
                const preset = options.Presets[presetIndex];
                if (preset) {
                  hydrateFromPreset(preset);
                }
              }}
            >
              <RotateCcw className="w-3 h-3" />
              Reset
            </Button>

            <div className="flex-1" />

            <div className="flex items-center gap-2">
              <CheckboxField
                id="ask-preset"
                checked={askForPreset}
                onCheckedChange={(checked) => setAskForPreset(checked as boolean)}
                className="h-3.5 w-7"
              />
              <label htmlFor="ask-preset" className="text-xs text-muted-foreground cursor-pointer">
                Ask on startup
              </label>
            </div>
          </div>
        </section>

        <section className="space-y-3">
          <div className="flex items-center gap-2">
            <Folder className="w-4 h-4 text-muted-foreground" />
            <h3 className="text-[12px] font-semibold uppercase tracking-wider text-muted-foreground">Default Directories</h3>
          </div>
          <div className="rounded-lg border border-panel-border/25 bg-card p-3 space-y-3">
            <div className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Input Directories</div>
            <div className="space-y-2">
              {directoryFields.slice(0, 5).map((item) => (
                <div key={item.label} className="flex items-center gap-3 group">
                  <span className="text-xs text-muted-foreground w-36 text-right shrink-0">{item.label}</span>
                  <div className="flex-1 flex items-center gap-1">
                    <TextField
                      value={item.value}
                      onChange={(e) => item.onChange(e.target.value)}
                      placeholder="Select directory..."
                      className="flex-1"
                    />
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-9 w-9 shrink-0 opacity-70 hover:opacity-100 hover:text-warning"
                      title="Browse"
                      onClick={async () => {
                        const folder = await pickDirectory();
                        if (folder) {
                          item.onChange(folder);
                        }
                      }}
                    >
                      <FolderOpen className="w-4 h-4" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-9 w-9 shrink-0 opacity-50 hover:opacity-100 hover:text-destructive"
                      title="Clear"
                      onClick={() => item.onChange("")}
                    >
                      <X className="w-3.5 h-3.5" />
                    </Button>
                  </div>
                </div>
              ))}
            </div>
            <div className="pt-1 border-t border-panel-border/30">
              <div className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Output Directory</div>
            </div>
            <div className="space-y-2">
              {directoryFields.slice(5).map((item) => (
                <div key={item.label} className="flex items-center gap-3 group">
                  <span className="text-xs text-muted-foreground w-36 text-right shrink-0">{item.label}</span>
                  <div className="flex-1 flex items-center gap-1">
                    <TextField
                      value={item.value}
                      onChange={(e) => item.onChange(e.target.value)}
                      placeholder="Select directory..."
                      className="flex-1"
                    />
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-9 w-9 shrink-0 opacity-70 hover:opacity-100 hover:text-warning"
                      title="Browse"
                      onClick={async () => {
                        const folder = await pickDirectory();
                        if (folder) {
                          item.onChange(folder);
                        }
                      }}
                    >
                      <FolderOpen className="w-4 h-4" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-9 w-9 shrink-0 opacity-50 hover:opacity-100 hover:text-destructive"
                      title="Clear"
                      onClick={() => item.onChange("")}
                    >
                      <X className="w-3.5 h-3.5" />
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </section>

        <section className="space-y-2">
          <div className="flex items-center gap-2">
            <FileType2 className="w-4 h-4 text-muted-foreground" />
            <h3 className="text-[12px] font-semibold uppercase tracking-wider text-muted-foreground">File Extensions</h3>
            <span className="text-[11px] text-muted-foreground/70">(Advanced)</span>
          </div>
          <p className="text-[11px] text-muted-foreground/70">Used when scanning folders.</p>
          <div className="rounded-lg border border-panel-border/20 bg-panel/40 p-3">
            <div className="grid grid-cols-2 gap-x-6 gap-y-2 text-[12px]">
            {[
              { label: "Video", value: videoExtensions, onChange: setVideoExtensions, options: ["mkv,avi,mp4,m4v,mov", "mkv,mp4", "mkv"] },
              { label: "Subtitle", value: subtitleExtensions, onChange: setSubtitleExtensions, options: ["ass,srt,ssa,sup,pgs", "ass,srt", "srt"] },
              { label: "Audio", value: audioExtensions, onChange: setAudioExtensions, options: ["aac,ac3,flac,eac3,mka", "aac,ac3", "flac"] },
              { label: "Chapter", value: chapterExtensions, onChange: setChapterExtensions, options: ["xml", "txt", "ogm"] },
            ].map((item) => (
              <div key={item.label} className="flex items-center gap-3">
                <span className="text-xs text-muted-foreground w-16 text-right shrink-0">{item.label}</span>
                <Select value={item.value} onValueChange={item.onChange}>
                  <DropdownTrigger className="flex-1">
                    <SelectValue />
                  </DropdownTrigger>
                  <DropdownContent>
                    {item.options.map((opt) => (
                      <SelectItem key={opt} value={opt}>
                        {opt.toUpperCase().split(",").join(", ")}
                      </SelectItem>
                    ))}
                  </DropdownContent>
                </Select>
              </div>
            ))}
          </div>
          </div>
        </section>

        <section className="space-y-2">
          <div className="flex items-center gap-2">
            <Languages className="w-4 h-4 text-muted-foreground" />
            <h3 className="text-[12px] font-semibold uppercase tracking-wider text-muted-foreground">Favorite Languages</h3>
          </div>
          <p className="text-[11px] text-muted-foreground/70">Used as default when adding new tracks.</p>
          <div className="flex items-center gap-6">
            <div className="flex items-center gap-2">
              <span className="text-xs text-muted-foreground">Subtitle:</span>
              <LanguageSelect value={subtitleLanguage} onChange={setSubtitleLanguage} className="w-40 h-9" />
            </div>

            <div className="flex items-center gap-2">
              <span className="text-xs text-muted-foreground">Audio:</span>
              <LanguageSelect value={audioLanguage} onChange={setAudioLanguage} className="w-40 h-9" />
            </div>
          </div>
        </section>

        <section className="space-y-2">
          <div className="flex items-center justify-between mb-1">
            <div>
              <div className="flex items-center gap-2">
                <Plug className="w-4 h-4 text-muted-foreground" />
                <h3 className="text-[12px] font-semibold uppercase tracking-wider text-muted-foreground">Windows Prerequisites</h3>
              </div>
              <p className="text-xs text-muted-foreground/70 mt-1">
                Install these once so the app runs without extra setup.
              </p>
            </div>
            <Button variant="secondary" size="sm" className="gap-1.5" onClick={openAllPrereqs}>
              <Download className="w-3.5 h-3.5" />
              Download All
            </Button>
          </div>
          <div className="space-y-2">
            {prereqLinks.map((item) => (
              <div
                key={item.name}
                className="flex items-center justify-between gap-3 rounded-md border border-panel-border bg-panel px-3 py-2"
              >
                <div className="min-w-0">
                  <div className="text-sm font-medium text-foreground truncate">{item.name}</div>
                  <div className="text-xs text-muted-foreground/80 truncate">{item.note}</div>
                </div>
                <div className="flex items-center gap-1">
                  <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => openExternal(item.url)}>
                    <Download className="w-4 h-4" />
                  </Button>
                  <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => copyToClipboard(item.url)}>
                    <Copy className="w-4 h-4" />
                  </Button>
                </div>
              </div>
            ))}
          </div>
        </section>

        <div className="flex items-center justify-between pt-2">
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <Info className="w-3.5 h-3.5 text-primary" />
            Changes take effect on next launch • Ionicboy
          </div>
          <div className="flex items-center gap-2">
            <Button
              variant="ghost"
              size="sm"
              className="h-8 text-xs gap-1.5 text-muted-foreground hover:text-foreground"
              onClick={() => openExternal("https://github.com/AdkHex/MkvBatchMux")}
            >
              <Info className="w-3.5 h-3.5 text-primary" />
              About Ionicboy
            </Button>
          </div>
        </div>
      </div>
    </BaseModal>
  );
}
