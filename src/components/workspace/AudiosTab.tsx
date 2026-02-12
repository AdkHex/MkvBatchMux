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


export function AudiosTab({
  audioFiles,
  videoFiles,
  onAudioFilesChange,
  onVideoFilesChange,
  onAddTrack,
  preset,
}: AudiosTabProps) {
  const syncAudioLinks = useCallback(
    (files: ExternalFile[]) =>
      files.map((file, index) => ({
        ...file,
        matchedVideoId: videoFiles[index]?.id,
      })),
    [videoFiles]
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
  const canLinkSelection = selectedVideoIndex !== null && selectedAudioIndex !== null;
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
  const [editForm, setEditForm] = useState({
    trackName: "",
    language: "und",
    delay: "0.000",
    isDefault: false,
    isForced: false,
    muxAfter: "video",
    applyDelayToAll: false,
    includedTrackIds: [] as number[],
    includeSubtitles: false,
    includedSubtitleTrackIds: [] as number[],
  });

  const currentConfig = audioTrackConfigs[activeAudioTrack] || defaultTrackConfig;
  const editingFile = audioFiles.find((file) => file.id === editingFileId) || null;
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

  const getAudioTrackIds = (file: ExternalFile) =>
    file.tracks
      ? file.tracks
          .filter((track) => track.type === "audio")
          .map((track) => Number(track.id))
          .filter((id) => Number.isFinite(id))
      : [];

  const getSubtitleTrackIds = (file: ExternalFile) =>
    file.tracks
      ? file.tracks
          .filter((track) => track.type === "subtitle")
          .map((track) => Number(track.id))
          .filter((id) => Number.isFinite(id))
      : [];

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
      language: currentConfig.language,
      trackName: currentConfig.trackName,
      delay: delayValue,
      isDefault: currentConfig.isDefault,
      isForced: currentConfig.isForced,
      muxAfter: currentConfig.muxAfter,
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
      includeSubtitles: file.includeSubtitles || false,
      includedSubtitleTrackIds:
        file.includedSubtitleTrackIds !== undefined
          ? [...file.includedSubtitleTrackIds]
          : getSubtitleTrackIds(file),
    });
    setEditDialogOpen(true);
  };

  const applyEditChanges = () => {
    if (!editingFileId) return;
    const delayValue = Number(editForm.delay) || 0;
    const updated = audioFiles.map((file) => {
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
        };
      }
      if (editForm.applyDelayToAll) {
        return { ...file, delay: delayValue };
      }
      return file;
    });
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

    const updated = audioFiles.map((file) => {
      if (file.id !== fileId) return file;
      const nextOverrides = { ...(file.trackOverrides || {}) };
      nextOverrides[trackId] = {
        language: nextLanguage || undefined,
        delay: nextDelay,
        trackName: nextName || undefined,
      };
      return { ...file, trackOverrides: nextOverrides };
    });
    onAudioFilesChange(updated);
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

  const linkAudioToVideo = () => {
    if (selectedVideoIndex === null || selectedAudioIndex === null) return;
    reorderAudioFile(selectedAudioIndex, selectedVideoIndex);
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
      includeSubtitles: file.includeSubtitles ?? false,
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
    const isSynced = audioFiles.every((file, index) => file.matchedVideoId === videoFiles[index]?.id);
    if (!isSynced) {
      onAudioFilesChange(syncAudioLinks(audioFiles));
    }
  }, [audioFiles, onAudioFilesChange, syncAudioLinks, videoFiles]);

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

  return (
    <div className="flex flex-col h-full p-5 gap-4">
      {/* Track Selector Card */}
      <div className="fluent-surface p-4 min-h-[56px]">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-12 pl-4">
            <Select value={activeAudioTrack} onValueChange={setActiveAudioTrack}>
              <SelectTrigger className="w-32 h-9 bg-secondary text-secondary-foreground border border-panel-border font-medium">
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
                className="h-9 w-9 text-destructive hover:text-destructive hover:bg-destructive/10"
                onClick={() => confirmDeleteTrack(activeAudioTrack)}
              >
                <Trash2 className="w-4 h-4" />
              </Button>
            )}
          </div>
          <div className="flex items-center gap-2 mr-3">
            <Button
              variant="outline"
              size="sm"
              className="h-9 gap-2"
              onClick={duplicateTrack}
            >
              <Copy className="w-4 h-4" />
              Duplicate
            </Button>
            <Button
              variant="default"
              size="sm"
              className="h-9 gap-2"
              onClick={addNewTrack}
            >
              <Plus className="w-4 h-4" />
              Add Track
            </Button>
          </div>
        </div>
      </div>

      {/* Track Configuration Card */}
      <div className="fluent-surface p-3 space-y-2.5 min-h-[188px]">
        <h3 className="text-sm font-semibold text-foreground">Track Configuration</h3>
        
        {/* Source Folder */}
        <div className="flex items-center gap-3">
          <label className="text-[13px] text-muted-foreground w-28 shrink-0">Source Folder</label>
          <div className="flex-1 flex items-center gap-2">
            <Input
              value={currentConfig.sourceFolder}
              onChange={(e) => updateCurrentConfig({ sourceFolder: e.target.value })}
              placeholder="Select audio folder path..."
              className="h-9 flex-1"
            />
            <Button
              variant="outline"
              size="icon"
              className="h-9 w-9"
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
              className="h-9 w-9 bg-primary/10 text-primary hover:bg-primary/20"
              onClick={() => scanAudios(currentConfig.sourceFolder)}
            >
              <RefreshCw className="w-4 h-4" />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              className="h-9 w-9 bg-destructive/10 text-destructive hover:bg-destructive/20"
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
        <div className="grid grid-cols-[1.1fr_1.1fr_1.2fr] gap-4">
          <div className="grid grid-cols-[92px_minmax(0,1fr)] items-center gap-2">
            <label className="text-[13px] text-muted-foreground">Extension</label>
            <Select value={currentConfig.extension} onValueChange={(v) => updateCurrentConfig({ extension: v })}>
              <SelectTrigger className="h-9 flex-1">
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

          <div className="grid grid-cols-[92px_minmax(0,1fr)] items-center gap-2">
            <label className="text-[13px] text-muted-foreground">Language</label>
            <LanguageSelect
              value={currentConfig.language}
              onChange={(v) => updateCurrentConfig({ language: v })}
              className="h-9 flex-1"
            />
          </div>

          <div className="grid grid-cols-[92px_minmax(0,1fr)] items-center gap-2">
            <label className="text-[13px] text-muted-foreground">Track Name</label>
            <Input
              value={currentConfig.trackName}
              onChange={(e) => updateCurrentConfig({ trackName: e.target.value })}
              placeholder="Enter name"
              className="h-9 flex-1"
            />
          </div>

        </div>

        <div className="flex flex-wrap items-center gap-6 pt-1">
          <div className="grid grid-cols-[92px_minmax(0,1fr)] items-center gap-2 min-w-[240px]">
            <label className="text-[13px] text-muted-foreground">Mux After</label>
            <Select value={currentConfig.muxAfter} onValueChange={(v) => updateCurrentConfig({ muxAfter: v })}>
              <SelectTrigger className="h-9 w-40">
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

          <div className="grid grid-cols-[56px_minmax(0,1fr)_auto] items-center gap-2">
            <label className="text-[13px] text-muted-foreground">Delay</label>
            <Input
              value={currentConfig.delay}
              onChange={(e) => updateCurrentConfig({ delay: e.target.value })}
              className="h-9 w-24 text-center font-mono"
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
      <div className="flex-1 grid grid-cols-2 gap-4 min-h-0">
        {/* Video Files Card */}
        <div className="panel-card flex flex-col min-h-0 overflow-hidden">
          <div className="panel-card-header">
            <div className="flex items-center gap-2">
              {canLinkSelection ? (
                <Button
                  variant="default"
                  size="sm"
                  className="panel-text-btn"
                  onClick={linkAudioToVideo}
                >
                  Link
                </Button>
              ) : null}
              <h4 className="panel-card-title">Video Files</h4>
            </div>
          </div>
          <div className="flex-1 overflow-y-auto scrollbar-thin">
            {videoFiles.map((file, index) => (
              <div
                key={file.id}
                onClick={() => setSelectedVideoIndex(index)}
                className={cn(
                  "table-row px-4 text-sm cursor-pointer transition-colors font-mono flex items-center",
                  selectedVideoIndex === index && "selected",
                )}
              >
                <div className="media-row-main">
                  <span className="media-row-index">{index + 1}</span>
                  <span className="media-row-name">{file.name}</span>
                </div>
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
          <div className="flex-1 overflow-y-auto scrollbar-thin">
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
                  className={cn(
                    "table-row px-4 text-sm cursor-pointer transition-colors font-mono flex items-center justify-between gap-3",
                    selectedAudioIndex === index && "selected",
                    draggedIndex === index && "opacity-60"
                  )}
                >
                  <div className="media-row-main">
                    <GripVertical className="w-4 h-4 text-muted-foreground/50 hover:text-muted-foreground cursor-grab active:cursor-grabbing shrink-0" />
                    <span className="media-row-index">{index + 1}</span>
                    <span className="media-row-name">{file.name}</span>
                  </div>
                  <div className="media-row-actions">
                    {file.tracks && file.tracks.length > 1 && (
                      <span className="table-chip">
                        {file.tracks.length} tracks
                      </span>
                    )}
                    {file.tracks && file.tracks.some((track) => track.type === "subtitle") && (
                      <Button
                        variant="ghost"
                        size="sm"
                      className={cn(
                          "h-7 px-2 text-[10px] uppercase tracking-wide rounded-md",
                          file.includeSubtitles
                            ? "text-primary border border-primary/40 bg-primary/10"
                            : "text-muted-foreground border border-panel-border/50"
                        )}
                        onClick={(event) => {
                          event.stopPropagation();
                          const subtitleIds = getSubtitleTrackIds(file);
                          const nextInclude = !file.includeSubtitles;
                          const updated = audioFiles.map((entry) =>
                            entry.id === file.id
                              ? {
                                  ...entry,
                                  includeSubtitles: nextInclude,
                                  includedSubtitleTrackIds: subtitleIds.length ? subtitleIds : entry.includedSubtitleTrackIds,
                                }
                              : entry,
                          );
                          onAudioFilesChange(updated);
                        }}
                      >
                        Subs {getSubtitleTrackIds(file).length}
                      </Button>
                    )}
                    <Button
                      variant="ghost"
                      size="icon"
                      className="panel-icon-btn"
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
                      className="panel-icon-btn"
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
                      className="panel-icon-btn"
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
                  return (
                    <label key={file.id} className="flex items-center gap-2 text-xs text-foreground/80 cursor-pointer">
                      <Checkbox
                        checked={checked}
                        onCheckedChange={(value) => {
                          setBulkSelectedAudioIds((prev) =>
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

          <div className="grid grid-cols-[1fr_auto] gap-4">
            <div className="rounded-md border border-panel-border/50 bg-panel-header/40 px-4 py-3 space-y-2">
              <div className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Track Flags</div>
              <div className="flex items-center gap-5">
                <div className="flex items-center gap-3">
                  <Checkbox
                    id="audio-edit-default"
                    checked={editForm.isDefault}
                    onCheckedChange={(checked) =>
                      setEditForm((prev) => ({ ...prev, isDefault: checked as boolean }))
                    }
                  />
                  <label htmlFor="audio-edit-default" className="text-sm">
                    Default
                  </label>
                </div>
                <div className="flex items-center gap-3">
                  <Checkbox
                    id="audio-edit-forced"
                    checked={editForm.isForced}
                    onCheckedChange={(checked) =>
                      setEditForm((prev) => ({ ...prev, isForced: checked as boolean }))
                    }
                  />
                  <div className="flex flex-col">
                    <label htmlFor="audio-edit-forced" className="text-sm">
                      Forced
                    </label>
                    <span className="text-[11px] text-muted-foreground">
                      Rare for audio; some players may ignore.
                    </span>
                  </div>
                </div>
              </div>
            </div>
            <div className="rounded-md border border-panel-border/50 bg-panel-header/30 px-4 py-3">
              <div className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground mb-2">Bulk Action</div>
              <div className="flex items-center gap-3">
                <Checkbox
                  id="audio-edit-delay-all"
                  checked={editForm.applyDelayToAll}
                  onCheckedChange={(checked) =>
                    setEditForm((prev) => ({ ...prev, applyDelayToAll: checked as boolean }))
                  }
                />
                <label htmlFor="audio-edit-delay-all" className="text-sm">
                  Apply delay to all
                </label>
              </div>
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
