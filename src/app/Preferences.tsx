/** Preferences: its own window with icon tabs (General, Presets, Measurement,
 *  Tools, Updates), as in the approved mockup. It edits the options file the
 *  old Options dialog did, with the same rules: Save writes everything and
 *  closes; on Presets, Save preset / Set as default / Revert act at once, as
 *  the old dialog's Save / Set Default / Reset did. */

import {
  ArrowDownloadRegular,
  ArrowSyncRegular,
  DismissRegular,
  FolderListRegular,
  FolderOpenRegular,
  GaugeRegular,
  SettingsRegular,
  WrenchRegular,
} from "@fluentui/react-icons";
import { useCallback, useEffect, useState, type ReactNode } from "react";

import { installDependency, pickDirectory, type DependencyStatus } from "@/shared/lib/backend";
import type { MeasurementSettings, OptionsData } from "@/shared/types";
import { ENGINE_DEFAULTS, ENGINE_LIMITS } from "@/shared/types/audiosync";
import { Modal } from "@/ui/frame";
import { Btn, Cmd, Combo, InfoBar, LangCombo, Seg, Slider, TBox, Toggle, cx } from "@/ui/kit";
import { toast } from "@/ui/toast";

import {
  FILE_TYPE_CHOICES,
  clampMaxOffsetSeconds,
  clampMeasurement,
  clampWindowCount,
  clampWindowSeconds,
  differsFromEngine,
  fileTypeLabel,
  formFromPreset,
  presetFromForm,
  type PresetForm,
} from "./preferenceRules";

export type PrefsTab = "general" | "presets" | "measure" | "tools" | "updates";

export interface PreferencesProps {
  tab: PrefsTab;
  onTab: (tab: PrefsTab) => void;
  options: OptionsData | null;
  /** Save the whole options file and apply it. */
  onSave: (options: OptionsData) => void;
  /** Show a theme while it is being chosen; Cancel puts the saved one back. */
  onPreviewTheme: (dark: boolean) => void;
  onClose: () => void;
  version: string;
  /** MKVToolNix, MediaInfo, FFmpeg and the engine; null while checking. */
  tools: DependencyStatus[] | null;
  onRefreshTools: () => void;
  update: { version: string; notes: string } | null;
  onUpdateFound: (update: { version: string; notes: string } | null) => void;
  onInstallUpdate: () => void;
  /** A batch is muxing: installing an update would restart the app under it. */
  busy: boolean;
}

const TABS: { id: PrefsTab; label: string; icon: ReactNode }[] = [
  { id: "general", label: "General", icon: <SettingsRegular /> },
  { id: "presets", label: "Presets", icon: <FolderListRegular /> },
  { id: "measure", label: "Measurement", icon: <GaugeRegular /> },
  { id: "tools", label: "Tools", icon: <WrenchRegular /> },
  { id: "updates", label: "Updates", icon: <ArrowSyncRegular /> },
];

const openLink = (url: string) => void import("@tauri-apps/api/shell").then(({ open }) => open(url)).catch(() => undefined);

const Row = ({ h, d, children }: { h: ReactNode; d?: ReactNode; children?: ReactNode }) => (
  <div className="srow">
    <div className="tx">
      <div>{h}</div>
      {d && <div className="d">{d}</div>}
    </div>
    {children}
  </div>
);

const SliderCtl = ({ value, min, max, step, display, label, onChange }: { value: number; min: number; max: number; step: number; display: string; label: string; onChange: (value: number) => void }) => (
  <div className="row" style={{ gap: 12, width: 240 }}>
    <Slider value={value} min={min} max={max} step={step} onChange={onChange} label={label} />
    <span className="num" style={{ width: 40, textAlign: "right" }}>{display}</span>
  </div>
);

