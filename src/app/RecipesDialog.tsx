/** File › Recipes: per-show recipes, listed on the left and edited on the
 *  right. A recipe is made from scratch or from the workspace as it is now
 *  (its slots, output name, folder and mux options), saved to the app data
 *  folder, and applied with Apply… (which shows every change first). */

import { AddRegular, ArrowDownRegular, ArrowUpRegular, DeleteRegular } from "@fluentui/react-icons";
import { useEffect, useMemo, useState, type ReactNode } from "react";

import {
  DEFAULT_MEASUREMENT_POLICY,
  DEFAULT_SLOT,
  createRecipe,
  createRule,
  resolveOutputNames,
  showNameFrom,
  slotsFromTabState,
  usesEpisodeTokens,
  validateRecipe,
} from "@/features/workspace/lib/recipes";
import type { MuxSettings, OutputSettings, VideoFile } from "@/shared/types";
import type { MeasurementPolicy, Recipe, RecipeMuxOptions, SlotTemplate, TrackRule, TrackRuleAction } from "@/shared/types/recipes";
import { Dialog } from "@/ui/frame";
import { Btn, Chk, Cmd, Combo, InfoBar, LangCombo, TBox, Toggle, cx, type Option } from "@/ui/kit";
import { toast } from "@/ui/toast";

import { FolderField, SetRow, listText, textList } from "./fields";
import type { RecipesState } from "./useRecipes";

export interface RecipeSource {
  videoFiles: VideoFile[];
  audioTracks: string[];
  audioTrackConfigs: Record<string, SlotTemplate>;
  subtitleTracks: string[];
  subtitleTrackConfigs: Record<string, SlotTemplate>;
  muxSettings: MuxSettings;
  outputSettings: OutputSettings;
}

/** The mux options a recipe can set from this dialog; the rest come along when made from the workspace. */
const MUX_TOGGLES: [keyof RecipeMuxOptions, string][] = [
  ["removeGlobalTags", "Remove global tags"],
  ["discardOldChapters", "Remove the source's chapters"],
  ["discardOldAttachments", "Remove the source's attachments"],
  ["addCrc", "Add a CRC to each name"],
  ["verifyOutput", "Verify each output"],
  ["verifySync", "Check the sync of added audio"],
  ["abortOnErrors", "Stop the batch on an error"],
];

/** The workspace's mux options as a recipe keeps them: the output folder and name are its own fields. */
export function muxOptionsOf(settings: MuxSettings): RecipeMuxOptions {
  const { destinationDir: _d, outputNamingPattern: _n, overwriteSource: _o, ...rest } = settings;
  void _d;
  void _n;
  void _o;
  return rest;
}

/** A recipe from the workspace as it is: its slots, output name and folder, mux options. */
export function recipeFromWorkspace(name: string, source: RecipeSource): Recipe {
  const recipe = createRecipe(name);
  const firstVideo = source.videoFiles[0];
  const hasFolder = (slot: SlotTemplate) => Boolean(slot.sourceFolder.trim());
  const audio = slotsFromTabState(source.audioTracks, source.audioTrackConfigs);
  const subtitles = slotsFromTabState(source.subtitleTracks, source.subtitleTrackConfigs);
  return {
    ...recipe,
    show: firstVideo ? showNameFrom(firstVideo.path || firstVideo.name) || undefined : undefined,
    audioSlots: audio.some(hasFolder) || audio.length > 1 ? audio : [],
    subtitleSlots: subtitles.some(hasFolder) || subtitles.length > 1 ? subtitles : [],
    namingPattern: source.outputSettings.namingPattern,
    destination: source.outputSettings.directory,
    overwriteExisting: source.outputSettings.overwriteExisting,
    muxOptions: muxOptionsOf(source.muxSettings),
  };
}

const TYPE_OPTIONS: Option<string>[] = [
  { value: "", label: "Any track" },
  { value: "video", label: "Video" },
  { value: "audio", label: "Audio" },
  { value: "subtitle", label: "Subtitles" },
];
const KEEP_OPTIONS: Option<string>[] = [
  { value: "", label: "Leave it" },
  { value: "keep", label: "Keep it" },
  { value: "remove", label: "Remove it" },
];
const FLAG_OPTIONS = (word: string): Option<string>[] => [
  { value: "", label: `${word}: leave` },
  { value: "on", label: `${word}: yes` },
  { value: "off", label: `${word}: no` },
];

