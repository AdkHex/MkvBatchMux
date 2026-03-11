import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import { X, RefreshCw, FolderOpen, ChevronUp, ChevronDown, Plus, Trash2, Copy, AudioLines, Pencil, GripVertical } from "lucide-react";
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
import { AUDIO_EXTENSIONS } from "@/lib/extensions";
import { matchExternalToVideos } from "@/lib/matchUtils";
import { CODE_TO_LABEL, LABEL_TO_CODE } from "@/data/languages-iso6393";

interface AudiosTabProps {
  audioFiles: ExternalFile[];
  videoFiles: VideoFile[];
  onAudioFilesChange: (files: ExternalFile[]) => void;
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
  language: 'hin',
  trackName: '',
  delay: '0.000',
  isDefault: false,
  isForced: false,
  muxAfter: 'video',
};

const normalizeLanguage = (value: string) => {
  if (!value) return "und";
  const trimmed = value.trim();
  if (CODE_TO_LABEL[trimmed]) return trimmed;
  return LABEL_TO_CODE[trimmed] || LABEL_TO_CODE[trimmed.toLowerCase()] || trimmed.toLowerCase();
};

const audioExtensions = [...AUDIO_EXTENSIONS];

const getAudioTrackIds = (file: ExternalFile) =>
  file.tracks
    ? file.tracks.filter((t) => t.type === "audio").map((t) => Number(t.id)).filter((id) => Number.isFinite(id))
    : [];

const getSubtitleTrackIds = (file: ExternalFile) =>
  file.tracks
    ? file.tracks.filter((t) => t.type === "subtitle").map((t) => Number(t.id)).filter((id) => Number.isFinite(id))
    : [];

const getDefaultIncludeSubtitles = (file: ExternalFile) =>
  file.includeSubtitles !== undefined ? file.includeSubtitles : getSubtitleTrackIds(file).length > 0;