function Folder({ label, value, onChange }: { label: string; value: string; onChange: (value: string) => void }) {
  return (
    <span className="row" style={{ gap: 2 }}>
      <TBox label={`${label} folder`} value={value} placeholder="Not set" w={260} mono onChange={onChange} />
      <Cmd
        icon={<FolderOpenRegular />}
        title="Choose folder"
        onClick={async () => {
          const folder = await pickDirectory();
          if (folder) onChange(folder);
        }}
      />
      <Cmd icon={<DismissRegular />} title="Clear" disabled={!value} onClick={() => onChange("")} />
    </span>
  );
}

type UpdateState =
  | { status: "idle" }
  | { status: "checking" }
  | { status: "current" }
  | { status: "error"; message: string };

export function PreferencesWindow(props: PreferencesProps) {
  const { tab, onTab, options, onSave, onPreviewTheme, onClose } = props;
  const [presetIndex, setPresetIndex] = useState(0);
  const [askForPreset, setAskForPreset] = useState(false);
  const [darkMode, setDarkMode] = useState(true);
  const [form, setForm] = useState<PresetForm | null>(null);
  const [measurement, setMeasurement] = useState<MeasurementSettings>({ ...ENGINE_DEFAULTS });

  // Everything re-reads from the saved options when they change, as the old
  // dialog did: after Save preset the fields show what was saved.
  useEffect(() => {
    if (!options) return;
    const index = options.FavoritePresetId ?? 0;
    setPresetIndex(index);
    setAskForPreset(Boolean(options.Choose_Preset_On_Startup));
    setDarkMode(Boolean(options.Dark_Mode));
    setMeasurement({ ...ENGINE_DEFAULTS, ...options.Measurement });
    setForm(formFromPreset(options.Presets[index] || options.Presets[0]));
  }, [options]);

  const setField = (updates: Partial<PresetForm>) => setForm((prev) => (prev ? { ...prev, ...updates } : prev));

  const saveAll = () => {
    if (!options || !form) {
      onClose();
      return;
    }
    const presets = [...options.Presets];
    presets[presetIndex] = presetFromForm(presets[presetIndex], form);
    onSave({
      ...options,
      Presets: presets,
      FavoritePresetId: presetIndex,
      Choose_Preset_On_Startup: askForPreset,
      Dark_Mode: darkMode,
      Measurement: clampMeasurement(measurement),
    });
    onClose();
  };

  return (
    <Modal onClose={onClose}>
      <div className="prefs" role="dialog" aria-modal="true" aria-label="Preferences">
        <div className="pt">
          Preferences
          <button type="button" className="cap x" style={{ marginLeft: "auto" }} aria-label="Close" onClick={onClose}>
            <svg width="10" height="10" aria-hidden><path d="M.5.5l9 9M9.5.5l-9 9" stroke="currentColor" /></svg>
          </button>
        </div>
        <div className="ptabs" role="tablist">
          {TABS.map((t) => (
            <button key={t.id} type="button" role="tab" aria-selected={t.id === tab} className={cx("ptab", t.id === tab && "on")} onClick={() => onTab(t.id)}>
              <span className="ic" aria-hidden>{t.icon}</span>
              {t.label}
            </button>
          ))}
        </div>
        <div className="pbody" role="tabpanel" aria-label={TABS.find((t) => t.id === tab)?.label}>
          {tab === "general" && (
            <>
              <div className="group-h">Appearance</div>
              <div className="group">
                <Row h="Theme">
                  <Seg<"dark" | "light">
                    label="Theme"
                    items={[
                      { value: "dark", label: "Dark" },
                      { value: "light", label: "Light" },
                    ]}
                    value={darkMode ? "dark" : "light"}
                    onChange={(value) => {
                      setDarkMode(value === "dark");
                      onPreviewTheme(value === "dark");
                    }}
                  />
                </Row>
              </div>
              <div className="group-h">Startup</div>
              <div className="group">
                <Row h="Ask which preset to use"><Toggle name="Ask which preset to use" on={askForPreset} onChange={setAskForPreset} /></Row>
              </div>
              <div className="group-h">About</div>
              <div className="group">
                <Row h={`MKVBatchMux ${props.version}`} d="By Ionicboy (AdkHex)">
                  <Btn onClick={() => openLink("https://github.com/AdkHex/MkvBatchMux")}>Project page</Btn>
                </Row>
              </div>
            </>
          )}
          {tab === "presets" && (
            <PresetsTab
              options={options}
              presetIndex={presetIndex}
              onPresetIndex={(index) => {
                setPresetIndex(index);
                if (options?.Presets[index]) setForm(formFromPreset(options.Presets[index]));
              }}
              form={form}
              setField={setField}
              onSavePreset={() => {
                if (!options || !form) return;
                const presets = [...options.Presets];
                presets[presetIndex] = presetFromForm(presets[presetIndex], form);
                onSave({ ...options, Presets: presets, Choose_Preset_On_Startup: askForPreset, Dark_Mode: darkMode });
                toast({ title: "Preset saved" });
              }}
              onSetDefault={() => {
                if (!options) return;
                onSave({ ...options, FavoritePresetId: presetIndex, Choose_Preset_On_Startup: askForPreset, Dark_Mode: darkMode });
                toast({ title: `${options.Presets[presetIndex]?.Preset_Name ?? "Preset"} is the default` });
              }}
              onRevert={() => {
                const preset = options?.Presets[presetIndex];
                if (preset) setForm(formFromPreset(preset));
              }}
            />
          )}
          {tab === "measure" && <MeasurementTab measurement={measurement} onChange={setMeasurement} />}
          {tab === "tools" && <ToolsTab tools={props.tools} onRefresh={props.onRefreshTools} />}
          {tab === "updates" && <UpdatesTab {...props} />}
        </div>
        <div className="pfoot">
          {tab === "measure" && <Btn onClick={() => setMeasurement({ ...ENGINE_DEFAULTS, fullTimeline: measurement.fullTimeline })}>Reset to AudioSyncMaster's</Btn>}
          <span style={{ flex: 1 }} />
          <Btn style={{ minWidth: 96 }} onClick={onClose}>Cancel</Btn>
          <Btn accent style={{ minWidth: 96 }} onClick={saveAll}>Save</Btn>
        </div>
      </div>
    </Modal>
  );
}

function PresetsTab({
  options,
  presetIndex,
  onPresetIndex,
  form,
  setField,
  onSavePreset,
  onSetDefault,
  onRevert,
}: {
  options: OptionsData | null;
  presetIndex: number;
  onPresetIndex: (index: number) => void;
  form: PresetForm | null;
  setField: (updates: Partial<PresetForm>) => void;
  onSavePreset: () => void;
  onSetDefault: () => void;
  onRevert: () => void;
}) {
  if (!form) return <div className="group-h t3">Reading the options…</div>;
  const folders: [string, keyof PresetForm][] = [
    ["Videos", "videosDir"],
    ["Subtitles", "subtitlesDir"],
    ["Audio", "audiosDir"],
    ["Chapters", "chaptersDir"],
    ["Attachments", "attachmentsDir"],
    ["Output", "destinationDir"],
  ];
  const types: [string, keyof PresetForm, readonly string[]][] = [
    ["Video", "videoExtensions", FILE_TYPE_CHOICES.video],
    ["Subtitle", "subtitleExtensions", FILE_TYPE_CHOICES.subtitle],
    ["Audio", "audioExtensions", FILE_TYPE_CHOICES.audio],
    ["Chapter", "chapterExtensions", FILE_TYPE_CHOICES.chapter],
  ];
  return (
    <>
      <div className="group-h">Preset</div>
      <div className="group">
        <Row h="Preset in use" d="Folders, file types and languages the pages start with.">
          <Combo<number> label="Preset" w={160} value={presetIndex} options={(options?.Presets ?? []).map((preset, index) => ({ value: index, label: preset.Preset_Name }))} onChange={onPresetIndex} />
        </Row>
        <div className="srow" style={{ minHeight: 48, justifyContent: "flex-end", gap: 8 }}>
          <Btn onClick={onRevert}>Revert</Btn>
          <Btn onClick={onSetDefault}>Set as default</Btn>
          <Btn onClick={onSavePreset}>Save preset</Btn>
        </div>
      </div>
      <div className="group-h">Folders</div>
      <div className="group">
        {folders.map(([label, key]) => (
          <Row key={key} h={label}>
            <Folder label={label} value={form[key]} onChange={(value) => setField({ [key]: value })} />
          </Row>
        ))}
      </div>
      <div className="group-h">File types</div>
      <div className="group">
        {types.map(([label, key, choices]) => (
          <Row key={key} h={label}>
            <Combo<string>
              label={`${label} file types`}
              w={220}
              value={choices.includes(form[key]) ? form[key] : null}
              placeholder={fileTypeLabel(form[key]) || "Choose"}
              options={choices.map((choice) => ({ value: choice, label: fileTypeLabel(choice) }))}
              onChange={(value) => setField({ [key]: value })}
            />
          </Row>
        ))}
      </div>
      <div className="group-h">Languages</div>
      <div className="group">
        <Row h="New subtitle tracks"><LangCombo label="Language of new subtitle tracks" w={220} value={form.subtitleLanguage} onChange={(subtitleLanguage) => setField({ subtitleLanguage })} /></Row>
        <Row h="New audio tracks"><LangCombo label="Language of new audio tracks" w={220} value={form.audioLanguage} onChange={(audioLanguage) => setField({ audioLanguage })} /></Row>
      </div>
    </>
  );
}

function MeasurementTab({ measurement, onChange }: { measurement: MeasurementSettings; onChange: (m: MeasurementSettings) => void }) {
  const set = (patch: Partial<MeasurementSettings>) => onChange({ ...measurement, ...patch });
  return (
    <>
      <div className="group-h">Measuring</div>
      <div className="group">
        <Row h="Sample windows" d="The same settings as AudioSyncMaster give the same delays.">
          <SliderCtl label="Sample windows" value={measurement.windowCount} min={ENGINE_LIMITS.windowCount.min} max={ENGINE_LIMITS.windowCount.max} step={1} display={String(measurement.windowCount)} onChange={(v) => set({ windowCount: clampWindowCount(v) })} />
        </Row>
        <Row h="Window length">
          <SliderCtl label="Window length" value={measurement.windowSeconds} min={ENGINE_LIMITS.windowSeconds.min} max={ENGINE_LIMITS.windowSeconds.max} step={5} display={`${measurement.windowSeconds} s`} onChange={(v) => set({ windowSeconds: clampWindowSeconds(v) })} />
        </Row>
        <Row h="Largest offset">
          <SliderCtl
            label="Largest offset"
            value={Math.round(measurement.maxOffsetMs / 1000)}
            min={ENGINE_LIMITS.maxOffsetSeconds.min}
            max={ENGINE_LIMITS.maxOffsetSeconds.max}
            step={5}
            display={`${Math.round(measurement.maxOffsetMs / 1000)} s`}
            onChange={(v) => set({ maxOffsetMs: clampMaxOffsetSeconds(v) * 1000 })}
          />
        </Row>
      </div>
      {differsFromEngine(measurement) && (
        <InfoBar tone="warn" style={{ margin: "12px 0 0" }}>
          AudioSyncMaster measures with {ENGINE_DEFAULTS.windowCount} × {ENGINE_DEFAULTS.windowSeconds} s windows and a {ENGINE_DEFAULTS.maxOffsetMs / 1000} s largest offset. The two apps agree only with the same values.
        </InfoBar>
      )}
      <div className="group-h">Checks</div>
      <div className="group">
        <Row h="Whole-timeline scan" d="Finds every cut and frame-rate change. Reads both files end to end: minutes per film.">
          <Toggle name="Whole-timeline scan" on={measurement.fullTimeline ?? false} onChange={(fullTimeline) => set({ fullTimeline })} />
        </Row>
      </div>
    </>
  );
}

function ToolsTab({ tools, onRefresh }: { tools: DependencyStatus[] | null; onRefresh: () => void }) {
  const [installingId, setInstallingId] = useState<string | null>(null);
  // Checked again on every open: the user may have installed something since,
  // and a stale "Required" is worse than none.
  useEffect(() => {
    onRefresh();
  }, [onRefresh]);

  const install = useCallback(
    async (item: DependencyStatus) => {
      setInstallingId(item.id);
      try {
        const message = await installDependency(item.id);
        toast({ title: item.name, description: message });
        onRefresh();
      } catch (error) {
        // Offer the download page as a fallback rather than leaving the user
        // stuck: the failure is usually a blocked network or declined UAC.
        toast({ title: `Could not install ${item.name}`, description: String(error), variant: "destructive" });
        openLink(item.downloadUrl);
      } finally {
        setInstallingId(null);
      }
    },
    [onRefresh],
  );

  return (
    <>
      <div className="group-h" style={{ display: "flex", alignItems: "center" }}>
        <span className="grow">Tools</span>
        <Cmd sm icon={<ArrowSyncRegular />} disabled={tools === null} onClick={onRefresh}>Check again</Cmd>
      </div>
      <div className="group">
        {tools === null ? (
          <Row h="Checking…" />
        ) : tools.length === 0 ? (
          <Row h="Could not read which tools are installed." />
        ) : (
          tools.map((item) => {
            const word = item.bundled ? "Included" : item.available ? "Installed" : item.required ? "Required" : "Optional";
            const tone = !item.available && !item.bundled ? (item.required ? "bad" : "warn") : "t3";
            const detail = item.available ? [item.version, item.path].filter(Boolean).join(" · ") || item.purpose : item.purpose;
            return (
              <Row key={item.id} h={item.name} d={<span title={item.path ?? undefined}>{detail}</span>}>
                <span className={tone} style={{ marginRight: !item.available && !item.bundled ? 8 : 0 }}>{word}</span>
                {!item.available && !item.bundled && (
                  <Btn icon={<ArrowDownloadRegular />} disabled={installingId !== null} onClick={() => void install(item)}>
                    {installingId === item.id ? "Installing…" : "Install"}
                  </Btn>
                )}
              </Row>
            );
          })
        )}
      </div>
    </>
  );
}

function UpdatesTab({ version, update, onUpdateFound, onInstallUpdate, busy }: PreferencesProps) {
  const [state, setState] = useState<UpdateState>({ status: "idle" });
  const check = useCallback(async () => {
    setState({ status: "checking" });
    try {
      const { checkUpdate } = await import("@tauri-apps/api/updater");
      const result = await checkUpdate();
      if (result.shouldUpdate) {
        onUpdateFound({ version: result.manifest?.version ?? "", notes: result.manifest?.body ?? "" });
        setState({ status: "idle" });
      } else {
        setState({ status: "current" });
      }
    } catch (error) {
      setState({ status: "error", message: String(error) });
    }
  }, [onUpdateFound]);

  const line =
    state.status === "checking"
      ? "Checking for updates…"
      : state.status === "current"
        ? "You're on the latest version."
        : state.status === "error"
          ? <span className="bad">{state.message}</span>
          : "Checks on launch and every six hours, never during a mux.";

  return (
    <>
      <div className="group-h">Updates</div>
      <div className="group">
        {update && (
          <Row h={`Version ${update.version} is ready`} d={busy ? "Installing restarts the app. Finish or stop the batch first." : "Installing restarts the app. Your queue and settings are kept."}>
            <Btn accent icon={<ArrowDownloadRegular />} disabled={busy} onClick={onInstallUpdate}>Install and restart</Btn>
          </Row>
        )}
        <Row h={`MKVBatchMux ${version}`} d={line}>
          <Btn disabled={state.status === "checking"} onClick={() => void check()}>Check now</Btn>
        </Row>
      </div>
      {update?.notes && (
        <>
          <div className="group-h">What's new in {update.version}</div>
          <div className="group">
            <div className="srow" style={{ whiteSpace: "pre-wrap", color: "var(--text-2)" }}>{update.notes}</div>
          </div>
        </>
      )}
    </>
  );
}