const flagValue = (value: boolean | undefined) => (value === undefined ? "" : value ? "on" : "off");
const flagFrom = (value: string) => (value === "" ? undefined : value === "on");

function without<T extends object>(object: T, key: keyof T): T {
  const next = { ...object };
  delete next[key];
  return next;
}

const Section = ({ title, end, children }: { title: string; end?: ReactNode; children: ReactNode }) => (
  <>
    <div className="group-h row" style={{ gap: 8 }}>
      <span className="grow">{title}</span>
      {end}
    </div>
    <div className="group">{children}</div>
  </>
);

function RuleEditor({ rule, index, count, onChange, onRemove, onMove }: { rule: TrackRule; index: number; count: number; onChange: (rule: TrackRule) => void; onRemove: () => void; onMove: (by: number) => void }) {
  const match = rule.match;
  const action = rule.action;
  const setMatch = (updates: Partial<TrackRule["match"]>) => {
    let next = { ...match, ...updates };
    for (const key of Object.keys(updates) as (keyof TrackRule["match"])[]) {
      const value = next[key];
      if (value === undefined || value === "" || (Array.isArray(value) && value.length === 0)) next = without(next, key);
    }
    onChange({ ...rule, match: next });
  };
  const setAction = (updates: Partial<TrackRuleAction>) => {
    let next = { ...action, ...updates };
    for (const key of Object.keys(updates) as (keyof TrackRuleAction)[]) if (next[key] === undefined) next = without(next, key);
    onChange({ ...rule, action: next });
  };
  return (
    <div className="srow" style={{ flexDirection: "column", alignItems: "stretch", gap: 8 }}>
      <div className="row" style={{ gap: 8 }}>
        <Chk on={rule.enabled !== false} name="Use this rule" onChange={(on) => onChange(on ? without(rule, "enabled") : { ...rule, enabled: false })} />
        <TBox label="Rule name" value={rule.label ?? ""} placeholder={`Rule ${index + 1}`} className="grow" onChange={(label) => onChange(label ? { ...rule, label } : without(rule, "label"))} />
        <Cmd icon={<ArrowUpRegular />} title="Move up" disabled={index === 0} onClick={() => onMove(-1)} />
        <Cmd icon={<ArrowDownRegular />} title="Move down" disabled={index === count - 1} onClick={() => onMove(1)} />
        <Cmd icon={<DeleteRegular />} title="Delete the rule" onClick={onRemove} />
      </div>
      <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
        <span className="t3" style={{ width: 40 }}>When</span>
        <Combo label="Track type" value={match.type ?? ""} options={TYPE_OPTIONS} w={120} onChange={(type) => setMatch({ type: (type || undefined) as TrackRule["match"]["type"] })} />
        <TBox label="Languages" value={listText(match.languages)} placeholder="language is (hin, eng)" w={160} onChange={(text) => setMatch({ languages: textList(text) })} />
        <TBox label="Not languages" value={listText(match.excludeLanguages)} placeholder="language isn't" w={130} onChange={(text) => setMatch({ excludeLanguages: textList(text) })} />
        <TBox label="Codec pattern" value={match.codecRegex ?? ""} placeholder="codec (E-AC-3)" w={130} mono onChange={(codecRegex) => setMatch({ codecRegex })} />
        <TBox label="Name pattern" value={match.nameRegex ?? ""} placeholder="name (commentary)" w={150} mono onChange={(nameRegex) => setMatch({ nameRegex })} />
      </div>
      <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
        <span className="t3" style={{ width: 40 }}>Then</span>
        <Combo label="Keep or remove" value={action.keep === undefined ? "" : action.keep ? "keep" : "remove"} options={KEEP_OPTIONS} w={120} onChange={(value) => setAction({ keep: value === "" ? undefined : value === "keep" })} />
        <Combo label="Default" value={flagValue(action.setDefault)} options={FLAG_OPTIONS("Default")} w={130} onChange={(value) => setAction({ setDefault: flagFrom(value) })} />
        <Combo label="Forced" value={flagValue(action.setForced)} options={FLAG_OPTIONS("Forced")} w={130} onChange={(value) => setAction({ setForced: flagFrom(value) })} />
        <TBox label="Rename to" value={action.rename ?? ""} placeholder="rename ({name} {language} {codec} {channels})" w={250} onChange={(rename) => setAction({ rename: rename === "" ? undefined : rename })} />
        <TBox label="Set language" value={action.setLanguage ?? ""} placeholder="set language" w={110} onChange={(setLanguage) => setAction({ setLanguage: setLanguage.trim() || undefined })} />
      </div>
    </div>
  );
}

