import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import { X, RefreshCw, FolderOpen, ChevronUp, ChevronDown, Plus, Trash2, Copy, AudioLines, Pencil, GripVertical, Gauge, Ban } from "lucide-react";
import { toast } from "@/shared/hooks/use-toast";
import { Button } from "@/shared/ui/button";
import { Input } from "@/shared/ui/input";
import { Checkbox } from "@/shared/ui/checkbox";
import { Switch } from "@/shared/ui/switch";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/shared/ui/select";
import { AlertDialogAction, AlertDialogCancel } from "@/shared/ui/alert-dialog";
import { BaseModal } from "@/shared/components/BaseModal";
import { EmptyState } from "@/shared/components/EmptyState";
import { MAX_PLAUSIBLE_OFFSET_MS } from "@/shared/types/audiosync";
import { LanguageSelect } from "@/features/workspace/components/LanguageSelect";
import {
  ImportTrackEditDialog,
  ImportTrackEditButton,
  type ImportTrackOverride,
} from "./ImportTrackEditDialog";
import { cn } from "@/shared/lib/utils";
import type { VideoFile, ExternalFile, Preset, StretchSetting } from "@/shared/types";
import { pickDirectory, scanMedia } from "@/shared/lib/backend";
import { useTabState } from "@/features/workspace/store/useTabState";
import { AUDIO_EXTENSIONS } from "@/shared/lib/extensions";
import {
  getUnlinkedExternalFiles,
  linkExternalFilesByOrder,
} from "@/shared/lib/matchUtils";
import { CODE_TO_LABEL, LABEL_TO_CODE } from "@/shared/data/languages-iso6393";
import { useMeasureDelays } from "@/features/workspace/hooks/useMeasureDelays";
import { MeasuredDelayInfo } from "@/features/workspace/components/MeasuredDelayInfo";
import { StretchToggle } from "@/features/workspace/components/StretchToggle";
import { ReferenceTrackPicker } from "@/features/workspace/components/ReferenceTrackPicker";
import { applyMeasurement, markDelayAsManual } from "@/features/workspace/lib/applyMeasurement";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/shared/ui/tooltip";

