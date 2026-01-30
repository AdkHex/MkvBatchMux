import { useState, useRef } from "react";
import { Check, X, GripVertical } from "lucide-react";
import type { VideoFile } from "@/types";
import { TrackInfoEditDialog, VideoTrackInfo } from "./TrackInfoEditDialog";
import { VideoFileEditDialog } from "./VideoFileEditDialog";
import {
  ReorderableTable,
  ReorderableTableHeader,
  ReorderableTableBody,
  ReorderableRow,
  ReorderableTableCell,
  ReorderHandle,
} from "@/components/shared/ReorderableTable";
import { CODE_TO_LABEL } from "@/data/languages-iso6393";

interface TrackInfoTableProps {
  videoFiles: VideoFile[];
  trackType: "subtitle" | "audio";
  trackInfoList: VideoTrackInfo[];
  onTrackInfoChange: (updated: VideoTrackInfo) => void;
  onVideoFileChange?: (updatedFile: VideoFile) => void;
  onReorder?: (reorderedList: VideoTrackInfo[]) => void;
}

export function TrackInfoTable({
  videoFiles,
  trackType,
  trackInfoList,
  onTrackInfoChange,
  onVideoFileChange,
  onReorder,
}: TrackInfoTableProps) {
  const [editDialogOpen, setEditDialogOpen] = useState(false);
  const [selectedTrackInfo, setSelectedTrackInfo] = useState<VideoTrackInfo | null>(null);
  const [videoEditDialogOpen, setVideoEditDialogOpen] = useState(false);
  const [selectedVideoFile, setSelectedVideoFile] = useState<VideoFile | null>(null);

  const [draggedIndex, setDraggedIndex] = useState<number | null>(null);
  const [dragOverIndex, setDragOverIndex] = useState<number | null>(null);
  const dragNodeRef = useRef<HTMLDivElement | null>(null);

  const handleDoubleClick = (info: VideoTrackInfo) => {
    const videoFile = videoFiles.find((f) => f.id === info.videoId);

    if (videoFile && onVideoFileChange) {
      setSelectedVideoFile(videoFile);
      setVideoEditDialogOpen(true);
    } else {
      setSelectedTrackInfo(info);
      setEditDialogOpen(true);
    }
  };

  const handleSaveTrackInfo = (updated: VideoTrackInfo) => {
    onTrackInfoChange(updated);
  };

  const handleSaveVideoFile = (updatedFile: VideoFile) => {
    if (onVideoFileChange) {
      onVideoFileChange(updatedFile);
    }
  };

  const handleDragStart = (e: React.DragEvent, index: number) => {
    setDraggedIndex(index);
    dragNodeRef.current = e.target as HTMLDivElement;
    e.dataTransfer.effectAllowed = "move";
    e.dataTransfer.setData("text/plain", index.toString());

    setTimeout(() => {
      if (dragNodeRef.current) {
        dragNodeRef.current.style.opacity = "0.5";
      }
    }, 0);
  };

  const handleDragEnd = () => {
    if (dragNodeRef.current) {
      dragNodeRef.current.style.opacity = "1";
    }

    if (
      draggedIndex !== null &&
      dragOverIndex !== null &&
      draggedIndex !== dragOverIndex &&
      onReorder
    ) {
      const reordered = [...trackInfoList];
      const [removed] = reordered.splice(draggedIndex, 1);
      reordered.splice(dragOverIndex, 0, removed);
      onReorder(reordered);
    }

    setDraggedIndex(null);
    setDragOverIndex(null);
    dragNodeRef.current = null;
  };

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
  };

  const handleDragEnter = (index: number) => {
    if (draggedIndex !== null && index !== draggedIndex) {
      setDragOverIndex(index);
    }
  };

  return (
    <>
      <ReorderableTable className="rounded-lg">
        <ReorderableTableHeader className="grid grid-cols-[24px_1fr_60px_56px_56px_100px_90px] items-center">
          <ReorderableTableCell className="center" />
          <ReorderableTableCell>Video</ReorderableTableCell>
          <ReorderableTableCell className="center">Found</ReorderableTableCell>
          <ReorderableTableCell className="center">Def</ReorderableTableCell>
          <ReorderableTableCell className="center">Frc</ReorderableTableCell>
          <ReorderableTableCell>Name</ReorderableTableCell>
          <ReorderableTableCell className="right">Lang</ReorderableTableCell>
        </ReorderableTableHeader>

        <ReorderableTableBody className="max-h-28">
          {trackInfoList.map((info, index) => (
            <ReorderableRow
              key={info.videoId}
              draggable
              onDragStart={(e) => handleDragStart(e, index)}
              onDragEnd={handleDragEnd}
              onDragOver={handleDragOver}
              onDragEnter={() => handleDragEnter(index)}
              onDoubleClick={() => handleDoubleClick(info)}
              dropTarget={dragOverIndex === index}
              dragging={draggedIndex === index}
              className="grid grid-cols-[24px_1fr_60px_56px_56px_100px_90px] items-center cursor-pointer"
              title="Double-click to edit, drag to reorder"
            >
              <ReorderableTableCell className="center">
                <ReorderHandle className="flex items-center justify-center">
                  <GripVertical className="w-3.5 h-3.5" />
                </ReorderHandle>
              </ReorderableTableCell>
              <ReorderableTableCell className="text-foreground/70 truncate pr-2 font-mono">
                <span className="text-primary/70 mr-1.5">{index + 1}.</span>
                {info.videoName}
              </ReorderableTableCell>
              <ReorderableTableCell className="center">
                {info.found ? (
                  <Check className="w-3.5 h-3.5 text-success" />
                ) : (
                  <X className="w-3.5 h-3.5 text-destructive/40" />
                )}
              </ReorderableTableCell>
              <ReorderableTableCell className="center">
                {info.isDefault ? (
                  <Check className="w-3.5 h-3.5 text-success" />
                ) : (
                  <X className="w-3.5 h-3.5 text-destructive/40" />
                )}
              </ReorderableTableCell>
              <ReorderableTableCell className="center">
                {info.isForced ? (
                  <Check className="w-3.5 h-3.5 text-success" />
                ) : (
                  <X className="w-3.5 h-3.5 text-destructive/40" />
                )}
              </ReorderableTableCell>
              <ReorderableTableCell className="text-foreground/80 truncate">
                {info.trackName || "—"}
              </ReorderableTableCell>
              <ReorderableTableCell className="right text-primary font-medium">
                {CODE_TO_LABEL[info.language] || info.language}
              </ReorderableTableCell>
            </ReorderableRow>
          ))}
        </ReorderableTableBody>
      </ReorderableTable>

      <TrackInfoEditDialog
        open={editDialogOpen}
        onOpenChange={setEditDialogOpen}
        trackInfo={selectedTrackInfo}
        onSave={handleSaveTrackInfo}
        trackType={trackType}
      />

      <VideoFileEditDialog
        open={videoEditDialogOpen}
        onOpenChange={setVideoEditDialogOpen}
        videoFile={selectedVideoFile}
        onSave={handleSaveVideoFile}
      />
    </>
  );
}