function SlotEditor({ slot, label, onChange, onRemove }: { slot: SlotTemplate; label: string; onChange: (slot: SlotTemplate) => void; onRemove: () => void }) {
  return (
    <div className="srow" style={{ flexWrap: "wrap", gap: 8, minHeight: 48 }}>
      <span style={{ width: 84 }}>{label}</span>
      <FolderField label="Folder" value={slot.sourceFolder} w={220} placeholder="Folder its files are in" onChange={(sourceFolder) => onChange({ ...slot, sourceFolder })} />
      <LangCombo value={slot.language} sm w={130} label={`${label} language`} onChange={(language) => onChange({ ...slot, language })} />
      <TBox label={`${label} track name`} value={slot.trackName} placeholder="Track name" w={120} onChange={(trackName) => onChange({ ...slot, trackName })} />
      <TBox label={`${label} delay`} value={slot.delay} w={84} unit="s" mono onChange={(delay) => onChange({ ...slot, delay })} />
      <Chk on={slot.isDefault} onChange={(isDefault) => onChange({ ...slot, isDefault })}>Default</Chk>
      <Chk on={slot.isForced} onChange={(isForced) => onChange({ ...slot, isForced })}>Forced</Chk>
      <Cmd icon={<DeleteRegular />} title={`Remove ${label}`} onClick={onRemove} />
    </div>
  );
}