export function AudiosTab({
  audioFiles,
  videoFiles,
  onAudioFilesChange,
  onVideoFilesChange,
  onAddTrack,
  preset,
}: AudiosTabProps) {
  const syncAudioLinks = useCallback(
    (files: ExternalFile[]) => matchExternalToVideos(files, videoFiles),
    [videoFiles],
  );

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
  const [selectedVideoIndex, setSelectedVideoIndex] = useState<number | null>(null);
  const [selectedAudioIndex, setSelectedAudioIndex] = useState<number | null>(null);
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [trackToDelete, setTrackToDelete] = useState<string | null>(null);
  const [editDialogOpen, setEditDialogOpen] = useState(false);
  const [editingFileId, setEditingFileId] = useState<string | null>(null);
  const [draggedIndex, setDraggedIndex] = useState<number | null>(null);
  const dragItem = useRef<number | null>(null);
  const dragOverItem = useRef<number | null>(null);
  const audioFilesCache = useRef<Record<string, ExternalFile[]>>({});
  const [bulkOpen, setBulkOpen] = useState(false);
  const [bulkSelectedVideoIds, setBulkSelectedVideoIds] = useState<string[]>([]);
  const [bulkSelectedAudioIds, setBulkSelectedAudioIds] = useState<string[]>([]);
  const [bulkIncludeMode, setBulkIncludeMode] = useState<"all" | "first">("all");
  const [bulkFirstCount, setBulkFirstCount] = useState("2");
  const [bulkReplaceExisting, setBulkReplaceExisting] = useState(false);
  const [trackEditOpen, setTrackEditOpen] = useState(false);
  const [trackEditTarget, setTrackEditTarget] = useState<{
    fileId: string;
    trackId: number;
    trackType: "audio" | "subtitle";
  } | null>(null);
  const [trackEditForm, setTrackEditForm] = useState({
    language: "und",
    delay: "0.000",
    trackName: "",
  });
  const [multiDelayOpen, setMultiDelayOpen] = useState(false);
  const [multiDelayFileId, setMultiDelayFileId] = useState<string | null>(null);
  const [multiDelayTrackType, setMultiDelayTrackType] = useState<"audio" | "subtitle">("audio");
  const [multiDelayValues, setMultiDelayValues] = useState<Record<number, string>>({});
  const [multiDelayBulkValue, setMultiDelayBulkValue] = useState("0.000");
  const [importStreamsOpen, setImportStreamsOpen] = useState(false);
  const [importSourceVideoId, setImportSourceVideoId] = useState("");
  const [importSelectedTrackKeys, setImportSelectedTrackKeys] = useState<string[]>([]);
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
  });

  const currentConfig = audioTrackConfigs[activeAudioTrack] || defaultTrackConfig;
  const editingFile = audioFiles.find((file) => file.id === editingFileId) || null;
  const multiDelayFile = audioFiles.find((file) => file.id === multiDelayFileId) || null;
  const createExternalId = () =>
    typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(16).slice(2)}`;

  const muxAfterOptions = useMemo(() => {
    const primaryTracks = videoFiles[0]?.tracks || [];
    const trackCount =
      primaryTracks.length || Math.max(0, ...videoFiles.map((video) => video.tracks?.length || 0));
    const options = [{ value: "video", label: "Video" }];
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
            (track) => track.type === "audio" && track.action !== "remove",
          )
        : [],
    [selectedImportSource],
  );
  const getImportTrackKey = (trackIndex: number, trackId: string) => `${trackIndex}:${trackId}`;


  const updateCurrentConfig = (updates: Partial<TrackConfig>) => {
    updateAudioTrackConfig(activeAudioTrack, updates);
  };

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
    const delayValue = Number(currentConfig.delay) || 0;
    const updatedFiles = audioFiles.map((file) => ({
      ...file,
      // Global default/forced toggles must always apply from Track Configuration.
      isDefault: currentConfig.isDefault,
      isForced: currentConfig.isForced,
      ...(file.isManuallyEdited
        ? {}
        : {
            language: currentConfig.language,
            trackName: currentConfig.trackName,
            delay: delayValue,
            muxAfter: currentConfig.muxAfter,
          }),
    }));
    onAudioFilesChange(updatedFiles);
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
    setSelectedAudioIndex(null);
    setSelectedVideoIndex(null);
    toast({
      title: "Track Added",
      description: `Audio #${newTrackNumber} has been created.`,
    });
  }, [audioTracks, setActiveAudioTrack, setAudioTracks, updateAudioTrackConfig]);

  const duplicateTrack = () => {
    const newTrackNumber = (audioTracks.length + 1).toString();
    const currentSettings = audioTrackConfigs[activeAudioTrack] || defaultTrackConfig;
    setAudioTracks([...audioTracks, newTrackNumber]);
    updateAudioTrackConfig(newTrackNumber, { ...currentSettings });
    setActiveAudioTrack(newTrackNumber);
    toast({
      title: "Track Duplicated",
      description: `Audio #${activeAudioTrack} settings copied to Audio #${newTrackNumber}.`,
    });
  };

  const reorderAudioFile = (fromIndex: number, toIndex: number) => {
    if (toIndex < 0 || toIndex >= audioFiles.length) return;
    const updated = [...audioFiles];
    const [moved] = updated.splice(fromIndex, 1);
    updated.splice(toIndex, 0, moved);
    onAudioFilesChange(syncAudioLinks(updated));
    setSelectedAudioIndex(toIndex);
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
      reorderAudioFile(dragItem.current, dragOverItem.current);
    }
    dragItem.current = null;
    dragOverItem.current = null;
    setDraggedIndex(null);
  };

  const removeAudioFile = (index: number) => {
    const updated = syncAudioLinks(audioFiles.filter((_, currentIndex) => currentIndex !== index));
    onAudioFilesChange(updated);
    setSelectedAudioIndex(null);
  };

  const duplicateAudioFile = (index: number) => {
    const original = audioFiles[index];
    if (!original) return;
    if (videoFiles.length === 0) {
      toast({
        title: "Cannot Duplicate Audio",
        description: "Add video files before duplicating audio.",
        variant: "destructive",
      });
      return;
    }
    if (audioFiles.length >= videoFiles.length) {
      toast({
        title: "Cannot Duplicate Audio",
        description: "Audio count cannot exceed video count.",
        variant: "destructive",
      });
      return;
    }

    const newFile: ExternalFile = {
      ...original,
      id: `audio-dup-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    };
    const updated = [...audioFiles];
    updated.splice(index + 1, 0, newFile);
    onAudioFilesChange(syncAudioLinks(updated));
    setSelectedAudioIndex(index + 1);
    toast({
      title: "Audio Duplicated",
      description: `${original.name} duplicated.`,
    });
  };

  const openEditDialog = (fileId: string) => {
    const file = audioFiles.find((entry) => entry.id === fileId);
    if (!file) return;
    const defaultIncluded =
      file.tracks && file.tracks.length > 0
        ? getAudioTrackIds(file)
        : [];
    setEditingFileId(fileId);
    setEditForm({
      trackName: file.trackName || "",
      language: file.language || "und",
      delay: (file.delay ?? 0).toFixed(3),
      isDefault: file.isDefault || false,
      isForced: file.isForced || false,
      muxAfter: file.muxAfter || "video",
      applyDelayToAll: false,
      includedTrackIds: file.includedTrackIds !== undefined ? [...file.includedTrackIds] : defaultIncluded,
      includeSubtitles: getDefaultIncludeSubtitles(file),
      includedSubtitleTrackIds:
        file.includedSubtitleTrackIds !== undefined
          ? [...file.includedSubtitleTrackIds]
          : getSubtitleTrackIds(file),
    });
    setEditDialogOpen(true);
  };

  const applyTrackChangesToDuplicateFiles = useCallback(
    (
      fileId: string,
      updater: (file: ExternalFile, isTarget: boolean) => ExternalFile,
    ) => {
      const target = audioFiles.find((entry) => entry.id === fileId);
      if (!target) return;
      const updated = audioFiles.map((file) => {
        if (file.path !== target.path) return file;
        return updater(file, file.id === fileId);
      });
      onAudioFilesChange(updated);
    },
    [audioFiles, onAudioFilesChange],
  );

  const applyEditChanges = () => {
    if (!editingFileId) return;
    const delayValue = Number(editForm.delay) || 0;

    if (editForm.applyToAllFiles) {
      // Compute which track INDICES are selected in the editing file, then mirror to all files
      const editingFileData = audioFiles.find((f) => f.id === editingFileId);
      const srcAudioTracks = (editingFileData?.tracks || []).filter((t) => t.type === "audio");
      const srcSubTracks = (editingFileData?.tracks || []).filter((t) => t.type === "subtitle");
      const selAudioIdx = new Set(
        srcAudioTracks
          .map((t, i) => ({ i, id: Number(t.id) }))
          .filter(({ id }) => editForm.includedTrackIds.includes(id))
          .map(({ i }) => i),
      );
      const selSubIdx = new Set(
        srcSubTracks
          .map((t, i) => ({ i, id: Number(t.id) }))
          .filter(({ id }) => editForm.includedSubtitleTrackIds.includes(id))
          .map(({ i }) => i),
      );

      const updated = audioFiles.map((file) => {
        const fileAudioTracks = (file.tracks || []).filter((t) => t.type === "audio");
        const fileSubTracks = (file.tracks || []).filter((t) => t.type === "subtitle");
        const newAudioIds = fileAudioTracks
          .map((t, i) => ({ i, id: Number(t.id) }))
          .filter(({ i }) => selAudioIdx.has(i))
          .map(({ id }) => id)
          .filter((id) => Number.isFinite(id));
        const newSubIds = fileSubTracks
          .map((t, i) => ({ i, id: Number(t.id) }))
          .filter(({ i }) => selSubIdx.has(i))
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
          includedTrackIds: fileAudioTracks.length > 0 ? newAudioIds : file.includedTrackIds,
          includeSubtitles: editForm.includeSubtitles,
          includedSubtitleTrackIds: fileSubTracks.length > 0 ? newSubIds : file.includedSubtitleTrackIds,
          isManuallyEdited: true,
        };
      });

      onAudioFilesChange(updated);
      setEditDialogOpen(false);
      setEditingFileId(null);
      toast({ title: "Applied to All Files", description: `Settings applied to all ${audioFiles.length} audio file(s).` });
      return;
    }

    let updated = audioFiles.map((file) => {
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
          includeSubtitles: editForm.includeSubtitles,
          includedSubtitleTrackIds: editForm.includedSubtitleTrackIds,
          trackOverrides: file.trackOverrides,
          isManuallyEdited: true,
        };
      }
      if (editForm.applyDelayToAll) {
        return { ...file, delay: delayValue };
      }
      return file;
    });

    const editedTarget = updated.find((file) => file.id === editingFileId);
    if (editedTarget) {
      updated = updated.map((file) => {
        if (file.id === editingFileId) return file;
        if (file.path !== editedTarget.path) return file;
        return {
          ...file,
          includedTrackIds: [...editForm.includedTrackIds],
          includeSubtitles: editForm.includeSubtitles,
          includedSubtitleTrackIds: [...editForm.includedSubtitleTrackIds],
          trackOverrides: { ...(file.trackOverrides || {}) },
          isManuallyEdited: true,
        };
      });
    }

    onAudioFilesChange(updated);
    setEditDialogOpen(false);
    setEditingFileId(null);
  };

  const openTrackEdit = (fileId: string, trackId: number, trackType: "audio" | "subtitle") => {
    const file = audioFiles.find((entry) => entry.id === fileId);
    if (!file) return;
    const track = file.tracks?.find((t) => Number(t.id) === trackId);
    const overrides = file.trackOverrides?.[trackId] || {};
    setTrackEditTarget({ fileId, trackId, trackType });
    setTrackEditForm({
      language: overrides.language || track?.language || "und",
      delay: (overrides.delay ?? 0).toFixed(3),
      trackName: overrides.trackName || track?.name || "",
    });
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
      const delay = file.trackOverrides?.[trackId]?.delay ?? file.delay ?? 0;
      initial[trackId] = delay.toFixed(3);
    });
    setMultiDelayFileId(fileId);
    setMultiDelayTrackType(trackType);
    setMultiDelayValues(initial);
    setMultiDelayBulkValue((file.delay ?? 0).toFixed(3));
    setMultiDelayOpen(true);
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

    applyTrackChangesToDuplicateFiles(fileId, (file) => {
      const nextOverrides = { ...(file.trackOverrides || {}) };
      nextOverrides[trackId] = {
        language: nextLanguage || undefined,
        delay: nextDelay,
        trackName: nextName || undefined,
      };
      return { ...file, trackOverrides: nextOverrides, isManuallyEdited: true };
    });
  };

  const applyMultiDelayChanges = () => {
    if (!multiDelayFileId) return;
    applyTrackChangesToDuplicateFiles(multiDelayFileId, (file) => {
      const targetTracks = (file.tracks || []).filter((track) => track.type === multiDelayTrackType);
      const nextOverrides = { ...(file.trackOverrides || {}) };
      targetTracks.forEach((track) => {
        const trackId = Number(track.id);
        if (!Number.isFinite(trackId)) return;
        const nextDelay = Number(multiDelayValues[trackId]) || 0;
        const prev = nextOverrides[trackId] || {};
        nextOverrides[trackId] = {
          ...prev,
          delay: nextDelay,
        };
      });
      return {
        ...file,
        trackOverrides: nextOverrides,
        isManuallyEdited: true,
      };
    });
    setMultiDelayOpen(false);
    setMultiDelayFileId(null);
    setMultiDelayTrackType("audio");
    toast({
      title: "Track Delays Updated",
      description: `Applied per-track delay values for selected ${multiDelayTrackType} tracks.`,
    });
  };

  const applyBulkMapping = () => {
    if (bulkSelectedVideoIds.length === 0 || bulkSelectedAudioIds.length === 0) {
      toast({
        title: "Bulk Apply",
        description: "Select at least one video and one audio file.",
        variant: "destructive",
      });
      return;
    }

    const firstCount = Math.max(1, Math.floor(Number(bulkFirstCount) || 1));
    const selectedAudio = audioFiles.filter((file) => bulkSelectedAudioIds.includes(file.id));
    if (selectedAudio.length === 0) {
      toast({
        title: "Bulk Apply",
        description: "Selected audio files are not available.",
        variant: "destructive",
      });
      return;
    }

    const remaining = bulkReplaceExisting
      ? audioFiles.filter((file) => !bulkSelectedVideoIds.includes(file.matchedVideoId || ""))
      : [...audioFiles];

    const nextFiles = bulkSelectedVideoIds.reduce<ExternalFile[]>((acc, videoId) => {
      selectedAudio.forEach((file) => {
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

    onAudioFilesChange([...remaining, ...nextFiles]);
    setBulkOpen(false);
    toast({
      title: "Bulk Apply Complete",
      description: `Applied ${selectedAudio.length} audio file(s) to ${bulkSelectedVideoIds.length} video(s).`,
    });
  };

  useEffect(() => {
    if (onAddTrack) {
      window.__audiosAddTrack = addNewTrack;
    }
    return () => {
      delete window.__audiosAddTrack;
    };
  }, [onAddTrack, addNewTrack]);

  useEffect(() => {
    if (!preset || audioPresetApplied) return;
    audioTracks.forEach((trackId) => {
      updateAudioTrackConfig(trackId, {
        sourceFolder: preset.Default_Audio_Directory || "",
        extension: "all",
        language: preset.Default_Audio_Language
          ? normalizeLanguage(preset.Default_Audio_Language)
          : "und",
      });
    });
    setAudioPresetApplied(true);
  }, [preset, audioPresetApplied, audioTracks, updateAudioTrackConfig, setAudioPresetApplied]);

  const scanAudios = useCallback(async (folderPath: string) => {
    if (!folderPath) {
      onAudioFilesChange([]);
      return;
    }
    const extensions =
      currentConfig.extension === 'all' ? audioExtensions : [currentConfig.extension];
    const results = await scanMedia({
      folder: folderPath,
      extensions,
      recursive: true,
      type: 'audio',
      include_tracks: true,
    });
    const normalized = (results as ExternalFile[]).map((file, index) => ({
      ...file,
      type: 'audio' as const,
      language: currentConfig.language,
      trackName: currentConfig.trackName,
      delay: Number(currentConfig.delay) || 0,
      isDefault: currentConfig.isDefault,
      isForced: currentConfig.isForced,
      muxAfter: currentConfig.muxAfter,
      includeSubtitles: getSubtitleTrackIds(file).length > 0,
      includedSubtitleTrackIds:
        file.includedSubtitleTrackIds?.length
          ? file.includedSubtitleTrackIds
          : getSubtitleTrackIds(file),
      trackOverrides: file.trackOverrides ?? {},
      includedTrackIds:
        file.tracks && file.tracks.length > 0
          ? getAudioTrackIds(file)
          : file.includedTrackIds,
    }));
    onAudioFilesChange(syncAudioLinks(normalized));
  }, [currentConfig, onAudioFilesChange, syncAudioLinks]);

  useEffect(() => {
    if (audioFiles.length === 0) return;
    // Re-match only when some file's matchedVideoId is missing or points to a removed video
    const videoIdSet = new Set(videoFiles.map((v) => v.id));
    const needsRematch = audioFiles.some(
      (f) => !f.matchedVideoId || !videoIdSet.has(f.matchedVideoId),
    );
    if (needsRematch) {
      onAudioFilesChange(matchExternalToVideos(audioFiles, videoFiles));
    }
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
    
    if (activeAudioTrack === trackToDelete) {
      const remainingTracks = audioTracks.filter(t => t !== trackToDelete);
      setActiveAudioTrack(remainingTracks[0] || '1');
    }
    
    setDeleteDialogOpen(false);
    setTrackToDelete(null);
    
    toast({
      title: "Track Deleted",
      description: `Audio #${deletedNumber} has been removed.`,
      variant: "destructive",
    });
  };

  const handleImportAudios = async () => {
    if (videoFiles.length === 0) {
      toast({
        title: "No Videos Loaded",
        description: "Load video files first, then import audio streams.",
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

  const handleConfirmImportAudios = () => {
    const targetIndex = selectedVideoIndex ?? 0;
    const targetVideo = videoFiles[targetIndex];
    if (!targetVideo || !selectedImportSource || importSelectedTrackKeys.length === 0) return;

    const selectedTrackKeySet = new Set(importSelectedTrackKeys);
    const selectedTracks = importableTracks.filter((track, trackIndex) =>
      selectedTrackKeySet.has(getImportTrackKey(trackIndex, String(track.id))),
    );
    if (selectedTracks.length === 0) return;

    const existingAtTarget = audioFiles[targetIndex];
    const existingTracks = existingAtTarget?.tracks?.filter((track) => track.type === "audio") || [];
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
      type: "audio",
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
      includeSubtitles: false,
      includedSubtitleTrackIds: [],
    };

    const updated = [...audioFiles];
    if (targetIndex < updated.length) {
      updated[targetIndex] = importedFile;
    } else {
      updated.push(importedFile);
    }
    onAudioFilesChange(syncAudioLinks(updated));
    setSelectedAudioIndex(targetIndex);
    setSelectedVideoIndex(targetIndex);
    setImportStreamsOpen(false);
    toast({
      title: "Audio Streams Imported",
      description: `Imported ${selectedTracks.length} stream${selectedTracks.length > 1 ? "s" : ""} to Video #${targetIndex + 1}.`,
    });
  };

  return (
    <div className="flex flex-col h-full p-5 gap-4 bg-background">
      {/* Track Selector Card */}
      <div className="track-selector-bar">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <Select value={activeAudioTrack} onValueChange={setActiveAudioTrack}>
              <SelectTrigger className="w-36 h-8 bg-panel-header text-secondary-foreground border border-panel-border font-medium">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {audioTracks.map((track) => (
                  <SelectItem key={track} value={track}>Audio #{track}</SelectItem>
                ))}
              </SelectContent>
            </Select>
            {audioTracks.length > 1 && (
              <Button
                variant="ghost"
                size="icon"
                className="h-8 w-8 text-destructive hover:text-destructive hover:bg-destructive/10"
                onClick={() => confirmDeleteTrack(activeAudioTrack)}
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
              onClick={handleImportAudios}
            >
              Import Audios
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
              placeholder="Select audio folder path..."
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
                  scanAudios(folder);
                }
              }}
            >
              <FolderOpen className="w-4 h-4" />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              className="h-8 w-8 bg-primary/10 text-primary hover:bg-primary/20"
              onClick={() => scanAudios(currentConfig.sourceFolder)}
            >
              <RefreshCw className="w-4 h-4" />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              className="h-8 w-8 bg-destructive/10 text-destructive hover:bg-destructive/20"
              onClick={() => {
                updateCurrentConfig({ sourceFolder: '' });
                onAudioFilesChange([]);
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
                {AUDIO_EXTENSIONS.map((ext) => (
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
                id="audio-default"
                checked={currentConfig.isDefault}
                onCheckedChange={(checked) => updateCurrentConfig({ isDefault: checked as boolean })}
              />
              <label htmlFor="audio-default" className="text-[12px] cursor-pointer">Default</label>
            </div>
            <div className="flex items-center gap-2 min-w-[120px]">
              <Checkbox
                id="audio-forced"
                checked={currentConfig.isForced}
                onCheckedChange={(checked) => updateCurrentConfig({ isForced: checked as boolean })}
              />
              <label htmlFor="audio-forced" className="text-[12px] cursor-pointer">Forced</label>
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

        {/* Audio Files Card */}
        <div className="panel-card flex flex-col min-h-0 overflow-hidden">
          <div className="panel-card-header">
            <h4 className="panel-card-title">Audio Files</h4>
            <div className="panel-card-actions">
              <Button
                variant="ghost"
                size="icon"
                className="panel-icon-btn"
                onClick={() =>
                  selectedAudioIndex !== null && reorderAudioFile(selectedAudioIndex, selectedAudioIndex - 1)
                }
                disabled={selectedAudioIndex === null || selectedAudioIndex === 0}
              >
                <ChevronUp className="w-3.5 h-3.5" />
              </Button>
              <Button
                variant="ghost"
                size="icon"
                className="panel-icon-btn"
                onClick={() =>
                  selectedAudioIndex !== null && reorderAudioFile(selectedAudioIndex, selectedAudioIndex + 1)
                }
                disabled={selectedAudioIndex === null || selectedAudioIndex === audioFiles.length - 1}
              >
                <ChevronDown className="w-3.5 h-3.5" />
              </Button>
              <Button
                variant="ghost"
                size="sm"
                className="panel-text-btn"
                onClick={() => selectedAudioIndex !== null && duplicateAudioFile(selectedAudioIndex)}
                disabled={selectedAudioIndex === null}
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
                  setBulkSelectedAudioIds(audioFiles.map((file) => file.id));
                  setBulkOpen(true);
                }}
                disabled={videoFiles.length === 0 || audioFiles.length === 0}
              >
                Bulk Apply
              </Button>
            </div>
          </div>
          <div className="flex-1 overflow-auto scrollbar-thin">
            {audioFiles.length === 0 ? (
              <EmptyState
                icon={<AudioLines className="w-5 h-5 text-muted-foreground/65" />}
                title="No audio files found"
                description="Click the folder icon above or drag and drop files here"
                className="h-full"
              />
            ) : (
              audioFiles.map((file, index) => (
                <div
                  key={file.id}
                  draggable
                  onDragStart={() => handleDragStart(index)}
                  onDragEnter={() => handleDragEnter(index)}
                  onDragEnd={handleDragEnd}
                  onDragOver={(e) => e.preventDefault()}
                  onClick={() => setSelectedAudioIndex(index)}
                  onDoubleClick={() => openEditDialog(file.id)}
                  className={cn("file-item-audio", selectedAudioIndex === index && "selected", draggedIndex === index && "opacity-60")}
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
                        removeAudioFile(index);
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
                        duplicateAudioFile(index);
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
        title="Import Audio Streams"
        subtitle="Import specific audio streams from loaded video files."
        icon={<AudioLines className="w-5 h-5 text-primary" />}
        className="max-w-2xl"
        footerRight={
          <>
            <Button variant="ghost" onClick={() => setImportStreamsOpen(false)}>
              Cancel
            </Button>
            <Button onClick={handleConfirmImportAudios} disabled={!importSourceVideoId || importSelectedTrackKeys.length === 0}>
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
            <label className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Audio Streams</label>
            <div className="max-h-56 overflow-y-auto rounded border border-panel-border/60 p-2 space-y-2">
              {importableTracks.length === 0 ? (
                <div className="text-xs text-muted-foreground px-1 py-2">No audio streams available in selected video.</div>
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
                        {track.name || track.codec || `Audio ${idx + 1}`}
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
        title="Bulk Apply Audio Files"
        subtitle="Apply selected audio files to selected videos with a track subset."
        icon={<AudioLines className="w-5 h-5 text-primary" />}
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
              <div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Audio Files</div>
              <div className="max-h-48 overflow-y-auto space-y-2 pr-1 scrollbar-thin">
                {audioFiles.map((file) => {
                  const checked = bulkSelectedAudioIds.includes(file.id);
                  const trackCount = file.tracks?.length || file.includedTrackIds?.length || 0;
                  const audioTrackCount = (file.tracks || []).filter((track) => track.type === "audio").length;
                  return (
                    <div key={file.id} className="flex items-center gap-2 text-xs text-foreground/80">
                      <label className="flex items-center gap-2 min-w-0 flex-1 cursor-pointer">
                        <Checkbox
                          checked={checked}
                          onCheckedChange={(value) => {
                            setBulkSelectedAudioIds((prev) =>
                              value ? [...prev, file.id] : prev.filter((id) => id !== file.id),
                            );
                          }}
                        />
                        <span className="truncate">{file.name}</span>
                      </label>
                      {audioTrackCount > 1 && (
                        <Button
                          variant="ghost"
                          size="sm"
                          className="h-6 px-2 text-[10px]"
                          onClick={() => openEditDialog(file.id)}
                        >
                          Tracks
                        </Button>
                      )}
                      {trackCount > 1 && (
                        <span className="text-[10px] text-muted-foreground/70 shrink-0">{trackCount} tracks</span>
                      )}
                    </div>
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
              Replace existing bulk audio mappings for selected videos
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
        title="Edit Audio Track"
        subtitle="Update audio track settings."
        icon={<AudioLines className="w-5 h-5 text-primary" />}
        className="max-w-lg"
        footerRight={
          <>
            <Button
              variant="ghost"
              className="text-muted-foreground hover:text-foreground"
              onClick={() => setEditDialogOpen(false)}
            >
              Cancel
            </Button>
            <Button onClick={applyEditChanges}>Save Changes</Button>
          </>
        }
      >
        <div className="space-y-4">
          <div className="space-y-1.5">
            <label className="text-xs font-medium text-muted-foreground">Source File</label>
            <div
              className="h-9 px-3 flex items-center rounded-md border border-panel-border/50 bg-panel-header/60 text-sm text-foreground truncate"
              title={editingFile?.name || ""}
            >
              {editingFile?.name || "—"}
            </div>
          </div>
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
              <label className="text-xs font-medium text-muted-foreground">Track Order</label>
              <Select
                value={editForm.muxAfter}
                onValueChange={(value) => setEditForm((prev) => ({ ...prev, muxAfter: value }))}
              >
                <SelectTrigger className="h-9">
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

          <div className="grid grid-cols-1 md:grid-cols-[1fr_auto] items-start gap-3">
            <div className="rounded-md border border-panel-border/50 bg-panel-header/40 px-4 py-3 space-y-2">
              <div className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Track Flags</div>
              <div className="flex flex-wrap items-start gap-x-5 gap-y-2">
                <label className="inline-flex items-center gap-3 cursor-pointer">
                  <Checkbox
                    id="audio-edit-default"
                    checked={editForm.isDefault}
                    onCheckedChange={(checked) =>
                      setEditForm((prev) => ({ ...prev, isDefault: checked as boolean }))
                    }
                  />
                  <span className="text-sm">Default</span>
                </label>
                <div className="inline-flex items-start gap-3">
                  <Checkbox
                    id="audio-edit-forced"
                    checked={editForm.isForced}
                    onCheckedChange={(checked) =>
                      setEditForm((prev) => ({ ...prev, isForced: checked as boolean }))
                    }
                  />
                  <div className="flex flex-col">
                    <label htmlFor="audio-edit-forced" className="text-sm cursor-pointer">
                      Forced
                    </label>
                    <span className="max-w-[190px] text-[11px] leading-tight text-muted-foreground">
                      Rare for audio; some players may ignore.
                    </span>
                  </div>
                </div>
              </div>
            </div>
            <div className="rounded-md border border-panel-border/50 bg-panel-header/30 px-4 py-3 space-y-2">
              <div className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground mb-2">Bulk Action</div>
              <label className="inline-flex items-center gap-3 cursor-pointer">
                <Checkbox
                  id="audio-edit-delay-all"
                  checked={editForm.applyDelayToAll}
                  onCheckedChange={(checked) =>
                    setEditForm((prev) => ({ ...prev, applyDelayToAll: checked as boolean }))
                  }
                />
                <span className="text-sm">Apply delay to all</span>
              </label>
              <label className="inline-flex items-center gap-3 cursor-pointer">
                <Checkbox
                  id="audio-edit-apply-all"
                  checked={editForm.applyToAllFiles}
                  onCheckedChange={(checked) =>
                    setEditForm((prev) => ({ ...prev, applyToAllFiles: checked as boolean }))
                  }
                />
                <div className="flex flex-col">
                  <span className="text-sm">Apply to all files</span>
                  <span className="text-[11px] text-muted-foreground leading-tight">Track selection applied by position</span>
                </div>
              </label>
            </div>
          </div>

          {editingFile?.tracks && editingFile.tracks.length > 0 && (
            <>
              <div className="rounded-md border border-panel-border/50 bg-panel-header/40 px-4 py-3 space-y-3">
                <div className="flex items-center justify-between">
                  <div className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                    Included Audio Tracks
                  </div>
                  <div className="flex items-center gap-2">
                    {editingFile.tracks.filter((track) => track.type === "audio").length > 1 && (
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-7 px-2 text-[11px]"
                        onClick={() => openMultiDelayDialog(editingFile.id, "audio")}
                      >
                        Track Delays
                      </Button>
                    )}
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-7 px-2 text-[11px]"
                      onClick={() =>
                        setEditForm((prev) => ({
                          ...prev,
                          includedTrackIds: getAudioTrackIds(editingFile),
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
                  {editingFile.tracks
                    .filter((track) => track.type === "audio")
                    .map((track, index) => {
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
                              onClick={() => openTrackEdit(editingFile.id, trackId, "audio")}
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

              {editingFile.tracks.some((track) => track.type === "subtitle") && (
                <div className="rounded-md border border-panel-border/50 bg-panel-header/40 px-4 py-3 space-y-3">
                  <div className="flex items-center justify-between">
                    <div className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                      Included Subtitle Tracks
                    </div>
                    <div className="flex items-center gap-2">
                      {editingFile.tracks.filter((track) => track.type === "subtitle").length > 1 && (
                        <Button
                          variant="ghost"
                          size="sm"
                          className="h-7 px-2 text-[11px]"
                          onClick={() => openMultiDelayDialog(editingFile.id, "subtitle")}
                        >
                          Track Delays
                        </Button>
                      )}
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-7 px-2 text-[11px]"
                        onClick={() =>
                          setEditForm((prev) => ({
                            ...prev,
                            includeSubtitles: true,
                            includedSubtitleTrackIds: getSubtitleTrackIds(editingFile),
                          }))
                        }
                      >
                        Copy All
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-7 px-2 text-[11px] text-muted-foreground hover:text-foreground"
                        onClick={() =>
                          setEditForm((prev) => ({
                            ...prev,
                            includeSubtitles: false,
                            includedSubtitleTrackIds: [],
                          }))
                        }
                      >
                        Uncopy All
                      </Button>
                    </div>
                  </div>
                  <div className="flex items-center gap-2 text-xs text-muted-foreground">
                    <Checkbox
                      checked={editForm.includeSubtitles}
                      onCheckedChange={(value) =>
                        setEditForm((prev) => ({
                          ...prev,
                          includeSubtitles: value as boolean,
                          includedSubtitleTrackIds: value
                            ? getSubtitleTrackIds(editingFile)
                            : [],
                        }))
                      }
                    />
                    Include subtitle tracks from this file
                  </div>
                  <div className="space-y-2">
                    {editingFile.tracks
                      .filter((track) => track.type === "subtitle")
                      .map((track, index) => {
                        const trackId = Number(track.id);
                        const checked = editForm.includedSubtitleTrackIds.includes(trackId);
                        return (
                          <div key={track.id} className="flex items-center justify-between gap-3">
                            <div className="flex items-center gap-3 min-w-0">
                              <Checkbox
                                checked={checked}
                                onCheckedChange={(value) => {
                                  const next = new Set(editForm.includedSubtitleTrackIds);
                                  if (value) {
                                    if (!Number.isNaN(trackId)) next.add(trackId);
                                  } else {
                                    next.delete(trackId);
                                  }
                                  setEditForm((prev) => ({
                                    ...prev,
                                    includeSubtitles: true,
                                    includedSubtitleTrackIds: Array.from(next),
                                  }));
                                }}
                              />
                              <div className="text-sm text-foreground truncate">
                                Track {index + 1}
                                {track.language ? ` • ${track.language}` : ""}
                                {track.name ? ` • ${track.name}` : ""}
                              </div>
                            </div>
                            <Button
                              variant="ghost"
                              size="icon"
                              className="h-7 w-7 text-muted-foreground hover:text-foreground"
                              onClick={() => openTrackEdit(editingFile.id, trackId, "subtitle")}
                            >
                              <Pencil className="w-3.5 h-3.5" />
                            </Button>
                          </div>
                        );
                      })}
                  </div>
                </div>
              )}
            </>
          )}
        </div>
      </BaseModal>

      <BaseModal
        open={multiDelayOpen}
        onOpenChange={(open) => {
          setMultiDelayOpen(open);
          if (!open) {
            setMultiDelayFileId(null);
            setMultiDelayTrackType("audio");
            setMultiDelayValues({});
          }
        }}
        title={`Edit Multi-Track ${multiDelayTrackType === "audio" ? "Audio" : "Subtitle"} Delays`}
        subtitle={
          multiDelayFile?.name ||
          `Set separate delays for each ${multiDelayTrackType} track`
        }
        icon={<AudioLines className="w-5 h-5 text-primary" />}
        className="max-w-xl"
        bodyClassName="px-5 py-4"
        footerRight={
          <>
            <Button
              variant="ghost"
              className="text-muted-foreground hover:text-foreground"
              onClick={() => setMultiDelayOpen(false)}
            >
              Cancel
            </Button>
            <Button onClick={applyMultiDelayChanges}>Save Delays</Button>
          </>
        }
      >
        <div className="space-y-4">
          <div className="rounded-md border border-panel-border/50 bg-panel-header/30 px-4 py-3 space-y-3">
            <div className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
              Bulk Fill
            </div>
            <div className="flex items-center gap-2">
              <Input
                value={multiDelayBulkValue}
                onChange={(event) => setMultiDelayBulkValue(event.target.value)}
                className="h-9 font-mono"
                placeholder="0.000"
              />
              <Button
                variant="outline"
                onClick={() =>
                  setMultiDelayValues((prev) => {
                    if (!multiDelayFile) return prev;
                    const next = { ...prev };
                    multiDelayFile.tracks
                      ?.filter((track) => track.type === multiDelayTrackType)
                      .forEach((track) => {
                        const trackId = Number(track.id);
                        if (!Number.isFinite(trackId)) return;
                        next[trackId] = multiDelayBulkValue;
                      });
                    return next;
                  })
                }
              >
                Apply To All {multiDelayTrackType === "audio" ? "Audio" : "Subtitle"} Tracks
              </Button>
            </div>
            <div className="text-[11px] text-muted-foreground/70">
              Use positive values to delay {multiDelayTrackType} and negative values to make it earlier.
            </div>
          </div>

          <div className="rounded-md border border-panel-border/50 bg-panel-header/40 px-4 py-3 space-y-3">
            <div className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
              Per-Track Delays
            </div>
            <div className="max-h-72 overflow-y-auto pr-1 space-y-2 scrollbar-thin">
              {(multiDelayFile?.tracks || [])
                .filter((track) => track.type === multiDelayTrackType)
                .map((track, index) => {
                  const trackId = Number(track.id);
                  const includedIds =
                    multiDelayTrackType === "audio"
                      ? multiDelayFile?.includedTrackIds
                      : multiDelayFile?.includedSubtitleTrackIds;
                  const isIncluded =
                    multiDelayTrackType === "subtitle" && !multiDelayFile?.includeSubtitles
                      ? false
                      : !includedIds || includedIds.length === 0
                      ? true
                      : includedIds.includes(trackId);
                  return (
                    <div
                      key={`${track.id}-${index}`}
                      className="grid grid-cols-[1fr_120px] items-center gap-3 rounded-md border border-panel-border/40 bg-card/40 px-3 py-2"
                    >
                      <div className="min-w-0">
                        <div className="text-sm text-foreground truncate">
                          Track {index + 1}
                          {track.language ? ` • ${track.language}` : ""}
                          {track.name ? ` • ${track.name}` : ""}
                        </div>
                        <div className="text-[11px] text-muted-foreground/70">
                          ID {track.id}
                          {isIncluded ? " • Included" : " • Not included"}
                        </div>
                      </div>
                      <Input
                        value={Number.isFinite(trackId) ? (multiDelayValues[trackId] ?? "0.000") : "0.000"}
                        onChange={(event) => {
                          const value = event.target.value;
                          if (!Number.isFinite(trackId)) return;
                          setMultiDelayValues((prev) => ({ ...prev, [trackId]: value }));
                        }}
                        className="h-8 font-mono text-right"
                      />
                    </div>
                  );
                })}
            </div>
          </div>
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
        title="Delete Audio Track"
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
          Are you sure you want to delete Audio #{trackToDelete}? This will remove all settings associated with this track.
        </p>
      </BaseModal>
    </div>
  );
}
