/** Subtitles: external subtitle files for each video, in track slots
 *  (Subtitle 1, Subtitle 2…). Row n of the list is video n and file n, which
 *  is how the mux pairs them. The logic is the old Subtitles tab's. */

import {
  ArrowImportRegular,
  ArrowSyncRegular,
  CheckmarkRegular,
  ClosedCaptionRegular,
  CopyRegular,
  DeleteRegular,
  DismissRegular,
  FolderOpenRegular,
  TimelineRegular,
} from "@fluentui/react-icons";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { PageDock } from "@/app/dock";
import { useShell, usePageCommands, useStatus } from "@/app/shell";
import { ImportTrackEditDialog, type ImportTrackOverride } from "@/features/workspace/components/ImportTrackEditDialog";
import { useRowReorder } from "@/features/workspace/lib/useRowReorder";
import { useTabState, type TrackConfig } from "@/features/workspace/store/useTabState";
import { DelayField, delayInputsAreValid } from "@/shared/components/DelayField";
import { CODE_TO_LABEL, LABEL_TO_CODE } from "@/shared/data/languages-iso6393";
import { inspectPaths, pickDirectory, scanMedia } from "@/shared/lib/backend";
import { delaySecondsOrZero } from "@/shared/lib/delayInput";
import { SUBTITLE_EXTENSIONS } from "@/shared/lib/extensions";
import { getUnlinkedExternalFiles, linkExternalFilesByOrder } from "@/shared/lib/matchUtils";
import type { ExternalFile, Preset, VideoFile } from "@/shared/types";
import { Dialog, PageView, Panel, lcdStatus, type LcdProps } from "@/ui/frame";
import { Btn, Chk, Cmd, Combo, Empty, Fld, Grip, LangCombo, TBox, Table, Tr } from "@/ui/kit";
import { toast } from "@/ui/toast";

import { FILTER_OPTIONS, SearchBox, extensionOptions, formatDelay, looksLikeFolder, matchesSearch, type FilterValue } from "./common";
import { DeleteSlotDialog, FileTrackRow, FileTracks, ImportStreamsDialog, TrackDelaysDialog, TrackSheet, TrackTabs, languageName } from "./tracks/parts";

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