function RecipeEditor({ draft, onChange, source }: { draft: Recipe; onChange: (recipe: Recipe) => void; source: RecipeSource }) {
  const set = (updates: Partial<Recipe>) => onChange({ ...draft, ...updates });
  const setPolicy = (updates: Partial<MeasurementPolicy>) => set({ measurement: { ...draft.measurement, ...updates } });
  const rules = draft.trackRules;
  const setRules = (next: TrackRule[]) => set({ trackRules: next });
  const slotList = (kind: "audio" | "subtitle") => (kind === "audio" ? draft.audioSlots : draft.subtitleSlots);
  const setSlots = (kind: "audio" | "subtitle", next: SlotTemplate[]) => set(kind === "audio" ? { audioSlots: next } : { subtitleSlots: next });

  const pattern = draft.namingPattern ?? "";
  const preview = useMemo(() => {
    if (!usesEpisodeTokens(pattern) || source.videoFiles.length === 0) return null;
    return resolveOutputNames(source.videoFiles.slice(0, 200), pattern, { show: draft.show });
  }, [pattern, draft.show, source.videoFiles]);

  return (
    <div className="col" style={{ paddingBottom: 16 }}>
      <Section title="Recipe">
        <SetRow h="Name">
          <TBox label="Recipe name" value={draft.name} w={300} onChange={(name) => set({ name })} />
        </SetRow>
        <SetRow h="Show" d="For {show} in the output name. Empty: read from each file's name or folder.">
          <TBox label="Show name" value={draft.show ?? ""} w={300} placeholder="From the file names" onChange={(show) => set(show ? { show } : without(draft, "show"))} />
        </SetRow>
      </Section>

      <Section title="Track rules" end={<Btn icon={<AddRegular />} onClick={() => setRules([...rules, createRule({ match: {}, action: {} })])}>Add rule</Btn>}>
        {rules.length === 0 && <SetRow h={<span className="t3">No rules: every video keeps its tracks as they are.</span>} d='For example: name "commentary" → remove it; audio, language hin → default: yes.' />}
        {rules.map((rule, index) => (
          <RuleEditor
            key={rule.id}
            rule={rule}
            index={index}
            count={rules.length}
            onChange={(next) => setRules(rules.map((item) => (item.id === rule.id ? next : item)))}
            onRemove={() => setRules(rules.filter((item) => item.id !== rule.id))}
            onMove={(by) => {
              const next = [...rules];
              const [moved] = next.splice(index, 1);
              next.splice(index + by, 0, moved);
              setRules(next);
            }}
          />
        ))}
      </Section>

      {(["audio", "subtitle"] as const).map((kind) => {
        const list = slotList(kind);
        const word = kind === "audio" ? "Audio" : "Subtitles";
        return (
          <Section
            key={kind}
            title={`${word} slots`}
            end={
              <>
                <Btn onClick={() => setSlots(kind, slotsFromTabState(kind === "audio" ? source.audioTracks : source.subtitleTracks, kind === "audio" ? source.audioTrackConfigs : source.subtitleTrackConfigs))}>Use the workspace's</Btn>
                <Btn icon={<AddRegular />} onClick={() => setSlots(kind, [...list, { ...DEFAULT_SLOT, muxAfter: kind === "audio" ? "video" : "audio", isDefault: list.length === 0 }])}>Add slot</Btn>
              </>
            }
          >
            {list.length === 0 && <SetRow h={<span className="t3">None: the {word.toLowerCase()} slots stay as they are.</span>} />}
            {list.map((slot, index) => (
              <SlotEditor
                key={index}
                slot={slot}
                label={`${word} ${index + 1}`}
                onChange={(next) => setSlots(kind, list.map((item, at) => (at === index ? next : item)))}
                onRemove={() => setSlots(kind, list.filter((_, at) => at !== index))}
              />
            ))}
          </Section>
        );
      })}

      <Section title="Output">
        <SetRow h="Output name" d="{show} {season} {episode} {original_filename}. Empty: keep the workspace's.">
          <TBox label="Output name pattern" value={pattern} w={300} mono placeholder="{show} - {episode}" onChange={(namingPattern) => set(namingPattern ? { namingPattern } : without(draft, "namingPattern"))} />
        </SetRow>
        {preview && (
          <SetRow
            h={<span className="t2">{source.videoFiles.slice(0, 3).map((video) => `${preview.names[video.id]?.stem}.mkv`).join(" · ")}</span>}
            d={preview.collisions.length ? <span className="bad">{preview.collisions.length} name{preview.collisions.length === 1 ? " is" : "s are"} shared by two or more episodes: the mux won't start like this.</span> : "As the loaded videos would be named."}
          />
        )}
        <SetRow h="Output folder" d={draft.destination === undefined ? "Keep the workspace's." : draft.destination ? undefined : "Beside each source."}>
          <span className="row" style={{ gap: 8 }}>
            <Chk on={draft.destination !== undefined} onChange={(on) => set(on ? { destination: source.outputSettings.directory } : without(draft, "destination"))}>Set</Chk>
            {draft.destination !== undefined && <FolderField label="Output folder" value={draft.destination} w={220} placeholder="Beside each source" onChange={(destination) => set({ destination })} />}
          </span>
        </SetRow>
        <SetRow h="Replace existing files" d={draft.overwriteExisting === undefined ? "Keep the workspace's." : undefined}>
          <span className="row" style={{ gap: 8 }}>
            <Chk on={draft.overwriteExisting !== undefined} onChange={(on) => set(on ? { overwriteExisting: source.outputSettings.overwriteExisting } : without(draft, "overwriteExisting"))}>Set</Chk>
            {draft.overwriteExisting !== undefined && <Toggle on={draft.overwriteExisting} label name="Replace existing files" onChange={(overwriteExisting) => set({ overwriteExisting })} />}
          </span>
        </SetRow>
      </Section>

      <Section
        title="Mux options"
        end={
          <Chk on={draft.muxOptions !== undefined} onChange={(on) => set(on ? { muxOptions: muxOptionsOf(source.muxSettings) } : without(draft, "muxOptions"))}>
            Set mux options
          </Chk>
        }
      >
        {draft.muxOptions === undefined ? (
          <SetRow h={<span className="t3">Not set: the workspace's mux options are used.</span>} />
        ) : (
          MUX_TOGGLES.map(([key, label]) => (
            <SetRow key={key} h={label}>
              <Toggle on={Boolean(draft.muxOptions?.[key] ?? source.muxSettings[key])} label name={label} onChange={(on) => set({ muxOptions: { ...draft.muxOptions, [key]: on } })} />
            </SetRow>
          ))
        )}
      </Section>

      <Section title="Measuring (watch folders)">
        <SetRow h="Measure new dubs" d="A watch folder measures each new episode's dubs before muxing.">
          <Toggle on={draft.measurement.autoMeasure} label name="Measure new dubs" onChange={(autoMeasure) => setPolicy({ autoMeasure })} />
        </SetRow>
        <SetRow h="Apply delays without asking" d="Only clean results: no cut, no drift, no warning. Anything else waits for you.">
          <Toggle on={draft.measurement.autoApply} label name="Apply delays without asking" onChange={(autoApply) => setPolicy({ autoApply })} />
        </SetRow>
        <SetRow h="At a confidence of at least">
          <TBox
            label="Confidence to apply at"
            value={String(Math.round(draft.measurement.autoApplyMinConfidence * 100))}
            unit="%"
            w={90}
            mono
            onChange={(text) => {
              const value = Number(text);
              if (Number.isFinite(value)) setPolicy({ autoApplyMinConfidence: Math.max(0, Math.min(100, value)) / 100 });
            }}
          />
        </SetRow>
        <SetRow h="Conform dubs of another cut" d="For now a watch folder leaves these for you to conform on the Audio page.">
          <Toggle on={draft.measurement.autoConformCuts} label name="Conform dubs of another cut" onChange={(autoConformCuts) => setPolicy({ autoConformCuts })} />
        </SetRow>
      </Section>
    </div>
  );
}

export function RecipesDialog({
  recipes,
  source,
  initialId,
  onApply,
  onClose,
}: {
  recipes: RecipesState;
  source: RecipeSource;
  initialId?: string | null;
  /** Apply… on a saved recipe: the app shows the changes first. */
  onApply: (recipe: Recipe) => void;
  onClose: () => void;
}) {
  const [selectedId, setSelectedId] = useState<string | null>(initialId ?? recipes.recipes[0]?.id ?? null);
  /** Edits not saved yet, by recipe; a new recipe lives only here until saved. */
  const [drafts, setDrafts] = useState<Record<string, Recipe>>({});
  const [confirmClose, setConfirmClose] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (selectedId === null && recipes.recipes.length) setSelectedId(recipes.recipes[0].id);
  }, [recipes.recipes, selectedId]);

  const saved = recipes.recipes.find((recipe) => recipe.id === selectedId) ?? null;
  const draft = (selectedId && drafts[selectedId]) || saved;
  const isNew = Boolean(draft && !saved);
  const dirty = Boolean(selectedId && drafts[selectedId] && JSON.stringify(drafts[selectedId]) !== JSON.stringify(saved));
  const anyDirty = Object.entries(drafts).some(([id, item]) => JSON.stringify(item) !== JSON.stringify(recipes.recipes.find((recipe) => recipe.id === id)));
  const problems = draft ? validateRecipe(draft) : [];
  const listed = [...recipes.recipes, ...Object.values(drafts).filter((item) => !recipes.recipes.some((recipe) => recipe.id === item.id))];

  const edit = (next: Recipe) => {
    setConfirmClose(false);
    setDrafts((prev) => ({ ...prev, [next.id]: next }));
  };
  const add = (recipe: Recipe) => {
    edit(recipe);
    setSelectedId(recipe.id);
  };
  const uniqueName = (base: string) => {
    const names = new Set(listed.map((item) => item.name.toLowerCase()));
    if (!names.has(base.toLowerCase())) return base;
    for (let n = 2; ; n++) if (!names.has(`${base} ${n}`.toLowerCase())) return `${base} ${n}`;
  };

  const save = async () => {
    if (!draft || problems.length) return;
    setSaving(true);
    const error = await recipes.save(draft);
    setSaving(false);
    if (error) {
      toast({ title: "The recipe wasn't saved", description: error, variant: "destructive" });
      return;
    }
    setDrafts((prev) => without(prev, draft.id));
    toast({ title: `Saved ${draft.name}` });
  };

  const remove = async () => {
    if (!draft) return;
    if (!isNew) {
      const error = await recipes.remove(draft.id);
      if (error) {
        toast({ title: "The recipe wasn't deleted", description: error, variant: "destructive" });
        return;
      }
    }
    setDrafts((prev) => without(prev, draft.id));
    setSelectedId(listed.find((item) => item.id !== draft.id)?.id ?? null);
  };

  const close = () => {
    if (anyDirty && !confirmClose) {
      setConfirmClose(true);
      return;
    }
    onClose();
  };

  return (
    <Dialog
      size="xl"
      title="Recipes"
      sub="What to do with every episode of a show: track rules, slots, output name and folder, mux options."
      onClose={close}
      left={draft && <Btn icon={<DeleteRegular />} onClick={() => void remove()}>{isNew ? "Discard" : "Delete"}</Btn>}
      foot={
        <>
          {confirmClose && <span className="warn" style={{ marginRight: 8 }}>Unsaved changes are lost.</span>}
          <Btn onClick={close}>{confirmClose ? "Close anyway" : "Close"}</Btn>
          <Btn disabled={!draft || isNew || dirty} title={dirty ? "Save the recipe first" : undefined} onClick={() => saved && onApply(saved)}>Apply…</Btn>
          <Btn accent disabled={!draft || !(dirty || isNew) || problems.length > 0 || saving} onClick={() => void save()}>Save</Btn>
        </>
      }
      bodyClass="flush"
    >
      <div className="row" style={{ alignItems: "stretch", flex: 1, minHeight: 0 }}>
        <div className="col" style={{ width: 220, flexShrink: 0, borderRight: "1px solid var(--divider)", padding: 8, gap: 4 }}>
          <div className="row" style={{ gap: 4, flexWrap: "wrap" }}>
            <Btn icon={<AddRegular />} onClick={() => add({ ...createRecipe(uniqueName("New recipe")), measurement: { ...DEFAULT_MEASUREMENT_POLICY } })}>New</Btn>
            <Btn onClick={() => add(recipeFromWorkspace(uniqueName(source.videoFiles[0] ? showNameFrom(source.videoFiles[0].path) || "From the workspace" : "From the workspace"), source))}>From the workspace</Btn>
          </div>
          {recipes.error && <InfoBar tone="warn">{recipes.error}</InfoBar>}
          <div className="col" role="listbox" aria-label="Recipes" style={{ overflow: "auto", gap: 2, marginTop: 4 }}>
            {listed.length === 0 && <div className="t3 sm" style={{ padding: 8 }}>No recipes yet. Make one from the workspace once a show is set up the way you like.</div>}
            {listed.map((item) => {
              const unsaved = Boolean(drafts[item.id]) && JSON.stringify(drafts[item.id]) !== JSON.stringify(recipes.recipes.find((recipe) => recipe.id === item.id));
              const shownItem = drafts[item.id] ?? item;
              return (
                <button
                  key={item.id}
                  type="button"
                  role="option"
                  aria-selected={item.id === selectedId}
                  className={cx("cmd", item.id === selectedId && "on")}
                  style={{ justifyContent: "flex-start", width: "100%", flexShrink: 0 }}
                  onClick={() => {
                    setSelectedId(item.id);
                    setConfirmClose(false);
                  }}
                >
                  <span className="truncate">{shownItem.name || "Untitled"}</span>
                  {unsaved && <span className="t3" style={{ marginLeft: "auto" }} title="Not saved">•</span>}
                </button>
              );
            })}
          </div>
        </div>
        <div className="grow" style={{ overflow: "auto", padding: "0 16px" }}>
          {draft ? (
            <>
              {problems.length > 0 && (dirty || isNew) && (
                <InfoBar tone="warn" style={{ marginTop: 12 }}>
                  {problems.join(" ")}
                </InfoBar>
              )}
              <RecipeEditor draft={draft} onChange={edit} source={source} />
            </>
          ) : (
            <div className="t3" style={{ padding: 24 }}>Make a recipe with New, or From the workspace to start from what is loaded now.</div>
          )}
        </div>
      </div>
    </Dialog>
  );
}