interface AudiosTabProps {
  audioFiles: ExternalFile[];
  videoFiles: VideoFile[];
  onAudioFilesChange: (files: ExternalFile[]) => void;
  onVideoFilesChange?: (files: VideoFile[]) => void;
  onAddTrack?: () => void;
  preset?: Preset | null;
  searchValue?: string;
  filterValue?: string;
  sortValue?: string;
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

/**
 * Per-track measurement results for a file, in track order.
 *
 * A multi-track external file is measured once per included track, and each
 * result is written to trackOverrides[trackId] rather than to the file. Rows
 * render file.measuredDelay directly, so without this the results of a batch
 * were invisible even though the mux used them.
 */
const measuredTrackEntries = (file: ExternalFile) => {
  const overrides = file.trackOverrides;
  if (!overrides) return [];
  const audioTracks = (file.tracks ?? []).filter((track) => track.type === "audio");

  return audioTracks
    .map((track, index) => {
      const trackId = Number(track.id);
      const override = overrides[trackId];
      if (!Number.isFinite(trackId) || !override?.measuredDelay) return null;
      return { trackId, override, label: `#${index + 1}` };
    })
    .filter((entry): entry is NonNullable<typeof entry> => entry !== null);
};

const getDefaultIncludeSubtitles = (file: ExternalFile) =>
  file.includeSubtitles !== undefined ? file.includeSubtitles : getSubtitleTrackIds(file).length > 0;


export function AudiosTab({
  audioFiles,
  videoFiles,
  onAudioFilesChange,
  onVideoFilesChange,
  onAddTrack,
  preset,
  searchValue = "",
  filterValue = "all",
  sortValue = "loaded",
}: AudiosTabProps) {
  const syncAudioLinks = useCallback(
    (files: ExternalFile[]) => linkExternalFilesByOrder(files, videoFiles),
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
  /** Which audio track of each video to measure against, by video id. Empty
   *  means "use each video's default", resolved at plan time. */
  const [referenceTrackByVideoId, setReferenceTrackByVideoId] = useState<Record<string, number>>(
    {},
  );
  const {
    engine: audiosyncEngine,
    isMeasuring,
    progress: measureProgress,
    start: startMeasuring,
    cancel: cancelMeasuring,
  } = useMeasureDelays({
    videoFiles,
    audioFiles,
    onAudioFilesChange,
    referenceTrackByVideoId,
  });

  const measurementAvailable = Boolean(
    audiosyncEngine?.engineAvailable && audiosyncEngine.ffmpegAvailable,
  );

  const setStretchForFile = useCallback(
    (fileId: string, stretch: StretchSetting | undefined) => {
      onAudioFilesChange(
        audioFiles.map((file) => (file.id === fileId ? { ...file, stretch } : file)),
      );
    },
    [audioFiles, onAudioFilesChange],
  );

  /** Re-measure one row, ignoring the skip rules for it alone. */
  const remeasureFile = useCallback(
    (fileId: string) => {
      startMeasuring({ onlyAudioFileIds: [fileId], force: true });
    },
    [startMeasuring],
  );

  /** Apply a delay that cut detection withheld -- a deliberate act, per §5.4. */
  const applyCutDelayAnyway = useCallback(
    (fileId: string, trackId: number | null) => {
      const file = audioFiles.find((candidate) => candidate.id === fileId);
      const measured = trackId === null
        ? file?.measuredDelay
        : file?.trackOverrides?.[trackId]?.measuredDelay;
      if (!file || !measured) return;

      // Rebuild the minimal result the writer needs from what was stored, so
      // this path shares the same conversion as an ordinary measurement.
      onAudioFilesChange(
        audioFiles.map((candidate) =>
          candidate.id === fileId
            ? applyMeasurement({
                file: candidate,
                result: {
                  videoFile: "",
                  audioFile: candidate.name,
                  delayMs: measured.engineDelayMs,
                  delayAtStartMs: null,
                  confidence: measured.confidence,
                  driftMsPerS: measured.driftMsPerS,
                  totalDriftMs: null,
                  hasSignificantDrift: measured.hasSignificantDrift,
                  startDelayMs: null,
                  endDelayMs: null,
                  windowsUsed: null,
                  windowsTotal: null,
                  error: null,
                  elapsedMs: null,
                  isLikelyCut: measured.isLikelyCut,
                  isRateMismatch: measured.isRateMismatch,
                  primaryFps: measured.primaryFps,
                },
                trackId,
                referenceTrack: measured.referenceTrack,
                measuredAt: measured.measuredAt,
                allowCut: true,
                force: true,
              })
            : candidate,
        ),
      );
      toast({
        title: "Delay applied",
        description: "The measured delay was applied despite the different-cut warning.",
      });
    },
    [audioFiles, onAudioFilesChange],
  );
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [trackToDelete, setTrackToDelete] = useState<string | null>(null);
  const [editDialogOpen, setEditDialogOpen] = useState(false);
  const [editingFileId, setEditingFileId] = useState<string | null>(null);
  const [draggedIndex, setDraggedIndex] = useState<number | null>(null);
  const dragItem = useRef<number | null>(null);
  const dragOverItem = useRef<number | null>(null);
  const audioFilesCache = useRef<Record<string, ExternalFile[]>>({});
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
  // Per-stream overrides for an import, keyed by the same track key as the
  // selection above. Cleared whenever the source video changes.
  const [importOverrides, setImportOverrides] = useState<Record<string, ImportTrackOverride>>({});
  const [importEditingKey, setImportEditingKey] = useState<string | null>(null);
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
  const unlinkedCount = useMemo(
    () => getUnlinkedExternalFiles(audioFiles, videoFiles).length,
    [audioFiles, videoFiles],
  );
  /**
   * Whether the audio row at this index has grown to show a measurement.
   *
   * The two panes are separate scroll areas paired by index, so a taller audio
   * row has to push its video partner to the same height or every row below
   * drifts out of alignment.
   */
  const audioRowIsTall = useCallback(
    (index: number) => {
      const file = audioFiles[index];
      if (!file) return false;
      return Boolean(file.measuredDelay) || measuredTrackEntries(file).length > 0;
    },
    [audioFiles],
  );

  const visibleVideoFiles = useMemo(() => {
    const term = searchValue.trim().toLowerCase();
    const filtered = videoFiles.filter((file) =>
      term ? `${file.name} ${file.path}`.toLowerCase().includes(term) : true,
    );
    if (sortValue === "name-asc") return [...filtered].sort((a, b) => a.name.localeCompare(b.name));
    if (sortValue === "name-desc") return [...filtered].sort((a, b) => b.name.localeCompare(a.name));
    if (sortValue === "size-desc") return [...filtered].sort((a, b) => (b.size || 0) - (a.size || 0));
    return filtered;
  }, [searchValue, sortValue, videoFiles]);
  const visibleAudioFiles = useMemo(() => {
    const term = searchValue.trim().toLowerCase();
    const filtered = audioFiles.filter((file) => {
      if (term && !`${file.name} ${file.path}`.toLowerCase().includes(term)) return false;
      if (filterValue === "linked") return Boolean(file.matchedVideoId);
      if (filterValue === "unlinked") return !file.matchedVideoId;
      return true;
    });
    if (sortValue === "name-asc") return [...filtered].sort((a, b) => a.name.localeCompare(b.name));
    if (sortValue === "name-desc") return [...filtered].sort((a, b) => b.name.localeCompare(a.name));
    if (sortValue === "size-desc") return [...filtered].sort((a, b) => (b.size || 0) - (a.size || 0));
    return filtered;
  }, [audioFiles, filterValue, searchValue, sortValue]);

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
    onAudioFilesChange(linkExternalFilesByOrder(updated, videoFiles));
    setSelectedAudioIndex(index + 1);
    toast({
      title: "Audio Duplicated",
      description: `${original.name} duplicated and matched by row order.`,
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
      applyToAllFiles: false,
      includedTrackIds: file.includedTrackIds !== undefined ? [...file.includedTrackIds] : defaultIncluded,
      includeSubtitles: getDefaultIncludeSubtitles(file),
      includedSubtitleTrackIds:
        file.includedSubtitleTrackIds !== undefined
          ? [...file.includedSubtitleTrackIds]
          : getSubtitleTrackIds(file),
      includedSubtitlesDefault: file.includedSubtitlesDefault || false,
      includedSubtitlesForced: file.includedSubtitlesForced || false,
      includedSubtitlesFirst: file.includedSubtitlesFirst || false,
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
      setEditDialogOpen(false);
      setEditingFileId(null);
      toast({ title: "Applied to All Files", description: `Settings applied to all ${audioFiles.length} audio file(s).` });
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
      if (editForm.applyDelayToAll) {
        return file.delay !== delayValue
          ? { ...markDelayAsManual(file, null), delay: delayValue }
          : file;
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
          includedSubtitlesDefault: editForm.includeSubtitles && editForm.includedSubtitlesDefault,
          includedSubtitlesForced: editForm.includeSubtitles && editForm.includedSubtitlesForced,
          includedSubtitlesFirst: editForm.includeSubtitles && editForm.includedSubtitlesFirst,
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
      const previous = file.trackOverrides?.[trackId];
      // A changed delay is hand-typed, and clears the measurement it replaces;
      // an unchanged one leaves the existing provenance and metadata intact.
      const source = previous?.delay !== nextDelay ? markDelayAsManual(file, trackId) : file;
      const nextOverrides = { ...(source.trackOverrides || {}) };
      nextOverrides[trackId] = {
        ...nextOverrides[trackId],
        language: nextLanguage || undefined,
        delay: nextDelay,
        trackName: nextName || undefined,
      };
      return { ...source, trackOverrides: nextOverrides, isManuallyEdited: true };
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
        const changed = prev.delay !== nextDelay;
        nextOverrides[trackId] = {
          ...prev,
          delay: nextDelay,
          // Typing a delay here overrides any measurement for that track.
          ...(changed
            ? { delayProvenance: "manual" as const, measuredDelay: undefined }
            : {}),
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

  // Read through a ref so a rescan sees the current list without making
  // scanAudios depend on it, which would rebuild the callback on every edit.
  const audioFilesRef = useRef(audioFiles);
  audioFilesRef.current = audioFiles;

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
      recursive: false,
      type: 'audio',
      include_tracks: true,
    });
    // A rescan re-reads the same folder, so anything already measured or typed
    // for a file still applies. Carrying it over means pressing refresh does
    // not silently discard a batch of measured delays.
    const priorByPath = new Map(
      audioFilesRef.current.map((file) => [file.path.toLowerCase(), file] as const),
    );

    const normalized = (results as ExternalFile[]).map((file) => {
      const prior = priorByPath.get(file.path.toLowerCase());
      const keepsOwnDelay =
        prior && (prior.delayProvenance === "measured" || prior.delayProvenance === "manual");

      return {
      ...file,
      type: 'audio' as const,
      language: prior?.language ?? currentConfig.language,
      trackName: prior?.trackName ?? currentConfig.trackName,
      delay: keepsOwnDelay ? prior.delay : Number(currentConfig.delay) || 0,
      ...(keepsOwnDelay
        ? {
            delayProvenance: prior.delayProvenance,
            measuredDelay: prior.measuredDelay,
            stretch: prior.stretch,
          }
        : {}),
      isDefault: currentConfig.isDefault,
      isForced: currentConfig.isForced,
      muxAfter: currentConfig.muxAfter,
      includeSubtitles: getSubtitleTrackIds(file).length > 0,
      includedSubtitleTrackIds:
        file.includedSubtitleTrackIds?.length
          ? file.includedSubtitleTrackIds
          : getSubtitleTrackIds(file),
      // Per-track measurements live here, so they survive a rescan too.
      trackOverrides: prior?.trackOverrides ?? file.trackOverrides ?? {},
      includedTrackIds:
        file.tracks && file.tracks.length > 0
          ? getAudioTrackIds(file)
          : file.includedTrackIds,
      };
    });
    onAudioFilesChange(syncAudioLinks(normalized));
  }, [currentConfig, onAudioFilesChange, syncAudioLinks]);

  useEffect(() => {
    if (audioFiles.length === 0) return;
    // Only the files that have a video to pair with: rows past the end
    // keep their existing link, so comparing them against undefined
    // would report a mismatch that relinking can never resolve.
    const needsRowMatch = audioFiles
      .slice(0, videoFiles.length)
      .some((file, index) => file.matchedVideoId !== videoFiles[index]?.id);
    if (needsRowMatch) {
      onAudioFilesChange(linkExternalFilesByOrder(audioFiles, videoFiles));
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
      // Carry any per-stream edits through as track overrides, keyed by track
      // id so the mux job picks them up the same way manual edits do. Without
      // this every imported stream would silently take the tab's shared delay.
      trackOverrides: (() => {
        const overrides: NonNullable<ExternalFile["trackOverrides"]> = {
          ...(existingAtTarget?.trackOverrides ?? {}),
        };
        importableTracks.forEach((track, trackIndex) => {
          const key = getImportTrackKey(trackIndex, String(track.id));
          if (!selectedTrackKeySet.has(key)) return;
          const override = importOverrides[key];
          if (!override) return;
          const id = Number(track.id);
          if (!Number.isFinite(id)) return;
          overrides[id] = { ...(overrides[id] ?? {}), ...override };
        });
        return Object.keys(overrides).length > 0 ? overrides : undefined;
      })(),
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
    setImportOverrides({});
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
              <SelectTrigger className="w-36 h-[30px] bg-panel-header text-secondary-foreground border border-panel-border font-medium">
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
                className="h-[30px] w-[30px] text-destructive hover:text-destructive hover:bg-destructive/10"
                onClick={() => confirmDeleteTrack(activeAudioTrack)}
              >
                <Trash2 className="w-4 h-4" />
              </Button>
            )}
          </div>
          <div className="track-selector-actions">
            {isMeasuring ? (
              <>
                <span className="text-xs text-muted-foreground whitespace-nowrap">
                  {measureProgress
                    ? `Measuring ${measureProgress.processed} of ${measureProgress.total}${
                        measureProgress.current ? ` — ${measureProgress.current}` : ""
                      }`
                    : "Measuring…"}
                </span>
                <Button
                  variant="outline"
                  size="sm"
                  className="h-[30px] gap-2"
                  onClick={cancelMeasuring}
                >
                  <Ban className="w-4 h-4" />
                  Cancel
                </Button>
              </>
            ) : (
              <TooltipProvider>
                <Tooltip>
                  <TooltipTrigger asChild>
                    {/* A disabled button emits no pointer events, so the span
                        must be inline-block (it needs a box of its own) for the
                        tooltip to fire — which is exactly when the reason for
                        the button being disabled matters most. */}
                    <span className="inline-block">
                      <Button
                        variant="outline"
                        size="sm"
                        className="h-[30px] gap-2"
                        disabled={!measurementAvailable || audioFiles.length === 0}
                        onClick={() => startMeasuring()}
                        aria-describedby="measure-delays-reason"
                      >
                        <Gauge className="w-4 h-4" />
                        Measure delays
                      </Button>
                    </span>
                  </TooltipTrigger>
                  <TooltipContent id="measure-delays-reason" className="max-w-xs">
                    {/* Order matters: report the blocking reason, not the
                        happy-path description, whenever the button is off. */}
                    {audiosyncEngine === null
                      ? "Checking for the audio analysis engine…"
                      : (audiosyncEngine.message ??
                        (audioFiles.length === 0
                          ? "Add audio files to measure their delays."
                          : "Measure each audio file's delay against the video it will be muxed into."))}
                  </TooltipContent>
                </Tooltip>
              </TooltipProvider>
            )}
            <Button
              variant="outline"
              size="sm"
              className="h-[30px] gap-2"
              onClick={handleImportAudios}
            >
              Import Audios
            </Button>
            <Button
              variant="outline"
              size="sm"
              className="h-[30px] gap-2"
              onClick={duplicateTrack}
            >
              <Copy className="w-4 h-4" />
              Duplicate
            </Button>
            <Button
              variant="default"
              size="sm"
              className="h-[30px] gap-2"
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
        <h3 className="text-xs text-muted-foreground font-semibold">Track configuration</h3>
        
        {/* Source Folder */}
        <div className="flex items-center gap-3">
          <label className="config-label">Source folder</label>
          <div className="flex-1 flex items-center gap-2">
            <Input
              value={currentConfig.sourceFolder}
              onChange={(e) => updateCurrentConfig({ sourceFolder: e.target.value })}
              placeholder="Select audio folder path..."
              className="h-[30px] flex-1 font-mono"
            />
            <Button
              variant="outline"
              size="icon"
              className="h-[30px] w-[30px]"
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
              className="h-[30px] w-[30px] border border-panel-border bg-[hsl(var(--control))] hover:bg-[hsl(var(--control-hover))] text-foreground"
              onClick={() => scanAudios(currentConfig.sourceFolder)}
            >
              <RefreshCw className="w-4 h-4" />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              className="h-[30px] w-[30px] border border-panel-border bg-[hsl(var(--control))] hover:bg-destructive/10 hover:text-destructive text-muted-foreground"
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
              <SelectTrigger className="h-[30px] flex-1">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All formats</SelectItem>
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
              className="h-[30px] flex-1"
            />
          </div>

          <div className="grid grid-cols-[100px_minmax(0,1fr)] items-center gap-2">
            <label className="config-label">Track name</label>
            <Input
              value={currentConfig.trackName}
              onChange={(e) => updateCurrentConfig({ trackName: e.target.value })}
              placeholder="Enter name"
              className="h-[30px] flex-1"
            />
          </div>

        </div>

        <div className="flex flex-wrap items-center gap-5">
          <div className="grid grid-cols-[100px_minmax(0,1fr)] items-center gap-2 min-w-[240px]">
            <label className="config-label">Mux after</label>
            <Select value={currentConfig.muxAfter} onValueChange={(v) => updateCurrentConfig({ muxAfter: v })}>
              <SelectTrigger className="h-[30px] w-40">
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
              className="h-[30px] w-20 text-center font-mono"
            />
            <span className="text-xs text-muted-foreground">sec</span>
          </div>

          {/* No "Forced": audio is never forced in practice. */}
          <div className="flex items-center gap-2.5 pl-3">
            <Switch
              id="audio-default"
              checked={currentConfig.isDefault}
              onCheckedChange={(checked) => updateCurrentConfig({ isDefault: checked })}
            />
            <label htmlFor="audio-default" className="text-[13px] cursor-pointer">
              Default
            </label>
          </div>
        </div>
      </div>

      {measurementAvailable && (
        <ReferenceTrackPicker
          videos={videoFiles}
          value={referenceTrackByVideoId}
          onChange={setReferenceTrackByVideoId}
          disabled={isMeasuring}
        />
      )}

      {/* Matching Panel */}
      <div className="workspace-split flex-1 grid grid-cols-[minmax(400px,1fr)_minmax(400px,1fr)] gap-4 min-h-0">
        {/* Video Files Card */}
        <div className="panel-card flex flex-col min-h-0 overflow-hidden">
          <div className="panel-card-header">
            <div className="flex items-center gap-2">
              <h4 className="panel-card-title">Video files</h4>
              <span className="text-xs font-mono text-muted-foreground">{videoFiles.length}</span>
            </div>
          </div>
          <div className="flex-1 overflow-y-auto overflow-x-hidden scrollbar-thin">
            {visibleVideoFiles.map((file) => {
              const index = videoFiles.findIndex((entry) => entry.id === file.id);
              return (
              <div
                key={file.id}
                onClick={() => setSelectedVideoIndex(index)}
                className={cn(
                  "file-item-video",
                  audioRowIsTall(index) && "file-item-video--tall",
                  selectedVideoIndex === index && "selected",
                )}
              >
                <span className="media-row-index">{`${index + 1}.`}</span>
                <span className="media-row-name">{file.name}</span>
              </div>
              );
            })}
          </div>
        </div>

        {/* Audio Files Card */}
        <div className="panel-card flex flex-col min-h-0 overflow-hidden">
          <div className="panel-card-header">
            <h4 className="panel-card-title">Audio files</h4>
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
            </div>
          </div>
          <div className="flex-1 overflow-y-auto overflow-x-hidden scrollbar-thin">
            {unlinkedCount > 0 && (
              <div className="px-3 py-2 text-xs text-warning border-b border-panel-border bg-warning/8">
                {unlinkedCount} audio file{unlinkedCount === 1 ? "" : "s"} do not have a matching video row before muxing.
              </div>
            )}
            {audioFiles.length === 0 ? (
              <EmptyState
                icon={<AudioLines className="w-5 h-5 text-muted-foreground/65" />}
                title="No audio files found"
                description="Use the folder button above to choose a source folder"
                className="h-full"
              />
            ) : visibleAudioFiles.length === 0 ? (
              <EmptyState
                icon={<AudioLines className="w-5 h-5 text-muted-foreground/65" />}
                title="No audio files match the current filter"
                description="Clear search or change the filter to show all audio files"
                className="h-full"
              />
            ) : (
              visibleAudioFiles.map((file) => {
                const index = audioFiles.findIndex((entry) => entry.id === file.id);
                return (
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
                      "file-item-audio",
                      // Grows for the delay readout; the paired video row is
                      // told to grow too so the lists stay in step.
                      (file.measuredDelay || measuredTrackEntries(file).length > 0) &&
                        "file-item-audio--tall",
                      selectedAudioIndex === index && "selected",
                      draggedIndex === index && "opacity-60",
                    )}
                  >
                    <span className="media-row-handle">
                      <GripVertical className="w-4 h-4" />
                    </span>
                    <span className="media-row-index">{index + 1}</span>
                    <div className="min-w-0 flex-1">
                      <div className="media-row-name">{file.name}</div>
                      {file.measuredDelay && (
                        <>
                          <MeasuredDelayInfo
                            measured={file.measuredDelay}
                            onApplyAnyway={
                              file.measuredDelay.isLikelyCut ||
                              Math.abs(file.measuredDelay.engineDelayMs) > MAX_PLAUSIBLE_OFFSET_MS
                                ? () => applyCutDelayAnyway(file.id, null)
                                : undefined
                            }
                          />
                          <div onClick={(event) => event.stopPropagation()}>
                            <StretchToggle
                              id={`stretch-${file.id}`}
                              measured={file.measuredDelay}
                              value={file.stretch}
                              disabled={isMeasuring}
                              onChange={(next) => setStretchForFile(file.id, next)}
                            />
                          </div>
                        </>
                      )}
                      {/* A file with several included tracks is measured once
                          per track, and each result lands in trackOverrides
                          rather than on the file. Without this the whole batch
                          appeared to do nothing: the delays were stored and
                          used by the mux, but never shown. */}
                      {measuredTrackEntries(file).map(({ trackId, override, label }) => (
                        <div key={trackId} className="flex items-start gap-2">
                          <span className="text-xs text-muted-foreground shrink-0 mt-px">
                            {label}
                          </span>
                          <div className="min-w-0">
                            <MeasuredDelayInfo
                              measured={override.measuredDelay!}
                              onApplyAnyway={
                                override.measuredDelay!.isLikelyCut ||
                                Math.abs(override.measuredDelay!.engineDelayMs) >
                                  MAX_PLAUSIBLE_OFFSET_MS
                                  ? () => applyCutDelayAnyway(file.id, trackId)
                                  : undefined
                              }
                            />
                          </div>
                        </div>
                      ))}
                    </div>
                    <div className="media-row-actions">
                      {measurementAvailable && (
                        <TooltipProvider>
                          <Tooltip>
                            <TooltipTrigger asChild>
                              <Button
                                variant="ghost"
                                size="icon"
                                className="file-action-btn file-action-btn--muted"
                                disabled={isMeasuring}
                                onClick={(event) => {
                                  event.stopPropagation();
                                  remeasureFile(file.id);
                                }}
                              >
                                <Gauge className="w-3.5 h-3.5" />
                              </Button>
                            </TooltipTrigger>
                            <TooltipContent>
                              {file.measuredDelay ? "Re-measure delay" : "Measure delay"}
                            </TooltipContent>
                          </Tooltip>
                        </TooltipProvider>
                      )}
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
                );
              })
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
            <Button variant="ghost" onClick={() => { setImportStreamsOpen(false); setImportOverrides({}); }}>
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
            <label className="text-xs font-semibold text-muted-foreground">Source video</label>
            <Select value={importSourceVideoId} onValueChange={(value) => {
              setImportSourceVideoId(value);
              setImportSelectedTrackKeys([]);
              setImportOverrides({});
            }}>
              <SelectTrigger className="h-[30px]">
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
            <label className="text-xs font-semibold text-muted-foreground">Audio streams</label>
            <div className="max-h-56 overflow-y-auto rounded border border-panel-border p-2 space-y-2">
              {importableTracks.length === 0 ? (
                <div className="text-xs text-muted-foreground px-1 py-2">No audio streams available in selected video.</div>
              ) : (
                importableTracks.map((track, idx) => {
                  const trackKey = getImportTrackKey(idx, String(track.id));
                  const checked = importSelectedTrackKeys.includes(trackKey);
                  const override = importOverrides[trackKey];
                  const hasOverride = Boolean(
                    override && (override.delay || override.language || override.trackName),
                  );
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
                      <span className="truncate flex-1 min-w-0">
                        {override?.trackName || track.name || track.codec || `Audio ${idx + 1}`}
                        {override?.language || track.language
                          ? ` • ${override?.language || track.language}`
                          : ""}
                      </span>
                      {hasOverride && override?.delay ? (
                        <span className="font-mono text-xs text-primary shrink-0">
                          {override.delay > 0 ? "+" : ""}
                          {override.delay}s
                        </span>
                      ) : null}
                      <ImportTrackEditButton
                        edited={hasOverride}
                        label={`Edit stream ${idx + 1}`}
                        onClick={() => setImportEditingKey(trackKey)}
                      />
                    </label>
                  );
                })
              )}
            </div>
          </div>
        </div>
      </BaseModal>

      <ImportTrackEditDialog
        open={importEditingKey !== null}
        onOpenChange={(open) => {
          if (!open) setImportEditingKey(null);
        }}
        kind="audio"
        trackLabel={(() => {
          if (!importEditingKey) return "";
          const idx = Number(importEditingKey.split(":")[0]);
          const track = importableTracks[idx];
          return track
            ? `#${idx + 1} · ${track.name || track.codec || "Audio"}${track.language ? ` · ${track.language}` : ""}`
            : "";
        })()}
        value={importEditingKey ? (importOverrides[importEditingKey] ?? {}) : {}}
        onSave={(next) => {
          if (!importEditingKey) return;
          setImportOverrides((prev) => ({ ...prev, [importEditingKey]: next }));
          // Editing a stream implies wanting it, so select it too.
          setImportSelectedTrackKeys((prev) =>
            prev.includes(importEditingKey) ? prev : [...prev, importEditingKey],
          );
        }}
      />

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
        className="max-w-3xl"
        bodyClassName="max-h-[72vh] overflow-y-auto px-5 py-4"
        footerRight={
          <>
            <Button
              variant="ghost"
              className="text-muted-foreground hover:text-foreground"
              onClick={() => setEditDialogOpen(false)}
            >
              Cancel
            </Button>
            <Button onClick={applyEditChanges}>Save changes</Button>
          </>
        }
      >
        <div className="space-y-4">
          <div className="space-y-1.5">
            <label className="text-xs font-medium text-muted-foreground">Source file</label>
            <div
              className="text-[13px] text-foreground truncate font-mono"
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
                className="h-[30px]"
              />
            </div>
            <div className="space-y-1.5">
              <label className="text-xs font-medium text-muted-foreground">Track name</label>
              <Input
                value={editForm.trackName}
                onChange={(event) => setEditForm((prev) => ({ ...prev, trackName: event.target.value }))}
                placeholder="Track name"
                className="h-[30px]"
              />
            </div>
            <div className="space-y-1.5">
              <label className="text-xs font-medium text-muted-foreground">Delay (sec)</label>
              <Input
                value={editForm.delay}
                onChange={(event) => setEditForm((prev) => ({ ...prev, delay: event.target.value }))}
                className="h-[30px] font-mono"
              />
            </div>
            <div className="space-y-1.5">
              <label className="text-xs font-medium text-muted-foreground">Track order</label>
              <Select
                value={editForm.muxAfter}
                onValueChange={(value) => setEditForm((prev) => ({ ...prev, muxAfter: value }))}
              >
                <SelectTrigger className="h-[30px]">
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

          {/* One flat list of switches. "Forced" is gone: audio is never
              forced in practice, and the flag still defaults to false in the
              mux job. */}
          <div className="rounded border border-panel-border divide-y divide-panel-border">
            <label className="flex items-center gap-3 px-3 py-2.5 cursor-pointer">
              <div className="min-w-0 flex-1">
                <span className="block text-[13px]">Default audio</span>
                <span className="block text-xs text-muted-foreground">
                  Marks the first included track as default.
                </span>
              </div>
              <Switch
                id="audio-edit-default"
                checked={editForm.isDefault}
                onCheckedChange={(checked) =>
                  setEditForm((prev) => ({ ...prev, isDefault: checked }))
                }
              />
            </label>
            <label className="flex items-center gap-3 px-3 py-2.5 cursor-pointer">
              <div className="min-w-0 flex-1">
                <span className="block text-[13px]">Apply delay to all files</span>
              </div>
              <Switch
                id="audio-edit-delay-all"
                checked={editForm.applyDelayToAll}
                onCheckedChange={(checked) =>
                  setEditForm((prev) => ({ ...prev, applyDelayToAll: checked }))
                }
              />
            </label>
            <label className="flex items-center gap-3 px-3 py-2.5 cursor-pointer">
              <div className="min-w-0 flex-1">
                <span className="block text-[13px]">Apply all settings to every file</span>
                <span className="block text-xs text-muted-foreground">
                  Track selection is applied by position.
                </span>
              </div>
              <Switch
                id="audio-edit-apply-all"
                checked={editForm.applyToAllFiles}
                onCheckedChange={(checked) =>
                  setEditForm((prev) => ({ ...prev, applyToAllFiles: checked }))
                }
              />
            </label>
          </div>

          {editingFile?.tracks && editingFile.tracks.length > 0 && (
            <>
              <div className="rounded border border-panel-border px-3 py-2.5 space-y-2">
                <div className="flex items-center justify-between">
                  <div className="text-xs font-semibold text-muted-foreground">
                    Included Audio Tracks
                  </div>
                  <div className="flex items-center gap-2">
                    {editingFile.tracks.filter((track) => track.type === "audio").length > 1 && (
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-[26px] px-2 text-xs"
                        onClick={() => openMultiDelayDialog(editingFile.id, "audio")}
                      >
                        Track Delays
                      </Button>
                    )}
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-[26px] px-2 text-xs"
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
                      className="h-[26px] px-2 text-xs text-muted-foreground hover:text-foreground"
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
                              <span className="text-xs text-primary/80">Default</span>
                            )}
                            <Button
                              variant="ghost"
                              size="icon"
                              className="h-[26px] w-[26px] text-muted-foreground hover:text-foreground"
                              onClick={() => openTrackEdit(editingFile.id, trackId, "audio")}
                            >
                              <Pencil className="w-3.5 h-3.5" />
                            </Button>
                          </div>
                        </div>
                      );
                    })}
                </div>
                <div className="text-xs text-muted-foreground/70">
                  When Default is enabled for this file, the first included track becomes default and the rest are set to no.
                </div>
              </div>

              {editingFile.tracks.some((track) => track.type === "subtitle") && (
                <div className="rounded border border-panel-border px-3 py-2.5 space-y-2">
                  <div className="flex items-center justify-between">
                    <div className="text-xs font-semibold text-muted-foreground">
                      Included Subtitle Tracks
                    </div>
                    <div className="flex items-center gap-2">
                      {editingFile.tracks.filter((track) => track.type === "subtitle").length > 1 && (
                        <Button
                          variant="ghost"
                          size="sm"
                          className="h-[26px] px-2 text-xs"
                          onClick={() => openMultiDelayDialog(editingFile.id, "subtitle")}
                        >
                          Track Delays
                        </Button>
                      )}
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-[26px] px-2 text-xs"
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
	                        className="h-[26px] px-2 text-xs text-muted-foreground hover:text-foreground"
	                        onClick={() =>
	                          setEditForm((prev) => ({
	                            ...prev,
	                            includeSubtitles: false,
	                            includedSubtitleTrackIds: [],
	                            includedSubtitlesDefault: false,
	                            includedSubtitlesForced: false,
	                            includedSubtitlesFirst: false,
	                          }))
	                        }
	                      >
                        Uncopy All
                      </Button>
                    </div>
                  </div>
                  <div className="grid gap-2 md:grid-cols-2">
                    <label className="flex items-start gap-3 rounded-md bg-[hsl(var(--muted))] px-3 py-2 cursor-pointer">
                      <Checkbox
                        checked={editForm.includeSubtitles}
                        onCheckedChange={(value) =>
                          setEditForm((prev) => ({
                            ...prev,
                            includeSubtitles: value as boolean,
                            includedSubtitleTrackIds: value
                              ? getSubtitleTrackIds(editingFile)
                              : [],
                            includedSubtitlesDefault: value ? prev.includedSubtitlesDefault : false,
                            includedSubtitlesForced: value ? prev.includedSubtitlesForced : false,
                            includedSubtitlesFirst: value ? prev.includedSubtitlesFirst : false,
                          }))
                        }
                      />
                      <div className="min-w-0">
                        <span className="block text-sm font-medium">Include subtitles</span>
                        <span className="block text-xs leading-snug text-muted-foreground">
                          Copy subtitle tracks embedded in this audio file.
                        </span>
                      </div>
                    </label>
                    <label className="flex items-start gap-3 rounded-md bg-[hsl(var(--muted))] px-3 py-2 cursor-pointer">
                      <Checkbox
                        checked={editForm.includedSubtitlesFirst && editForm.includedSubtitlesDefault}
                        onCheckedChange={(value) =>
                          setEditForm((prev) => ({
                            ...prev,
                            includeSubtitles: true,
                            includedSubtitleTrackIds: prev.includedSubtitleTrackIds.length
                              ? prev.includedSubtitleTrackIds
                              : getSubtitleTrackIds(editingFile),
                            includedSubtitlesFirst: value as boolean,
                            includedSubtitlesDefault: value as boolean,
                          }))
                        }
                      />
                      <div className="min-w-0">
                        <span className="block text-sm font-medium">First + default subtitle</span>
                        <span className="block text-xs leading-snug text-muted-foreground">
                          Put copied subtitles before existing subtitles and make the first one default.
                        </span>
                      </div>
                    </label>
                    <label className="flex items-start gap-3 rounded-md bg-[hsl(var(--muted))] px-3 py-2 cursor-pointer md:col-span-2">
                      <Checkbox
                        checked={editForm.includedSubtitlesForced}
                        onCheckedChange={(value) =>
                          setEditForm((prev) => ({
                            ...prev,
                            includeSubtitles: true,
                            includedSubtitleTrackIds: prev.includedSubtitleTrackIds.length
                              ? prev.includedSubtitleTrackIds
                              : getSubtitleTrackIds(editingFile),
                            includedSubtitlesForced: value as boolean,
                          }))
                        }
                      />
                      <div className="min-w-0">
                        <span className="block text-sm font-medium">Forced copied subtitles</span>
                        <span className="block text-xs leading-snug text-muted-foreground">
                          Mark copied subtitle tracks as forced display tracks.
                        </span>
                      </div>
                    </label>
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
                              className="h-[26px] w-[26px] text-muted-foreground hover:text-foreground"
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
          <div className="rounded border border-panel-border px-3 py-2.5 space-y-2">
            <div className="text-xs font-semibold text-muted-foreground">
              Bulk Fill
            </div>
            <div className="flex items-center gap-2">
              <Input
                value={multiDelayBulkValue}
                onChange={(event) => setMultiDelayBulkValue(event.target.value)}
                className="h-[30px] font-mono"
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
            <div className="text-xs text-muted-foreground/70">
              Use positive values to delay {multiDelayTrackType} and negative values to make it earlier.
            </div>
          </div>

          <div className="rounded border border-panel-border px-3 py-2.5 space-y-2">
            <div className="text-xs font-semibold text-muted-foreground">
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
                      className="grid grid-cols-[1fr_120px] items-center gap-3 py-1"
                    >
                      <div className="min-w-0">
                        <div className="text-sm text-foreground truncate">
                          Track {index + 1}
                          {track.language ? ` • ${track.language}` : ""}
                          {track.name ? ` • ${track.name}` : ""}
                        </div>
                        <div className="text-xs text-muted-foreground/70">
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
                        className="h-[30px] font-mono text-right"
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
              className="h-[30px]"
            />
          </div>
          <div className="space-y-1.5">
            <label className="text-xs font-medium text-muted-foreground">Track name</label>
            <Input
              value={trackEditForm.trackName}
              onChange={(event) => {
                const value = event.target.value;
                setTrackEditForm((prev) => ({ ...prev, trackName: value }));
                updateTrackOverride({ trackName: value });
              }}
              className="h-[30px]"
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
              className="h-[30px] font-mono"
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
