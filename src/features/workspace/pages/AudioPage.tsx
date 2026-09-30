/** Audio: external audio (dubs) for each video, in track slots (Audio 1,
 *  Audio 2…), with delay measurement. Row n of the list is video n and file
 *  n, which is how the mux pairs them. The logic is the old Audio tab's; the
 *  measurement readout moved from the rows into the inspector. */

import {
  ArrowImportRegular,
  ArrowSyncRegular,
  CheckmarkRegular,
  CopyRegular,
  DeleteRegular,
  DismissRegular,
  EditRegular,
  FolderOpenRegular,
  GaugeRegular,
  MusicNote2Regular,
  StopRegular,
  TimelineRegular,
} from "@fluentui/react-icons";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { PageDock } from "@/app/dock";
import { runName, timeLeftText, tookText } from "@/app/history";
import { useShell, usePageCommands, useStatus } from "@/app/shell";
import { ImportTrackEditDialog, type ImportTrackOverride } from "@/features/workspace/components/ImportTrackEditDialog";
import { useMeasureDelays } from "@/features/workspace/hooks/useMeasureDelays";
import { acceptWithheldMeasurement, applyAllPendingDelays, hasPendingDelay, markDelayAsManual } from "@/features/workspace/lib/applyMeasurement";
import { audioFpsFor, formatAudioFps, needsRateChange } from "@/features/workspace/lib/audioFps";
import { measureFindings, measureOutcome, measureStatus, measurementsOf } from "@/features/workspace/lib/measureVerdict";
import { DEFAULT_REFERENCE_TRACK, plannedReferenceTrack, referenceForEveryVideo } from "@/features/workspace/lib/measurePairs";
import { frameOffset } from "@/features/workspace/lib/delayConversion";
import { applyTimelineDelay } from "@/features/workspace/lib/timelineScan";
import { useRowReorder } from "@/features/workspace/lib/useRowReorder";
import { useTabState, type TrackConfig } from "@/features/workspace/store/useTabState";
import { DelayField, delayInputsAreValid } from "@/shared/components/DelayField";
import { CODE_TO_LABEL, LABEL_TO_CODE } from "@/shared/data/languages-iso6393";
import { inspectPaths, pickDirectory, scanMedia } from "@/shared/lib/backend";
import { delaySecondsOrZero } from "@/shared/lib/delayInput";
import { AUDIO_EXTENSIONS } from "@/shared/lib/extensions";
import { getUnlinkedExternalFiles, linkExternalFilesByOrder } from "@/shared/lib/matchUtils";
import type { ExternalFile, MeasurementSettings, Preset, StretchSetting, VideoFile } from "@/shared/types";
import { Dialog, PageView, Panel, lcdStatus, type LcdProps } from "@/ui/frame";
import { Btn, Chk, Cmd, Combo, DL, Empty, Fld, Grip, LangCombo, Links, Meter, SheetField, Status, TBox, Table, Tr, cx, type St } from "@/ui/kit";
import { toast } from "@/ui/toast";

import { FILTER_OPTIONS, SearchBox, extensionOptions, formatDelay, formatFileSize, looksLikeFolder, matchesSearch, type FilterValue } from "./common";
import { L, MeasureSection } from "./tracks/MeasurePane";
import { DeleteSlotDialog, FileTrackRow, FileTracks, ImportStreamsDialog, TrackDelaysDialog, TrackSheet, TrackTabs, languageName } from "./tracks/parts";

export interface AudioPageProps {
  hidden: boolean;
  audioFiles: ExternalFile[];
  videoFiles: VideoFile[];
  onAudioFilesChange: (files: ExternalFile[]) => void;
  onVideoFilesChange?: (files: VideoFile[]) => void;
  preset?: Preset | null;
  /** Preferences › Measurement; the engine gets these, so they must match AudioSyncMaster's. */
  measurement?: MeasurementSettings;
}

const defaultTrackConfig: TrackConfig = {
  sourceFolder: "",
  extension: "all",
  language: "hin",
  trackName: "",
  delay: "0.000",
  isDefault: true,
  isForced: false,
  muxAfter: "video",
};

const normalizeLanguage = (value: string) => {
  if (!value) return "und";
  const trimmed = value.trim();
  if (CODE_TO_LABEL[trimmed]) return trimmed;
  return LABEL_TO_CODE[trimmed] || LABEL_TO_CODE[trimmed.toLowerCase()] || trimmed.toLowerCase();
};

const audioExtensions = [...AUDIO_EXTENSIONS];

const getAudioTrackIds = (file: ExternalFile) =>
  file.tracks ? file.tracks.filter((t) => t.type === "audio").map((t) => Number(t.id)).filter((id) => Number.isFinite(id)) : [];

const getSubtitleTrackIds = (file: ExternalFile) =>
  file.tracks ? file.tracks.filter((t) => t.type === "subtitle").map((t) => Number(t.id)).filter((id) => Number.isFinite(id)) : [];

const getDefaultIncludeSubtitles = (file: ExternalFile) => (file.includeSubtitles !== undefined ? file.includeSubtitles : getSubtitleTrackIds(file).length > 0);

/** Per-track measurement results for a file, in track order. */
const measuredTrackEntries = (file: ExternalFile) => {
  const overrides = file.trackOverrides;
  if (!overrides) return [];
  return (file.tracks ?? [])
    .filter((track) => track.type === "audio")
    .map((track, index) => {
      const trackId = Number(track.id);
      const override = overrides[trackId];
      if (!Number.isFinite(trackId) || !override?.measuredDelay) return null;
      return { trackId, override, track, label: `${index + 1}` };
    })
    .filter((entry): entry is NonNullable<typeof entry> => entry !== null);
};

