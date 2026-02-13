import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import { X, RefreshCw, FolderOpen, ChevronUp, ChevronDown, Plus, Trash2, Copy, FileText, Pencil, GripVertical } from "lucide-react";
import { toast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { AlertDialogAction, AlertDialogCancel } from "@/components/ui/alert-dialog";
import { BaseModal } from "@/components/shared/BaseModal";
import { EmptyState } from "@/components/shared/EmptyState";
import { LanguageSelect } from "@/components/LanguageSelect";
import { cn } from "@/lib/utils";
import type { VideoFile, ExternalFile, Preset } from "@/types";
import { pickDirectory, scanMedia } from "@/lib/backend";
import { useTabState } from "@/stores/useTabState";
import { SUBTITLE_EXTENSIONS } from "@/lib/extensions";
import { CODE_TO_LABEL, LABEL_TO_CODE } from "@/data/languages-iso6393";

interface SubtitlesTabProps {
  subtitleFiles: ExternalFile[];
  videoFiles: VideoFile[];
  onSubtitleFilesChange: (files: ExternalFile[]) => void;
  onVideoFilesChange?: (files: VideoFile[]) => void;
  onAddTrack?: () => void;
  preset?: Preset | null;
}

interface TrackConfig {
  sourceFolder: string;
  extension: string;
  language: string;
  trackName: string;
  delay: string;
  isDefault: boolean;
  isForced: boolean;
  muxAfter: string;
}

const defaultTrackConfig: TrackConfig = {
  sourceFolder: '',
  extension: 'all',
  language: 'eng',
  trackName: '',
  delay: '0.000',
  isDefault: false,
  isForced: false,
  muxAfter: 'audio',
};

const normalizeLanguage = (value: string) => {
  if (!value) return "und";
  const trimmed = value.trim();
  if (CODE_TO_LABEL[trimmed]) return trimmed;
  return LABEL_TO_CODE[trimmed] || LABEL_TO_CODE[trimmed.toLowerCase()] || trimmed.toLowerCase();
};

const subtitleExtensions = [...SUBTITLE_EXTENSIONS];


export function SubtitlesTab({
  subtitleFiles,
  videoFiles,
  onSubtitleFilesChange,
  onVideoFilesChange,
  onAddTrack,
  preset,
}: SubtitlesTabProps) {
  const syncSubtitleLinks = useCallback(
    (files: ExternalFile[]) =>
      files.map((file, index) => ({
        ...file,
        matchedVideoId: videoFiles[index]?.id,
      })),
    [videoFiles]
  );
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
  const [selectedVideoIndex, setSelectedVideoIndex] = useState<number | null>(null);
  const [selectedSubtitleIndex, setSelectedSubtitleIndex] = useState<number | null>(null);
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [trackToDelete, setTrackToDelete] = useState<string | null>(null);
  const [editDialogOpen, setEditDialogOpen] = useState(false);
  const [editingFileId, setEditingFileId] = useState<string | null>(null);
  const [draggedIndex, setDraggedIndex] = useState<number | null>(null);
  const dragItem = useRef<number | null>(null);
  const dragOverItem = useRef<number | null>(null);
  const subtitleFilesCache = useRef<Record<string, ExternalFile[]>>({});
  const [bulkOpen, setBulkOpen] = useState(false);
  const [bulkSelectedVideoIds, setBulkSelectedVideoIds] = useState<string[]>([]);
  const [bulkSelectedSubtitleIds, setBulkSelectedSubtitleIds] = useState<string[]>([]);
  const [bulkIncludeMode, setBulkIncludeMode] = useState<"all" | "first">("all");
  const [bulkFirstCount, setBulkFirstCount] = useState("2");
  const [bulkReplaceExisting, setBulkReplaceExisting] = useState(false);
  const [trackEditOpen, setTrackEditOpen] = useState(false);
  const [trackEditTarget, setTrackEditTarget] = useState<{
    fileId: string;
    trackId: number;
  } | null>(null);
  const [trackEditForm, setTrackEditForm] = useState({
    language: "und",
    delay: "0.000",
    trackName: "",
  });
  const [importStreamsOpen, setImportStreamsOpen] = useState(false);
  const [importSourceVideoId, setImportSourceVideoId] = useState("");
  const [importSelectedTrackKeys, setImportSelectedTrackKeys] = useState<string[]>([]);
  const [editForm, setEditForm] = useState({
    trackName: "",
    language: "und",
    delay: "0.000",
    isDefault: false,
    isForced: false,
    muxAfter: "audio",
    applyDelayToAll: false,
    includedTrackIds: [] as number[],
  });

  const currentConfig = subtitleTrackConfigs[activeSubtitleTrack] || defaultTrackConfig;
  const editingFile = subtitleFiles.find((file) => file.id === editingFileId) || null;
  const createExternalId = () =>
    typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const muxAfterOptions = useMemo(() => {
    const primaryTracks = videoFiles[0]?.tracks || [];
    const trackCount =
      primaryTracks.length || Math.max(0, ...videoFiles.map((video) => video.tracks?.length || 0));
    const options = [{ value: "audio", label: "Audio" }];
    for (let i = 1; i <= trackCount; i += 1) {
      const track = primaryTracks[i - 1];
      const trackLabel = track
        ? `Track ${i} - ${track.type}${track.language ? ` (${track.language})` : ""}`
        : `Track ${i}`;
      options.push({ value: `track-${i}`, label: trackLabel });
    }
    options.push({ value: "end", label: "End" });
    return options;
  }, [videoFiles]);

  const selectedImportSource = useMemo(
    () => videoFiles.find((file) => file.id === importSourceVideoId) || null,
    [videoFiles, importSourceVideoId],
  );

  const importableTracks = useMemo(
    () =>
      selectedImportSource
        ? (selectedImportSource.tracks || []).filter(
            (track) => track.type === "subtitle" && track.action !== "remove",
          )
        : [],
    [selectedImportSource],
  );
  const getImportTrackKey = (trackIndex: number, trackId: string) => `${trackIndex}:${trackId}`;

  const updateCurrentConfig = (updates: Partial<TrackConfig>) => {
    updateSubtitleTrackConfig(activeSubtitleTrack, updates);
  };

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
    const delayValue = Number(currentConfig.delay) || 0;
    const updatedFiles = subtitleFiles.map((file) => ({
      ...(file.isManuallyEdited
        ? file
        : {
            ...file,
            language: currentConfig.language,
            trackName: currentConfig.trackName,
            delay: delayValue,
            isDefault: currentConfig.isDefault,
            isForced: currentConfig.isForced,
            muxAfter: currentConfig.muxAfter,
          }),
    }));
    onSubtitleFilesChange(updatedFiles);
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
    setSelectedSubtitleIndex(null);
    setSelectedVideoIndex(null);
    toast({
      title: "Track Added",
      description: `Subtitle #${newTrackNumber} has been created.`,
    });
  }, [setActiveSubtitleTrack, setSubtitleTracks, subtitleTracks, updateSubtitleTrackConfig]);

  const duplicateTrack = () => {
    const newTrackNumber = (subtitleTracks.length + 1).toString();
    const currentSettings = subtitleTrackConfigs[activeSubtitleTrack] || defaultTrackConfig;
    setSubtitleTracks([...subtitleTracks, newTrackNumber]);
    updateSubtitleTrackConfig(newTrackNumber, { ...currentSettings });
    setActiveSubtitleTrack(newTrackNumber);
    toast({
      title: "Track Duplicated",
      description: `Subtitle #${activeSubtitleTrack} settings copied to Subtitle #${newTrackNumber}.`,
    });
  };

  useEffect(() => {
    if (onAddTrack) {
      window.__subtitlesAddTrack = addNewTrack;
    }
    return () => {
      delete window.__subtitlesAddTrack;
    };
  }, [onAddTrack, addNewTrack]);

  useEffect(() => {
    if (!preset) return;
    if (subtitlePresetApplied) return;
    subtitleTracks.forEach((trackId) => {
      updateSubtitleTrackConfig(trackId, {
        sourceFolder: preset.Default_Subtitle_Directory || "",
        extension: "all",
        language: preset.Default_Subtitle_Language
          ? normalizeLanguage(preset.Default_Subtitle_Language)
          : "und",
      });
    });
    setSubtitlePresetApplied(true);
  }, [preset, subtitlePresetApplied, subtitleTracks, updateSubtitleTrackConfig, setSubtitlePresetApplied]);

  const scanSubtitles = useCallback(async (folderPath: string) => {
    if (!folderPath) {
      onSubtitleFilesChange([]);
      return;
    }
    const extensions =
      currentConfig.extension === 'all' ? subtitleExtensions : [currentConfig.extension];
    const results = await scanMedia({
      folder: folderPath,
      extensions,
      recursive: true,
      type: 'subtitle',
      include_tracks: true,
    });
    const normalized = (results as ExternalFile[]).map((file, index) => ({
      ...file,
      type: 'subtitle' as const,
      language: currentConfig.language,
      trackName: currentConfig.trackName,
      delay: Number(currentConfig.delay) || 0,
      isDefault: currentConfig.isDefault,
      isForced: currentConfig.isForced,
      muxAfter: currentConfig.muxAfter,
      trackOverrides: file.trackOverrides ?? {},
      includedTrackIds:
        file.tracks && file.tracks.length > 0
          ? file.tracks.map((track) => Number(track.id)).filter((id) => !Number.isNaN(id))
          : file.includedTrackIds,
    }));
    onSubtitleFilesChange(syncSubtitleLinks(normalized));
  }, [currentConfig, onSubtitleFilesChange, syncSubtitleLinks]);

  useEffect(() => {
    if (subtitleFiles.length === 0) return;
    const isSynced = subtitleFiles.every(
      (file, index) => file.matchedVideoId === videoFiles[index]?.id
    );
    if (!isSynced) {
      onSubtitleFilesChange(syncSubtitleLinks(subtitleFiles));
    }
  }, [onSubtitleFilesChange, subtitleFiles, syncSubtitleLinks, videoFiles]);

  const reorderSubtitleFile = (fromIndex: number, toIndex: number) => {
    if (toIndex < 0 || toIndex >= subtitleFiles.length) return;
    const updated = [...subtitleFiles];
    const [moved] = updated.splice(fromIndex, 1);
    updated.splice(toIndex, 0, moved);
    onSubtitleFilesChange(syncSubtitleLinks(updated));
    setSelectedSubtitleIndex(toIndex);
  };

  const handleDragStart = (index: number) => {
    dragItem.current = index;
    setDraggedIndex(index);
  };

  const handleDragEnter = (index: number) => {
    dragOverItem.current = index;
  };

  const handleDragEnd = () => {
    if (dragItem.current !== null && dragOverItem.current !== null && dragItem.current !== dragOverItem.current) {
      reorderSubtitleFile(dragItem.current, dragOverItem.current);
    }
    dragItem.current = null;
    dragOverItem.current = null;
    setDraggedIndex(null);
  };

  const duplicateSubtitleFile = (index: number) => {
    const original = subtitleFiles[index];
    if (!original) return;
    if (videoFiles.length === 0) {
      toast({
        title: "Cannot Duplicate Subtitle",
        description: "Add video files before duplicating subtitles.",
        variant: "destructive",
      });
      return;
    }
    if (subtitleFiles.length >= videoFiles.length) {
      toast({
        title: "Cannot Duplicate Subtitle",
        description: "Subtitle count cannot exceed video count.",
        variant: "destructive",
      });
      return;
    }

    const newFile: ExternalFile = {
      ...original,
      id: `subtitle-dup-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    };
    const updated = [...subtitleFiles];
    updated.splice(index + 1, 0, newFile);
    onSubtitleFilesChange(syncSubtitleLinks(updated));
    setSelectedSubtitleIndex(index + 1);
    toast({
      title: "Subtitle Duplicated",
      description: `${original.name} duplicated.`,
    });
  };

  const openEditDialog = (fileId: string) => {
    const file = subtitleFiles.find((entry) => entry.id === fileId);
    if (!file) return;
    const defaultIncluded =
      file.tracks && file.tracks.length > 0
        ? file.tracks.map((track) => Number(track.id)).filter((id) => !Number.isNaN(id))
        : [];
    setEditingFileId(fileId);
    setEditForm({
      trackName: file.trackName || "",
      language: file.language || "und",
      delay: (file.delay ?? 0).toFixed(3),
      isDefault: file.isDefault || false,
      isForced: file.isForced || false,
      muxAfter: file.muxAfter || "audio",
      applyDelayToAll: false,
      includedTrackIds: file.includedTrackIds !== undefined ? [...file.includedTrackIds] : defaultIncluded,
    });
    setEditDialogOpen(true);
  };

  const applyEditChanges = () => {
    if (!editingFileId) return;
    const delayValue = Number(editForm.delay) || 0;
    const updated = subtitleFiles.map((file) => {
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
      if (editForm.applyDelayToAll) {
        return { ...file, delay: delayValue };
      }
      return file;
    });
    onSubtitleFilesChange(updated);
    setEditDialogOpen(false);
    setEditingFileId(null);
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

  const applyTrackEdit = () => {
    if (!trackEditTarget) return;
    setTrackEditOpen(false);
    setTrackEditTarget(null);
  };

  const updateTrackOverride = (updates: { language?: string; delay?: string; trackName?: string }) => {
    if (!trackEditTarget) return;
    const { fileId, trackId } = trackEditTarget;
    const nextDelay =
      updates.delay !== undefined ? Number(updates.delay) || 0 : Number(trackEditForm.delay) || 0;
    const nextLanguage =
      updates.language !== undefined ? updates.language : trackEditForm.language;
    const nextName =
      updates.trackName !== undefined ? updates.trackName : trackEditForm.trackName;

    const updated = subtitleFiles.map((file) => {
      if (file.id !== fileId) return file;
      const nextOverrides = { ...(file.trackOverrides || {}) };
      nextOverrides[trackId] = {
        language: nextLanguage || undefined,
        delay: nextDelay,
        trackName: nextName || undefined,
      };
      return { ...file, trackOverrides: nextOverrides, isManuallyEdited: true };
    });
    onSubtitleFilesChange(updated);
  };

  const removeSubtitleFile = (index: number) => {
    const updated = syncSubtitleLinks(subtitleFiles.filter((_, currentIndex) => currentIndex !== index));
    onSubtitleFilesChange(updated);
    setSelectedSubtitleIndex(null);
  };

  const applyBulkMapping = () => {
    if (bulkSelectedVideoIds.length === 0 || bulkSelectedSubtitleIds.length === 0) {
      toast({
        title: "Bulk Apply",
        description: "Select at least one video and one subtitle file.",
        variant: "destructive",
      });
      return;
    }

    const firstCount = Math.max(1, Math.floor(Number(bulkFirstCount) || 1));
    const selectedSubtitles = subtitleFiles.filter((file) => bulkSelectedSubtitleIds.includes(file.id));
    if (selectedSubtitles.length === 0) {
      toast({
        title: "Bulk Apply",
        description: "Selected subtitle files are not available.",
        variant: "destructive",
      });
      return;
    }

    const remaining = bulkReplaceExisting
      ? subtitleFiles.filter((file) => !bulkSelectedVideoIds.includes(file.matchedVideoId || ""))
      : [...subtitleFiles];

    const nextFiles = bulkSelectedVideoIds.reduce<ExternalFile[]>((acc, videoId) => {
      selectedSubtitles.forEach((file) => {
        const available =
          file.tracks && file.tracks.length > 0
            ? file.tracks.map((track) => Number(track.id)).filter((id) => Number.isFinite(id))
            : file.includedTrackIds || [];
        let includedTrackIds: number[] | undefined;
        if (bulkIncludeMode === "first" && available.length > 0) {
          includedTrackIds = available.slice(0, Math.min(firstCount, available.length));
        } else if (bulkIncludeMode === "all" && available.length > 0) {
          includedTrackIds = available;
        }

        const existingIndex = remaining.findIndex(
          (entry) => entry.matchedVideoId === videoId && entry.path === file.path,
        );
        if (existingIndex !== -1) {
          const existing = remaining[existingIndex];
          remaining[existingIndex] = {
            ...existing,
            includedTrackIds,
            trackName: file.trackName ?? existing.trackName,
            language: file.language ?? existing.language,
            delay: file.delay ?? existing.delay,
            isDefault: file.isDefault ?? existing.isDefault,
            isForced: file.isForced ?? existing.isForced,
            muxAfter: file.muxAfter ?? existing.muxAfter,
            tracks: file.tracks ?? existing.tracks,
          };
        } else {
          acc.push({
            ...file,
            id: createExternalId(),
            matchedVideoId: videoId,
            includedTrackIds,
          });
        }
      });
      return acc;
    }, []);

    onSubtitleFilesChange([...remaining, ...nextFiles]);
    setBulkOpen(false);
    toast({
      title: "Bulk Apply Complete",
      description: `Applied ${selectedSubtitles.length} subtitle file(s) to ${bulkSelectedVideoIds.length} video(s).`,
    });
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
    
    if (activeSubtitleTrack === trackToDelete) {
      const remainingTracks = subtitleTracks.filter(t => t !== trackToDelete);
      setActiveSubtitleTrack(remainingTracks[0] || '1');
    }
    
    setDeleteDialogOpen(false);
    setTrackToDelete(null);
    
    toast({
      title: "Track Deleted",
      description: `Subtitle #${deletedNumber} has been removed.`,
      variant: "destructive",
    });
  };

  const handleImportSubtitles = async () => {
    if (videoFiles.length === 0) {
      toast({
        title: "No Videos Loaded",
        description: "Load video files first, then import subtitle streams.",
        variant: "destructive",
      });
      return;
    }
    if (selectedVideoIndex === null) {
      setSelectedVideoIndex(0);
    }
    setImportSourceVideoId(videoFiles[0]?.id || "");
    setImportSelectedTrackKeys([]);
    setImportStreamsOpen(true);
  };

  const handleConfirmImportSubtitles = () => {
    const targetIndex = selectedVideoIndex ?? 0;
    const targetVideo = videoFiles[targetIndex];
    if (!targetVideo || !selectedImportSource || importSelectedTrackKeys.length === 0) {
      toast({
        title: "Import Failed",
        description: "Select at least one subtitle stream and a valid target video.",
        variant: "destructive",
      });
      return;
    }

    const selectedTrackKeySet = new Set(importSelectedTrackKeys);
    const selectedTracks = importableTracks.filter((track, trackIndex) =>
      selectedTrackKeySet.has(getImportTrackKey(trackIndex, String(track.id))),
    );
    if (selectedTracks.length === 0) return;

    const existingAtTarget = subtitleFiles[targetIndex];
    const existingTracks = existingAtTarget?.tracks?.filter((track) => track.type === "subtitle") || [];
    const mergedTracks = [...existingTracks];
    selectedTracks.forEach((track) => {
      if (!mergedTracks.some((entry) => String(entry.id) === String(track.id))) {
        mergedTracks.push(track);
      }
    });

    const mergedIncludedTrackIds = mergedTracks
      .map((track) => Number(track.id))
      .filter((id) => Number.isFinite(id));

    const importedFile: ExternalFile = {
      id: createExternalId(),
      name: selectedImportSource.name,
      path: selectedImportSource.path,
      type: "subtitle",
      source: "per-file",
      language: currentConfig.language,
      trackName: currentConfig.trackName,
      delay: Number(currentConfig.delay) || 0,
      isDefault: currentConfig.isDefault,
      isForced: currentConfig.isForced,
      muxAfter: currentConfig.muxAfter,
      matchedVideoId: targetVideo.id,
      tracks: mergedTracks,
      includedTrackIds: mergedIncludedTrackIds,
    };

    const updated = [...subtitleFiles];
    const existingByVideoIndex = updated.findIndex((file) => file.matchedVideoId === targetVideo.id);
    if (existingByVideoIndex >= 0) {
      updated[existingByVideoIndex] = importedFile;
    } else if (targetIndex <= updated.length) {
      updated.splice(targetIndex, 0, importedFile);
    } else {
      updated.push(importedFile);
    }
    onSubtitleFilesChange(syncSubtitleLinks(updated));
    setSelectedSubtitleIndex(targetIndex);
    setSelectedVideoIndex(targetIndex);
    setImportStreamsOpen(false);
    toast({
      title: "Subtitle Streams Imported",
      description: `Imported ${selectedTracks.length} stream${selectedTracks.length > 1 ? "s" : ""} to Video #${targetIndex + 1}.`,
    });
  };

  return (
    <div className="flex flex-col h-full p-5 gap-4 bg-background">
      {/* Track Selector Card */}
      <div className="track-selector-bar">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <Select value={activeSubtitleTrack} onValueChange={setActiveSubtitleTrack}>
              <SelectTrigger className="w-36 h-8 bg-panel-header text-secondary-foreground border border-panel-border font-medium">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {subtitleTracks.map((track) => (
                  <SelectItem key={track} value={track}>Subtitle #{track}</SelectItem>
                ))}
              </SelectContent>
            </Select>
            {subtitleTracks.length > 1 && (
              <Button
                variant="ghost"
                size="icon"
                className="h-8 w-8 text-destructive hover:text-destructive hover:bg-destructive/10"
                onClick={() => confirmDeleteTrack(activeSubtitleTrack)}
              >
                <Trash2 className="w-4 h-4" />
              </Button>
            )}
          </div>
          <div className="track-selector-actions">
            <Button
              variant="outline"
              size="sm"
              className="h-8 gap-2"
              onClick={handleImportSubtitles}
            >
              Import Subtitles
            </Button>
            <Button
              variant="outline"
              size="sm"
              className="h-8 gap-2"
              onClick={duplicateTrack}
            >
              <Copy className="w-4 h-4" />
              Duplicate
            </Button>
            <Button
              variant="default"
              size="sm"
              className="h-8 gap-2"
              onClick={addNewTrack}
            >
              <Plus className="w-4 h-4" />
              Add Track
            </Button>
          </div>
        </div>
      </div>

      {/* Track Configuration Card */}
      <div className="config-card space-y-4 min-h-[188px]">
        <h3 className="text-[12px] uppercase tracking-[0.5px] text-muted-foreground font-semibold">Track Configuration</h3>
        
        {/* Source Folder */}
        <div className="flex items-center gap-3">
          <label className="config-label">Source Folder</label>
          <div className="flex-1 flex items-center gap-2">
            <Input
              value={currentConfig.sourceFolder}
              onChange={(e) => updateCurrentConfig({ sourceFolder: e.target.value })}
              placeholder="Select subtitle folder path..."
              className="h-8 flex-1 font-mono"
            />
            <Button
              variant="outline"
              size="icon"
              className="h-8 w-8"
              onClick={async () => {
                const folder = await pickDirectory();
                if (folder) {
                  updateCurrentConfig({ sourceFolder: folder });
                  scanSubtitles(folder);
                }
              }}
            >
              <FolderOpen className="w-4 h-4" />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              className="h-8 w-8 bg-primary/10 text-primary hover:bg-primary/20"
              onClick={() => scanSubtitles(currentConfig.sourceFolder)}
            >
              <RefreshCw className="w-4 h-4" />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              className="h-8 w-8 bg-destructive/10 text-destructive hover:bg-destructive/20"
              onClick={() => {
                updateCurrentConfig({ sourceFolder: '' });
                onSubtitleFilesChange([]);
              }}
            >
              <X className="w-4 h-4" />
            </Button>
          </div>
        </div>

        {/* Settings Grid */}
        <div className="grid grid-cols-[1.1fr_1.1fr_1.2fr] gap-3">
          <div className="grid grid-cols-[100px_minmax(0,1fr)] items-center gap-2">
            <label className="config-label">Extension</label>
            <Select value={currentConfig.extension} onValueChange={(v) => updateCurrentConfig({ extension: v })}>
              <SelectTrigger className="h-8 flex-1">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All Formats</SelectItem>
                {SUBTITLE_EXTENSIONS.map((ext) => (
                  <SelectItem key={ext} value={ext}>
                    {ext.toUpperCase()}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="grid grid-cols-[100px_minmax(0,1fr)] items-center gap-2">
            <label className="config-label">Language</label>
            <LanguageSelect
              value={currentConfig.language}
              onChange={(v) => updateCurrentConfig({ language: v })}
              className="h-8 flex-1"
            />
          </div>

          <div className="grid grid-cols-[100px_minmax(0,1fr)] items-center gap-2">
            <label className="config-label">Track Name</label>
            <Input
              value={currentConfig.trackName}
              onChange={(e) => updateCurrentConfig({ trackName: e.target.value })}
              placeholder="Enter name"
              className="h-8 flex-1"
            />
          </div>

        </div>

        <div className="flex flex-wrap items-center gap-5">
          <div className="grid grid-cols-[100px_minmax(0,1fr)] items-center gap-2 min-w-[240px]">
            <label className="config-label">Mux After</label>
            <Select value={currentConfig.muxAfter} onValueChange={(v) => updateCurrentConfig({ muxAfter: v })}>
              <SelectTrigger className="h-8 w-40">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {muxAfterOptions.map((option) => (
                  <SelectItem key={option.value} value={option.value}>
                    {option.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="grid grid-cols-[100px_minmax(0,1fr)_auto] items-center gap-2">
            <label className="config-label">Delay</label>
            <Input
              value={currentConfig.delay}
              onChange={(e) => updateCurrentConfig({ delay: e.target.value })}
              className="h-8 w-20 text-center font-mono"
            />
            <span className="text-[12px] text-muted-foreground">sec</span>
          </div>

          <div className="grid grid-cols-2 gap-14 pl-3 items-center">
            <div className="flex items-center gap-2 min-w-[120px]">
              <Checkbox
                id="sub-default"
                checked={currentConfig.isDefault}
                onCheckedChange={(checked) => updateCurrentConfig({ isDefault: checked as boolean })}
              />
              <label htmlFor="sub-default" className="text-[12px] cursor-pointer">Default</label>
            </div>
            <div className="flex items-center gap-2 min-w-[120px]">
              <Checkbox
                id="sub-forced"
                checked={currentConfig.isForced}
                onCheckedChange={(checked) => updateCurrentConfig({ isForced: checked as boolean })}
              />
              <label htmlFor="sub-forced" className="text-[12px] cursor-pointer">Forced</label>
            </div>
          </div>
        </div>
      </div>

      {/* Matching Panel */}
      <div className="workspace-split flex-1 grid grid-cols-[minmax(400px,1fr)_minmax(400px,1fr)] gap-4 min-h-0 overflow-x-auto">
        {/* Video Files Card */}
        <div className="panel-card flex flex-col min-h-0 overflow-hidden">
          <div className="panel-card-header">
            <div className="flex items-center gap-2">
              <h4 className="panel-card-title">Video Files</h4>
              <span className="text-[11px] font-mono text-muted-foreground">{videoFiles.length}</span>
            </div>
          </div>
          <div className="flex-1 overflow-auto scrollbar-thin">
            {videoFiles.map((file, index) => (
              <div
                key={file.id}
                onClick={() => setSelectedVideoIndex(index)}
                className={cn(
                  "file-item-video",
                  selectedVideoIndex === index && "selected",
                )}
              >
                <span className="media-row-index">{`${index + 1}.`}</span>
                <span className="media-row-name">{file.name}</span>
              </div>
            ))}
          </div>
        </div>

        {/* Subtitle Files Card */}
        <div className="panel-card flex flex-col min-h-0 overflow-hidden">
          <div className="panel-card-header">
            <h4 className="panel-card-title">Subtitle Files</h4>
            <div className="panel-card-actions">
              <Button
                variant="ghost"
                size="icon"
                className="panel-icon-btn"
                onClick={() =>
                  selectedSubtitleIndex !== null && reorderSubtitleFile(selectedSubtitleIndex, selectedSubtitleIndex - 1)
                }
                disabled={selectedSubtitleIndex === null || selectedSubtitleIndex === 0}
              >
                <ChevronUp className="w-3.5 h-3.5" />
              </Button>
              <Button
                variant="ghost"
                size="icon"
                className="panel-icon-btn"
                onClick={() =>
                  selectedSubtitleIndex !== null && reorderSubtitleFile(selectedSubtitleIndex, selectedSubtitleIndex + 1)
                }
                disabled={selectedSubtitleIndex === null || selectedSubtitleIndex === subtitleFiles.length - 1}
              >
                <ChevronDown className="w-3.5 h-3.5" />
              </Button>
              <Button
                variant="ghost"
                size="sm"
                className="panel-text-btn"
                onClick={() => selectedSubtitleIndex !== null && duplicateSubtitleFile(selectedSubtitleIndex)}
                disabled={selectedSubtitleIndex === null}
              >
                <Copy className="w-3 h-3 mr-1" />
                Duplicate
              </Button>
              <Button
                variant="ghost"
                size="sm"
                className="panel-text-btn"
                onClick={() => {
                  setBulkSelectedVideoIds(videoFiles.map((file) => file.id));
                  setBulkSelectedSubtitleIds(subtitleFiles.map((file) => file.id));
                  setBulkOpen(true);
                }}
                disabled={videoFiles.length === 0 || subtitleFiles.length === 0}
              >
                Bulk Apply
              </Button>
            </div>
          </div>
          <div className="flex-1 overflow-auto scrollbar-thin">
            {subtitleFiles.length === 0 ? (
              <EmptyState
                icon={<FileText className="w-5 h-5 text-muted-foreground/65" />}
                title="No subtitle files found"
                description="Click the folder icon above or drag and drop files here"
                className="h-full"
              />
            ) : (
              subtitleFiles.map((file, index) => (
                <div
                  key={file.id}
                  draggable
                  onDragStart={() => handleDragStart(index)}
                  onDragEnter={() => handleDragEnter(index)}
                  onDragEnd={handleDragEnd}
                  onDragOver={(e) => e.preventDefault()}
                  onClick={() => setSelectedSubtitleIndex(index)}
                  onDoubleClick={() => openEditDialog(file.id)}
                  className={cn("file-item-audio", selectedSubtitleIndex === index && "selected", draggedIndex === index && "opacity-60")}
                >
                  <span className="media-row-handle">
                    <GripVertical className="w-4 h-4" />
                  </span>
                  <span className="media-row-index">{`${index + 1}.`}</span>
                  <span className="media-row-name">{file.name}</span>
                  <div className="media-row-actions">
                    <Button
                      variant="ghost"
                      size="icon"
                      className="file-action-btn file-action-btn--delete"
                      onClick={(event) => {
                        event.stopPropagation();
                        removeSubtitleFile(index);
                      }}
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="file-action-btn file-action-btn--muted"
                      onClick={(event) => {
                        event.stopPropagation();
                        openEditDialog(file.id);
                      }}
                    >
                      <Pencil className="w-3.5 h-3.5" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="file-action-btn file-action-btn--muted"
                      onClick={(event) => {
                        event.stopPropagation();
                        duplicateSubtitleFile(index);
                      }}
                    >
                      <Copy className="w-3.5 h-3.5" />
                    </Button>
                  </div>
                </div>
              ))
            )}
          </div>
        </div>
      </div>

      <BaseModal
        open={importStreamsOpen}
        onOpenChange={setImportStreamsOpen}
        title="Import Subtitle Streams"
        subtitle="Import specific subtitle streams from loaded video files."
        icon={<FileText className="w-5 h-5 text-primary" />}
        className="max-w-2xl"
        footerRight={
          <>
            <Button variant="ghost" onClick={() => setImportStreamsOpen(false)}>
              Cancel
            </Button>
            <Button onClick={handleConfirmImportSubtitles} disabled={!importSourceVideoId || importSelectedTrackKeys.length === 0}>
              Import
            </Button>
          </>
        }
      >
        <div className="space-y-4">
          <div className="space-y-2">
            <label className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Source Video</label>
            <Select value={importSourceVideoId} onValueChange={(value) => {
              setImportSourceVideoId(value);
              setImportSelectedTrackKeys([]);
            }}>
              <SelectTrigger className="h-8">
                <SelectValue placeholder="Choose source video" />
              </SelectTrigger>
              <SelectContent>
                {videoFiles.map((file) => (
                  <SelectItem key={file.id} value={file.id}>
                    {file.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-2">
            <label className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Subtitle Streams</label>
            <div className="max-h-56 overflow-y-auto rounded border border-panel-border/60 p-2 space-y-2">
              {importableTracks.length === 0 ? (
                <div className="text-xs text-muted-foreground px-1 py-2">No subtitle streams available in selected video.</div>
              ) : (
                importableTracks.map((track, idx) => {
                  const trackKey = getImportTrackKey(idx, String(track.id));
                  const checked = importSelectedTrackKeys.includes(trackKey);
                  return (
                    <label key={`${track.id}-${idx}`} className="flex items-center gap-2 px-1 py-1 cursor-pointer text-sm">
                      <Checkbox
                        checked={checked}
                        onCheckedChange={(value) => {
                          setImportSelectedTrackKeys((prev) =>
                            value
                              ? Array.from(new Set([...prev, trackKey]))
                              : prev.filter((id) => id !== trackKey),
                          );
                        }}
                      />
                      <span className="font-mono text-xs text-muted-foreground">
                        #{idx + 1}
                      </span>
                      <span className="truncate">
                        {track.name || track.codec || `Subtitle ${idx + 1}`}
                        {track.language ? ` • ${track.language}` : ""}
                      </span>
                    </label>
                  );
                })
              )}
            </div>
          </div>
        </div>
      </BaseModal>

      <BaseModal
        open={bulkOpen}
        onOpenChange={setBulkOpen}
        title="Bulk Apply Subtitle Files"
        subtitle="Apply selected subtitle files to selected videos with a track subset."
        icon={<FileText className="w-5 h-5 text-primary" />}
        className="max-w-2xl"
        bodyClassName="px-5 py-4"
        footerRight={
          <>
            <Button variant="ghost" className="text-muted-foreground hover:text-foreground" onClick={() => setBulkOpen(false)}>
              Cancel
            </Button>
            <Button onClick={applyBulkMapping}>Apply</Button>
          </>
        }
      >
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-4">
            <div className="rounded-md border border-panel-border/50 bg-panel-header/40 px-3 py-2 space-y-2">
              <div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Videos</div>
              <div className="max-h-48 overflow-y-auto space-y-2 pr-1 scrollbar-thin">
                {videoFiles.map((file) => {
                  const checked = bulkSelectedVideoIds.includes(file.id);
                  return (
                    <label key={file.id} className="flex items-center gap-2 text-xs text-foreground/80 cursor-pointer">
                      <Checkbox
                        checked={checked}
                        onCheckedChange={(value) => {
                          setBulkSelectedVideoIds((prev) =>
                            value ? [...prev, file.id] : prev.filter((id) => id !== file.id),
                          );
                        }}
                      />
                      <span className="truncate">{file.name}</span>
                    </label>
                  );
                })}
              </div>
            </div>
            <div className="rounded-md border border-panel-border/50 bg-panel-header/40 px-3 py-2 space-y-2">
              <div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Subtitle Files</div>
              <div className="max-h-48 overflow-y-auto space-y-2 pr-1 scrollbar-thin">
                {subtitleFiles.map((file) => {
                  const checked = bulkSelectedSubtitleIds.includes(file.id);
                  const trackCount = file.tracks?.length || file.includedTrackIds?.length || 0;
                  return (
                    <label key={file.id} className="flex items-center gap-2 text-xs text-foreground/80 cursor-pointer">
                      <Checkbox
                        checked={checked}
                        onCheckedChange={(value) => {
                          setBulkSelectedSubtitleIds((prev) =>
                            value ? [...prev, file.id] : prev.filter((id) => id !== file.id),
                          );
                        }}
                      />
                      <span className="truncate">{file.name}</span>
                      {trackCount > 1 && (
                        <span className="ml-auto text-[10px] text-muted-foreground/70">{trackCount} tracks</span>
                      )}
                    </label>
                  );
                })}
              </div>
            </div>
          </div>
          <div className="rounded-md border border-panel-border/50 bg-panel-header/40 px-3 py-2 space-y-3">
            <div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Track Subset</div>
            <div className="flex items-center gap-4 text-xs">
              <label className="flex items-center gap-2 cursor-pointer">
                <Checkbox
                  checked={bulkIncludeMode === "all"}
                  onCheckedChange={(value) => value && setBulkIncludeMode("all")}
                />
                All tracks
              </label>
              <label className="flex items-center gap-2 cursor-pointer">
                <Checkbox
                  checked={bulkIncludeMode === "first"}
                  onCheckedChange={(value) => value && setBulkIncludeMode("first")}
                />
                First
                <Input
                  value={bulkFirstCount}
                  onChange={(event) => setBulkFirstCount(event.target.value)}
                  className="h-7 w-12 text-center font-mono"
                />
                tracks
              </label>
            </div>
          </div>
          <div className="flex items-center justify-between rounded-md border border-panel-border/50 bg-panel-header/30 px-3 py-2">
            <label className="flex items-center gap-2 text-xs text-muted-foreground cursor-pointer">
              <Checkbox
                checked={bulkReplaceExisting}
                onCheckedChange={(value) => setBulkReplaceExisting(value as boolean)}
              />
              Replace existing bulk subtitle mappings for selected videos
            </label>
          </div>
        </div>
      </BaseModal>

      <BaseModal
        open={editDialogOpen}
        onOpenChange={(open) => {
          setEditDialogOpen(open);
          if (!open) {
            setEditingFileId(null);
          }
        }}
        title="Edit Subtitle Track"
        subtitle={editingFile?.name || "Update subtitle track settings."}
        icon={<FileText className="w-5 h-5 text-primary" />}
        className="max-w-lg"
        footerRight={
          <>
            <Button variant="ghost" className="text-muted-foreground hover:text-foreground" onClick={() => setEditDialogOpen(false)}>
              Cancel
            </Button>
            <Button onClick={applyEditChanges}>Save Changes</Button>
          </>
        }
      >
        <div className="space-y-3">
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-1.5">
              <label className="text-xs font-medium text-muted-foreground">Language</label>
              <LanguageSelect
                value={editForm.language}
                onChange={(value) => setEditForm((prev) => ({ ...prev, language: value }))}
                className="h-9"
              />
            </div>
            <div className="space-y-1.5">
              <label className="text-xs font-medium text-muted-foreground">Track Name</label>
              <Input
                value={editForm.trackName}
                onChange={(event) => setEditForm((prev) => ({ ...prev, trackName: event.target.value }))}
                placeholder="Track name"
                className="h-9"
              />
            </div>
            <div className="space-y-1.5">
              <label className="text-xs font-medium text-muted-foreground">Delay (sec)</label>
              <Input
                value={editForm.delay}
                onChange={(event) => setEditForm((prev) => ({ ...prev, delay: event.target.value }))}
                className="h-9 font-mono"
              />
            </div>
            <div className="space-y-1.5">
              <label className="text-xs font-medium text-muted-foreground">Mux After</label>
              <Select
                value={editForm.muxAfter}
                onValueChange={(value) => setEditForm((prev) => ({ ...prev, muxAfter: value }))}
              >
                <SelectTrigger className="h-9 rounded-md focus:ring-1 focus:ring-ring/40">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {muxAfterOptions.map((option) => (
                    <SelectItem key={option.value} value={option.value}>
                      {option.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          <div className="rounded-md border border-panel-border/60 bg-panel/40 px-3 py-2">
            <div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-2">Track Flags</div>
            <div className="flex items-center justify-between gap-6">
              <div className="flex items-center gap-3">
                <Checkbox
                  id="sub-edit-default"
                  checked={editForm.isDefault}
                  onCheckedChange={(checked) =>
                    setEditForm((prev) => ({ ...prev, isDefault: checked as boolean }))
                  }
                />
                <label htmlFor="sub-edit-default" className="text-sm">
                  Default
                </label>
              </div>
              <div className="flex items-center gap-3">
                <Checkbox
                  id="sub-edit-forced"
                  checked={editForm.isForced}
                  onCheckedChange={(checked) =>
                    setEditForm((prev) => ({ ...prev, isForced: checked as boolean }))
                  }
                />
                <label htmlFor="sub-edit-forced" className="text-sm">
                  Forced
                </label>
              </div>
              <div className="flex items-center gap-3">
                <Checkbox
                  id="sub-edit-delay-all"
                  checked={editForm.applyDelayToAll}
                  onCheckedChange={(checked) =>
                    setEditForm((prev) => ({ ...prev, applyDelayToAll: checked as boolean }))
                  }
                />
                <label htmlFor="sub-edit-delay-all" className="text-sm">
                  Apply delay to all
                </label>
              </div>
            </div>
          </div>

          {editingFile?.tracks && editingFile.tracks.length > 1 && (
            <div className="rounded-md border border-panel-border/50 bg-panel-header/40 px-4 py-3 space-y-3">
              <div className="flex items-center justify-between">
                <div className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                  Included Tracks
                </div>
                <div className="flex items-center gap-2">
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-7 px-2 text-[11px]"
                    onClick={() =>
                      setEditForm((prev) => ({
                        ...prev,
                        includedTrackIds: editingFile.tracks
                          ? editingFile.tracks.map((track) => Number(track.id)).filter((id) => !Number.isNaN(id))
                          : prev.includedTrackIds,
                      }))
                    }
                  >
                    Copy All
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-7 px-2 text-[11px] text-muted-foreground hover:text-foreground"
                    onClick={() => setEditForm((prev) => ({ ...prev, includedTrackIds: [] }))}
                  >
                    Uncopy All
                  </Button>
                </div>
              </div>
              <div className="space-y-2">
                {editingFile.tracks.map((track, index) => {
                  const trackId = Number(track.id);
                  const checked = editForm.includedTrackIds.includes(trackId);
                  return (
                    <div key={track.id} className="flex items-center justify-between gap-3">
                      <div className="flex items-center gap-3 min-w-0">
                        <Checkbox
                          checked={checked}
                          onCheckedChange={(value) => {
                            const next = new Set(editForm.includedTrackIds);
                            if (value) {
                              if (!Number.isNaN(trackId)) next.add(trackId);
                            } else {
                              next.delete(trackId);
                            }
                            setEditForm((prev) => ({ ...prev, includedTrackIds: Array.from(next) }));
                          }}
                        />
                        <div className="text-sm text-foreground truncate">
                          Track {index + 1}
                          {track.language ? ` • ${track.language}` : ""}
                          {track.name ? ` • ${track.name}` : ""}
                        </div>
                      </div>
                      <div className="flex items-center gap-2">
                        {track.isDefault && (
                          <span className="text-[10px] uppercase tracking-wide text-primary/80">Default</span>
                        )}
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-7 w-7 text-muted-foreground hover:text-foreground"
                          onClick={() => openTrackEdit(editingFile.id, trackId)}
                        >
                          <Pencil className="w-3.5 h-3.5" />
                        </Button>
                      </div>
                    </div>
                  );
                })}
              </div>
              <div className="text-[11px] text-muted-foreground/70">
                When Default is enabled for this file, the first included track becomes default and the rest are set to no.
              </div>
            </div>
          )}
        </div>
      </BaseModal>

      <BaseModal
        open={trackEditOpen}
        onOpenChange={setTrackEditOpen}
        title="Edit Track Settings"
        subtitle={trackEditTarget ? `Track ${trackEditTarget.trackId}` : "Track settings"}
        icon={<Pencil className="w-5 h-5 text-primary" />}
        className="max-w-md"
        footerRight={
          <>
            <Button variant="ghost" className="text-muted-foreground hover:text-foreground" onClick={() => setTrackEditOpen(false)}>
              Cancel
            </Button>
            <Button onClick={applyTrackEdit}>Save</Button>
          </>
        }
      >
        <div className="space-y-3">
          <div className="space-y-1.5">
            <label className="text-xs font-medium text-muted-foreground">Language</label>
            <LanguageSelect
              value={trackEditForm.language}
              onChange={(value) => {
                setTrackEditForm((prev) => ({ ...prev, language: value }));
                updateTrackOverride({ language: value });
              }}
              className="h-9"
            />
          </div>
          <div className="space-y-1.5">
            <label className="text-xs font-medium text-muted-foreground">Track Name</label>
            <Input
              value={trackEditForm.trackName}
              onChange={(event) => {
                const value = event.target.value;
                setTrackEditForm((prev) => ({ ...prev, trackName: value }));
                updateTrackOverride({ trackName: value });
              }}
              className="h-9"
            />
          </div>
          <div className="space-y-1.5">
            <label className="text-xs font-medium text-muted-foreground">Delay (sec)</label>
            <Input
              value={trackEditForm.delay}
              onChange={(event) => {
                const value = event.target.value;
                setTrackEditForm((prev) => ({ ...prev, delay: value }));
                updateTrackOverride({ delay: value });
              }}
              className="h-9 font-mono"
            />
          </div>
        </div>
      </BaseModal>

      {/* Delete Confirmation Dialog */}
      <BaseModal
        variant="alert"
        open={deleteDialogOpen}
        onOpenChange={setDeleteDialogOpen}
        title="Delete Subtitle Track"
        icon={<Trash2 className="w-5 h-5 text-destructive" />}
        className="max-w-md"
        footerRight={
          <>
            <AlertDialogCancel className="mt-0">Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={deleteTrack} className="bg-destructive text-destructive-foreground hover:bg-destructive/90">
              Delete
            </AlertDialogAction>
          </>
        }
      >
        <p className="text-sm text-muted-foreground">
          Are you sure you want to delete Subtitle #{trackToDelete}? This will remove all settings associated with this track.
        </p>
      </BaseModal>
    </div>
  );
}
