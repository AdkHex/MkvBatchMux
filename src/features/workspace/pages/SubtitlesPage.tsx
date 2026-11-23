/** Subtitles: external subtitle files for each video, in track slots
 *  (Subtitle 1, Subtitle 2…). Row n of the list is video n and file n, which
 *  is how the mux pairs them; pairing by episode arranges the list so each
 *  file is in its episode's row, an empty row where one is missing
 *  (smartPairing). The logic is the old Subtitles tab's. */

import {
  ArrowImportRegular,
  ArrowSyncRegular,
  ArrowUndoRegular,
  CheckmarkRegular,
  ClosedCaptionRegular,
  CopyRegular,
  DeleteRegular,
  DismissRegular,
  FolderOpenRegular,
  StopRegular,
  TextAlignJustifyRegular,
  TimelineRegular,
} from "@fluentui/react-icons";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { PageDock } from "@/app/dock";
import { tookText } from "@/app/history";
import { useShell, usePageCommands, useStatus } from "@/app/shell";
import { ImportTrackEditDialog, type ImportTrackOverride } from "@/features/workspace/components/ImportTrackEditDialog";
import { usePairing } from "@/features/workspace/hooks/usePairing";
import { useSubsync, type SubsyncSummary } from "@/features/workspace/hooks/useSubsync";
import { engineHolder } from "@/features/workspace/lib/engineHolder";
import { applyAllPendingDelays, markDelayAsManual } from "@/features/workspace/lib/applyMeasurement";
import {
  AUDIO_MIN_SCORE,
  PICTURE_MESSAGE,
  applySyncAnyway,
  chooseReference,
  describeSync,
  isPictureSubtitle,
  canUndoSync,
  pendingSyncDelay,
  syncStatus,
  syncTarget,
  syncedAgainstAnother,
  undoSync,
} from "@/features/workspace/lib/subsync";
import { useRowReorder } from "@/features/workspace/lib/useRowReorder";
import { useTabState, type TrackConfig } from "@/features/workspace/store/useTabState";
import { DelayField, delayInputsAreValid } from "@/shared/components/DelayField";
import { CODE_TO_LABEL, LABEL_TO_CODE } from "@/shared/data/languages-iso6393";
import { inspectPaths, pickDirectory, scanMedia } from "@/shared/lib/backend";
import { delaySecondsOrZero } from "@/shared/lib/delayInput";
import { SUBTITLE_EXTENSIONS } from "@/shared/lib/extensions";
import { getUnlinkedExternalFiles, isPlaceholder, placeholderFor, realFiles } from "@/shared/lib/matchUtils";
import type { ExternalFile, Preset, VideoFile } from "@/shared/types";
import { Dialog, PageView, Panel, lcdStatus, type LcdProps } from "@/ui/frame";
import { Btn, Chk, Cmd, Combo, DL, Empty, Fld, Grip, LangCombo, Links, Meter, Status, TBox, Table, Tr, cx, type St } from "@/ui/kit";
import { toast } from "@/ui/toast";

import { FILTER_OPTIONS, SearchBox, extensionOptions, formatDelay, looksLikeFolder, matchesSearch, type FilterValue } from "./common";
import { L } from "./tracks/MeasurePane";
import { MatchCell, PairByCombo, PairingLinks, pairingLine } from "./tracks/pairing";
import { DeleteSlotDialog, FileTrackRow, FileTracks, ImportStreamsDialog, TrackDelaysDialog, TrackSheet, TrackTabs, languageName, nextSlotId } from "./tracks/parts";

export interface SubtitlesPageProps {
  hidden: boolean;
  subtitleFiles: ExternalFile[];
  videoFiles: VideoFile[];
  onSubtitleFilesChange: (files: ExternalFile[]) => void;
  onVideoFilesChange?: (files: VideoFile[]) => void;
  preset?: Preset | null;
}

const defaultTrackConfig: TrackConfig = {
  sourceFolder: "",
  extension: "all",
  language: "eng",
  trackName: "",
  delay: "0.000",
  isDefault: true,
  isForced: false,
  muxAfter: "audio",
};

const normalizeLanguage = (value: string) => {
  if (!value) return "und";
  const trimmed = value.trim();
  if (CODE_TO_LABEL[trimmed]) return trimmed;
  return LABEL_TO_CODE[trimmed] || LABEL_TO_CODE[trimmed.toLowerCase()] || trimmed.toLowerCase();
};

const subtitleExtensions = [...SUBTITLE_EXTENSIONS];

