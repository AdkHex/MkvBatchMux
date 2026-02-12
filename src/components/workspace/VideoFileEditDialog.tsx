import { useCallback, useEffect, useRef, useState } from "react";
import { ChevronUp, ChevronDown, RotateCcw, Film, Subtitles, Volume2, GripVertical, Trash2, Plus, Download } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { TextField } from "@/components/shared/Fields";
import { BaseModal } from "@/components/shared/BaseModal";
import { LanguageSelect } from "@/components/LanguageSelect";
import {
  ReorderableTable,
  ReorderableTableHeader,
  ReorderableTableBody,
  ReorderableRow,
  ReorderableTableCell,
  ReorderHandle,
} from "@/components/shared/ReorderableTable";
import { cn } from "@/lib/utils";
import { pickFiles } from "@/lib/backend";
import { AUDIO_EXTENSIONS, SUBTITLE_EXTENSIONS } from "@/lib/extensions";
import type { VideoFile, Track, ExternalFile } from "@/types";

interface VideoFileEditDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  videoFile: VideoFile | null;
  allVideoFiles?: VideoFile[];
  onSave: (updatedFile: VideoFile) => void;
  onAddExternalFiles?: (
    type: "audio" | "subtitle",
    videoFileId: string,
    paths: string[],
    config: {
      trackName: string;
      language: string;
      delay: number;
      isDefault: boolean;
      isForced: boolean;
      muxAfter: string;
    },
  ) => void;
  externalAudioFiles?: ExternalFile[];
  externalSubtitleFiles?: ExternalFile[];
  onExternalFilesChange?: (videoFileId: string, type: "audio" | "subtitle", files: ExternalFile[]) => void;
}

type TrackTab = "videos" | "subtitles" | "audios";

interface TrackRow {
  id: string;
  trackIndex: number;
  copyTrack: boolean;
  setDefault: boolean;
  setForced: boolean;
  trackName: string;
  language: string;
  source: "internal" | "external";
  originalTrack?: Track;
  externalFile?: ExternalFile;
}


const tabConfig: { id: TrackTab; label: string; icon: React.ComponentType<{ className?: string }>; trackType: Track["type"] }[] = [
  { id: "videos", label: "Videos", icon: Film, trackType: "video" },
  { id: "subtitles", label: "Subtitles", icon: Subtitles, trackType: "subtitle" },
  { id: "audios", label: "Audios", icon: Volume2, trackType: "audio" },
];