const createExternalId = () =>
  typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}`;

const audioTracksOf = (video: VideoFile | undefined) => (video?.tracks ?? []).filter((track) => track.type === "audio");

/** "2 · Korean": a reference track, short, for the Against column. */
function shortReference(track: { language?: string }, index: number): string {
  const language = track.language ? (CODE_TO_LABEL[track.language] ?? track.language) : null;
  return language ? `${index + 1} · ${language}` : `${index + 1}`;
}

/** A reference track's name: enough to tell a dub from a commentary. */
function referenceLabel(track: { language?: string; name?: string; codec?: string }, index: number): string {
  const parts: string[] = [`${index + 1}`];
  const language = track.language ? (CODE_TO_LABEL[track.language] ?? track.language) : null;
  if (language) parts.push(language);
  if (track.codec) parts.push(track.codec.toUpperCase());
  if (track.name) parts.push(track.name);
  return parts.join(" · ");
}

/** The worst status among a file's measurements, for its row. */
function rowStatus(file: ExternalFile, currentReferenceTrack: number | undefined): { s: St; text: string } {
  const entries = [
    ...(file.measuredDelay ? [{ m: file.measuredDelay, pending: file.pendingDelay !== undefined }] : []),
    ...measuredTrackEntries(file).map(({ override }) => ({ m: override.measuredDelay!, pending: override.pendingDelay !== undefined })),
  ];
  if (entries.length === 0) return { s: "ready", text: "Ready" };
  const rank: Record<St, number> = { bad: 0, warn: 1, ok: 2, run: 3, writing: 3, wait: 4, ready: 5, written: 2 };
  return entries.map(({ m, pending }) => measureStatus(m, { pending, currentReferenceTrack })).sort((a, b) => rank[a.s] - rank[b.s])[0];
}

export function AudioPage({ hidden, audioFiles, videoFiles, onAudioFilesChange, preset, measurement }: AudioPageProps) {
  const shell = useShell();
  const syncAudioLinks = useCallback((files: ExternalFile[]) => linkExternalFilesByOrder(files, videoFiles), [videoFiles]);
  const {
    audioTracks,
    activeAudioTrack,
    audioTrackConfigs,
    audioPresetApplied,
    setAudioTracks,
    setActiveAudioTrack,
    updateAudioTrackConfig,
    removeAudioTrackConfig,
    setAudioPresetApplied,
  } = useTabState((state) => ({
    audioTracks: state.audioTracks,
    activeAudioTrack: state.activeAudioTrack,
    audioTrackConfigs: state.audioTrackConfigs,
    audioPresetApplied: state.audioPresetApplied,
    setAudioTracks: state.setAudioTracks,
    setActiveAudioTrack: state.setActiveAudioTrack,
    updateAudioTrackConfig: state.updateAudioTrackConfig,
    removeAudioTrackConfig: state.removeAudioTrackConfig,
    setAudioPresetApplied: state.setAudioPresetApplied,
  }));
  /** The selected row: video n and audio file n. */
  const [selectedRow, setSelectedRow] = useState<number | null>(null);
  /** The selected file's details popup (a double-click on its row). */
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState<FilterValue>("all");
  /** Which audio track of each video to measure against, by video id. Empty
   *  means "the first audio track", as AudioSyncMaster does. */
  const [referenceTrackByVideoId, setReferenceTrackByVideoId] = useState<Record<string, number>>({});

  /** The reference track in force for the video a file is matched to, so a
   *  measurement taken against a different one can be flagged as out of date. */
  const currentReferenceFor = useCallback(
    (file: ExternalFile): number | undefined => {
      if (!file.matchedVideoId) return undefined;
      const video = videoFiles.find((entry) => entry.id === file.matchedVideoId);
      if (!video) return undefined;
      return plannedReferenceTrack(video, referenceTrackByVideoId);
    },
    [videoFiles, referenceTrackByVideoId],
  );

  const { engine: audiosyncEngine, isMeasuring, progress: measureProgress, start: startMeasuring, cancel: cancelMeasuring } = useMeasureDelays({
    videoFiles,
    audioFiles,
    onAudioFilesChange,
    referenceTrackByVideoId,
    measurement,
  });
  const measurementAvailable = Boolean(audiosyncEngine?.engineAvailable && audiosyncEngine.ffmpegAvailable);

  // ------------------------------------------------------------ the engine
  // One command at a time: measuring holds the engine, so Mux cannot start a
  // batch meanwhile, and the other way round.
  const isMeasuringRef = useRef(isMeasuring);
  isMeasuringRef.current = isMeasuring;
  const run = useRef<{ ids: Set<string> | null; startedAt: number } | null>(null);
  const beginMeasuring = useCallback(
    async (options: { onlyAudioFileIds?: string[]; force?: boolean } = {}) => {
      if (isMeasuringRef.current) return;
      if (!shell.claimEngine("audio")) {
        toast({ title: "Muxing is running", description: "Measure once the batch is done, or stop it first." });
        return;
      }
      run.current = { ids: options.onlyAudioFileIds ? new Set(options.onlyAudioFileIds) : null, startedAt: Date.now() };
      shell.log(`Measuring ${options.onlyAudioFileIds ? "1 file" : "Audio " + activeAudioTrack} against ${measurement?.windowCount ?? 6} × ${measurement?.windowSeconds ?? 45} s windows`);
      await startMeasuring(options);
      // Nothing to measure (a toast said why): give the engine back.
      window.setTimeout(() => {
        if (!isMeasuringRef.current) {
          run.current = null;
          shell.releaseEngine("audio");
        }
      }, 50);
    },
    [shell, startMeasuring, activeAudioTrack, measurement?.windowCount, measurement?.windowSeconds],
  );

  // A run that ends: release the engine, record it, and log what it found.
  const wasMeasuring = useRef(false);
  const audioFilesRef = useRef(audioFiles);
  audioFilesRef.current = audioFiles;
  useEffect(() => {
    if (isMeasuring) {
      wasMeasuring.current = true;
      return;
    }
    if (!wasMeasuring.current) return;
    wasMeasuring.current = false;
    shell.releaseEngine("audio");
    const current = run.current;
    run.current = null;
    if (!current) return;
    const files = audioFilesRef.current.filter((file) => (current.ids ? current.ids.has(file.id) : true) && measurementsOf(file).some((m) => Date.parse(m.measuredAt) >= current.startedAt - 1000));
    if (files.length === 0) return;
    for (const file of files) {
      for (const m of measurementsOf(file)) {
        const top = measureFindings(m, currentReferenceFor(file)).find((finding) => finding.tone !== "ok");
        if (top) shell.log(`${file.name}: ${top.word.toLowerCase()}: ${top.line}`);
      }
    }
    const outcome = measureOutcome(files);
    shell.log(`Measured ${files.length} file${files.length === 1 ? "" : "s"} in ${tookText(Date.now() - current.startedAt)}: ${outcome.parts.join(", ")}`);
    shell.addHistory({
      id: createExternalId(),
      page: "audio",
      name: runName(files.map((file) => file.name)),
      outcome: { tone: outcome.tone, text: outcome.parts.join(", ") },
      date: new Date().toISOString(),
      files: files.map((file) => {
        const status = rowStatus(file, currentReferenceFor(file));
        return { name: file.name, tone: status.s, text: status.text };
      }),
    });
  }, [isMeasuring, shell, currentReferenceFor]);

  // ---------------------------------------------------------- measurement

  const setStretchForFile = useCallback(
    (fileId: string, stretch: StretchSetting | undefined) => onAudioFilesChange(audioFiles.map((file) => (file.id === fileId ? { ...file, stretch } : file))),
    [audioFiles, onAudioFilesChange],
  );
  /** The same opt-in, but per track: a container can hold one dub that was
   *  rate-converted and one that was not. */
  const setStretchForTrack = useCallback(
    (fileId: string, trackId: number, stretch: StretchSetting | undefined) =>
      onAudioFilesChange(
        audioFiles.map((file) =>
          file.id === fileId ? { ...file, trackOverrides: { ...file.trackOverrides, [trackId]: { ...(file.trackOverrides?.[trackId] ?? {}), stretch } } } : file,
        ),
      ),
    [audioFiles, onAudioFilesChange],
  );

  /** Re-measure one row, ignoring the skip rules for it alone. */
  const remeasureFile = useCallback((fileId: string) => void beginMeasuring({ onlyAudioFileIds: [fileId], force: true }), [beginMeasuring]);

  // Drives the Apply button; measuredCount separately gates the re-measure offer.
  const pendingCount = useMemo(() => audioFiles.filter(hasPendingDelay).length, [audioFiles]);
  const measuredCount = useMemo(() => audioFiles.filter((file) => file.measuredDelay || Object.values(file.trackOverrides ?? {}).some((o) => o.measuredDelay)).length, [audioFiles]);

  const applyAllMeasuredDelays = useCallback(() => {
    onAudioFilesChange(audioFiles.map(applyAllPendingDelays));
    shell.log(`Applied ${pendingCount} measured ${pendingCount === 1 ? "delay" : "delays"}`);
    toast({ title: `Applied ${pendingCount} ${pendingCount === 1 ? "delay" : "delays"}`, description: "The measured values are now the files' delays." });
  }, [audioFiles, onAudioFilesChange, pendingCount, shell]);

  /** Accept one file's measurement, leaving every other file alone. */
  const applyOneMeasuredDelay = useCallback(
    (fileId: string) => onAudioFilesChange(audioFiles.map((file) => (file.id === fileId ? applyAllPendingDelays(file) : file))),
    [audioFiles, onAudioFilesChange],
  );

  const applyCutDelayAnyway = useCallback(
    (fileId: string, trackId: number | null) => {
      const file = audioFiles.find((candidate) => candidate.id === fileId);
      if (!file) return;
      const accepted = acceptWithheldMeasurement(file, trackId);
      if (accepted === file) return;
      onAudioFilesChange(audioFiles.map((candidate) => (candidate.id === fileId ? accepted : candidate)));
      toast({ title: "Delay applied", description: "The measured delay is in despite the warning." });
    },
    [audioFiles, onAudioFilesChange],
  );

  const applyTimelineDelayFor = useCallback(
    (fileId: string, trackId: number | null) => {
      const file = audioFiles.find((candidate) => candidate.id === fileId);
      if (!file) return;
      const updated = applyTimelineDelay(file, trackId);
      if (updated === file) return;
      onAudioFilesChange(audioFiles.map((candidate) => (candidate.id === fileId ? updated : candidate)));
      toast({ title: "Timeline delay applied", description: "The whole-timeline scan's opening offset is now the delay." });
    },
    [audioFiles, onAudioFilesChange],
  );

  // --------------------------------------------------------------- dialogs

  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [trackToDelete, setTrackToDelete] = useState<string | null>(null);
  const [editDialogOpen, setEditDialogOpen] = useState(false);
  const [editingFileId, setEditingFileId] = useState<string | null>(null);
  const audioFilesCache = useRef<Record<string, ExternalFile[]>>({});
  const [trackEditOpen, setTrackEditOpen] = useState(false);
  const [trackEditTarget, setTrackEditTarget] = useState<{ fileId: string; trackId: number; trackType: "audio" | "subtitle" } | null>(null);
  const [trackEditForm, setTrackEditForm] = useState({ language: "und", delay: "0.000", trackName: "" });
  const [multiDelayOpen, setMultiDelayOpen] = useState(false);
  const [multiDelayFileId, setMultiDelayFileId] = useState<string | null>(null);
  const [multiDelayTrackType, setMultiDelayTrackType] = useState<"audio" | "subtitle">("audio");
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
    muxAfter: "video",
    applyDelayToAll: false,
    applyToAllFiles: false,
    includedTrackIds: [] as number[],
    includeSubtitles: false,
    includedSubtitleTrackIds: [] as number[],
    includedSubtitlesDefault: false,
    includedSubtitlesForced: false,
    includedSubtitlesFirst: false,
  });

  const currentConfig = audioTrackConfigs[activeAudioTrack] || defaultTrackConfig;
  const editingFile = audioFiles.find((file) => file.id === editingFileId) || null;
  const multiDelayFile = audioFiles.find((file) => file.id === multiDelayFileId) || null;

  const muxAfterOptions = useMemo(() => {
    const primaryTracks = videoFiles[0]?.tracks || [];
    const trackCount = primaryTracks.length || Math.max(0, ...videoFiles.map((video) => video.tracks?.length || 0));
    const options = [{ value: "video", label: "Video" }];
    for (let i = 1; i <= trackCount; i += 1) {
      const track = primaryTracks[i - 1];
      options.push({ value: `track-${i}`, label: track ? `Track ${i} - ${track.type}${track.language ? ` (${track.language})` : ""}` : `Track ${i}` });
    }
    options.push({ value: "end", label: "End" });
    return options;
  }, [videoFiles]);

  const selectedImportSource = useMemo(() => videoFiles.find((file) => file.id === importSourceVideoId) || null, [videoFiles, importSourceVideoId]);
  const unlinkedCount = useMemo(() => getUnlinkedExternalFiles(audioFiles, videoFiles).length, [audioFiles, videoFiles]);
  const importableTracks = useMemo(
    () => (selectedImportSource ? (selectedImportSource.tracks || []).filter((track) => track.type === "audio" && track.action !== "remove") : []),
    [selectedImportSource],
  );
  const getImportTrackKey = (trackIndex: number, trackId: string) => `${trackIndex}:${trackId}`;

  const updateCurrentConfig = (updates: Partial<TrackConfig>) => updateAudioTrackConfig(activeAudioTrack, updates);

  const lastAppliedConfig = useRef<TrackConfig | null>(null);
  useEffect(() => {
    if (audioFiles.length === 0) return;
    const prev = lastAppliedConfig.current;
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
    lastAppliedConfig.current = { ...currentConfig };
    const delayValue = delaySecondsOrZero(currentConfig.delay);
    onAudioFilesChange(
      audioFiles.map((file) => ({
        ...file,
        // Global default/forced toggles must always apply from the slot's settings.
        isDefault: currentConfig.isDefault,
        isForced: currentConfig.isForced,
        ...(file.isManuallyEdited
          ? {}
          : {
              language: currentConfig.language,
              trackName: currentConfig.trackName,
              // An accepted measurement is the file's own delay, not a slot for
              // the global default to keep overwriting.
              delay: file.delayProvenance === "measured" ? file.delay : delayValue,
              muxAfter: currentConfig.muxAfter,
            }),
      })),
    );
  }, [audioFiles, currentConfig, onAudioFilesChange]);

  useEffect(() => {
    audioFilesCache.current[activeAudioTrack] = audioFiles;
  }, [audioFiles, activeAudioTrack]);
  useEffect(() => {
    const cached = audioFilesCache.current[activeAudioTrack];
    if (!cached || cached === audioFiles) return;
    if (cached.length === audioFiles.length) return;
    onAudioFilesChange(cached);
  }, [activeAudioTrack, audioFiles, onAudioFilesChange]);

  const addNewTrack = useCallback(() => {
    const newTrackNumber = (audioTracks.length + 1).toString();
    setAudioTracks([...audioTracks, newTrackNumber]);
    updateAudioTrackConfig(newTrackNumber, { ...defaultTrackConfig });
    setActiveAudioTrack(newTrackNumber);
    setSelectedRow(null);
    toast({ title: `Audio ${newTrackNumber} added` });
  }, [audioTracks, setActiveAudioTrack, setAudioTracks, updateAudioTrackConfig]);

  const duplicateTrack = () => {
    const newTrackNumber = (audioTracks.length + 1).toString();
    const currentSettings = audioTrackConfigs[activeAudioTrack] || defaultTrackConfig;
    setAudioTracks([...audioTracks, newTrackNumber]);
    updateAudioTrackConfig(newTrackNumber, { ...currentSettings });
    setActiveAudioTrack(newTrackNumber);
    toast({ title: `Audio ${newTrackNumber} added`, description: `With the settings of Audio ${activeAudioTrack}.` });
  };

  const reorderAudioFile = (fromIndex: number, toIndex: number) => {
    if (toIndex < 0 || toIndex >= audioFiles.length) return;
    const updated = [...audioFiles];
    const [moved] = updated.splice(fromIndex, 1);
    updated.splice(toIndex, 0, moved);
    onAudioFilesChange(syncAudioLinks(updated));
    setSelectedRow(toIndex);
  };

  const removeAudioFile = (index: number) => {
    onAudioFilesChange(syncAudioLinks(audioFiles.filter((_, currentIndex) => currentIndex !== index)));
    setSelectedRow(null);
  };

  const duplicateAudioFile = (index: number) => {
    const original = audioFiles[index];
    if (!original) return;
    if (videoFiles.length === 0) {
      toast({ title: "Nothing to duplicate into", description: "Add video files before duplicating audio.", variant: "destructive" });
      return;
    }
    if (audioFiles.length >= videoFiles.length) {
      toast({ title: "Nothing to duplicate into", description: "There cannot be more audio files than videos.", variant: "destructive" });
      return;
    }
    const newFile: ExternalFile = { ...original, id: `audio-dup-${Date.now()}-${Math.random().toString(36).slice(2, 8)}` };
    const updated = [...audioFiles];
    updated.splice(index + 1, 0, newFile);
    onAudioFilesChange(linkExternalFilesByOrder(updated, videoFiles));
    setSelectedRow(index + 1);
    toast({ title: "Audio duplicated", description: `${original.name}, paired by row.` });
  };

  const openEditDialog = (fileId: string) => {
    const file = audioFiles.find((entry) => entry.id === fileId);
    if (!file) return;
    const defaultIncluded = file.tracks && file.tracks.length > 0 ? getAudioTrackIds(file) : [];
    setEditingFileId(fileId);
    setEditForm({
      trackName: file.trackName || "",
      language: file.language || "und",
      delay: (file.delay ?? 0).toFixed(3),
      isDefault: file.isDefault || false,
      isForced: file.isForced || false,
      muxAfter: file.muxAfter || "video",
      applyDelayToAll: false,
      applyToAllFiles: false,
      includedTrackIds: file.includedTrackIds !== undefined ? [...file.includedTrackIds] : defaultIncluded,
      includeSubtitles: getDefaultIncludeSubtitles(file),
      includedSubtitleTrackIds: file.includedSubtitleTrackIds !== undefined ? [...file.includedSubtitleTrackIds] : getSubtitleTrackIds(file),
      includedSubtitlesDefault: file.includedSubtitlesDefault || false,
      includedSubtitlesForced: file.includedSubtitlesForced || false,
      includedSubtitlesFirst: file.includedSubtitlesFirst || false,
    });
    setEditDialogOpen(true);
  };

  const applyTrackChangesToDuplicateFiles = useCallback(
    (fileId: string, updater: (file: ExternalFile, isTarget: boolean) => ExternalFile) => {
      const target = audioFiles.find((entry) => entry.id === fileId);
      if (!target) return;
      onAudioFilesChange(audioFiles.map((file) => (file.path !== target.path ? file : updater(file, file.id === fileId))));
    },
    [audioFiles, onAudioFilesChange],
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
      const editingFileData = audioFiles.find((f) => f.id === editingFileId);
      const srcAudioTracks = (editingFileData?.tracks || []).filter((t) => t.type === "audio");
      const srcSubTracks = (editingFileData?.tracks || []).filter((t) => t.type === "subtitle");
      const selAudioIdx = new Set(srcAudioTracks.map((t, i) => ({ i, id: Number(t.id) })).filter(({ id }) => editForm.includedTrackIds.includes(id)).map(({ i }) => i));
      const selSubIdx = new Set(srcSubTracks.map((t, i) => ({ i, id: Number(t.id) })).filter(({ id }) => editForm.includedSubtitleTrackIds.includes(id)).map(({ i }) => i));
      const updated = audioFiles.map((file) => {
        const fileAudioTracks = (file.tracks || []).filter((t) => t.type === "audio");
        const fileSubTracks = (file.tracks || []).filter((t) => t.type === "subtitle");
        const newAudioIds = fileAudioTracks.map((t, i) => ({ i, id: Number(t.id) })).filter(({ i }) => selAudioIdx.has(i)).map(({ id }) => id).filter((id) => Number.isFinite(id));
        const newSubIds = fileSubTracks.map((t, i) => ({ i, id: Number(t.id) })).filter(({ i }) => selSubIdx.has(i)).map(({ id }) => id).filter((id) => Number.isFinite(id));
        const base = file.delay !== delayValue ? markDelayAsManual(file, null) : file;
        return {
          ...base,
          language: editForm.language,
          trackName: editForm.trackName,
          delay: delayValue,
          isDefault: editForm.isDefault,
          isForced: editForm.isForced,
          muxAfter: editForm.muxAfter,
          includedTrackIds: fileAudioTracks.length > 0 ? newAudioIds : file.includedTrackIds,
          includeSubtitles: editForm.includeSubtitles,
          includedSubtitleTrackIds: fileSubTracks.length > 0 ? newSubIds : file.includedSubtitleTrackIds,
          includedSubtitlesDefault: editForm.includeSubtitles && editForm.includedSubtitlesDefault,
          includedSubtitlesForced: editForm.includeSubtitles && editForm.includedSubtitlesForced,
          includedSubtitlesFirst: editForm.includeSubtitles && editForm.includedSubtitlesFirst,
          isManuallyEdited: true,
        };
      });
      onAudioFilesChange(updated);
      closeEdit();
      toast({ title: "Applied to every file", description: `${audioFiles.length} audio file${audioFiles.length === 1 ? "" : "s"}.` });
      return;
    }
    let updated = audioFiles.map((file) => {
      if (file.id === editingFileId) {
        // Only a changed delay counts as hand-typed. Saving the dialog without
        // touching it must not lock the field against a later measurement.
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
          includeSubtitles: editForm.includeSubtitles,
          includedSubtitleTrackIds: editForm.includedSubtitleTrackIds,
          includedSubtitlesDefault: editForm.includeSubtitles && editForm.includedSubtitlesDefault,
          includedSubtitlesForced: editForm.includeSubtitles && editForm.includedSubtitlesForced,
          includedSubtitlesFirst: editForm.includeSubtitles && editForm.includedSubtitlesFirst,
          trackOverrides: base.trackOverrides,
          isManuallyEdited: true,
        };
      }
      if (editForm.applyDelayToAll) return file.delay !== delayValue ? { ...markDelayAsManual(file, null), delay: delayValue } : file;
      return file;
    });
    const editedTarget = updated.find((file) => file.id === editingFileId);
    if (editedTarget) {
      updated = updated.map((file) => {
        if (file.id === editingFileId || file.path !== editedTarget.path) return file;
        return {
          ...file,
          includedTrackIds: [...editForm.includedTrackIds],
          includeSubtitles: editForm.includeSubtitles,
          includedSubtitleTrackIds: [...editForm.includedSubtitleTrackIds],
          includedSubtitlesDefault: editForm.includeSubtitles && editForm.includedSubtitlesDefault,
          includedSubtitlesForced: editForm.includeSubtitles && editForm.includedSubtitlesForced,
          includedSubtitlesFirst: editForm.includeSubtitles && editForm.includedSubtitlesFirst,
          trackOverrides: { ...(file.trackOverrides || {}) },
          isManuallyEdited: true,
        };
      });
    }
    onAudioFilesChange(updated);
    closeEdit();
  };

  const openTrackEdit = (fileId: string, trackId: number, trackType: "audio" | "subtitle") => {
    const file = audioFiles.find((entry) => entry.id === fileId);
    if (!file) return;
    const track = file.tracks?.find((t) => Number(t.id) === trackId);
    const overrides = file.trackOverrides?.[trackId] || {};
    setTrackEditTarget({ fileId, trackId, trackType });
    setTrackEditForm({ language: overrides.language || track?.language || "und", delay: (overrides.delay ?? 0).toFixed(3), trackName: overrides.trackName || track?.name || "" });
    setTrackEditOpen(true);
  };

  const openMultiDelayDialog = (fileId: string, trackType: "audio" | "subtitle" = "audio") => {
    const file = audioFiles.find((entry) => entry.id === fileId);
    if (!file) return;
    const targetTracks = (file.tracks || []).filter((track) => track.type === trackType);
    if (targetTracks.length === 0) return;
    const initial: Record<number, string> = {};
    targetTracks.forEach((track) => {
      const trackId = Number(track.id);
      if (!Number.isFinite(trackId)) return;
      initial[trackId] = (file.trackOverrides?.[trackId]?.delay ?? file.delay ?? 0).toFixed(3);
    });
    setMultiDelayFileId(fileId);
    setMultiDelayTrackType(trackType);
    setMultiDelayValues(initial);
    setMultiDelayBulkValue((file.delay ?? 0).toFixed(3));
    setMultiDelayOpen(true);
  };

  /** Committed on Save rather than per keystroke, so Cancel really does cancel. */
  const applyTrackEdit = (next: ImportTrackOverride) => {
    if (!trackEditTarget) return;
    const { fileId, trackId } = trackEditTarget;
    const nextDelay = delaySecondsOrZero(next.delay ?? 0);
    applyTrackChangesToDuplicateFiles(fileId, (file) => {
      const previous = file.trackOverrides?.[trackId];
      // A changed delay is hand-typed, and clears the measurement it replaces;
      // an unchanged one leaves the existing provenance and metadata intact.
      const source = previous?.delay !== nextDelay ? markDelayAsManual(file, trackId) : file;
      const nextOverrides = { ...(source.trackOverrides || {}) };
      nextOverrides[trackId] = { ...nextOverrides[trackId], language: next.language || undefined, delay: nextDelay, trackName: next.trackName || undefined };
      return { ...source, trackOverrides: nextOverrides, isManuallyEdited: true };
    });
    setTrackEditOpen(false);
    setTrackEditTarget(null);
  };

  const applyMultiDelayChanges = () => {
    if (!multiDelayFileId) return;
    applyTrackChangesToDuplicateFiles(multiDelayFileId, (file) => {
      const targetTracks = (file.tracks || []).filter((track) => track.type === multiDelayTrackType);
      const nextOverrides = { ...(file.trackOverrides || {}) };
      targetTracks.forEach((track) => {
        const trackId = Number(track.id);
        if (!Number.isFinite(trackId)) return;
        const nextDelay = delaySecondsOrZero(multiDelayValues[trackId]);
        const prev = nextOverrides[trackId] || {};
        const changed = prev.delay !== nextDelay;
        // Typing a delay here overrides any measurement for that track.
        nextOverrides[trackId] = { ...prev, delay: nextDelay, ...(changed ? { delayProvenance: "manual" as const, measuredDelay: undefined } : {}) };
      });
      return { ...file, trackOverrides: nextOverrides, isManuallyEdited: true };
    });
    setMultiDelayOpen(false);
    setMultiDelayFileId(null);
    setMultiDelayTrackType("audio");
    toast({ title: "Track delays saved" });
  };

  useEffect(() => {
    if (!preset || audioPresetApplied) return;
    audioTracks.forEach((trackId) => {
      updateAudioTrackConfig(trackId, {
        sourceFolder: preset.Default_Audio_Directory || "",
        extension: "all",
        language: preset.Default_Audio_Language ? normalizeLanguage(preset.Default_Audio_Language) : "und",
      });
    });
    setAudioPresetApplied(true);
  }, [preset, audioPresetApplied, audioTracks, updateAudioTrackConfig, setAudioPresetApplied]);

  /** A scan's or a drop's files, keeping the delays measured or typed before. */
  const normalize = useCallback(
    (results: ExternalFile[]) => {
      // Carry over prior measured/typed delays so a refresh doesn't discard them.
      const priorByPath = new Map(audioFilesRef.current.map((file) => [file.path.toLowerCase(), file] as const));
      return results.map((file) => {
        const prior = priorByPath.get(file.path.toLowerCase());
        const keepsOwnDelay = prior && (prior.delayProvenance === "measured" || prior.delayProvenance === "manual");
        return {
          ...file,
          type: "audio" as const,
          language: prior?.language ?? currentConfig.language,
          trackName: prior?.trackName ?? currentConfig.trackName,
          delay: keepsOwnDelay ? prior.delay : delaySecondsOrZero(currentConfig.delay),
          ...(keepsOwnDelay ? { delayProvenance: prior.delayProvenance, measuredDelay: prior.measuredDelay, stretch: prior.stretch } : {}),
          isDefault: currentConfig.isDefault,
          isForced: currentConfig.isForced,
          muxAfter: currentConfig.muxAfter,
          includeSubtitles: getSubtitleTrackIds(file).length > 0,
          includedSubtitleTrackIds: file.includedSubtitleTrackIds?.length ? file.includedSubtitleTrackIds : getSubtitleTrackIds(file),
          // Per-track measurements live here, so they survive a rescan too.
          trackOverrides: prior?.trackOverrides ?? file.trackOverrides ?? {},
          includedTrackIds: file.tracks && file.tracks.length > 0 ? getAudioTrackIds(file) : file.includedTrackIds,
        };
      });
    },
    [currentConfig],
  );

  const scanAudios = useCallback(
    async (folderPath: string) => {
      if (!folderPath) {
        onAudioFilesChange([]);
        return;
      }
      const extensions = currentConfig.extension === "all" ? audioExtensions : [currentConfig.extension];
      try {
        const results = await scanMedia({ folder: folderPath, extensions, recursive: false, type: "audio", include_tracks: true });
        onAudioFilesChange(syncAudioLinks(normalize(results as ExternalFile[])));
        shell.log(`Audio ${activeAudioTrack}: ${results.length} file${results.length === 1 ? "" : "s"} from ${folderPath}, paired by row`);
      } catch (error) {
        shell.log(`Error: could not scan ${folderPath}: ${String(error)}`);
        toast({ title: "Could not scan the folder", description: String(error), variant: "destructive" });
      }
    },
    [currentConfig.extension, normalize, onAudioFilesChange, syncAudioLinks, shell, activeAudioTrack],
  );

  useEffect(() => {
    if (audioFiles.length === 0) return;
    // Only compare rows that have a video to pair with; past the end, keep the existing link.
    const needsRowMatch = audioFiles.slice(0, videoFiles.length).some((file, index) => file.matchedVideoId !== videoFiles[index]?.id);
    if (needsRowMatch) onAudioFilesChange(linkExternalFilesByOrder(audioFiles, videoFiles));
  }, [audioFiles, onAudioFilesChange, videoFiles]);

  const confirmDeleteTrack = (trackId: string) => {
    if (audioTracks.length <= 1) return;
    setTrackToDelete(trackId);
    setDeleteDialogOpen(true);
  };

  const deleteTrack = () => {
    if (!trackToDelete || audioTracks.length <= 1) return;
    const deletedNumber = trackToDelete;
    setAudioTracks(audioTracks.filter((track) => track !== trackToDelete));
    removeAudioTrackConfig(trackToDelete);
    if (activeAudioTrack === trackToDelete) setActiveAudioTrack(audioTracks.filter((t) => t !== trackToDelete)[0] || "1");
    setDeleteDialogOpen(false);
    setTrackToDelete(null);
    toast({ title: `Audio ${deletedNumber} deleted` });
  };

  const handleImportAudios = () => {
    if (videoFiles.length === 0) {
      toast({ title: "No videos loaded", description: "Load the videos first, then import audio streams from them.", variant: "destructive" });
      return;
    }
    if (selectedRow === null) setSelectedRow(0);
    setImportSourceVideoId(videoFiles[0]?.id || "");
    setImportSelectedTrackKeys([]);
    setImportStreamsOpen(true);
  };

  const handleConfirmImportAudios = () => {
    const targetIndex = selectedRow ?? 0;
    const targetVideo = videoFiles[targetIndex];
    if (!targetVideo || !selectedImportSource || importSelectedTrackKeys.length === 0) return;
    const selectedTrackKeySet = new Set(importSelectedTrackKeys);
    const selectedTracks = importableTracks.filter((track, trackIndex) => selectedTrackKeySet.has(getImportTrackKey(trackIndex, String(track.id))));
    if (selectedTracks.length === 0) return;
    const existingAtTarget = audioFiles[targetIndex];
    const mergedTracks = [...(existingAtTarget?.tracks?.filter((track) => track.type === "audio") || [])];
    selectedTracks.forEach((track) => {
      if (!mergedTracks.some((entry) => String(entry.id) === String(track.id))) mergedTracks.push(track);
    });
    const importedFile: ExternalFile = {
      id: createExternalId(),
      name: selectedImportSource.name,
      path: selectedImportSource.path,
      type: "audio",
      source: "per-file",
      language: currentConfig.language,
      trackName: currentConfig.trackName,
      delay: delaySecondsOrZero(currentConfig.delay),
      isDefault: currentConfig.isDefault,
      isForced: currentConfig.isForced,
      muxAfter: currentConfig.muxAfter,
      matchedVideoId: targetVideo.id,
      tracks: mergedTracks,
      includedTrackIds: mergedTracks.map((track) => Number(track.id)).filter((id) => Number.isFinite(id)),
      includeSubtitles: false,
      includedSubtitleTrackIds: [],
      // Keyed by track id so the mux job picks up per-stream edits, not the
      // slot's shared delay.
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
    const updated = [...audioFiles];
    if (targetIndex < updated.length) updated[targetIndex] = importedFile;
    else updated.push(importedFile);
    onAudioFilesChange(syncAudioLinks(updated));
    setSelectedRow(targetIndex);
    setImportStreamsOpen(false);
    setImportOverrides({});
    toast({ title: `Imported ${selectedTracks.length} stream${selectedTracks.length > 1 ? "s" : ""}`, description: `Into row ${targetIndex + 1}, beside ${targetVideo.name}.` });
  };

  const chooseFolder = async () => {
    const folder = await pickDirectory();
    if (folder) {
      updateCurrentConfig({ sourceFolder: folder });
      void scanAudios(folder);
    }
  };

  /** Dropped audio files: read and added after the ones already here. */
  const addDropped = async (paths: string[]) => {
    const allowed = new Set(audioExtensions.map((ext) => ext.toLowerCase()));
    const picked = paths.filter((path) => allowed.has(path.split(".").pop()?.toLowerCase() ?? ""));
    if (picked.length === 0) {
      toast({ title: "No audio files in the drop" });
      return;
    }
    const inspected = (await inspectPaths({ paths: picked, type: "audio", include_tracks: true })) as ExternalFile[];
    onAudioFilesChange(syncAudioLinks([...audioFiles, ...normalize(inspected)]));
  };

  // ------------------------------------------------------------------ rows

  const rowCount = Math.max(videoFiles.length, audioFiles.length);
  const rows = useMemo(() => {
    const all = Array.from({ length: rowCount }, (_, index) => ({ index, video: videoFiles[index], file: audioFiles[index] }));
    return all.filter(({ video, file }) => {
      const hit = (video && matchesSearch(video, search)) || (file && matchesSearch(file, search));
      if (!hit) return false;
      if (filter === "linked") return Boolean(file?.matchedVideoId && video);
      if (filter === "unlinked") return !(file && video);
      return true;
    });
  }, [rowCount, videoFiles, audioFiles, search, filter]);
  // Moving rows only makes sense while the list shows every row in mux order.
  const ordered = !search.trim() && filter === "all";
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const drag = useRowReorder({
    bodyRef,
    rowCount,
    disabled: !ordered || isMeasuring,
    onMove: (from, to) => from < audioFiles.length && reorderAudioFile(from, Math.min(to, audioFiles.length - 1)),
  });

  const selectedFile = selectedRow !== null ? audioFiles[selectedRow] : undefined;
  const selectedVideo = selectedRow !== null ? videoFiles[selectedRow] : undefined;
  const canMoveUp = ordered && !isMeasuring && selectedRow !== null && selectedRow > 0 && selectedRow < audioFiles.length;
  const canMoveDown = ordered && !isMeasuring && selectedRow !== null && selectedRow < audioFiles.length - 1;
  const muxHoldsEngine = shell.enginePage === "mux";

  usePageCommands("audio", {
    chooseFolder: () => void chooseFolder(),
    importFromVideo: handleImportAudios,
    removeSelected: selectedFile && selectedRow !== null && !isMeasuring ? () => removeAudioFile(selectedRow) : undefined,
    clear: audioFiles.length && !isMeasuring
      ? () => {
          updateCurrentConfig({ sourceFolder: "" });
          onAudioFilesChange([]);
        }
      : undefined,
    moveUp: canMoveUp ? () => reorderAudioFile(selectedRow!, selectedRow! - 1) : undefined,
    moveDown: canMoveDown ? () => reorderAudioFile(selectedRow!, selectedRow! + 1) : undefined,
    newTrack: isMeasuring ? undefined : addNewTrack,
    duplicateTrack: isMeasuring ? undefined : duplicateTrack,
    start: measurementAvailable && audioFiles.length > 0 && !isMeasuring && !muxHoldsEngine ? () => void beginMeasuring() : undefined,
    stop: isMeasuring ? () => void cancelMeasuring() : undefined,
    drop: (paths) => {
      if (isMeasuring) return;
      const folder = paths.find(looksLikeFolder);
      if (folder) {
        updateCurrentConfig({ sourceFolder: folder });
        void scanAudios(folder);
      } else void addDropped(paths);
    },
  });

  // --------------------------------------------------------------- display

  const summary = useMemo(() => measureOutcome(audioFiles), [audioFiles]);
  const slotLine = `Audio ${activeAudioTrack} · ${languageName(currentConfig.language)}${currentConfig.isDefault ? " · default" : ""} · after ${(muxAfterOptions.find((o) => o.value === currentConfig.muxAfter)?.label ?? "the video").toLowerCase()}`;
  const phaseWord = measureProgress ? { measure: "Measuring", wide: "Searching wider", scan: "Scanning for cuts" }[measureProgress.phase] : "Measuring";
  const lcd: LcdProps = isMeasuring
    ? {
        icon: "run",
        l1: measureProgress ? `${phaseWord} ${Math.max(1, Math.min(measureProgress.processed + (measureProgress.phase === "scan" ? 1 : 0) + (measureProgress.processed < measureProgress.total ? 1 : 0), measureProgress.total))} of ${measureProgress.total}` : "Measuring",
        l2: measureProgress?.current ?? undefined,
        pct: measureProgress && measureProgress.total > 0 ? (measureProgress.processed / measureProgress.total) * 100 : null,
        time: run.current && measureProgress ? (timeLeftText(Date.now() - run.current.startedAt, measureProgress.processed / Math.max(1, measureProgress.total)) ?? undefined) : undefined,
      }
    : audioFiles.length === 0
      ? { l1: `Drop a folder of audio files for Audio ${activeAudioTrack}` }
      : audiosyncEngine && !measurementAvailable
        ? { icon: "warn", l1: "The audio analysis engine is missing", l2: audiosyncEngine.message ?? "Measuring needs it · Preferences › Tools" }
        : unlinkedCount > 0
          ? { icon: "warn", l1: `${unlinkedCount} audio file${unlinkedCount === 1 ? " has" : "s have"} no video`, l2: `Rows past ${videoFiles.length} have nothing to go into` }
          : measuredCount > 0 && pendingCount > 0
            ? { icon: summary.problems ? "warn" : "ok", l1: summary.problems ? `${summary.parts[0]} · ${summary.problems} to check` : summary.parts[0], l2: summary.problems ? summary.parts.slice(1).join(" · ") : slotLine, time: `${pendingCount} to apply` }
            : measuredCount > 0
              ? { icon: summary.problems ? "warn" : "ok", l1: summary.problems ? `${summary.parts[0]} · ${summary.problems} to check` : `${measuredCount} delays in`, l2: summary.problems ? summary.parts.slice(1).join(" · ") : slotLine }
              : { l1: `${audioFiles.length} audio file${audioFiles.length === 1 ? "" : "s"} · ${audioFiles.length - unlinkedCount} paired`, l2: slotLine };

  const measureTitle = audiosyncEngine === null ? "Checking for the audio analysis engine…" : (audiosyncEngine.message ?? (muxHoldsEngine ? "Muxing is running" : audioFiles.length === 0 ? "Add audio files to measure their delays." : "Measure each file's delay against the video it will be muxed into."));
  const folder = currentConfig.sourceFolder;

  /** The reference track picker for a video: which of its audio tracks the
   *  measurement compares against. */
  const againstFor = (video: VideoFile | undefined) => {
    if (!video) return undefined;
    const tracks = (video.tracks ?? []).filter((track) => track.type === "audio");
    if (tracks.length === 0) return undefined;
    const value = referenceTrackByVideoId[video.id] ?? DEFAULT_REFERENCE_TRACK;
    if (tracks.length === 1) return <span className="truncate">{referenceLabel(tracks[0], 0)}</span>;
    const withChoice = videoFiles.filter((v) => (v.tracks ?? []).filter((t) => t.type === "audio").length > 1);
    return (
      <span className="col" style={{ gap: 2, minWidth: 0 }}>
        <Combo<number>
          sm
          w="100%"
          label="Measure against"
          disabled={isMeasuring}
          value={value}
          options={tracks.map((track, index) => ({ value: index, label: referenceLabel(track, index) }))}
          onChange={(index) => setReferenceTrackByVideoId((prev) => ({ ...prev, [video.id]: index }))}
        />
        {withChoice.length > 1 && (
          <button
            type="button"
            className="acc sm"
            style={{ textAlign: "left" }}
            disabled={isMeasuring}
            onClick={() => {
              const next = { ...referenceTrackByVideoId };
              // Clamp: not every video necessarily has that many tracks.
              withChoice.forEach((v) => (next[v.id] = Math.min(value, (v.tracks ?? []).filter((t) => t.type === "audio").length - 1)));
              setReferenceTrackByVideoId(next);
            }}
          >
            Same for every video
          </button>
        )}
      </span>
    );
  };

  const fileLinks = (index: number, fileId: string) => (
    <>
      <L icon={<EditRegular />} onClick={() => openEditDialog(fileId)} disabled={isMeasuring}>Edit…</L>
      <L icon={<CopyRegular />} onClick={() => duplicateAudioFile(index)} disabled={isMeasuring}>Duplicate</L>
      <L icon={<DeleteRegular />} onClick={() => removeAudioFile(index)} disabled={isMeasuring}>Remove</L>
    </>
  );

  /** Everything about one file, in the popup a double-click opens: the
   *  measurement in full (what the right panel used to show), or its format
   *  and delay before it is measured. */
  const details = () => {
    if (selectedRow === null || !selectedFile) return null;
    const index = selectedRow;
    const fps = audioFpsFor(selectedFile, videoFiles.find((v) => v.id === selectedFile.matchedVideoId));
    const trackEntries = measuredTrackEntries(selectedFile);
    const currentRef = currentReferenceFor(selectedFile);
    const format = (() => {
      const track = selectedFile.tracks?.find((t) => t.type === "audio");
      return [track?.codec, track?.name, track?.bitrate ? `${Math.round(track.bitrate / 1000)} kb/s` : null].filter(Boolean).join(" · ") || selectedFile.name.split(".").pop()?.toUpperCase() || "—";
    })();
    if (!selectedVideo)
      return (
        <>
          <div><div className="t3">Video</div><div className="big warn">None</div><div className="t2">Row {index + 1} is past the last video, so this file is not muxed.</div></div>
          <DL rows={[["Format", format], ["Size", selectedFile.size ? formatFileSize(selectedFile.size) : "—"]]} />
          <Links><L icon={<DeleteRegular />} onClick={() => removeAudioFile(index)}>Remove</L></Links>
        </>
      );
    return (
      <>
        {selectedFile.measuredDelay ? (
          <MeasureSection
            measured={selectedFile.measuredDelay}
            pending={selectedFile.pendingDelay !== undefined}
            currentReferenceTrack={currentRef}
            against={againstFor(selectedVideo)}
            stretch={selectedFile.stretch}
            onStretch={(next) => setStretchForFile(selectedFile.id, next)}
            busy={isMeasuring}
            onApply={() => applyOneMeasuredDelay(selectedFile.id)}
            onApplyAnyway={() => applyCutDelayAnyway(selectedFile.id, null)}
            onUseTimelineDelay={() => applyTimelineDelayFor(selectedFile.id, null)}
            onMeasureAgain={measurementAvailable && !muxHoldsEngine ? () => remeasureFile(selectedFile.id) : undefined}
            more={fileLinks(index, selectedFile.id)}
          />
        ) : trackEntries.length > 0 ? (
          <>
            <Links>
              {hasPendingDelay(selectedFile) && <L icon={<CheckmarkRegular />} onClick={() => applyOneMeasuredDelay(selectedFile.id)} disabled={isMeasuring}>Apply</L>}
              {measurementAvailable && !muxHoldsEngine && <L icon={<GaugeRegular />} onClick={() => remeasureFile(selectedFile.id)} disabled={isMeasuring}>Measure again</L>}
              {fileLinks(index, selectedFile.id)}
            </Links>
            {trackEntries.map(({ trackId, override, track, label }) => (
              <div key={trackId} className="col" style={{ gap: 12 }}>
                <div className="hr" />
                <span className="sec">Track {label} · {[languageName(track.language), track.codec].filter(Boolean).join(" · ")}</span>
                <MeasureSection
                  measured={override.measuredDelay!}
                  pending={override.pendingDelay !== undefined}
                  currentReferenceTrack={currentRef}
                  stretch={override.stretch}
                  onStretch={(next) => setStretchForTrack(selectedFile.id, trackId, next)}
                  busy={isMeasuring}
                  onApply={() => applyOneMeasuredDelay(selectedFile.id)}
                  onApplyAnyway={() => applyCutDelayAnyway(selectedFile.id, trackId)}
                  onUseTimelineDelay={() => applyTimelineDelayFor(selectedFile.id, trackId)}
                />
              </div>
            ))}
          </>
        ) : (
          <>
            <DL
              rows={[
                ["Video", <span key="v" className="truncate" title={selectedVideo.name}>{selectedVideo.name}</span>],
                ["Format", format],
                ["Size", selectedFile.size ? formatFileSize(selectedFile.size) : "—"],
                ["Duration", selectedFile.duration || "—"],
                ["Delay", `${formatDelay(selectedFile.delay)} s${selectedFile.delayProvenance === "manual" ? " · typed" : ""}`],
                ...(fps ? ([["Frame rate", <span key="fps" className={needsRateChange(fps) || fps.ambiguous ? "warn" : undefined}>{formatAudioFps(fps)}</span>]] as [string, JSX.Element][]) : []),
                ...(againstFor(selectedVideo) ? ([["Against", againstFor(selectedVideo)!]] as [string, JSX.Element][]) : []),
              ]}
            />
            <Links>
              {measurementAvailable && !muxHoldsEngine && <L icon={<GaugeRegular />} onClick={() => remeasureFile(selectedFile.id)} disabled={isMeasuring}>Measure</L>}
              {fileLinks(index, selectedFile.id)}
            </Links>
          </>
        )}
      </>
    );
  };

  const status = useStatus("audio", lcdStatus(lcd));

  // Reference: which of the source's audio tracks every dub is measured
  // against. The choices come from the video with the most audio tracks; a
  // video with fewer takes its last one.
  const referenceChoices = (() => {
    const richest = videoFiles.reduce<VideoFile | undefined>((best, video) => (audioTracksOf(video).length > audioTracksOf(best).length ? video : best), undefined);
    return audioTracksOf(richest).map((track, index) => ({ value: index, label: referenceLabel(track, index) }));
  })();
  const withAudio = videoFiles.filter((video) => audioTracksOf(video).length > 0);
  const references = new Set(withAudio.map((video) => referenceTrackByVideoId[video.id] ?? DEFAULT_REFERENCE_TRACK));
  const sharedReference = references.size <= 1 ? ([...references][0] ?? DEFAULT_REFERENCE_TRACK) : null;
  const setReferenceForAll = (index: number) => setReferenceTrackByVideoId(referenceForEveryVideo(videoFiles, index));

  return (
    <PageView
      hidden={hidden}
      status={status}
      dock={<PageDock common={shell.dock} />}
      tools={
        <>
          <Cmd icon={<ArrowImportRegular />} disabled={isMeasuring} onClick={handleImportAudios}>Import from a video</Cmd>
          <Cmd icon={<ArrowSyncRegular />} title="Rescan" disabled={!folder || isMeasuring} onClick={() => void scanAudios(folder)} />
          <Cmd icon={<CopyRegular />} title="Duplicate the file" disabled={!selectedFile || isMeasuring} onClick={() => selectedRow !== null && duplicateAudioFile(selectedRow)} />
          <Cmd icon={<DeleteRegular />} title="Remove (Del)" disabled={!selectedFile || isMeasuring} onClick={() => selectedRow !== null && removeAudioFile(selectedRow)} />
        </>
      }
      primary={
        isMeasuring ? (
          <Btn icon={<StopRegular />} kbd="Esc" onClick={() => void cancelMeasuring()}>Stop</Btn>
        ) : pendingCount > 0 ? (
          <>
            <Btn icon={<ArrowSyncRegular />} title="Measure every file again, including ones already measured" aria-label="Measure every file again" disabled={!measurementAvailable || muxHoldsEngine} onClick={() => void beginMeasuring({ force: true })} />
            <Btn accent icon={<CheckmarkRegular />} onClick={applyAllMeasuredDelays}>Apply {pendingCount} {pendingCount === 1 ? "delay" : "delays"}</Btn>
          </>
        ) : measuredCount > 0 ? (
          <Btn icon={<ArrowSyncRegular />} title="Measure every file again, including ones already measured" disabled={!measurementAvailable || muxHoldsEngine} onClick={() => void beginMeasuring({ force: true })}>
            Measure again
          </Btn>
        ) : (
          <Btn accent icon={<GaugeRegular />} kbd="Enter" title={measureTitle} disabled={!measurementAvailable || audioFiles.length === 0 || muxHoldsEngine} onClick={() => void beginMeasuring()}>
            Measure delays
          </Btn>
        )
      }
    >
      <Panel
        label={`Audio ${activeAudioTrack}`}
        left={
          <TrackTabs
            kind="audio"
            slots={audioTracks}
            active={activeAudioTrack}
            configs={audioTrackConfigs}
            disabled={isMeasuring}
            onPick={(slot) => {
              setActiveAudioTrack(slot);
              setSelectedRow(null);
            }}
            onNew={addNewTrack}
            onDuplicate={duplicateTrack}
            onDelete={confirmDeleteTrack}
          />
        }
        end={
          audioFiles.length > 0 && (
            <>
              <Combo<FilterValue> ghost sm w={96} label="Rows" value={filter} options={FILTER_OPTIONS} onChange={setFilter} />
              <SearchBox value={search} onChange={setSearch} label="Search audio" w={150} />
            </>
          )
        }
        sheet={
          <TrackSheet
            kind="audio"
            config={currentConfig}
            onChange={updateCurrentConfig}
            muxAfterOptions={muxAfterOptions}
            disabled={isMeasuring}
            folder={folder}
            onBrowse={() => void chooseFolder()}
            formats={{ value: currentConfig.extension, options: extensionOptions(AUDIO_EXTENSIONS), onChange: (extension) => updateCurrentConfig({ extension }) }}
            extra={
              <SheetField label="Reference" wide>
                <Combo<number>
                  label="Measure every dub against"
                  value={referenceChoices.length ? (sharedReference ?? -1) : null}
                  placeholder="The videos' first audio track"
                  options={[...referenceChoices, ...(sharedReference === null ? [{ value: -1, label: "Differs by video" }] : [])]}
                  w="100%"
                  disabled={isMeasuring || referenceChoices.length < 2}
                  onChange={(index) => index >= 0 && setReferenceForAll(index)}
                />
              </SheetField>
            }
          />
        }
      >
        {audioFiles.length > 0 ? (
          <Table
            cols="24px minmax(0,1fr) minmax(0,1fr) 112px 72px 56px 104px 148px"
            head={["#", "Video", "Audio file", "Against", " Delay", " Frames", "Confidence", "Status"]}
            label={`Audio ${activeAudioTrack}`}
            bodyRef={bodyRef}
          >
            {rows.map(({ index, video, file }) => {
              const dragProps = drag.rowProps(index);
              const inRun = Boolean(isMeasuring && file && (!run.current?.ids || run.current.ids.has(file.id)));
              const fps = file && video ? audioFpsFor(file, video) : null;
              const measuredStatus = file && video ? rowStatus(file, currentReferenceFor(file)) : null;
              const rowState = !file
                ? null
                : !video
                  ? { s: "warn" as St, text: "No video" }
                  : measuredStatus!.s === "ready" && fps && needsRateChange(fps)
                    ? { s: "warn" as St, text: formatAudioFps(fps) }
                    : measuredStatus!;
              const pending = file ? hasPendingDelay(file) : false;
              const shownDelay = file ? (file.pendingDelay ?? file.delay) : undefined;
              const running = inRun && measureProgress?.current === file?.name;
              const measured = file?.measuredDelay && !file.measuredDelay.error ? file.measuredDelay : null;
              const frames = measured ? frameOffset(measured.appliedMs, measured.primaryFps) : null;
              return (
                <Tr
                  key={file?.id ?? `video-${video?.id}`}
                  on={selectedRow === index}
                  className={dragProps.className}
                  onPointerDown={file ? dragProps.onPointerDown : undefined}
                  onClick={() => setSelectedRow(index)}
                  onDoubleClick={() => {
                    if (!file) return;
                    setSelectedRow(index);
                    setDetailsOpen(true);
                  }}
                  label={file?.name ?? video?.name}
                >
                  <span className="num t3">{index + 1}</span>
                  {video ? <span className="t2 truncate" title={video.name}>{video.name}</span> : <span className="warn">No video</span>}
                  {file ? <span className="cell"><Grip /><span className="truncate" title={file.name}>{file.name}</span></span> : <span className="nil">—</span>}
                  {video && audioTracksOf(video).length > 1 ? (
                    <Combo<number>
                      ghost
                      sm
                      w="100%"
                      label={`Measure ${file?.name ?? video.name} against`}
                      value={referenceTrackByVideoId[video.id] ?? DEFAULT_REFERENCE_TRACK}
                      options={audioTracksOf(video).map((track, i) => ({ value: i, label: shortReference(track, i) }))}
                      disabled={isMeasuring}
                      onChange={(i) => setReferenceTrackByVideoId((prev) => ({ ...prev, [video.id]: i }))}
                    />
                  ) : (
                    <span className="t3 truncate">{video && audioTracksOf(video)[0] ? shortReference(audioTracksOf(video)[0], 0) : "—"}</span>
                  )}
                  <span className={cx("r num", pending ? "acc" : "t2")} style={{ display: "flex" }}>{file ? formatDelay(shownDelay) : ""}</span>
                  <span className="r num t2" style={{ display: "flex" }}>{frames === null ? (file ? "—" : "") : `${frames > 0 ? "+" : ""}${frames}`}</span>
                  {measured?.confidence != null ? (
                    <span className="cell num t2"><Meter pct={measured.confidence * 100} />{Math.round(measured.confidence * 100)}%</span>
                  ) : (
                    <span className="t3">{file ? "—" : ""}</span>
                  )}
                  {!file ? <span /> : running ? <Status s="run" pct={null} text="Measuring" /> : inRun && rowState?.s === "ready" ? <Status s="wait" /> : <Status s={rowState!.s} text={rowState!.text} />}
                </Tr>
              );
            })}
          </Table>
        ) : (
          <Empty icon={<MusicNote2Regular />} title="Drop a folder of audio files">
            <Btn icon={<FolderOpenRegular />} onClick={() => void chooseFolder()}>Choose folder</Btn>
            <Btn icon={<ArrowImportRegular />} onClick={handleImportAudios}>Import from a video</Btn>
          </Empty>
        )}
      </Panel>

      {detailsOpen && selectedFile && (
        <Dialog
          size="xl"
          bodyClass="flush"
          title={selectedFile.name}
          sub={selectedVideo ? `Row ${(selectedRow ?? 0) + 1} · with ${selectedVideo.name}` : `Row ${(selectedRow ?? 0) + 1} · no video`}
          onClose={() => setDetailsOpen(false)}
          foot={<Btn accent onClick={() => setDetailsOpen(false)}>Close</Btn>}
        >
          <div className="box-b" style={{ overflow: "visible" }}>{details()}</div>
        </Dialog>
      )}

      {importStreamsOpen && (
        <ImportStreamsDialog
          kind="audio"
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
          targetLabel={`Into row ${(selectedRow ?? 0) + 1}${videoFiles[selectedRow ?? 0] ? `, beside ${videoFiles[selectedRow ?? 0].name}` : ""}`}
          onCancel={() => {
            setImportStreamsOpen(false);
            setImportOverrides({});
          }}
          onImport={handleConfirmImportAudios}
        />
      )}

      {editDialogOpen && editingFile && (
        <Dialog
          size="form"
          title="Edit audio file"
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
          <div className="egrid">
            <Fld label="Language"><LangCombo value={editForm.language} onChange={(language) => setEditForm((prev) => ({ ...prev, language }))} w="100%" /></Fld>
            <Fld label="Track name"><TBox label="Track name" value={editForm.trackName} placeholder="Keep the file's name" onChange={(trackName) => setEditForm((prev) => ({ ...prev, trackName }))} /></Fld>
            <DelayField value={editForm.delay} onChange={(delay) => setEditForm((prev) => ({ ...prev, delay }))} />
            <Fld label="Place after"><Combo<string> label="Place after" value={editForm.muxAfter} options={muxAfterOptions} w="100%" onChange={(muxAfter) => setEditForm((prev) => ({ ...prev, muxAfter }))} /></Fld>
          </div>
          {/* No "Forced": audio is never forced in practice. */}
          <div className="row" style={{ gap: 28 }}>
            <span title="The first included track becomes the default">
              <Chk on={editForm.isDefault} onChange={(isDefault) => setEditForm((prev) => ({ ...prev, isDefault }))}>Default</Chk>
            </span>
          </div>
          {editingFile.tracks && editingFile.tracks.length > 0 && (
            <FileTracks
              title="Audio tracks in this file"
              tools={
                <>
                  {editingFile.tracks.filter((track) => track.type === "audio").length > 1 && (
                    <Cmd sm icon={<TimelineRegular />} onClick={() => openMultiDelayDialog(editingFile.id, "audio")}>Track delays…</Cmd>
                  )}
                  <Cmd sm icon={<CheckmarkRegular />} onClick={() => setEditForm((prev) => ({ ...prev, includedTrackIds: getAudioTrackIds(editingFile) }))}>All</Cmd>
                  <Cmd sm icon={<DismissRegular />} onClick={() => setEditForm((prev) => ({ ...prev, includedTrackIds: [] }))}>None</Cmd>
                </>
              }
            >
              {editingFile.tracks
                .filter((track) => track.type === "audio")
                .map((track, index) => {
                  const trackId = Number(track.id);
                  return (
                    <FileTrackRow
                      key={track.id}
                      index={index}
                      label={[languageName(track.language), track.codec, track.name].filter(Boolean).join(" · ")}
                      on={editForm.includedTrackIds.includes(trackId)}
                      onChange={(on) => {
                        const next = new Set(editForm.includedTrackIds);
                        if (on) {
                          if (!Number.isNaN(trackId)) next.add(trackId);
                        } else next.delete(trackId);
                        setEditForm((prev) => ({ ...prev, includedTrackIds: Array.from(next) }));
                      }}
                      isDefault={track.isDefault}
                      onEdit={() => openTrackEdit(editingFile.id, trackId, "audio")}
                    />
                  );
                })}
            </FileTracks>
          )}
          {editingFile.tracks?.some((track) => track.type === "subtitle") && (
            <>
              <div className="row" style={{ gap: 28 }}>
                <span title="Subtitle tracks inside this audio file">
                  <Chk
                    on={editForm.includeSubtitles}
                    onChange={(on) =>
                      setEditForm((prev) => ({
                        ...prev,
                        includeSubtitles: on,
                        includedSubtitleTrackIds: on ? getSubtitleTrackIds(editingFile) : [],
                        includedSubtitlesDefault: on ? prev.includedSubtitlesDefault : false,
                        includedSubtitlesForced: on ? prev.includedSubtitlesForced : false,
                        includedSubtitlesFirst: on ? prev.includedSubtitlesFirst : false,
                      }))
                    }
                  >
                    Copy its subtitles
                  </Chk>
                </span>
                <span title="Before the video's own subtitles, the first one default">
                  <Chk
                    on={editForm.includedSubtitlesFirst && editForm.includedSubtitlesDefault}
                    onChange={(on) =>
                      setEditForm((prev) => ({
                        ...prev,
                        includeSubtitles: true,
                        includedSubtitleTrackIds: prev.includedSubtitleTrackIds.length ? prev.includedSubtitleTrackIds : getSubtitleTrackIds(editingFile),
                        includedSubtitlesFirst: on,
                        includedSubtitlesDefault: on,
                      }))
                    }
                  >
                    First and default
                  </Chk>
                </span>
                <span title="Forced display for the copied subtitles">
                  <Chk
                    on={editForm.includedSubtitlesForced}
                    onChange={(on) =>
                      setEditForm((prev) => ({
                        ...prev,
                        includeSubtitles: true,
                        includedSubtitleTrackIds: prev.includedSubtitleTrackIds.length ? prev.includedSubtitleTrackIds : getSubtitleTrackIds(editingFile),
                        includedSubtitlesForced: on,
                      }))
                    }
                  >
                    Forced
                  </Chk>
                </span>
              </div>
              <FileTracks
                title="Subtitles in this file"
                tools={
                  <>
                    {editingFile.tracks.filter((track) => track.type === "subtitle").length > 1 && (
                      <Cmd sm icon={<TimelineRegular />} onClick={() => openMultiDelayDialog(editingFile.id, "subtitle")}>Track delays…</Cmd>
                    )}
                    <Cmd sm icon={<CheckmarkRegular />} onClick={() => setEditForm((prev) => ({ ...prev, includeSubtitles: true, includedSubtitleTrackIds: getSubtitleTrackIds(editingFile) }))}>All</Cmd>
                    <Cmd
                      sm
                      icon={<DismissRegular />}
                      onClick={() =>
                        setEditForm((prev) => ({ ...prev, includeSubtitles: false, includedSubtitleTrackIds: [], includedSubtitlesDefault: false, includedSubtitlesForced: false, includedSubtitlesFirst: false }))
                      }
                    >
                      None
                    </Cmd>
                  </>
                }
              >
                {editingFile.tracks
                  .filter((track) => track.type === "subtitle")
                  .map((track, index) => {
                    const trackId = Number(track.id);
                    return (
                      <FileTrackRow
                        key={track.id}
                        index={index}
                        label={[languageName(track.language), track.codec, track.name].filter(Boolean).join(" · ")}
                        on={editForm.includedSubtitleTrackIds.includes(trackId)}
                        onChange={(on) => {
                          const next = new Set(editForm.includedSubtitleTrackIds);
                          if (on) {
                            if (!Number.isNaN(trackId)) next.add(trackId);
                          } else next.delete(trackId);
                          setEditForm((prev) => ({ ...prev, includeSubtitles: true, includedSubtitleTrackIds: Array.from(next) }));
                        }}
                        onEdit={() => openTrackEdit(editingFile.id, trackId, "subtitle")}
                      />
                    );
                  })}
              </FileTracks>
            </>
          )}
        </Dialog>
      )}

      {multiDelayOpen && multiDelayFile && (
        <TrackDelaysDialog
          kind={multiDelayTrackType}
          file={multiDelayFile}
          values={multiDelayValues}
          onValues={setMultiDelayValues}
          bulk={multiDelayBulkValue}
          onBulk={setMultiDelayBulkValue}
          onCancel={() => {
            setMultiDelayOpen(false);
            setMultiDelayFileId(null);
            setMultiDelayTrackType("audio");
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
        kind={trackEditTarget?.trackType ?? "audio"}
        title="Edit a track"
        trackLabel={trackEditTarget ? `Track ${trackEditTarget.trackId}` : ""}
        value={{ language: trackEditForm.language, trackName: trackEditForm.trackName, delay: delaySecondsOrZero(trackEditForm.delay) }}
        onSave={applyTrackEdit}
      />

      {deleteDialogOpen && trackToDelete && (
        <DeleteSlotDialog
          kind="audio"
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