const createExternalId = () =>
  typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}`;


/** "+2.500 s" for a measured delay, as the Delay column shows it. */

export function SubtitlesPage({ hidden, subtitleFiles, videoFiles, onSubtitleFilesChange, preset }: SubtitlesPageProps) {
  const shell = useShell();

  // ------------------------------------------------------- sync subtitles
  // Syncing holds the engine like measuring audio: one run at a time, and
  // never under a mux batch. Its end gives it back and says what it found.
  const onSyncFinished = useCallback(
    (summary: SubsyncSummary) => {
      shell.releaseEngine("subtitles");
      for (const skipped of summary.skipped) shell.log(`Sync subtitles: ${skipped.fileName}: not synced: ${skipped.reason}`);
      for (const { fileName, videoName, record } of summary.results) {
        const what =
          record.outcome === "delay" || record.outcome === "retimed"
            ? `${describeSync(record)}${record.held ? " (not sure, not filled in)" : record.outcome === "retimed" ? " (re-timed copy)" : ""}`
            : (record.description ?? record.outcome);
        shell.log(`Sync subtitles: ${fileName} against ${videoName} (${record.engine === "subtitle" ? "its subtitle track" : "its speech"}): ${what}`);
      }
      const count = (test: (record: SubsyncSummary["results"][number]["record"]) => boolean) => summary.results.filter(({ record }) => test(record)).length;
      const delays = count((r) => r.outcome === "delay" && !r.held);
      const retimed = count((r) => r.outcome === "retimed" && !r.held);
      const held = count((r) => r.held);
      const failed = count((r) => r.outcome === "error" || r.outcome === "picture" || r.outcome === "noMatch");
      const parts = [delays ? `${delays} measured` : null, retimed ? `${retimed} re-timed` : null, held ? `${held} not sure` : null, failed ? `${failed} not synced` : null, summary.skipped.length ? `${summary.skipped.length} skipped` : null].filter(Boolean) as string[];
      if (summary.results.length === 0) {
        toast({ title: summary.error ? "Could not sync subtitles" : "Nothing synced", description: summary.error ?? summary.skipped[0]?.reason ?? "There is nothing to sync.", variant: summary.error ? "destructive" : undefined });
        return;
      }
      shell.log(`Synced ${summary.results.length} subtitle${summary.results.length === 1 ? "" : "s"} in ${tookText(Date.now() - summary.startedAt)}: ${parts.join(", ")}${summary.cancelled ? " (stopped)" : ""}`);
      toast({
        title: summary.cancelled ? "Sync stopped" : summary.error ? "Sync ended early" : "Subtitles synced",
        description: summary.error ?? `${parts.join(", ")}. ${delays ? "Review the delays, then Apply." : retimed ? "The re-timed copies are muxed instead of the originals." : ""}`.trim(),
        variant: summary.error ? "destructive" : undefined,
      });
    },
    [shell],
  );
  const { engine: syncEngine, syncing, progress: syncProgress, start: startSync, cancel: cancelSync } = useSubsync({
    videoFiles,
    subtitleFiles,
    onSubtitleFilesChange,
    onFinished: onSyncFinished,
  });
  const syncAvailable = Boolean(syncEngine?.engineAvailable && syncEngine.ffmpegAvailable);
  const engineBusy = shell.enginePage !== null && shell.enginePage !== "subtitles";
  /** The run going: which rows (null: every row), and since when. */
  const [syncRun, setSyncRun] = useState<{ ids: Set<string> | null; startedAt: number }>({ ids: null, startedAt: 0 });
  const beginSync = useCallback(
    async (fileIds?: string[]) => {
      if (syncing) return;
      setSyncRun({ ids: fileIds ? new Set(fileIds) : null, startedAt: Date.now() });
      if (!shell.claimEngine("subtitles")) {
        toast({ title: engineHolder(shell.enginePage) ?? "The engine is busy", description: "Sync once it is done, or stop it first." });
        return;
      }
      shell.log(`Syncing ${fileIds ? `${fileIds.length} subtitle${fileIds.length === 1 ? "" : "s"}` : "the subtitles"} against their videos`);
      await startSync(fileIds);
    },
    [shell, startSync, syncing],
  );

  const pairing = usePairing({ files: subtitleFiles, videoFiles, onFilesChange: onSubtitleFilesChange, frozen: syncing });
  const syncSubtitleLinks = pairing.sync;
  const pairByFor = pairing.pairByFor;
  /** The files, without the empty rows that keep their places. */
  const realSubtitleFiles = useMemo(() => realFiles(subtitleFiles), [subtitleFiles]);
  const {
    subtitleTracks,
    activeSubtitleTrack,
    subtitleTrackConfigs,
    subtitlePresetApplied,
    setSubtitleTracks,
    setActiveSubtitleTrack,
    updateSubtitleTrackConfig,
    removeSubtitleTrackConfig,
    setSubtitlePresetApplied,
  } = useTabState((state) => ({
    subtitleTracks: state.subtitleTracks,
    activeSubtitleTrack: state.activeSubtitleTrack,
    subtitleTrackConfigs: state.subtitleTrackConfigs,
    subtitlePresetApplied: state.subtitlePresetApplied,
    setSubtitleTracks: state.setSubtitleTracks,
    setActiveSubtitleTrack: state.setActiveSubtitleTrack,
    updateSubtitleTrackConfig: state.updateSubtitleTrackConfig,
    removeSubtitleTrackConfig: state.removeSubtitleTrackConfig,
    setSubtitlePresetApplied: state.setSubtitlePresetApplied,
  }));
  /** The selected row: video n and subtitle file n. */
  const [selectedRow, setSelectedRow] = useState<number | null>(null);
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState<FilterValue>("all");
  // Cleared when the search or the filter changes, as on Videos: a hidden row
  // staying selected would let Remove or Duplicate act on a file out of sight.
  useEffect(() => setSelectedRow(null), [search, filter]);
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [trackToDelete, setTrackToDelete] = useState<string | null>(null);
  const [editDialogOpen, setEditDialogOpen] = useState(false);
  const [editingFileId, setEditingFileId] = useState<string | null>(null);
  const subtitleFilesCache = useRef<Record<string, ExternalFile[]>>({});
  const [trackEditOpen, setTrackEditOpen] = useState(false);
  const [trackEditTarget, setTrackEditTarget] = useState<{ fileId: string; trackId: number } | null>(null);
  const [trackEditForm, setTrackEditForm] = useState({ language: "und", delay: "0.000", trackName: "" });
  const [multiDelayOpen, setMultiDelayOpen] = useState(false);
  const [multiDelayFileId, setMultiDelayFileId] = useState<string | null>(null);
  const [multiDelayValues, setMultiDelayValues] = useState<Record<number, string>>({});
  const [multiDelayBulkValue, setMultiDelayBulkValue] = useState("0.000");
  const [importStreamsOpen, setImportStreamsOpen] = useState(false);
  const [importSourceVideoId, setImportSourceVideoId] = useState("");
  const [importSelectedTrackKeys, setImportSelectedTrackKeys] = useState<string[]>([]);
  // Per-stream overrides for an import, keyed by the same track key as the
  // selection above. Cleared whenever the source video changes.
  const [importOverrides, setImportOverrides] = useState<Record<string, ImportTrackOverride>>({});
  const [editForm, setEditForm] = useState({
    trackName: "",
    language: "und",
    delay: "0.000",
    isDefault: false,
    isForced: false,
    muxAfter: "audio",
    applyDelayToAll: false,
    applyToAllFiles: false,
    includedTrackIds: [] as number[],
  });

  const currentConfig = subtitleTrackConfigs[activeSubtitleTrack] || defaultTrackConfig;
  const editingFile = subtitleFiles.find((file) => file.id === editingFileId) || null;
  const multiDelayFile = subtitleFiles.find((file) => file.id === multiDelayFileId) || null;

  const muxAfterOptions = useMemo(() => {
    const primaryTracks = videoFiles[0]?.tracks || [];
    const trackCount = primaryTracks.length || Math.max(0, ...videoFiles.map((video) => video.tracks?.length || 0));
    const options = [
      { value: "subtitle-first", label: "First subtitle track" },
      { value: "audio", label: "After audio tracks" },
    ];
    for (let i = 1; i <= trackCount; i += 1) {
      const track = primaryTracks[i - 1];
      options.push({ value: `track-${i}`, label: track ? `Track ${i} - ${track.type}${track.language ? ` (${track.language})` : ""}` : `Track ${i}` });
    }
    options.push({ value: "end", label: "End" });
    return options;
  }, [videoFiles]);

  const selectedImportSource = useMemo(() => videoFiles.find((file) => file.id === importSourceVideoId) || null, [videoFiles, importSourceVideoId]);
  const unlinkedCount = useMemo(() => getUnlinkedExternalFiles(subtitleFiles, videoFiles).length, [subtitleFiles, videoFiles]);
  const importableTracks = useMemo(
    () => (selectedImportSource ? (selectedImportSource.tracks || []).filter((track) => track.type === "subtitle" && track.action !== "remove") : []),
    [selectedImportSource],
  );
  const getImportTrackKey = (trackIndex: number, trackId: string) => `${trackIndex}:${trackId}`;

  const updateCurrentConfig = (updates: Partial<TrackConfig>) => updateSubtitleTrackConfig(activeSubtitleTrack, updates);

  /** The settings last stamped on each slot's files, by slot: one shared by
   *  every slot would count each switch of tab as a change of settings. */
  const lastAppliedConfig = useRef<Record<string, TrackConfig>>({});
  useEffect(() => {
    if (subtitleFiles.length === 0) return;
    const prev = lastAppliedConfig.current[activeSubtitleTrack];
    const same =
      prev &&
      prev.sourceFolder === currentConfig.sourceFolder &&
      prev.extension === currentConfig.extension &&
      prev.language === currentConfig.language &&
      prev.trackName === currentConfig.trackName &&
      prev.delay === currentConfig.delay &&
      prev.isDefault === currentConfig.isDefault &&
      prev.isForced === currentConfig.isForced &&
      prev.muxAfter === currentConfig.muxAfter;
    if (same) return;
    lastAppliedConfig.current[activeSubtitleTrack] = { ...currentConfig };
    const delayValue = delaySecondsOrZero(currentConfig.delay);
    onSubtitleFilesChange(
      subtitleFiles.map((file) => file.placeholder ? file : ({
        ...file,
        // Global default/forced toggles must always apply from the slot's settings.
        isDefault: currentConfig.isDefault,
        isForced: currentConfig.isForced,
        ...(file.isManuallyEdited
          ? {}
          : {
              language: currentConfig.language,
              trackName: currentConfig.trackName,
              // A delay typed for the file ("This delay" for every file) or a
              // synced one is its own, not a slot for the global default to
              // keep overwriting.
              delay: file.delayProvenance === "manual" || file.delayProvenance === "measured" ? file.delay : delayValue,
              muxAfter: currentConfig.muxAfter,
            }),
      })),
    );
  }, [subtitleFiles, currentConfig, onSubtitleFilesChange, activeSubtitleTrack]);

  useEffect(() => {
    subtitleFilesCache.current[activeSubtitleTrack] = subtitleFiles;
  }, [subtitleFiles, activeSubtitleTrack]);
  useEffect(() => {
    const cached = subtitleFilesCache.current[activeSubtitleTrack];
    if (!cached || cached === subtitleFiles) return;
    if (cached.length === subtitleFiles.length) return;
    onSubtitleFilesChange(cached);
  }, [activeSubtitleTrack, subtitleFiles, onSubtitleFilesChange]);

  const addNewTrack = useCallback(() => {
    const newTrackNumber = nextSlotId(subtitleTracks);
    setSubtitleTracks([...subtitleTracks, newTrackNumber]);
    updateSubtitleTrackConfig(newTrackNumber, { ...defaultTrackConfig });
    setActiveSubtitleTrack(newTrackNumber);
    setSelectedRow(null);
    toast({ title: `Subtitle ${newTrackNumber} added` });
  }, [setActiveSubtitleTrack, setSubtitleTracks, subtitleTracks, updateSubtitleTrackConfig]);

  const duplicateTrack = () => {
    const newTrackNumber = nextSlotId(subtitleTracks);
    const currentSettings = subtitleTrackConfigs[activeSubtitleTrack] || defaultTrackConfig;
    setSubtitleTracks([...subtitleTracks, newTrackNumber]);
    updateSubtitleTrackConfig(newTrackNumber, { ...currentSettings });
    setActiveSubtitleTrack(newTrackNumber);
    toast({ title: `Subtitle ${newTrackNumber} added`, description: `With the settings of Subtitle ${activeSubtitleTrack}.` });
  };

  useEffect(() => {
    if (!preset || subtitlePresetApplied) return;
    subtitleTracks.forEach((trackId) => {
      updateSubtitleTrackConfig(trackId, {
        sourceFolder: preset.Default_Subtitle_Directory || "",
        extension: "all",
        language: preset.Default_Subtitle_Language ? normalizeLanguage(preset.Default_Subtitle_Language) : "und",
      });
    });
    setSubtitlePresetApplied(true);
  }, [preset, subtitlePresetApplied, subtitleTracks, updateSubtitleTrackConfig, setSubtitlePresetApplied]);

  // Read through a ref so a rescan sees the current list without making
  // scanSubtitles depend on it, which would rebuild the callback on every edit.
  const subtitleFilesRef = useRef(subtitleFiles);
  subtitleFilesRef.current = subtitleFiles;

  /** A scan's or a drop's files, keeping what was already set for them. */
  const normalize = useCallback(
    (results: ExternalFile[]) => {
      // A rescan re-reads the same folder, so a delay already typed for a file
      // still applies. Carrying it over means refresh does not discard edits.
      const priorByPath = new Map(subtitleFilesRef.current.map((file) => [file.path.toLowerCase(), file] as const));
      return results.map((file) => {
        const prior = priorByPath.get(file.path.toLowerCase());
        const keepsOwnDelay = prior && (prior.delayProvenance === "measured" || prior.delayProvenance === "manual");
        return {
          ...file,
          type: "subtitle" as const,
          language: prior?.language ?? currentConfig.language,
          trackName: prior?.trackName ?? currentConfig.trackName,
          delay: keepsOwnDelay ? prior.delay : delaySecondsOrZero(currentConfig.delay),
          ...(keepsOwnDelay ? { delayProvenance: prior.delayProvenance } : {}),
          // What Sync subtitles found for this very file, and its re-timed copy.
          ...(prior?.subsync ? { subsync: prior.subsync, retimed: prior.retimed, pendingDelay: prior.pendingDelay } : {}),
          isDefault: currentConfig.isDefault,
          isForced: currentConfig.isForced,
          muxAfter: currentConfig.muxAfter,
          trackOverrides: prior?.trackOverrides ?? file.trackOverrides ?? {},
          // Kept with the language and name it guards: dropped, the next change
          // of the slot's settings would overwrite what was set by hand.
          isManuallyEdited: prior?.isManuallyEdited,
          includedTrackIds:
            file.tracks && file.tracks.length > 0 ? file.tracks.map((track) => Number(track.id)).filter((id) => !Number.isNaN(id)) : file.includedTrackIds,
        };
      });
    },
    [currentConfig],
  );

  const scanSubtitles = useCallback(
    async (folderPath: string) => {
      if (!folderPath) {
        onSubtitleFilesChange([]);
        return;
      }
      const extensions = currentConfig.extension === "all" ? subtitleExtensions : [currentConfig.extension];
      try {
        const results = await scanMedia({ folder: folderPath, extensions, recursive: false, type: "subtitle", include_tracks: true });
        const paired = syncSubtitleLinks(normalize(results as ExternalFile[]));
        onSubtitleFilesChange(paired);
        const gaps = paired.filter(isPlaceholder).length;
        shell.log(`Subtitle ${activeSubtitleTrack}: ${results.length} file${results.length === 1 ? "" : "s"} from ${folderPath}, paired by ${pairByFor(paired) === "episode" ? `episode${gaps ? `, ${gaps} episode${gaps === 1 ? "" : "s"} without one` : ""}` : "row"}`);
      } catch (error) {
        shell.log(`Error: could not scan ${folderPath}: ${String(error)}`);
        toast({ title: "Could not scan the folder", description: String(error), variant: "destructive" });
      }
    },
    [currentConfig.extension, normalize, onSubtitleFilesChange, syncSubtitleLinks, shell, activeSubtitleTrack, pairByFor],
  );

  /** By order the rows between shift; by episode the two files trade videos,
   *  each kept where it was put (smartPairing.moveByHand). */
  const reorderSubtitleFile = (fromIndex: number, toIndex: number) => {
    const last = (pairing.pairBy === "episode" ? videoFiles.length : subtitleFiles.length) - 1;
    if (toIndex < 0 || toIndex > last || isPlaceholder(subtitleFiles[fromIndex])) return;
    pairing.move(fromIndex, toIndex);
    setSelectedRow(toIndex);
  };

  const duplicateSubtitleFile = (index: number) => {
    const original = subtitleFiles[index];
    if (!original || original.placeholder) return;
    if (videoFiles.length === 0) {
      toast({ title: "Nothing to duplicate into", description: "Add video files before duplicating subtitles.", variant: "destructive" });
      return;
    }
    if (realSubtitleFiles.length >= videoFiles.length) {
      toast({ title: "Nothing to duplicate into", description: "There cannot be more subtitle files than videos.", variant: "destructive" });
      return;
    }
    // The copy is kept with its video by hand: the same name twice would
    // otherwise read as a second file for one episode.
    const copy = (row: number): ExternalFile => ({ ...original, id: `subtitle-dup-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, matchedVideoId: videoFiles[row]?.id, isManuallyLinked: true, audioMatch: undefined });
    const updated = [...subtitleFiles];
    let row = index + 1;
    if (pairing.pairBy === "episode") {
      // Into the next empty row: every row with a file is that file's episode.
      row = videoFiles.findIndex((_, r) => r > index && (!subtitleFiles[r] || isPlaceholder(subtitleFiles[r])));
      if (row < 0) {
        toast({ title: "Nothing to duplicate into", description: "Every video after this one has its file.", variant: "destructive" });
        return;
      }
      while (updated.length < row) updated.push(placeholderFor(videoFiles[updated.length], "subtitle"));
      updated[row] = copy(row);
    } else if (isPlaceholder(updated[row])) updated[row] = copy(row);
    else updated.splice(row, 0, copy(row));
    onSubtitleFilesChange(syncSubtitleLinks(updated));
    setSelectedRow(row);
    toast({ title: "Subtitle duplicated", description: pairing.pairBy === "episode" ? `${original.name}, beside ${videoFiles[row].name}.` : `${original.name}, paired by row.` });
  };

  const openEditDialog = (fileId: string) => {
    const file = subtitleFiles.find((entry) => entry.id === fileId);
    if (!file) return;
    const defaultIncluded = file.tracks && file.tracks.length > 0 ? file.tracks.map((track) => Number(track.id)).filter((id) => !Number.isNaN(id)) : [];
    setEditingFileId(fileId);
    setEditForm({
      trackName: file.trackName || "",
      language: file.language || "und",
      delay: (file.delay ?? 0).toFixed(3),
      isDefault: file.isDefault || false,
      isForced: file.isForced || false,
      muxAfter: file.muxAfter || "audio",
      applyDelayToAll: false,
      applyToAllFiles: false,
      includedTrackIds: file.includedTrackIds !== undefined ? [...file.includedTrackIds] : defaultIncluded,
    });
    setEditDialogOpen(true);
  };

  const applyTrackChangesToDuplicateFiles = useCallback(
    (fileId: string, updater: (file: ExternalFile, isTarget: boolean) => ExternalFile) => {
      const target = subtitleFiles.find((entry) => entry.id === fileId);
      if (!target) return;
      onSubtitleFilesChange(subtitleFiles.map((file) => (file.path !== target.path ? file : updater(file, file.id === fileId))));
    },
    [subtitleFiles, onSubtitleFilesChange],
  );

  const closeEdit = () => {
    setEditDialogOpen(false);
    setEditingFileId(null);
  };

  const applyEditChanges = () => {
    if (!editingFileId) return;
    const delayValue = delaySecondsOrZero(editForm.delay);
    if (editForm.applyToAllFiles) {
      // Compute which track INDICES are selected in the editing file, then mirror to all files
      const editingFileData = subtitleFiles.find((f) => f.id === editingFileId);
      const srcTracks = (editingFileData?.tracks || []).filter((t) => t.type === "subtitle");
      const selIdx = new Set(
        srcTracks
          .map((t, i) => ({ i, id: Number(t.id) }))
          .filter(({ id }) => editForm.includedTrackIds.includes(id))
          .map(({ i }) => i),
      );
      const updated = subtitleFiles.map((file) => {
        if (file.placeholder) return file;
        const fileTracks = (file.tracks || []).filter((t) => t.type === "subtitle");
        const newIds = fileTracks
          .map((t, i) => ({ i, id: Number(t.id) }))
          .filter(({ i }) => selIdx.has(i))
          .map(({ id }) => id)
          .filter((id) => Number.isFinite(id));
        // A changed delay is typed by hand, so a rescan or the slot's Delay
        // leaves it alone; an unchanged one keeps where it came from.
        const base = file.delay !== delayValue ? markDelayAsManual(file, null) : file;
        return {
          ...base,
          language: editForm.language,
          trackName: editForm.trackName,
          delay: delayValue,
          isDefault: editForm.isDefault,
          isForced: editForm.isForced,
          muxAfter: editForm.muxAfter,
          includedTrackIds: fileTracks.length > 0 ? newIds : file.includedTrackIds,
          isManuallyEdited: true,
        };
      });
      onSubtitleFilesChange(updated);
      closeEdit();
      toast({ title: "Applied to every file", description: `${realSubtitleFiles.length} subtitle file${realSubtitleFiles.length === 1 ? "" : "s"}.` });
      return;
    }
    let updated = subtitleFiles.map((file) => {
      if (file.id === editingFileId) {
        const base = file.delay !== delayValue ? markDelayAsManual(file, null) : file;
        return {
          ...base,
          trackName: editForm.trackName,
          language: editForm.language,
          delay: delayValue,
          isDefault: editForm.isDefault,
          isForced: editForm.isForced,
          muxAfter: editForm.muxAfter,
          includedTrackIds: editForm.includedTrackIds,
          trackOverrides: base.trackOverrides,
          isManuallyEdited: true,
        };
      }
      if (editForm.applyDelayToAll && !file.placeholder) return file.delay !== delayValue ? { ...markDelayAsManual(file, null), delay: delayValue } : file;
      return file;
    });
    const editedTarget = updated.find((file) => file.id === editingFileId);
    if (editedTarget) {
      updated = updated.map((file) => {
        if (file.id === editingFileId || file.path !== editedTarget.path) return file;
        return { ...file, includedTrackIds: [...editForm.includedTrackIds], trackOverrides: { ...(file.trackOverrides || {}) }, isManuallyEdited: true };
      });
    }
    onSubtitleFilesChange(updated);
    closeEdit();
  };

  const openTrackEdit = (fileId: string, trackId: number) => {
    const file = subtitleFiles.find((entry) => entry.id === fileId);
    if (!file) return;
    const track = file.tracks?.find((t) => Number(t.id) === trackId);
    const overrides = file.trackOverrides?.[trackId] || {};
    setTrackEditTarget({ fileId, trackId });
    setTrackEditForm({
      language: overrides.language || track?.language || "und",
      // The delay the track is muxed with: its own, or else the file's
      // (main.rs). Opening on 0 for a track without one would save 0 over it.
      delay: (overrides.delay ?? file.delay ?? 0).toFixed(3),
      trackName: overrides.trackName || track?.name || "",
    });
    setTrackEditOpen(true);
  };

  const openMultiDelayDialog = (fileId: string) => {
    const file = subtitleFiles.find((entry) => entry.id === fileId);
    if (!file) return;
    const targetTracks = (file.tracks || []).filter((track) => track.type === "subtitle");
    if (targetTracks.length === 0) return;
    const initial: Record<number, string> = {};
    targetTracks.forEach((track) => {
      const trackId = Number(track.id);
      if (!Number.isFinite(trackId)) return;
      initial[trackId] = (file.trackOverrides?.[trackId]?.delay ?? file.delay ?? 0).toFixed(3);
    });
    setMultiDelayFileId(fileId);
    setMultiDelayValues(initial);
    setMultiDelayBulkValue((file.delay ?? 0).toFixed(3));
    setMultiDelayOpen(true);
  };

  /** Committed on Save rather than per keystroke, so Cancel really does cancel. */
  const applyTrackEdit = (next: ImportTrackOverride) => {
    if (!trackEditTarget) return;
    const { fileId, trackId } = trackEditTarget;
    const nextDelay = delaySecondsOrZero(next.delay ?? 0);
    // Only a delay changed in the dialog becomes the track's own; left as it
    // opened, the track keeps following its file's delay.
    const changed = nextDelay !== delaySecondsOrZero(trackEditForm.delay);
    applyTrackChangesToDuplicateFiles(fileId, (file) => {
      const nextOverrides = { ...(file.trackOverrides || {}) };
      nextOverrides[trackId] = { language: next.language || undefined, delay: changed ? nextDelay : file.trackOverrides?.[trackId]?.delay, trackName: next.trackName || undefined };
      return { ...file, trackOverrides: nextOverrides, isManuallyEdited: true };
    });
    setTrackEditOpen(false);
    setTrackEditTarget(null);
  };

  const applyMultiDelayChanges = () => {
    if (!multiDelayFileId) return;
    applyTrackChangesToDuplicateFiles(multiDelayFileId, (file) => {
      const targetTracks = (file.tracks || []).filter((track) => track.type === "subtitle");
      const nextOverrides = { ...(file.trackOverrides || {}) };
      targetTracks.forEach((track) => {
        const trackId = Number(track.id);
        if (!Number.isFinite(trackId)) return;
        nextOverrides[trackId] = { ...(nextOverrides[trackId] || {}), delay: delaySecondsOrZero(multiDelayValues[trackId]) };
      });
      return { ...file, trackOverrides: nextOverrides, isManuallyEdited: true };
    });
    setMultiDelayOpen(false);
    setMultiDelayFileId(null);
    toast({ title: "Track delays saved" });
  };

  const removeSubtitleFile = (index: number) => {
    onSubtitleFilesChange(syncSubtitleLinks(subtitleFiles.filter((_, currentIndex) => currentIndex !== index)));
    setSelectedRow(null);
  };

  const confirmDeleteTrack = (trackId: string) => {
    if (subtitleTracks.length <= 1) return;
    setTrackToDelete(trackId);
    setDeleteDialogOpen(true);
  };

  const deleteTrack = () => {
    if (!trackToDelete || subtitleTracks.length <= 1) return;
    const deletedNumber = trackToDelete;
    setSubtitleTracks(subtitleTracks.filter((track) => track !== trackToDelete));
    removeSubtitleTrackConfig(trackToDelete);
    if (activeSubtitleTrack === trackToDelete) setActiveSubtitleTrack(subtitleTracks.filter((t) => t !== trackToDelete)[0] || "1");
    setDeleteDialogOpen(false);
    setTrackToDelete(null);
    toast({ title: `Subtitle ${deletedNumber} deleted` });
  };

  /** The row an import lands in: the selected one, or the first without a
   *  file when that is further down. Row n is file n, so a file cannot sit
   *  past an empty row: pushed onto the end it would pair with the next video,
   *  not the one the dialog named. */
  const importRow = Math.min(selectedRow ?? 0, subtitleFiles.length);

  const handleImportSubtitles = () => {
    if (videoFiles.length === 0) {
      toast({ title: "No videos loaded", description: "Load the videos first, then import subtitle streams from them.", variant: "destructive" });
      return;
    }
    if (selectedRow === null) setSelectedRow(0);
    setImportSourceVideoId(videoFiles[0]?.id || "");
    setImportSelectedTrackKeys([]);
    setImportStreamsOpen(true);
  };

  const handleConfirmImportSubtitles = () => {
    const targetIndex = importRow;
    const targetVideo = videoFiles[targetIndex];
    if (!targetVideo || !selectedImportSource || importSelectedTrackKeys.length === 0) {
      toast({ title: "Nothing to import", description: "Choose at least one subtitle stream and a video to import into.", variant: "destructive" });
      return;
    }
    const selectedTrackKeySet = new Set(importSelectedTrackKeys);
    const selectedTracks = importableTracks.filter((track, trackIndex) => selectedTrackKeySet.has(getImportTrackKey(trackIndex, String(track.id))));
    if (selectedTracks.length === 0) return;
    const existingAtTarget = subtitleFiles[targetIndex];
    const mergedTracks = [...(existingAtTarget?.tracks?.filter((track) => track.type === "subtitle") || [])];
    selectedTracks.forEach((track) => {
      if (!mergedTracks.some((entry) => String(entry.id) === String(track.id))) mergedTracks.push(track);
    });
    const importedFile: ExternalFile = {
      id: createExternalId(),
      name: selectedImportSource.name,
      path: selectedImportSource.path,
      type: "subtitle",
      source: "per-file",
      language: currentConfig.language,
      trackName: currentConfig.trackName,
      delay: delaySecondsOrZero(currentConfig.delay),
      isDefault: currentConfig.isDefault,
      isForced: currentConfig.isForced,
      muxAfter: currentConfig.muxAfter,
      matchedVideoId: targetVideo.id,
      // Put in this row on purpose: pairing by episode leaves it here.
      isManuallyLinked: true,
      tracks: mergedTracks,
      includedTrackIds: mergedTracks.map((track) => Number(track.id)).filter((id) => Number.isFinite(id)),
      // Carry per-stream edits through as track overrides, keyed by track id,
      // so the mux job picks them up the same way manual edits do.
      trackOverrides: (() => {
        const overrides: NonNullable<ExternalFile["trackOverrides"]> = { ...(existingAtTarget?.trackOverrides ?? {}) };
        importableTracks.forEach((track, trackIndex) => {
          const key = getImportTrackKey(trackIndex, String(track.id));
          if (!selectedTrackKeySet.has(key)) return;
          const override = importOverrides[key];
          const id = Number(track.id);
          if (!override || !Number.isFinite(id)) return;
          overrides[id] = { ...(overrides[id] ?? {}), ...override };
        });
        return Object.keys(overrides).length > 0 ? overrides : undefined;
      })(),
    };
    const updated = [...subtitleFiles];
    const existingByVideoIndex = updated.findIndex((file) => file.matchedVideoId === targetVideo.id);
    if (existingByVideoIndex >= 0) updated[existingByVideoIndex] = importedFile;
    else if (targetIndex <= updated.length) updated.splice(targetIndex, 0, importedFile);
    else updated.push(importedFile);
    onSubtitleFilesChange(syncSubtitleLinks(updated));
    setSelectedRow(targetIndex);
    setImportStreamsOpen(false);
    setImportOverrides({});
    toast({ title: `Imported ${selectedTracks.length} stream${selectedTracks.length > 1 ? "s" : ""}`, description: `Into row ${targetIndex + 1}, beside ${targetVideo.name}.` });
  };

  const chooseFolder = async () => {
    const folder = await pickDirectory();
    if (folder) {
      updateCurrentConfig({ sourceFolder: folder });
      void scanSubtitles(folder);
    }
  };

  /** Dropped subtitle files: read and added after the ones already here. */
  const addDropped = async (paths: string[]) => {
    const allowed = new Set(subtitleExtensions.map((ext) => ext.toLowerCase()));
    const picked = paths.filter((path) => allowed.has(path.split(".").pop()?.toLowerCase() ?? ""));
    if (picked.length === 0) {
      toast({ title: "No subtitle files in the drop" });
      return;
    }
    const inspected = (await inspectPaths({ paths: picked, type: "subtitle", include_tracks: true })) as ExternalFile[];
    onSubtitleFilesChange(syncSubtitleLinks([...subtitleFiles, ...normalize(inspected)]));
  };

  // ------------------------------------------------------------------ rows

  const rowCount = Math.max(videoFiles.length, subtitleFiles.length);
  const rows = useMemo(() => {
    // An empty row (placeholder) shows as a row without a file.
    const all = Array.from({ length: rowCount }, (_, index) => ({ index, video: videoFiles[index], entry: subtitleFiles[index], file: isPlaceholder(subtitleFiles[index]) ? undefined : subtitleFiles[index] }));
    return all.filter(({ video, file }) => {
      const hit = (video && matchesSearch(video, search)) || (file && matchesSearch(file, search));
      if (!hit) return false;
      if (filter === "linked") return Boolean(file?.matchedVideoId && video);
      if (filter === "unlinked") return !(file && video);
      return true;
    });
  }, [rowCount, videoFiles, subtitleFiles, search, filter]);
  // Moving rows only makes sense while the list shows every row in mux order.
  const ordered = !search.trim() && filter === "all";
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const lastMovable = (pairing.pairBy === "episode" ? videoFiles.length : subtitleFiles.length) - 1;
  const drag = useRowReorder({ bodyRef, rowCount, disabled: !ordered || syncing, onMove: (from, to) => from < subtitleFiles.length && reorderSubtitleFile(from, Math.min(to, lastMovable)) });

  const selectedEntry = selectedRow !== null ? subtitleFiles[selectedRow] : undefined;
  const selectedFile = isPlaceholder(selectedEntry) ? undefined : selectedEntry;
  // An empty row can go while pairing by order (the files below move up); by
  // episode it would only come back.
  const canRemove = !syncing && selectedRow !== null && Boolean(selectedFile || (selectedEntry && pairing.pairBy === "order"));
  const canMoveUp = !syncing && ordered && Boolean(selectedFile) && selectedRow !== null && selectedRow > 0 && selectedRow <= lastMovable;
  const canMoveDown = !syncing && ordered && Boolean(selectedFile) && selectedRow !== null && selectedRow < lastMovable;

  // ------------------------------------------------------ sync results

  /** The video a file is paired with now, as the mux resolves it. */
  const videoOf = (file: ExternalFile | undefined) => (file?.matchedVideoId ? videoFiles.find((video) => video.id === file.matchedVideoId) : undefined);
  /** Pending sync delays Apply takes: not one measured against another video. */
  const pendingFiles = realSubtitleFiles.filter((file) => pendingSyncDelay(file) && !syncedAgainstAnother(file, videoOf(file)));
  const pendingCount = pendingFiles.length;
  const syncedCount = realSubtitleFiles.filter((file) => file.subsync).length;
  const applyPending = () => {
    const ids = new Set(pendingFiles.map((file) => file.id));
    onSubtitleFilesChange(subtitleFiles.map((file) => (ids.has(file.id) ? applyAllPendingDelays(file) : file)));
    shell.log(`Applied ${pendingCount} synced subtitle ${pendingCount === 1 ? "delay" : "delays"}`);
    toast({ title: `Applied ${pendingCount} ${pendingCount === 1 ? "delay" : "delays"}`, description: "The measured values are now the subtitles' delays." });
  };
  const updateFile = (fileId: string, update: (file: ExternalFile) => ExternalFile) => onSubtitleFilesChange(subtitleFiles.map((file) => (file.id === fileId ? update(file) : file)));
  const applyAnyway = (file: ExternalFile) => {
    updateFile(file.id, (current) => applySyncAnyway(current, syncTarget(current)));
    toast({ title: file.subsync?.outcome === "retimed" ? "Re-timed copy in use" : "Delay applied", description: "The synced timing is in despite the low confidence. Check a line or two before muxing." });
  };
  const applyOne = (file: ExternalFile) => updateFile(file.id, applyAllPendingDelays);
  const canSync = syncAvailable && !engineBusy && !syncing && realSubtitleFiles.length > 0;

  usePageCommands("subtitles", {
    chooseFolder: () => void chooseFolder(),
    importFromVideo: handleImportSubtitles,
    removeSelected: canRemove ? () => removeSubtitleFile(selectedRow!) : undefined,
    start: canSync ? () => void beginSync() : undefined,
    stop: syncing ? () => void cancelSync() : undefined,
    disabled: { chooseFolder: syncing, importFromVideo: syncing },
    clear: subtitleFiles.length && !syncing
      ? () => {
          updateCurrentConfig({ sourceFolder: "" });
          onSubtitleFilesChange([]);
        }
      : undefined,
    moveUp: canMoveUp ? () => reorderSubtitleFile(selectedRow!, selectedRow! - 1) : undefined,
    moveDown: canMoveDown ? () => reorderSubtitleFile(selectedRow!, selectedRow! + 1) : undefined,
    newTrack: syncing ? undefined : addNewTrack,
    duplicateTrack: syncing ? undefined : duplicateTrack,
    drop: (paths) => {
      if (syncing) return;
      const folder = paths.find(looksLikeFolder);
      if (folder) {
        updateCurrentConfig({ sourceFolder: folder });
        void scanSubtitles(folder);
      } else void addDropped(paths);
    },
  });

  const conflicts = pairing.report.conflicts;
  const rowStates = realSubtitleFiles.map((file) => syncStatus(file, videoOf(file)));
  const toCheck = rowStates.filter((state) => state.s === "warn" || state.s === "bad").length;
  const syncedOk = rowStates.filter((state) => state.s === "ok").length;
  const syncLine = [
    syncedOk ? `${syncedOk} synced` : null,
    rowStates.filter((state) => state.text === "Re-timed copy").length ? `${rowStates.filter((state) => state.text === "Re-timed copy").length} re-timed` : null,
    rowStates.filter((state) => state.text === "Low confidence").length ? `${rowStates.filter((state) => state.text === "Low confidence").length} low confidence` : null,
    rowStates.filter((state) => state.text === "Measured against another video").length ? `${rowStates.filter((state) => state.text === "Measured against another video").length} measured against another video` : null,
    rowStates.filter((state) => state.s === "bad" || state.text === "No clear match" || state.text === "Can't be synced automatically").length
      ? `${rowStates.filter((state) => state.s === "bad" || state.text === "No clear match" || state.text === "Can't be synced automatically").length} not synced`
      : null,
  ].filter(Boolean) as string[];
  const syncStage = syncProgress ? Object.values(syncProgress.active)[0]?.stage : null;
  const lcd: LcdProps = syncing
    ? {
        icon: "run",
        l1: syncProgress
          ? `Syncing against ${syncProgress.engine === "subtitle" ? "the videos' subtitle tracks" : "the videos' speech"} · ${syncProgress.processed} of ${syncProgress.total} done`
          : "Syncing subtitles",
        l2: syncStage ?? undefined,
        pct: syncProgress && syncProgress.total > 0 ? ((syncProgress.processed + Object.values(syncProgress.active).reduce((sum, entry) => sum + entry.percent / 100, 0)) / syncProgress.total) * 100 : null,
      }
    : realSubtitleFiles.length === 0
      ? { l1: `Drop a folder of subtitles for Subtitle ${activeSubtitleTrack}` }
      : syncedCount > 0 && conflicts.length === 0
        ? {
            icon: toCheck ? "warn" : "ok",
            l1: toCheck ? `${syncedOk} synced · ${toCheck} to check` : `${syncedOk} synced`,
            l2: syncLine.join(" · "),
            time: pendingCount ? `${pendingCount} to apply` : undefined,
          }
      : conflicts.length > 0
        ? {
            icon: "warn",
            l1: unlinkedCount === conflicts.length ? `${unlinkedCount} subtitle file${unlinkedCount === 1 ? " has" : "s have"} no video` : `${conflicts.length} subtitle file${conflicts.length === 1 ? "" : "s"} to pair`,
            l2: `Row ${conflicts[0].row + 1}: ${subtitleFiles[conflicts[0].row]?.name} ${conflicts[0].message.replace(/\.$/, "")}`,
          }
        : {
            l1: `${realSubtitleFiles.length} subtitle file${realSubtitleFiles.length === 1 ? "" : "s"} · ${realSubtitleFiles.length - unlinkedCount} paired by ${pairing.pairBy === "episode" ? "episode" : "row"}`,
            l2: `Subtitle ${activeSubtitleTrack} · ${languageName(currentConfig.language)}${currentConfig.isDefault ? " · default" : ""}${currentConfig.isForced ? " · forced" : ""} · ${(muxAfterOptions.find((o) => o.value === currentConfig.muxAfter)?.label ?? "").toLowerCase()}`,
          };

  const folder = currentConfig.sourceFolder;
  const status = useStatus("subtitles", lcdStatus(lcd));
  const syncTitle =
    syncEngine === null
      ? "Checking for the audio analysis engine…"
      : (syncEngine.message ??
        (engineBusy
          ? (engineHolder(shell.enginePage) ?? "The engine is busy")
          : "Measure each subtitle's delay against its video: against a subtitle track inside the video when it has one, else against its speech"));

  /** The popup's Sync part: what the engine found and what was done with it. */
  const syncPart = (file: ExternalFile) => {
    const video = videoOf(file);
    const record = file.subsync;
    const reference = video ? chooseReference(file, video) : null;
    const against = !video ? "No video" : isPictureSubtitle(file) ? PICTURE_MESSAGE : reference && "label" in reference ? reference.label : (reference as { reason: string } | null)?.reason ?? "—";
    const canRun = syncAvailable && !engineBusy && !syncing && Boolean(video);
    if (!record)
      return (
        <>
          <DL rows={[["Sync against", against]]} />
          <Links>
            <L icon={<TextAlignJustifyRegular />} onClick={() => void beginSync([file.id])} disabled={!canRun || isPictureSubtitle(file)}>Sync this subtitle</L>
          </Links>
          <div className="hr" />
        </>
      );
    const state = syncStatus(file, video);
    const stale = syncedAgainstAnother(file, video);
    const pending = pendingSyncDelay(file);
    const measured = record.outcome === "delay" || record.outcome === "retimed";
    return (
      <>
        <div>
          <div className="t3">{record.outcome === "retimed" ? "Re-timed" : "Delay"}</div>
          <div className="big">{measured ? describeSync(record) : "—"}</div>
          <div className={state.s === "ok" ? "t2" : state.s}>{state.text}{record.held ? `: the engine was not sure enough to fill it in` : ""}</div>
        </div>
        <Links>
          {pending && !stale && !record.held && (
            <L
              icon={<CheckmarkRegular />}
              onClick={() => {
                applyOne(file);
                // The form below shows the delay Save writes: the one just applied.
                setEditForm((prev) => ({ ...prev, delay: pending.seconds.toFixed(3) }));
              }}
              disabled={syncing}
            >
              Apply
            </L>
          )}
          {record.held && !stale && (
            <L
              icon={<CheckmarkRegular />}
              onClick={() => {
                applyAnyway(file);
                if (record.outcome === "delay" && record.offsetS !== null && syncTarget(file) === null) setEditForm((prev) => ({ ...prev, delay: record.offsetS!.toFixed(3) }));
              }}
              disabled={syncing}
              title="Use this timing despite the low confidence"
            >
              Apply anyway
            </L>
          )}
          {canUndoSync(file) && <L icon={<ArrowUndoRegular />} onClick={() => updateFile(file.id, undoSync)} disabled={syncing}>{file.retimed ? "Undo: mux the original" : "Discard"}</L>}
          <L icon={<TextAlignJustifyRegular />} onClick={() => void beginSync([file.id])} disabled={!canRun}>Sync again</L>
        </Links>
        <DL
          rows={[
            ["Against", `${record.engine === "subtitle" ? `The video's subtitle track ${record.referenceTrack + 1}` : `The video's speech (audio ${record.referenceTrack + 1})`} · ${record.videoName}`],
            ...(record.score !== null
              ? ([["Score", <span key="s" className="cell num"><Meter pct={record.score * 100} />{Math.round(record.score * 100)}%{record.confidence ? ` · ${record.confidence} confidence` : ""}</span>]] as [string, JSX.Element][])
              : []),
            ...(record.description ? ([["Engine", record.description]] as [string, string][]) : []),
            ...(file.retimed ? ([["Muxed", <span key="r" className="truncate" title={file.retimed.path}>The re-timed copy, at delay 0: {file.retimed.path.replace(/^.*[\\/]/, "")}</span>]] as [string, JSX.Element][]) : []),
            ...(record.engine === "audio" && measured
              ? ([["Note", `Measured from speech, which can sit a few hundred ms off the cues: filled in only at high confidence and a score of ${Math.round(AUDIO_MIN_SCORE * 100)}% or more. Check a line or two before muxing.`]] as [string, string][])
              : []),
            ...(record.warnings.length ? ([["Warnings", record.warnings.join(" ")]] as [string, string][]) : []),
            ...(stale ? ([["Pairing", `Measured against ${record.videoName}; this row's video is ${video?.name}. Sync it again.`]] as [string, string][]) : []),
          ]}
        />
        <div className="hr" />
      </>
    );
  };

  return (
    <PageView
      hidden={hidden}
      status={status}
      dock={<PageDock common={shell.dock} />}
      tools={
        <>
          <Cmd icon={<ArrowImportRegular />} disabled={syncing} onClick={handleImportSubtitles}>Import from a video</Cmd>
          <Cmd icon={<ArrowSyncRegular />} title="Rescan" disabled={!folder || syncing} onClick={() => void scanSubtitles(folder)} />
          <Cmd icon={<CopyRegular />} title="Duplicate the file" disabled={!selectedFile || syncing} onClick={() => selectedRow !== null && duplicateSubtitleFile(selectedRow)} />
          <Cmd icon={<DeleteRegular />} title="Remove (Del)" disabled={!canRemove} onClick={() => selectedRow !== null && removeSubtitleFile(selectedRow)} />
          {selectedFile && canUndoSync(selectedFile) && (
            <Cmd icon={<ArrowUndoRegular />} title="Back to the original file and its delay as it was before syncing" disabled={syncing} onClick={() => updateFile(selectedFile.id, undoSync)}>
              Undo sync
            </Cmd>
          )}
        </>
      }
      primary={
        syncing ? (
          <Btn icon={<StopRegular />} kbd="Esc" onClick={() => void cancelSync()}>Stop</Btn>
        ) : pendingCount > 0 ? (
          <>
            <Btn icon={<ArrowSyncRegular />} title="Sync every subtitle again" aria-label="Sync every subtitle again" disabled={!canSync} onClick={() => void beginSync()} />
            <Btn accent icon={<CheckmarkRegular />} onClick={applyPending}>Apply {pendingCount} {pendingCount === 1 ? "delay" : "delays"}</Btn>
          </>
        ) : syncedCount > 0 ? (
          <Btn icon={<ArrowSyncRegular />} title="Sync every subtitle again" disabled={!canSync} onClick={() => void beginSync()}>Sync again</Btn>
        ) : (
          <Btn accent icon={<TextAlignJustifyRegular />} kbd="Enter" title={syncTitle} disabled={!canSync} onClick={() => void beginSync()}>
            Sync subtitles
          </Btn>
        )
      }
    >
      <Panel
        label={`Subtitle ${activeSubtitleTrack}`}
        left={
          <TrackTabs
            kind="subtitle"
            slots={subtitleTracks}
            active={activeSubtitleTrack}
            configs={subtitleTrackConfigs}
            disabled={syncing}
            onPick={(slot) => {
              setActiveSubtitleTrack(slot);
              setSelectedRow(null);
            }}
            onNew={addNewTrack}
            onDuplicate={duplicateTrack}
            onDelete={confirmDeleteTrack}
          />
        }
        end={
          realSubtitleFiles.length > 0 && (
            <>
              <PairByCombo value={pairing.pairBy} chosen={pairing.chosen} disabled={syncing} onChange={pairing.choose} />
              <Combo<FilterValue> ghost sm w={96} label="Rows" value={filter} options={FILTER_OPTIONS} onChange={setFilter} />
              <SearchBox value={search} onChange={setSearch} label="Search subtitles" w={150} />
            </>
          )
        }
        sheet={
          <TrackSheet
            kind="subtitle"
            config={currentConfig}
            onChange={updateCurrentConfig}
            muxAfterOptions={muxAfterOptions}
            folder={folder}
            onBrowse={() => void chooseFolder()}
            formats={{ value: currentConfig.extension, options: extensionOptions(SUBTITLE_EXTENSIONS), onChange: (extension) => updateCurrentConfig({ extension }) }}
          />
        }
      >
        {realSubtitleFiles.length > 0 ? (
          <Table
            cols="24px minmax(0,1fr) minmax(0,1fr) 104px minmax(0,1fr) 80px 96px 196px"
            head={["#", "Video", "Subtitle file", "Match", "Against", " Delay", "Score", "Status"]}
            label={`Subtitle ${activeSubtitleTrack}`}
            bodyRef={bodyRef}
          >
            {rows.map(({ index, video, entry, file }) => {
              const dragProps = drag.rowProps(index);
              const paired = file ? (videoOf(file) ?? video) : undefined;
              const reference = file && paired ? (isPictureSubtitle(file) ? null : chooseReference(file, paired)) : null;
              const record = file?.subsync;
              const pending = file ? pendingSyncDelay(file) : null;
              const running = file && syncing ? syncProgress?.active[file.id] : undefined;
              const state: { s: St; text: string } | null = file ? syncStatus(file, paired) : null;
              const delayText = !file ? "" : file.retimed ? "copy" : pending ? formatDelay(pending.seconds) : formatDelay(file.delay);
              return (
                <Tr
                  key={entry?.id ?? `video-${video?.id}`}
                  on={selectedRow === index}
                  className={dragProps.className}
                  onPointerDown={file ? dragProps.onPointerDown : undefined}
                  onClick={() => setSelectedRow(index)}
                  onDoubleClick={() => file && openEditDialog(file.id)}
                  label={file?.name ?? video?.name}
                >
                  <span className="num t3">{index + 1}</span>
                  {video ? <span className="t2 truncate" title={video.name}>{video.name}</span> : <span className="warn">No video</span>}
                  {file ? (
                    <span className="cell"><Grip /><span className="truncate" title={file.name}>{file.name}</span></span>
                  ) : (
                    <span className="nil" title={entry ? "No file for this video: the files after it stay with their own" : undefined}>—</span>
                  )}
                  <MatchCell file={file} info={file ? pairing.infoOf(file.id) : undefined} conflict={file ? pairing.conflictOf(file.id) : undefined} />
                  <span className="t3 truncate" title={reference && "label" in reference ? reference.label : undefined}>
                    {!file || !paired ? "" : isPictureSubtitle(file) ? "Pictures" : reference && "label" in reference ? reference.label : "—"}
                  </span>
                  <span
                    className={cx("r num", pending && !record?.held ? "acc" : "t2")}
                    style={{ display: "flex" }}
                    title={file?.retimed ? `Muxed as the re-timed copy, at delay 0: ${file.retimed.path}` : pending ? "Measured, not applied yet" : undefined}
                  >
                    {delayText}
                  </span>
                  {record?.score != null ? (
                    <span className="cell num t2" title={record.confidence ? `${record.confidence} confidence` : undefined}><Meter pct={record.score * 100} />{Math.round(record.score * 100)}%</span>
                  ) : (
                    <span className="t3">{file ? "—" : ""}</span>
                  )}
                  {!file ? (
                    <span />
                  ) : running ? (
                    <Status s="run" pct={running.percent} text={running.stage ?? undefined} />
                  ) : syncing && (!syncRun.ids || syncRun.ids.has(file.id)) && !(record && Date.parse(record.measuredAt) >= syncRun.startedAt) ? (
                    <Status s="wait" />
                  ) : (
                    <span className="cell" style={{ minWidth: 0 }} title={record?.description ?? state!.text}><Status s={state!.s} text={state!.text} /></span>
                  )}
                </Tr>
              );
            })}
          </Table>
        ) : (
          <Empty icon={<ClosedCaptionRegular />} title="Drop a folder of subtitles">
            <Btn icon={<FolderOpenRegular />} onClick={() => void chooseFolder()}>Choose folder</Btn>
            <Btn icon={<ArrowImportRegular />} onClick={handleImportSubtitles}>Import from a video</Btn>
          </Empty>
        )}
      </Panel>

      {importStreamsOpen && (
        <ImportStreamsDialog
          kind="subtitle"
          videoFiles={videoFiles}
          sourceId={importSourceVideoId}
          onSource={(value) => {
            setImportSourceVideoId(value);
            setImportSelectedTrackKeys([]);
            setImportOverrides({});
          }}
          streams={importableTracks}
          selectedKeys={importSelectedTrackKeys}
          onSelectedKeys={setImportSelectedTrackKeys}
          overrides={importOverrides}
          onOverride={(key, value) => setImportOverrides((prev) => ({ ...prev, [key]: value }))}
          keyOf={getImportTrackKey}
          targetLabel={`Into row ${importRow + 1}${videoFiles[importRow] ? `, beside ${videoFiles[importRow].name}` : ""}${importRow < (selectedRow ?? 0) ? ", the first without a file" : ""}`}
          onCancel={() => {
            setImportStreamsOpen(false);
            setImportOverrides({});
          }}
          onImport={handleConfirmImportSubtitles}
        />
      )}

      {editDialogOpen && editingFile && (
        <Dialog
          size="form"
          title="Edit subtitle file"
          sub={[editingFile.name, videoFiles.find((video) => video.id === editingFile.matchedVideoId)?.name].filter(Boolean).join(" · with ")}
          onClose={closeEdit}
          left={
            <>
              <span className="t3">For every file</span>
              <Chk on={editForm.applyDelayToAll} onChange={(applyDelayToAll) => setEditForm((prev) => ({ ...prev, applyDelayToAll }))}>This delay</Chk>
              <span title="Track choices apply by position">
                <Chk on={editForm.applyToAllFiles} onChange={(applyToAllFiles) => setEditForm((prev) => ({ ...prev, applyToAllFiles }))}>Every setting</Chk>
              </span>
            </>
          }
          foot={
            <>
              <Btn onClick={closeEdit}>Cancel</Btn>
              <Btn accent disabled={!delayInputsAreValid(editForm.delay)} onClick={applyEditChanges}>Save</Btn>
            </>
          }
        >
          {syncPart(editingFile)}
          {(() => {
            const info = pairing.infoOf(editingFile.id);
            const conflict = pairing.conflictOf(editingFile.id);
            return (
              <>
                <DL rows={[["Paired", pairingLine(info, conflict, editingFile)]]} />
                <Links>
                  <PairingLinks info={info} conflict={conflict} disabled={syncing} onKeep={() => pairing.keep(editingFile.id)} onRelease={() => pairing.release(editingFile.id)} />
                </Links>
              </>
            );
          })()}
          <div className="egrid">
            <Fld label="Language"><LangCombo value={editForm.language} onChange={(language) => setEditForm((prev) => ({ ...prev, language }))} w="100%" /></Fld>
            <Fld label="Track name"><TBox label="Track name" value={editForm.trackName} placeholder="Keep the file's name" onChange={(trackName) => setEditForm((prev) => ({ ...prev, trackName }))} /></Fld>
            <DelayField value={editForm.delay} onChange={(delay) => setEditForm((prev) => ({ ...prev, delay }))} />
            <Fld label="Place after"><Combo<string> label="Place after" value={editForm.muxAfter} options={muxAfterOptions} w="100%" onChange={(muxAfter) => setEditForm((prev) => ({ ...prev, muxAfter }))} /></Fld>
          </div>
          <div className="row" style={{ gap: 28 }}>
            <span title="The first included track becomes the default">
              <Chk on={editForm.isDefault} onChange={(isDefault) => setEditForm((prev) => ({ ...prev, isDefault }))}>Default</Chk>
            </span>
            <span title="Forced display for the copied tracks">
              <Chk on={editForm.isForced} onChange={(isForced) => setEditForm((prev) => ({ ...prev, isForced }))}>Forced</Chk>
            </span>
            <span title="Before the video's own subtitles, the first one default">
              <Chk
                on={editForm.muxAfter === "subtitle-first" && editForm.isDefault}
                onChange={(on) =>
                  setEditForm((prev) => ({
                    ...prev,
                    isDefault: on ? true : prev.isDefault,
                    muxAfter: on ? "subtitle-first" : prev.muxAfter === "subtitle-first" ? "audio" : prev.muxAfter,
                  }))
                }
              >
                First and default
              </Chk>
            </span>
          </div>
          {editingFile.tracks && editingFile.tracks.length > 1 && (
            <FileTracks
              title="Tracks in this file"
              tools={
                <>
                  {editingFile.tracks.filter((track) => track.type === "subtitle").length > 1 && (
                    <Cmd sm icon={<TimelineRegular />} onClick={() => openMultiDelayDialog(editingFile.id)}>Track delays…</Cmd>
                  )}
                  <Cmd
                    sm
                    icon={<CheckmarkRegular />}
                    onClick={() =>
                      setEditForm((prev) => ({
                        ...prev,
                        includedTrackIds: editingFile.tracks ? editingFile.tracks.map((track) => Number(track.id)).filter((id) => !Number.isNaN(id)) : prev.includedTrackIds,
                      }))
                    }
                  >
                    All
                  </Cmd>
                  <Cmd sm icon={<DismissRegular />} onClick={() => setEditForm((prev) => ({ ...prev, includedTrackIds: [] }))}>None</Cmd>
                </>
              }
            >
              {editingFile.tracks.map((track, index) => {
                const trackId = Number(track.id);
                return (
                  <FileTrackRow
                    key={track.id}
                    index={index}
                    label={[track.language ? languageName(track.language) : null, track.codec, track.name].filter(Boolean).join(" · ") || `Track ${index + 1}`}
                    on={editForm.includedTrackIds.includes(trackId)}
                    onChange={(on) => {
                      const next = new Set(editForm.includedTrackIds);
                      if (on) {
                        if (!Number.isNaN(trackId)) next.add(trackId);
                      } else next.delete(trackId);
                      setEditForm((prev) => ({ ...prev, includedTrackIds: Array.from(next) }));
                    }}
                    isDefault={track.isDefault}
                    onEdit={() => openTrackEdit(editingFile.id, trackId)}
                  />
                );
              })}
            </FileTracks>
          )}
        </Dialog>
      )}

      {multiDelayOpen && multiDelayFile && (
        <TrackDelaysDialog
          kind="subtitle"
          file={multiDelayFile}
          values={multiDelayValues}
          onValues={setMultiDelayValues}
          bulk={multiDelayBulkValue}
          onBulk={setMultiDelayBulkValue}
          onCancel={() => {
            setMultiDelayOpen(false);
            setMultiDelayFileId(null);
            setMultiDelayValues({});
          }}
          onSave={applyMultiDelayChanges}
        />
      )}

      <ImportTrackEditDialog
        open={trackEditOpen}
        onOpenChange={(open) => {
          setTrackEditOpen(open);
          if (!open) setTrackEditTarget(null);
        }}
        kind="subtitle"
        title="Edit a track"
        trackLabel={trackEditTarget ? `Track ${trackEditTarget.trackId}` : ""}
        value={{ language: trackEditForm.language, trackName: trackEditForm.trackName, delay: delaySecondsOrZero(trackEditForm.delay) }}
        onSave={applyTrackEdit}
      />

      {deleteDialogOpen && trackToDelete && (
        <DeleteSlotDialog
          kind="subtitle"
          slot={trackToDelete}
          onCancel={() => {
            setDeleteDialogOpen(false);
            setTrackToDelete(null);
          }}
          onDelete={deleteTrack}
        />
      )}
    </PageView>
  );
}