export function VideoFileEditDialog({
  open,
  onOpenChange,
  videoFile,
  allVideoFiles,
  onSave,
  onAddExternalFiles,
  externalAudioFiles,
  externalSubtitleFiles,
  onExternalFilesChange,
}: VideoFileEditDialogProps) {
  const [activeTab, setActiveTab] = useState<TrackTab>("subtitles");
  const [selectedTrackId, setSelectedTrackId] = useState<string | null>(null);
  const [videoTracks, setVideoTracks] = useState<TrackRow[]>([]);
  const [subtitleTracks, setSubtitleTracks] = useState<TrackRow[]>([]);
  const [audioTracks, setAudioTracks] = useState<TrackRow[]>([]);
  const [editingTrackId, setEditingTrackId] = useState<string | null>(null);
  const [editingName, setEditingName] = useState("");
  const [draggedIndex, setDraggedIndex] = useState<number | null>(null);
  const [dragOverIndex, setDragOverIndex] = useState<number | null>(null);
  const [addExternalOpen, setAddExternalOpen] = useState(false);
  const [pendingExternalPaths, setPendingExternalPaths] = useState<string[]>([]);
  const [addExternalType, setAddExternalType] = useState<"audio" | "subtitle" | null>(null);
  const [addExternalForm, setAddExternalForm] = useState({
    trackName: "",
    language: "und",
    delay: "0.000",
    isDefault: false,
    isForced: false,
    muxAfter: "audio",
  });
  const [importStreamsOpen, setImportStreamsOpen] = useState(false);
  const [importSourceVideoId, setImportSourceVideoId] = useState("");
  const [importSelectedTrackIds, setImportSelectedTrackIds] = useState<number[]>([]);

  useEffect(() => {
    if (videoFile && open) {
      const fileTracks = videoFile.tracks || [];

      const toTrackRows = (tracks: Track[], type: Track["type"]): TrackRow[] =>
        tracks
          .filter((t) => t.type === type)
          .map((t, idx) => ({
            id: t.id,
            trackIndex: idx + 1,
            copyTrack: t.action !== "remove",
            setDefault: t.isDefault || false,
            setForced: t.isForced || false,
            trackName: t.name || t.codec || `Track ${idx + 1}`,
            language: t.language || "und",
            source: "internal",
            originalTrack: t,
          }));

      const toExternalRows = (files: ExternalFile[]): TrackRow[] =>
        files.map((file, idx) => ({
          id: file.id,
          trackIndex: idx + 1,
          copyTrack: true,
          setDefault: file.isDefault || false,
          setForced: file.isForced || false,
          trackName: file.trackName || file.name || `External ${idx + 1}`,
          language: file.language || "und",
          source: "external",
          externalFile: file,
        }));

      const externalAudio = (externalAudioFiles || []).filter(
        (file) => file.matchedVideoId === videoFile.id,
      );
      const externalSubtitle = (externalSubtitleFiles || []).filter(
        (file) => file.matchedVideoId === videoFile.id,
      );

      setVideoTracks(toTrackRows(fileTracks, "video"));
      setSubtitleTracks([...toTrackRows(fileTracks, "subtitle"), ...toExternalRows(externalSubtitle)]);
      setAudioTracks([...toTrackRows(fileTracks, "audio"), ...toExternalRows(externalAudio)]);
    }
  }, [videoFile, open, externalAudioFiles, externalSubtitleFiles]);

  useEffect(() => {
    if (!open) {
      setAddExternalOpen(false);
      setPendingExternalPaths([]);
      setAddExternalType(null);
      setImportStreamsOpen(false);
      setImportSourceVideoId("");
      setImportSelectedTrackIds([]);
    }
  }, [open]);

  const currentTracks = activeTab === "videos" ? videoTracks : activeTab === "subtitles" ? subtitleTracks : audioTracks;
  const setCurrentTracks =
    activeTab === "videos" ? setVideoTracks : activeTab === "subtitles" ? setSubtitleTracks : setAudioTracks;
  const importableSourceVideos = (allVideoFiles && allVideoFiles.length > 0 ? allVideoFiles : videoFile ? [videoFile] : []).filter(
    (file) => file.id !== videoFile?.id,
  );
  const selectedImportSource = importableSourceVideos.find((file) => file.id === importSourceVideoId) || null;
  const importStreamType: Track["type"] | null =
    activeTab === "audios" ? "audio" : activeTab === "subtitles" ? "subtitle" : null;
  const importableTracks =
    importStreamType && selectedImportSource
      ? (selectedImportSource.tracks || []).filter(
          (track) => track.type === importStreamType && track.action !== "remove",
        )
      : [];
  const allCopyChecked = currentTracks.length > 0 && currentTracks.every((track) => track.copyTrack);
  const allDefaultChecked = currentTracks.length > 0 && currentTracks.every((track) => track.setDefault);
  const allForcedChecked = currentTracks.length > 0 && currentTracks.every((track) => track.setForced);

  const handleTrackChange = (trackId: string, field: keyof TrackRow, value: boolean | string) => {
    setCurrentTracks((prev) =>
      prev.map((t) => {
        if (t.id !== trackId) return t;
        if (field === "copyTrack" && value === false) {
          return { ...t, copyTrack: false, setDefault: false, setForced: false };
        }
        return { ...t, [field]: value };
      }),
    );
  };

  const startEditing = (track: TrackRow) => {
    setEditingTrackId(track.id);
    setEditingName(track.trackName);
  };

  const finishEditing = () => {
    if (editingTrackId && editingName.trim()) {
      handleTrackChange(editingTrackId, "trackName", editingName.trim());
    }
    setEditingTrackId(null);
    setEditingName("");
  };

  const deleteTrack = (trackId: string) => {
    setCurrentTracks((prev) => prev.filter((t) => t.id !== trackId));
    if (selectedTrackId === trackId) {
      setSelectedTrackId(null);
    }
  };

  const setAllCopy = (value: boolean) => {
    setCurrentTracks((prev) =>
      prev.map((track) => ({
        ...track,
        copyTrack: value,
        setDefault: value ? track.setDefault : false,
        setForced: value ? track.setForced : false,
      })),
    );
  };

  const setAllDefault = (value: boolean) => {
    setCurrentTracks((prev) =>
      prev.map((track) => ({
        ...track,
        copyTrack: value ? true : track.copyTrack,
        setDefault: value,
      })),
    );
  };

  const setAllForced = (value: boolean) => {
    setCurrentTracks((prev) =>
      prev.map((track) => ({
        ...track,
        copyTrack: value ? true : track.copyTrack,
        setForced: value,
      })),
    );
  };

  const moveTrack = (direction: "up" | "down") => {
    if (!selectedTrackId) return;
    const tracks = currentTracks;
    const idx = tracks.findIndex((t) => t.id === selectedTrackId);
    if (idx < 0) return;
    if (direction === "up" && idx > 0) {
      setCurrentTracks((prev) => {
        const newTracks = [...prev];
        [newTracks[idx - 1], newTracks[idx]] = [newTracks[idx], newTracks[idx - 1]];
        return newTracks;
      });
    } else if (direction === "down" && idx < tracks.length - 1) {
      setCurrentTracks((prev) => {
        const newTracks = [...prev];
        [newTracks[idx + 1], newTracks[idx]] = [newTracks[idx], newTracks[idx + 1]];
        return newTracks;
      });
    }
  };

  const dragItem = useRef<number | null>(null);
  const dragOverItem = useRef<number | null>(null);
  const pointerDragActive = useRef(false);
  const pointerIdRef = useRef<number | null>(null);

  const handleDragEnd = useCallback(() => {
    if (
      dragItem.current !== null &&
      dragOverItem.current !== null &&
      dragItem.current !== dragOverItem.current
    ) {
      setCurrentTracks((prev) => {
        const newTracks = [...prev];
        const draggedItem = newTracks[dragItem.current!];
        newTracks.splice(dragItem.current!, 1);
        newTracks.splice(dragOverItem.current!, 0, draggedItem);
        return newTracks;
      });
    }
    dragItem.current = null;
    dragOverItem.current = null;
    setDraggedIndex(null);
    setDragOverIndex(null);
  }, [setCurrentTracks]);

  const startPointerDrag = (event: React.PointerEvent, index: number) => {
    event.preventDefault();
    pointerDragActive.current = true;
    pointerIdRef.current = event.pointerId;
    (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
    dragItem.current = index;
    dragOverItem.current = index;
    setDraggedIndex(index);
    setDragOverIndex(index);
  };

  useEffect(() => {
    const handlePointerMove = (event: PointerEvent) => {
      if (!pointerDragActive.current || pointerIdRef.current !== event.pointerId) return;
      const target = document.elementFromPoint(event.clientX, event.clientY) as HTMLElement | null;
      const row = target?.closest("[data-reorder-index]") as HTMLElement | null;
      if (!row) return;
      const idx = Number(row.dataset.reorderIndex);
      if (!Number.isFinite(idx) || idx === dragOverItem.current) return;
      dragOverItem.current = idx;
      setDragOverIndex(idx);
    };

    const handlePointerUp = (event: PointerEvent) => {
      if (!pointerDragActive.current || pointerIdRef.current !== event.pointerId) return;
      pointerDragActive.current = false;
      pointerIdRef.current = null;
      handleDragEnd();
    };

    window.addEventListener("pointermove", handlePointerMove);
    window.addEventListener("pointerup", handlePointerUp);
    window.addEventListener("pointercancel", handlePointerUp);
    return () => {
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", handlePointerUp);
      window.removeEventListener("pointercancel", handlePointerUp);
    };
  }, [handleDragEnd]);

  const handleApplyChanges = () => {
    if (!videoFile) return;

    const rowsToTracks = (rows: TrackRow[]): Track[] =>
      rows
        .filter((row) => row.source === "internal" && row.originalTrack)
        .map((row) => {
          const original = row.originalTrack!;
          const originalName = original.originalName ?? original.name ?? original.codec ?? "";
          const originalLanguage = original.originalLanguage ?? original.language ?? "";
          const originalDefault =
            original.originalDefault !== undefined ? original.originalDefault : original.isDefault ?? false;
          const originalForced =
            original.originalForced !== undefined ? original.originalForced : original.isForced ?? false;

          const nameChanged = row.trackName !== (original.name || original.codec || row.trackName);
          const languageChanged = (row.language || "") !== (original.language || "");
          const defaultChanged = row.setDefault !== (original.isDefault ?? false);
          const forcedChanged = row.setForced !== (original.isForced ?? false);
          const isRemoved = !row.copyTrack;
          const hasChanges = !isRemoved && (nameChanged || languageChanged || defaultChanged || forcedChanged);
          return {
            ...original,
            name: row.trackName,
            language: row.language,
            isDefault: row.setDefault,
            isForced: row.setForced,
            action: isRemoved ? ("remove" as const) : hasChanges ? ("modify" as const) : ("keep" as const),
            originalName,
            originalLanguage,
            originalDefault,
            originalForced,
          };
        });

    const updatedTracks: Track[] = [
      ...rowsToTracks(videoTracks),
      ...rowsToTracks(subtitleTracks),
      ...rowsToTracks(audioTracks),
    ];

    if (onExternalFilesChange) {
      const updatedExternalAudio = audioTracks
        .filter((row) => row.source === "external" && row.externalFile && row.copyTrack)
        .map((row) => ({
          ...row.externalFile!,
          trackName: row.trackName,
          language: row.language,
          isDefault: row.setDefault,
          isForced: row.setForced,
          matchedVideoId: videoFile.id,
        }));
      const updatedExternalSubtitle = subtitleTracks
        .filter((row) => row.source === "external" && row.externalFile && row.copyTrack)
        .map((row) => ({
          ...row.externalFile!,
          trackName: row.trackName,
          language: row.language,
          isDefault: row.setDefault,
          isForced: row.setForced,
          matchedVideoId: videoFile.id,
        }));
      onExternalFilesChange(videoFile.id, "audio", updatedExternalAudio);
      onExternalFilesChange(videoFile.id, "subtitle", updatedExternalSubtitle);
    }

    onSave({
      ...videoFile,
      tracks: updatedTracks,
    });
    onOpenChange(false);
  };

  const handleReset = () => {
    if (videoFile) {
      const fileTracks = videoFile.tracks || [];

      const toTrackRows = (tracks: Track[], type: Track["type"]): TrackRow[] =>
        tracks
          .filter((t) => t.type === type)
          .map((t, idx) => ({
            id: t.id,
            trackIndex: idx + 1,
            copyTrack: t.action !== "remove",
            setDefault: t.isDefault || false,
            setForced: t.isForced || false,
            trackName: t.name || t.codec || `Track ${idx + 1}`,
            language: t.language || "und",
            source: "internal",
            originalTrack: t,
          }));

      const toExternalRows = (files: ExternalFile[]): TrackRow[] =>
        files.map((file, idx) => ({
          id: file.id,
          trackIndex: idx + 1,
          copyTrack: true,
          setDefault: file.isDefault || false,
          setForced: file.isForced || false,
          trackName: file.trackName || file.name || `External ${idx + 1}`,
          language: file.language || "und",
          source: "external",
          externalFile: file,
        }));

      const externalAudio = (externalAudioFiles || []).filter(
        (file) => file.matchedVideoId === videoFile.id,
      );
      const externalSubtitle = (externalSubtitleFiles || []).filter(
        (file) => file.matchedVideoId === videoFile.id,
      );

      setVideoTracks(toTrackRows(fileTracks, "video"));
      setSubtitleTracks([...toTrackRows(fileTracks, "subtitle"), ...toExternalRows(externalSubtitle)]);
      setAudioTracks([...toTrackRows(fileTracks, "audio"), ...toExternalRows(externalAudio)]);
    }
  };

  const openAddExternalDialog = async (type: "audio" | "subtitle") => {
    const filters =
      type === "subtitle"
        ? [{ name: "Subtitle Files", extensions: [...SUBTITLE_EXTENSIONS] }]
        : [{ name: "Audio Files", extensions: [...AUDIO_EXTENSIONS] }];
    const files = await pickFiles(filters);
    if (files.length === 0) return;
    setPendingExternalPaths(files);
    setAddExternalType(type);
    setAddExternalForm({
      trackName: "",
      language: "und",
      delay: "0.000",
      isDefault: false,
      isForced: false,
      muxAfter: type === "subtitle" ? "audio" : "video",
    });
    setAddExternalOpen(true);
  };

  const handleConfirmAddExternal = () => {
    if (!videoFile || !addExternalType || !onAddExternalFiles) return;
    const delayValue = Number(addExternalForm.delay) || 0;
    onAddExternalFiles(addExternalType, videoFile.id, pendingExternalPaths, {
      trackName: addExternalForm.trackName,
      language: addExternalForm.language || "und",
      delay: delayValue,
      isDefault: addExternalForm.isDefault,
      isForced: addExternalForm.isForced,
      muxAfter: addExternalForm.muxAfter,
    });
    setAddExternalOpen(false);
    setPendingExternalPaths([]);
    setAddExternalType(null);
  };

  const handleOpenImportStreams = () => {
    setImportStreamsOpen(true);
    setImportSourceVideoId("");
    setImportSelectedTrackIds([]);
  };

  const handleConfirmImportStreams = () => {
    if (!selectedImportSource || !importStreamType || importSelectedTrackIds.length === 0 || !videoFile) return;

    const rows: TrackRow[] = importableTracks
      .filter((track) => importSelectedTrackIds.includes(Number(track.id)))
      .map((track, idx) => {
        const numericId = Number(track.id);
        const trackLabel =
          track.name || track.codec || `${importStreamType === "audio" ? "Audio" : "Subtitle"} ${idx + 1}`;

        const externalFile: ExternalFile = {
          id: `import-${importStreamType}-${selectedImportSource.id}-${track.id}-${Date.now()}-${idx}`,
          name: selectedImportSource.name,
          path: selectedImportSource.path,
          type: importStreamType,
          source: "per-file",
          language: track.language || "und",
          trackName: trackLabel,
          delay: 0,
          isDefault: false,
          isForced: false,
          matchedVideoId: videoFile.id,
          tracks: [track],
          includedTrackIds: Number.isFinite(numericId) ? [numericId] : [],
        };

        return {
          id: externalFile.id,
          trackIndex: 0,
          copyTrack: true,
          setDefault: false,
          setForced: false,
          trackName: trackLabel,
          language: track.language || "und",
          source: "external",
          externalFile,
        };
      });

    if (rows.length === 0) return;
    if (activeTab === "audios") {
      setAudioTracks((prev) => [...prev, ...rows]);
    } else if (activeTab === "subtitles") {
      setSubtitleTracks((prev) => [...prev, ...rows]);
    }
    setImportStreamsOpen(false);
    setImportSourceVideoId("");
    setImportSelectedTrackIds([]);
  };

  if (!videoFile) return null;

  return (
    <BaseModal
      open={open}
      onOpenChange={onOpenChange}
      title="Edit Video Tracks"
      subtitle={videoFile.name}
      icon={<Film className="w-5 h-5 text-primary" />}
      className="max-w-4xl"
      bodyClassName="p-0"
      footerLeft={
        <Button
          variant="ghost"
          className="h-9 px-4 text-sm text-muted-foreground hover:text-foreground gap-2"
          onClick={handleReset}
        >
          <RotateCcw className="w-4 h-4" />
          Reset
        </Button>
      }
      footerRight={
        <>
          <Button variant="outline" className="h-9 px-5 text-sm text-muted-foreground hover:text-foreground" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button className="h-9 px-5 text-sm" onClick={handleApplyChanges}>
            Apply Changes
          </Button>
        </>
      }
    >
      <div className="px-6 h-11 border-b border-panel-border flex items-center justify-between">
        <div className="flex items-center gap-2">
          {tabConfig.map((tab) => {
            const Icon = tab.icon;
            const count =
              tab.id === "videos"
                ? videoTracks.length
                : tab.id === "subtitles"
                  ? subtitleTracks.length
                  : audioTracks.length;
            return (
              <button
                key={tab.id}
                onClick={() => setActiveTab(tab.id)}
                className={cn(
                  "flex items-center gap-2 px-4 py-1.5 text-sm font-medium rounded-md transition-all",
                  activeTab === tab.id
                    ? "bg-accent/60 text-primary border border-primary/30"
                    : "text-muted-foreground hover:text-foreground hover:bg-muted/40 border border-transparent",
                )}
              >
                <Icon className="w-4 h-4" />
                {tab.label}
                <span className="text-xs text-muted-foreground">({count})</span>
              </button>
            );
          })}
        </div>

        <div className="flex items-center gap-3">
          {activeTab === "subtitles" && (
            <Button
              variant="outline"
              size="sm"
              className="h-8 px-3"
              onClick={() => openAddExternalDialog("subtitle")}
            >
              <Plus className="w-4 h-4" />
              Add Subtitle Track
            </Button>
          )}
          {activeTab === "audios" && (
            <Button
              variant="outline"
              size="sm"
              className="h-8 px-3"
              onClick={() => openAddExternalDialog("audio")}
            >
              <Plus className="w-4 h-4" />
              Add Audio Track
            </Button>
          )}
          {(activeTab === "audios" || activeTab === "subtitles") && (
            <Button
              variant="outline"
              size="sm"
              className="h-8 px-3"
              onClick={handleOpenImportStreams}
            >
              <Download className="w-4 h-4" />
              {activeTab === "audios" ? "Import Audio" : "Import Subtitles"}
            </Button>
          )}
          <div className="flex items-center">
            <Button
              variant="ghost"
              size="icon"
              className="h-8 w-8 text-muted-foreground hover:text-foreground rounded-l-md rounded-r-none border border-panel-border"
              onClick={() => moveTrack("up")}
              disabled={!selectedTrackId}
            >
              <ChevronUp className="w-4 h-4" />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              className="h-8 w-8 text-muted-foreground hover:text-foreground rounded-r-md rounded-l-none border border-l-0 border-panel-border"
              onClick={() => moveTrack("down")}
              disabled={!selectedTrackId}
            >
              <ChevronDown className="w-4 h-4" />
            </Button>
          </div>
        </div>
      </div>

      <div className="flex flex-col overflow-hidden px-6 py-2 h-[280px]">
        <ReorderableTable className="h-full min-h-0">
          <ReorderableTableHeader
            className={cn(
              "grid items-center py-2",
              activeTab === "audios"
                ? "grid-cols-[28px_56px_84px_84px_84px_96px_1fr_180px_44px]"
                : "grid-cols-[28px_56px_84px_84px_84px_1fr_180px_44px]",
            )}
          >
            <ReorderableTableCell className="center" />
            <ReorderableTableCell className="center">#</ReorderableTableCell>
            <ReorderableTableCell className="center">
              <div className="flex flex-col items-center gap-0.5">
                <span className="text-[10px] uppercase tracking-wide text-muted-foreground">Copy</span>
                <Checkbox
                  className="h-3.5 w-7"
                  checked={allCopyChecked}
                  onCheckedChange={(checked) => setAllCopy(checked as boolean)}
                />
              </div>
            </ReorderableTableCell>
            <ReorderableTableCell className="center">
              <div className="flex flex-col items-center gap-0.5">
                <span className="text-[10px] uppercase tracking-wide text-muted-foreground">Default</span>
                <Checkbox
                  className="h-3.5 w-7"
                  checked={allDefaultChecked}
                  onCheckedChange={(checked) => setAllDefault(checked as boolean)}
                />
              </div>
            </ReorderableTableCell>
            <ReorderableTableCell className="center">
              <div className="flex flex-col items-center gap-0.5">
                <span className="text-[10px] uppercase tracking-wide text-muted-foreground">Forced</span>
                <Checkbox
                  className="h-3.5 w-7"
                  checked={allForcedChecked}
                  onCheckedChange={(checked) => setAllForced(checked as boolean)}
                />
              </div>
            </ReorderableTableCell>
            {activeTab === "audios" && <ReorderableTableCell className="center">Bitrate</ReorderableTableCell>}
            <ReorderableTableCell>Track Name</ReorderableTableCell>
            <ReorderableTableCell className="right">Language</ReorderableTableCell>
            <ReorderableTableCell className="center" />
          </ReorderableTableHeader>

          <ReorderableTableBody className="max-h-[220px] overflow-y-auto">
            {currentTracks.length === 0 ? (
              <div className="flex items-center justify-center h-32 text-sm text-muted-foreground">
                No {activeTab} tracks found in this file
              </div>
            ) : (
              currentTracks.map((track, index) => (
                <ReorderableRow
                  key={track.id}
                  onClick={() => setSelectedTrackId(track.id)}
                  selected={selectedTrackId === track.id}
                  dragging={draggedIndex === index}
                  dropTarget={dragOverIndex === index}
                  data-reorder-index={index}
                  className={cn(
                    "grid items-center cursor-pointer h-12",
                    activeTab === "audios"
                      ? "grid-cols-[28px_56px_84px_84px_84px_96px_1fr_180px_44px]"
                      : "grid-cols-[28px_56px_84px_84px_84px_1fr_180px_44px]",
                  )}
                >
                  <ReorderableTableCell className="center">
                    <ReorderHandle
                      className="flex items-center justify-center touch-none"
                      onPointerDown={(event) => startPointerDrag(event, index)}
                    >
                      <GripVertical className="w-4 h-4" />
                    </ReorderHandle>
                  </ReorderableTableCell>
                  <ReorderableTableCell className="center text-primary font-mono">
                    {String(index + 1).padStart(2, "0")}
                  </ReorderableTableCell>
                  <ReorderableTableCell
                    className="center"
                    onClick={(e) => {
                      e.stopPropagation();
                      handleTrackChange(track.id, "copyTrack", !track.copyTrack);
                    }}
                  >
                    <Checkbox
                      checked={track.copyTrack}
                      onCheckedChange={(checked) => handleTrackChange(track.id, "copyTrack", checked as boolean)}
                      className="h-3.5 w-7"
                    />
                  </ReorderableTableCell>
                  <ReorderableTableCell
                    className="center"
                    onClick={(e) => {
                      e.stopPropagation();
                      if (!track.copyTrack) return;
                      handleTrackChange(track.id, "setDefault", !track.setDefault);
                    }}
                  >
                    <Checkbox
                      checked={track.setDefault}
                      disabled={!track.copyTrack}
                      onCheckedChange={(checked) => handleTrackChange(track.id, "setDefault", checked as boolean)}
                      className={cn("h-3.5 w-7", !track.copyTrack && "opacity-30 cursor-not-allowed")}
                    />
                  </ReorderableTableCell>
                  <ReorderableTableCell
                    className="center"
                    onClick={(e) => {
                      e.stopPropagation();
                      if (!track.copyTrack) return;
                      handleTrackChange(track.id, "setForced", !track.setForced);
                    }}
                  >
                    <Checkbox
                      checked={track.setForced}
                      disabled={!track.copyTrack}
                      onCheckedChange={(checked) => handleTrackChange(track.id, "setForced", checked as boolean)}
                      className={cn("h-3.5 w-7", !track.copyTrack && "opacity-30 cursor-not-allowed")}
                    />
                  </ReorderableTableCell>
                  {activeTab === "audios" && (
                    <ReorderableTableCell className="center text-muted-foreground font-mono">
                      {track.source === "external"
                        ? track.externalFile?.bitrate
                          ? `${Math.round(track.externalFile.bitrate / 1000)} kbps`
                          : "—"
                        : track.originalTrack?.bitrate
                          ? `${Math.round(track.originalTrack.bitrate / 1000)} kbps`
                          : "—"}
                    </ReorderableTableCell>
                  )}
                  <ReorderableTableCell className="pr-2" onClick={(e) => e.stopPropagation()}>
                    {editingTrackId === track.id ? (
                      <TextField
                        value={editingName}
                        onChange={(e) => setEditingName(e.target.value)}
                        onBlur={finishEditing}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") finishEditing();
                          if (e.key === "Escape") {
                            setEditingTrackId(null);
                            setEditingName("");
                          }
                        }}
                        autoFocus
                        className="h-7 text-sm"
                      />
                    ) : (
                      <div
                        className="text-sm text-foreground truncate cursor-text hover:text-primary transition-colors"
                        onDoubleClick={() => startEditing(track)}
                        title="Double-click to edit"
                      >
                        <span className="truncate">{track.trackName}</span>
                        {track.source === "external" && (
                          <span className="ml-2 inline-flex items-center rounded-full border border-panel-border/60 bg-panel-header/60 px-2 py-0.5 text-[10px] uppercase tracking-wide text-muted-foreground">
                            External
                          </span>
                        )}
                      </div>
                    )}
                  </ReorderableTableCell>
                  <ReorderableTableCell className="right" onClick={(e) => e.stopPropagation()}>
                    <LanguageSelect
                      value={track.language}
                      onChange={(value) => handleTrackChange(track.id, "language", value)}
                      className="h-8 justify-end bg-input/40 border border-panel-border/40 hover:bg-input/60"
                    />
                  </ReorderableTableCell>
                  <ReorderableTableCell className="center" onClick={(e) => e.stopPropagation()}>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-7 w-7 text-muted-foreground hover:text-destructive hover:bg-destructive/10"
                      onClick={() => deleteTrack(track.id)}
                    >
                      <Trash2 className="w-4 h-4" />
                    </Button>
                  </ReorderableTableCell>
                </ReorderableRow>
              ))
            )}
          </ReorderableTableBody>
        </ReorderableTable>
      </div>
      <BaseModal
        open={addExternalOpen}
        onOpenChange={setAddExternalOpen}
        title={addExternalType === "audio" ? "Add Audio Track" : "Add Subtitle Track"}
        subtitle={
          pendingExternalPaths.length > 1
            ? `${pendingExternalPaths.length} files selected`
            : pendingExternalPaths[0] || ""
        }
        icon={addExternalType === "audio" ? <Volume2 className="w-5 h-5 text-primary" /> : <Subtitles className="w-5 h-5 text-primary" />}
        className="max-w-lg"
        bodyClassName="px-5 py-4"
        footerRight={
          <>
            <Button
              variant="ghost"
              className="h-9 px-5 text-sm text-muted-foreground hover:text-foreground"
              onClick={() => setAddExternalOpen(false)}
            >
              Cancel
            </Button>
            <Button className="h-9 px-5 text-sm" onClick={handleConfirmAddExternal}>
              Add Track
            </Button>
          </>
        }
      >
        <div className="space-y-4">
          <div className="grid gap-3">
            <label className="text-xs uppercase tracking-wide text-muted-foreground">Track Name</label>
            <TextField
              value={addExternalForm.trackName}
              onChange={(e) => setAddExternalForm((prev) => ({ ...prev, trackName: e.target.value }))}
              placeholder="Optional"
              className="h-9"
            />
          </div>
          <div className="grid gap-3">
            <label className="text-xs uppercase tracking-wide text-muted-foreground">Language</label>
            <LanguageSelect
              value={addExternalForm.language}
              onChange={(value) => setAddExternalForm((prev) => ({ ...prev, language: value }))}
              className="h-9"
            />
          </div>
          <div className="grid gap-3">
            <label className="text-xs uppercase tracking-wide text-muted-foreground">Delay (sec)</label>
            <TextField
              value={addExternalForm.delay}
              onChange={(e) => setAddExternalForm((prev) => ({ ...prev, delay: e.target.value }))}
              className="h-9 w-32"
            />
          </div>
          <div className="flex items-center gap-6">
            <label className="inline-flex items-center gap-2 text-sm text-muted-foreground">
              <Checkbox
                checked={addExternalForm.isDefault}
                onCheckedChange={(checked) =>
                  setAddExternalForm((prev) => ({ ...prev, isDefault: checked as boolean }))
                }
              />
              Default
            </label>
            <label className="inline-flex items-center gap-2 text-sm text-muted-foreground">
              <Checkbox
                checked={addExternalForm.isForced}
                onCheckedChange={(checked) =>
                  setAddExternalForm((prev) => ({ ...prev, isForced: checked as boolean }))
                }
              />
              Forced
            </label>
          </div>
        </div>
      </BaseModal>
      <BaseModal
        open={importStreamsOpen}
        onOpenChange={setImportStreamsOpen}
        title={activeTab === "audios" ? "Import Audio Streams" : "Import Subtitle Streams"}
        subtitle="Select a loaded video and choose streams to import."
        icon={<Download className="w-5 h-5 text-primary" />}
        className="max-w-xl"
        bodyClassName="px-5 py-4"
        footerRight={
          <>
            <Button
              variant="ghost"
              className="h-9 px-5 text-sm text-muted-foreground hover:text-foreground"
              onClick={() => setImportStreamsOpen(false)}
            >
              Cancel
            </Button>
            <Button
              className="h-9 px-5 text-sm"
              disabled={!importSourceVideoId || importSelectedTrackIds.length === 0}
              onClick={handleConfirmImportStreams}
            >
              Import
            </Button>
          </>
        }
      >
        <div className="space-y-4">
          <div className="grid gap-2">
            <label className="text-xs uppercase tracking-wide text-muted-foreground">Source Video File</label>
            <Select
              value={importSourceVideoId}
              onValueChange={(value) => {
                setImportSourceVideoId(value);
                setImportSelectedTrackIds([]);
              }}
            >
              <SelectTrigger className="h-9">
                <SelectValue placeholder="Select loaded video file" />
              </SelectTrigger>
              <SelectContent>
                {importableSourceVideos.length === 0 ? (
                  <SelectItem value="__no_videos" disabled>
                    No other loaded videos available
                  </SelectItem>
                ) : (
                  importableSourceVideos.map((file) => (
                    <SelectItem key={file.id} value={file.id}>
                      {file.name}
                    </SelectItem>
                  ))
                )}
              </SelectContent>
            </Select>
          </div>

          <div className="rounded-md border border-panel-border/50 bg-panel-header/40 px-3 py-3 space-y-2">
            <div className="flex items-center justify-between">
              <div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                {activeTab === "audios" ? "Audio Streams" : "Subtitle Streams"}
              </div>
              {importableTracks.length > 0 && (
                <div className="flex items-center gap-2">
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-7 px-2 text-[11px]"
                    onClick={() =>
                      setImportSelectedTrackIds(
                        importableTracks
                          .map((track) => Number(track.id))
                          .filter((id) => Number.isFinite(id)),
                      )
                    }
                  >
                    Select All
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-7 px-2 text-[11px]"
                    onClick={() => setImportSelectedTrackIds([])}
                  >
                    Clear
                  </Button>
                </div>
              )}
            </div>
            {!importSourceVideoId ? (
              <p className="text-xs text-muted-foreground">Choose a source video to load its streams.</p>
            ) : importableTracks.length === 0 ? (
              <p className="text-xs text-muted-foreground">
                No {activeTab === "audios" ? "audio" : "subtitle"} streams found in this file.
              </p>
            ) : (
              <div className="max-h-52 overflow-y-auto pr-1 space-y-2 scrollbar-thin">
                {importableTracks.map((track, index) => {
                  const numericTrackId = Number(track.id);
                  const checked = importSelectedTrackIds.includes(numericTrackId);
                  return (
                    <label
                      key={`${track.id}-${index}`}
                      className="flex items-center gap-3 text-sm text-foreground/90 cursor-pointer"
                    >
                      <Checkbox
                        checked={checked}
                        onCheckedChange={(value) => {
                          if (!Number.isFinite(numericTrackId)) return;
                          setImportSelectedTrackIds((prev) => {
                            if (value) return [...prev, numericTrackId];
                            return prev.filter((id) => id !== numericTrackId);
                          });
                        }}
                      />
                      <span className="text-xs text-muted-foreground min-w-[22px]">#{index + 1}</span>
                      <span className="truncate">
                        {track.name || track.codec || "Unnamed"}
                        {track.language ? ` • ${track.language}` : ""}
                      </span>
                    </label>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      </BaseModal>
    </BaseModal>
  );
}