export function SubtitlesPage({ hidden, subtitleFiles, videoFiles, onSubtitleFilesChange, preset }: SubtitlesPageProps) {
  const shell = useShell();
  const syncSubtitleLinks = useCallback((files: ExternalFile[]) => linkExternalFilesByOrder(files, videoFiles), [videoFiles]);
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

  const lastAppliedConfig = useRef<TrackConfig | null>(null);
  useEffect(() => {
    if (subtitleFiles.length === 0) return;
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
    onSubtitleFilesChange(
      subtitleFiles.map((file) => ({
        ...file,
        // Global default/forced toggles must always apply from the slot's settings.
        isDefault: currentConfig.isDefault,
        isForced: currentConfig.isForced,
        ...(file.isManuallyEdited ? {} : { language: currentConfig.language, trackName: currentConfig.trackName, delay: delayValue, muxAfter: currentConfig.muxAfter }),
      })),
    );
  }, [subtitleFiles, currentConfig, onSubtitleFilesChange]);

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
    const newTrackNumber = (subtitleTracks.length + 1).toString();
    setSubtitleTracks([...subtitleTracks, newTrackNumber]);
    updateSubtitleTrackConfig(newTrackNumber, { ...defaultTrackConfig });
    setActiveSubtitleTrack(newTrackNumber);
    setSelectedRow(null);
    toast({ title: `Subtitle ${newTrackNumber} added` });
  }, [setActiveSubtitleTrack, setSubtitleTracks, subtitleTracks, updateSubtitleTrackConfig]);

  const duplicateTrack = () => {
    const newTrackNumber = (subtitleTracks.length + 1).toString();
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
          isDefault: currentConfig.isDefault,
          isForced: currentConfig.isForced,
          muxAfter: currentConfig.muxAfter,
          trackOverrides: prior?.trackOverrides ?? file.trackOverrides ?? {},
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
        onSubtitleFilesChange(syncSubtitleLinks(normalize(results as ExternalFile[])));
        shell.log(`Subtitle ${activeSubtitleTrack}: ${results.length} file${results.length === 1 ? "" : "s"} from ${folderPath}, paired by row`);
      } catch (error) {
        shell.log(`Error: could not scan ${folderPath}: ${String(error)}`);
        toast({ title: "Could not scan the folder", description: String(error), variant: "destructive" });
      }
    },
    [currentConfig.extension, normalize, onSubtitleFilesChange, syncSubtitleLinks, shell, activeSubtitleTrack],
  );

  useEffect(() => {
    if (subtitleFiles.length === 0) return;
    // Only the files that have a video to pair with: rows past the end keep
    // their existing link, so comparing them against undefined would report a
    // mismatch that relinking can never resolve.
    const needsRowMatch = subtitleFiles.slice(0, videoFiles.length).some((file, index) => file.matchedVideoId !== videoFiles[index]?.id);
    if (needsRowMatch) onSubtitleFilesChange(linkExternalFilesByOrder(subtitleFiles, videoFiles));
  }, [onSubtitleFilesChange, subtitleFiles, videoFiles]);

  const reorderSubtitleFile = (fromIndex: number, toIndex: number) => {
    if (toIndex < 0 || toIndex >= subtitleFiles.length) return;
    const updated = [...subtitleFiles];
    const [moved] = updated.splice(fromIndex, 1);
    updated.splice(toIndex, 0, moved);
    onSubtitleFilesChange(syncSubtitleLinks(updated));
    setSelectedRow(toIndex);
  };

  const duplicateSubtitleFile = (index: number) => {
    const original = subtitleFiles[index];
    if (!original) return;
    if (videoFiles.length === 0) {
      toast({ title: "Nothing to duplicate into", description: "Add video files before duplicating subtitles.", variant: "destructive" });
      return;
    }
    if (subtitleFiles.length >= videoFiles.length) {
      toast({ title: "Nothing to duplicate into", description: "There cannot be more subtitle files than videos.", variant: "destructive" });
      return;
    }
    const newFile: ExternalFile = { ...original, id: `subtitle-dup-${Date.now()}-${Math.random().toString(36).slice(2, 8)}` };
    const updated = [...subtitleFiles];
    updated.splice(index + 1, 0, newFile);
    onSubtitleFilesChange(linkExternalFilesByOrder(updated, videoFiles));
    setSelectedRow(index + 1);
    toast({ title: "Subtitle duplicated", description: `${original.name}, paired by row.` });
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
        const fileTracks = (file.tracks || []).filter((t) => t.type === "subtitle");
        const newIds = fileTracks
          .map((t, i) => ({ i, id: Number(t.id) }))
          .filter(({ i }) => selIdx.has(i))
          .map(({ id }) => id)
          .filter((id) => Number.isFinite(id));
        return {
          ...file,
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
      toast({ title: "Applied to every file", description: `${subtitleFiles.length} subtitle file${subtitleFiles.length === 1 ? "" : "s"}.` });
      return;
    }
    let updated = subtitleFiles.map((file) => {
      if (file.id === editingFileId) {
        return {
          ...file,
          trackName: editForm.trackName,
          language: editForm.language,
          delay: delayValue,
          isDefault: editForm.isDefault,
          isForced: editForm.isForced,
          muxAfter: editForm.muxAfter,
          includedTrackIds: editForm.includedTrackIds,
          trackOverrides: file.trackOverrides,
          isManuallyEdited: true,
        };
      }
      if (editForm.applyDelayToAll) return { ...file, delay: delayValue };
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
      delay: (overrides.delay ?? 0).toFixed(3),
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
    applyTrackChangesToDuplicateFiles(fileId, (file) => {
      const nextOverrides = { ...(file.trackOverrides || {}) };
      nextOverrides[trackId] = { language: next.language || undefined, delay: nextDelay, trackName: next.trackName || undefined };
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
    const targetIndex = selectedRow ?? 0;
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
    const all = Array.from({ length: rowCount }, (_, index) => ({ index, video: videoFiles[index], file: subtitleFiles[index] }));
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
  const drag = useRowReorder({ bodyRef, rowCount, disabled: !ordered, onMove: (from, to) => from < subtitleFiles.length && reorderSubtitleFile(from, Math.min(to, subtitleFiles.length - 1)) });

  const selectedFile = selectedRow !== null ? subtitleFiles[selectedRow] : undefined;
  const canMoveUp = ordered && selectedRow !== null && selectedRow > 0 && selectedRow < subtitleFiles.length;
  const canMoveDown = ordered && selectedRow !== null && selectedRow < subtitleFiles.length - 1;

  usePageCommands("subtitles", {
    chooseFolder: () => void chooseFolder(),
    importFromVideo: handleImportSubtitles,
    removeSelected: selectedFile && selectedRow !== null ? () => removeSubtitleFile(selectedRow) : undefined,
    clear: subtitleFiles.length
      ? () => {
          updateCurrentConfig({ sourceFolder: "" });
          onSubtitleFilesChange([]);
        }
      : undefined,
    moveUp: canMoveUp ? () => reorderSubtitleFile(selectedRow!, selectedRow! - 1) : undefined,
    moveDown: canMoveDown ? () => reorderSubtitleFile(selectedRow!, selectedRow! + 1) : undefined,
    newTrack: addNewTrack,
    duplicateTrack,
    drop: (paths) => {
      const folder = paths.find(looksLikeFolder);
      if (folder) {
        updateCurrentConfig({ sourceFolder: folder });
        void scanSubtitles(folder);
      } else void addDropped(paths);
    },
  });

  const lcd: LcdProps =
    subtitleFiles.length === 0
      ? { l1: `Drop a folder of subtitles for Subtitle ${activeSubtitleTrack}` }
      : unlinkedCount > 0
        ? { icon: "warn", l1: `${unlinkedCount} subtitle file${unlinkedCount === 1 ? " has" : "s have"} no video`, l2: `Rows past ${videoFiles.length} have nothing to go into` }
        : {
            l1: `${subtitleFiles.length} subtitle file${subtitleFiles.length === 1 ? "" : "s"} · ${subtitleFiles.length - unlinkedCount} paired`,
            l2: `Subtitle ${activeSubtitleTrack} · ${languageName(currentConfig.language)}${currentConfig.isDefault ? " · default" : ""}${currentConfig.isForced ? " · forced" : ""} · ${(muxAfterOptions.find((o) => o.value === currentConfig.muxAfter)?.label ?? "").toLowerCase()}`,
          };

  const folder = currentConfig.sourceFolder;
  const status = useStatus("subtitles", lcdStatus(lcd));

  return (
    <PageView
      hidden={hidden}
      status={status}
      dock={<PageDock common={shell.dock} />}
      tools={
        <>
          <Cmd icon={<ArrowImportRegular />} onClick={handleImportSubtitles}>Import from a video</Cmd>
          <Cmd icon={<ArrowSyncRegular />} title="Rescan" disabled={!folder} onClick={() => void scanSubtitles(folder)} />
          <Cmd icon={<CopyRegular />} title="Duplicate the file" disabled={!selectedFile} onClick={() => selectedRow !== null && duplicateSubtitleFile(selectedRow)} />
          <Cmd icon={<DeleteRegular />} title="Remove (Del)" disabled={!selectedFile} onClick={() => selectedRow !== null && removeSubtitleFile(selectedRow)} />
        </>
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
          subtitleFiles.length > 0 && (
            <>
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
        {subtitleFiles.length > 0 ? (
          <Table cols="24px minmax(0,1fr) minmax(0,1fr) 72px" head={["#", "Video", "Subtitle file", " Delay"]} label={`Subtitle ${activeSubtitleTrack}`} bodyRef={bodyRef}>
            {rows.map(({ index, video, file }) => {
              const dragProps = drag.rowProps(index);
              return (
                <Tr
                  key={file?.id ?? `video-${video?.id}`}
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
                    <span className="nil">—</span>
                  )}
                  <span className="r num t2" style={{ display: "flex" }}>{file ? formatDelay(file.delay) : ""}</span>
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
          targetLabel={`Into row ${(selectedRow ?? 0) + 1}${videoFiles[selectedRow ?? 0] ? `, beside ${videoFiles[selectedRow ?? 0].name}` : ""}`}
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
