/** Videos: the folder of videos every other page adds to, as one list the
 *  width of the window: each video's frame rate, duration and size. A click
 *  selects; a double-click opens Edit tracks. The scan (names first, then
 *  track details streamed in chunks) is the old Videos tab's, unchanged. */

import {
  ArrowSyncRegular,
  DeleteRegular,
  EditRegular,
  FolderOpenRegular,
  InfoRegular,
  StopRegular,
  TextBulletListSquareRegular,
  VideoClipMultipleRegular,
  VideoClipRegular,
} from "@fluentui/react-icons";
import { startTransition, useCallback, useEffect, useMemo, useRef, useState, type MouseEvent } from "react";

import { PageDock } from "@/app/dock";
import { useShell, usePageCommands, useStatus } from "@/app/shell";
import { MediaInfoDialog } from "@/features/workspace/components/MediaInfoDialog";
import { ModifyTracksDialog } from "@/features/workspace/components/ModifyTracksDialog";
import { VideoFileEditDialog } from "@/features/workspace/components/VideoFileEditDialog";
import { mergeVideoFiles } from "@/features/workspace/lib/videoMerge";
import {
  cancelScan as cancelBackendScan,
  inspectPathsStream,
  listenInspectPathsStreamChunk,
  listenInspectPathsStreamDone,
  listenInspectPathsStreamError,
  pickDirectory,
  scanMedia,
} from "@/shared/lib/backend";
import { VIDEO_EXTENSIONS } from "@/shared/lib/extensions";
import type { ExternalFile, Preset, VideoFile } from "@/shared/types";
import { Crumb, PageView, Panel, lcdStatus, type LcdProps } from "@/ui/frame";
import { Btn, Cmd, Combo, Empty, MidText, Table, Tr } from "@/ui/kit";

import {
  SORT_OPTIONS,
  SearchBox,
  extensionOptions,
  formatGb,
  looksLikeFolder,
  matchesSearch,
  sortFiles,
  type SortValue,
} from "./common";

export interface VideosPageProps {
  hidden: boolean;
  files: VideoFile[];
  sourceFolder: string;
  onSourceFolderChange: (folder: string) => void;
  onFilesChange: (files: VideoFile[]) => void;
  onAddExternalFiles?: (
    type: "audio" | "subtitle",
    videoFileId: string,
    paths: string[],
    config: { trackName: string; language: string; delay: number; isDefault: boolean; isForced: boolean; muxAfter: string },
  ) => void;
  externalFilesByVideoId?: Record<string, { audios: ExternalFile[]; subtitles: ExternalFile[] }>;
  onExternalFilesChange?: (videoFileId: string, type: "audio" | "subtitle", files: ExternalFile[]) => void;
  preset?: Preset | null;
}

const ROW_HEIGHT = 32;
const OVERSCAN_ROWS = 8;
/** Beyond this many rows only the visible ones are drawn. */
const VIRTUAL_FROM = 120;
/** Media info compares at most this many files. */
const MEDIA_INFO_MAX = 5;

const formatFps = (fps?: number) => (fps ? fps.toFixed(3).replace(/\.?0+$/, "") : "—");
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

export function VideosPage({
  hidden,
  files,
  sourceFolder,
  onSourceFolderChange,
  onFilesChange,
  onAddExternalFiles,
  externalFilesByVideoId,
  onExternalFilesChange,
  preset,
}: VideosPageProps) {
  const shell = useShell();
  const videoExtensions = VIDEO_EXTENSIONS.map((ext) => ext.toLowerCase());
  const [videoExtension, setVideoExtension] = useState("all");
  const [search, setSearch] = useState("");
  const [sort, setSort] = useState<SortValue>("loaded");
  const [isModifyTracksOpen, setIsModifyTracksOpen] = useState(false);
  const [selectedFileId, setSelectedFileId] = useState<string | null>(null);
  const [selectedFileIds, setSelectedFileIds] = useState<string[]>([]);
  const [lastSelectedIndex, setLastSelectedIndex] = useState<number | null>(null);
  const [isScanning, setIsScanning] = useState(false);
  const [scanProgress, setScanProgress] = useState({ current: 0, total: 0 });
  const [editingFile, setEditingFile] = useState<VideoFile | null>(null);
  const [isEditDialogOpen, setIsEditDialogOpen] = useState(false);
  const [isMediaInfoOpen, setIsMediaInfoOpen] = useState(false);
  const scanTokenRef = useRef(0);
  const scanAbortRef = useRef(false);
  const activeScanIdRef = useRef<string | null>(null);
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportHeight, setViewportHeight] = useState(0);

  const displayFiles = useMemo(() => sortFiles(files.filter((file) => matchesSearch(file, search)), sort), [files, search, sort]);

  // Cleared when the search changes: a hidden row staying selected would let
  // Remove take a file with no sign it was included.
  useEffect(() => {
    setSelectedFileIds([]);
    setSelectedFileId(null);
    setLastSelectedIndex(null);
  }, [search]);

  const shouldVirtualize = displayFiles.length > VIRTUAL_FROM;
  const virtualRange = useMemo(() => {
    if (!shouldVirtualize) return { startIndex: 0, endIndex: displayFiles.length, topSpacer: 0, bottomSpacer: 0 };
    const visibleRows = Math.ceil(viewportHeight / ROW_HEIGHT);
    const startIndex = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - OVERSCAN_ROWS);
    const endIndex = Math.min(displayFiles.length, startIndex + visibleRows + OVERSCAN_ROWS * 2);
    return { startIndex, endIndex, topSpacer: startIndex * ROW_HEIGHT, bottomSpacer: Math.max(0, (displayFiles.length - endIndex) * ROW_HEIGHT) };
  }, [displayFiles.length, scrollTop, viewportHeight, shouldVirtualize]);
  const visibleFiles = shouldVirtualize ? displayFiles.slice(virtualRange.startIndex, virtualRange.endIndex) : displayFiles;

  const updateFiles = useCallback(
    (next: VideoFile[]) => {
      startTransition(() => {
        onFilesChange(mergeVideoFiles(next));
      });
    },
    [onFilesChange],
  );

  useEffect(() => {
    if (files.length === 0) {
      setSelectedFileIds([]);
      setSelectedFileId(null);
      setLastSelectedIndex(null);
      return;
    }
    setSelectedFileIds((prev) => prev.filter((id) => files.some((file) => file.id === id)));
    if (selectedFileId && !files.some((file) => file.id === selectedFileId)) setSelectedFileId(null);
  }, [files, selectedFileId]);

  const selectAll = useCallback(() => {
    const allIds = displayFiles.map((file) => file.id);
    setSelectedFileIds(allIds);
    setSelectedFileId(allIds[0] ?? null);
    setLastSelectedIndex(displayFiles.length > 0 ? displayFiles.length - 1 : null);
  }, [displayFiles]);

  const handleRowClick = useCallback(
    (event: MouseEvent | { ctrlKey?: boolean; metaKey?: boolean; shiftKey?: boolean }, index: number, fileId: string) => {
      const isToggle = event.metaKey || event.ctrlKey;
      const isRange = event.shiftKey;
      if (isRange && lastSelectedIndex !== null) {
        const start = Math.min(lastSelectedIndex, index);
        const end = Math.max(lastSelectedIndex, index);
        setSelectedFileIds(displayFiles.slice(start, end + 1).map((file) => file.id));
        setSelectedFileId(fileId);
        setLastSelectedIndex(index);
        return;
      }
      if (isToggle) {
        setSelectedFileIds((prev) => {
          const set = new Set(prev);
          if (set.has(fileId)) set.delete(fileId);
          else set.add(fileId);
          const next = Array.from(set);
          setSelectedFileId(set.has(selectedFileId || "") ? fileId : (next[0] ?? null));
          return next;
        });
        setLastSelectedIndex(index);
        return;
      }
      setSelectedFileIds([fileId]);
      setSelectedFileId(fileId);
      setLastSelectedIndex(index);
    },
    [displayFiles, lastSelectedIndex, selectedFileId],
  );

  const openEdit = useCallback((file: VideoFile) => {
    setEditingFile(file);
    setIsEditDialogOpen(true);
  }, []);

  const handleSaveFile = (updatedFile: VideoFile) => {
    onFilesChange(files.map((f) => (f.id === updatedFile.id ? updatedFile : f)));
  };

  const removeSelected = useCallback(() => {
    if (selectedFileIds.length === 0) return;
    const selectedSet = new Set(selectedFileIds);
    onFilesChange(files.filter((f) => !selectedSet.has(f.id)));
  }, [files, onFilesChange, selectedFileIds]);

  useEffect(() => {
    if (!preset) return;
    const defaultExt = preset.Default_Video_Extensions?.[0];
    if (defaultExt) setVideoExtension(defaultExt.toLowerCase());
  }, [preset]);

  const hasFiles = files.length > 0;
  useEffect(() => {
    const element = bodyRef.current;
    if (!element) return;
    const observer = new ResizeObserver(() => setViewportHeight(element.clientHeight));
    observer.observe(element);
    setViewportHeight(element.clientHeight);
    return () => observer.disconnect();
    // The list's body only exists once there are files to show.
  }, [hasFiles]);

  const cancelScan = useCallback(() => {
    scanAbortRef.current = true;
    if (activeScanIdRef.current) void cancelBackendScan(activeScanIdRef.current);
    setIsScanning(false);
  }, []);

  /** Read track details for these videos in chunks, merging each into the
   *  list as it arrives. Shared by a folder scan and a drop of files. */
  const inspectInChunks = async (scanToken: number, start: VideoFile[], paths: string[]) => {
    let scannedFiles = start;
    let processed = 0;
    let updateQueued = false;
    const stale = () => scanAbortRef.current || scanTokenRef.current !== scanToken;
    const queueUiUpdate = () => {
      if (updateQueued) return;
      updateQueued = true;
      requestAnimationFrame(() => {
        updateQueued = false;
        if (stale()) return;
        updateFiles(scannedFiles);
        setScanProgress({ current: processed, total: paths.length });
      });
    };
    const streamId = `video-scan-${scanToken}`;
    activeScanIdRef.current = streamId;
    let resolveDone: () => void = () => undefined;
    let rejectDone: (error: Error) => void = () => undefined;
    const donePromise = new Promise<void>((resolve, reject) => {
      resolveDone = resolve;
      rejectDone = reject;
    });
    const unlistenChunk = await listenInspectPathsStreamChunk((payload) => {
      if (payload.scanId !== streamId || stale()) return;
      scannedFiles = mergeVideoFiles([...scannedFiles, ...(payload.items as VideoFile[])]);
      processed = payload.processed;
      queueUiUpdate();
    });
    const unlistenDone = await listenInspectPathsStreamDone((payload) => {
      if (payload.scanId === streamId) resolveDone();
    });
    const unlistenError = await listenInspectPathsStreamError((payload) => {
      if (payload.scanId === streamId) rejectDone(new Error(payload.message || "Scan stream failed."));
    });
    try {
      await inspectPathsStream({ scan_id: streamId, paths, type: "video", include_tracks: true, batch_size: 24 });
      await donePromise;
    } finally {
      if (activeScanIdRef.current === streamId) activeScanIdRef.current = null;
      unlistenChunk();
      unlistenDone();
      unlistenError();
    }
    if (stale()) return;
    if (!updateQueued) {
      updateFiles(scannedFiles);
      setScanProgress({ current: paths.length, total: paths.length });
    }
  };

  const scanVideos = async (folderPath: string) => {
    if (!folderPath) {
      cancelScan();
      onFilesChange([]);
      return;
    }
    scanAbortRef.current = false;
    scanTokenRef.current += 1;
    const scanToken = scanTokenRef.current;
    setIsScanning(true);
    setScanProgress({ current: 0, total: 0 });
    const scanStartedAt = performance.now();
    const extensions = videoExtension === "all" ? [...videoExtensions] : [videoExtension];
    try {
      const results = (await scanMedia({ folder: folderPath, extensions, recursive: false, type: "video", include_tracks: false })) as VideoFile[];
      const normalizedExtensions = new Set(extensions.map((ext) => ext.toLowerCase()));
      const currentFiles = mergeVideoFiles(
        results.filter((file) => {
          const ext = file.path.split(".").pop()?.toLowerCase();
          return ext ? normalizedExtensions.has(ext) : false;
        }),
      );
      if (scanAbortRef.current || scanTokenRef.current !== scanToken) return;
      updateFiles(currentFiles);
      const paths = currentFiles.map((file) => file.path);
      setScanProgress({ current: 0, total: paths.length });
      await inspectInChunks(scanToken, currentFiles, paths);
      if (scanTokenRef.current === scanToken && !scanAbortRef.current) {
        shell.log(`Scanned ${plural(paths.length, "video")} in ${folderPath} (${Math.round(performance.now() - scanStartedAt)} ms)`);
      }
    } catch (error) {
      shell.log(`Error: could not scan ${folderPath}: ${String(error)}`);
    } finally {
      if (scanTokenRef.current === scanToken) setIsScanning(false);
    }
  };

  /** Dropped video files: read and merged into the list. */
  const addDroppedVideos = async (paths: string[]) => {
    const extensions = new Set(videoExtensions);
    const videos = paths.filter((path) => extensions.has(path.split(".").pop()?.toLowerCase() ?? ""));
    if (videos.length === 0) return;
    scanAbortRef.current = false;
    scanTokenRef.current += 1;
    const scanToken = scanTokenRef.current;
    setIsScanning(true);
    setScanProgress({ current: 0, total: videos.length });
    try {
      await inspectInChunks(scanToken, files, videos);
      shell.log(`Added ${plural(videos.length, "dropped video")}`);
    } catch (error) {
      shell.log(`Error: could not read the dropped videos: ${String(error)}`);
    } finally {
      if (scanTokenRef.current === scanToken) setIsScanning(false);
    }
  };

  const chooseFolder = async () => {
    const folder = await pickDirectory();
    if (folder) {
      onSourceFolderChange(folder);
      void scanVideos(folder);
    }
  };

  const selected = useMemo(() => files.filter((f) => selectedFileIds.includes(f.id)), [files, selectedFileIds]);
  const one = selected.length === 1 ? selected[0] : null;

  usePageCommands("videos", {
    chooseFolder: () => void chooseFolder(),
    selectAll: files.length ? selectAll : undefined,
    removeSelected,
    clear: files.length
      ? () => {
          cancelScan();
          onSourceFolderChange("");
          onFilesChange([]);
        }
      : undefined,
    mediaInfo: () => selected.length && setIsMediaInfoOpen(true),
    stop: isScanning ? cancelScan : undefined,
    drop: (paths) => {
      const folder = paths.find(looksLikeFolder);
      if (folder) {
        onSourceFolderChange(folder);
        void scanVideos(folder);
      } else void addDroppedVideos(paths);
    },
    disabled: { removeSelected: selected.length === 0, mediaInfo: selected.length === 0, chooseFolder: isScanning },
  });

  // --------------------------------------------------------------- display

  // Only a scan has anything to say; the list itself shows the rest.
  const lcd: LcdProps = isScanning
    ? {
        icon: "run",
        l1: scanProgress.total > 0 ? `Reading media info ${Math.min(scanProgress.current, scanProgress.total)} of ${scanProgress.total}` : "Listing the videos",
        l2: sourceFolder || undefined,
        pct: scanProgress.total > 0 ? (scanProgress.current / scanProgress.total) * 100 : null,
      }
    : { l1: "" };

  const status = useStatus("videos", lcdStatus(lcd));
  const dock = <PageDock common={shell.dock} />;

  const has = files.length > 0;

  return (
    <PageView
      hidden={hidden}
      status={status}
      dock={dock}
      tools={
        <>
          <Cmd icon={<FolderOpenRegular />} disabled={isScanning} onClick={() => void chooseFolder()}>Choose folder</Cmd>
          <Cmd icon={<ArrowSyncRegular />} title="Rescan" disabled={!sourceFolder || isScanning} onClick={() => void scanVideos(sourceFolder)} />
          <Cmd icon={<DeleteRegular />} title="Remove (Del)" disabled={selected.length === 0} onClick={removeSelected} />
          <Cmd icon={<EditRegular />} title="Edit tracks" disabled={!one} onClick={() => one && openEdit(one)} />
          <Cmd icon={<InfoRegular />} title="Media info (Ctrl+I)" disabled={selected.length === 0} onClick={() => setIsMediaInfoOpen(true)} />
        </>
      }
      primary={
        isScanning ? (
          <Btn icon={<StopRegular />} kbd="Esc" onClick={cancelScan}>Stop</Btn>
        ) : (
          <Btn icon={<TextBulletListSquareRegular />} disabled={!has} onClick={() => setIsModifyTracksOpen(true)}>Modify tracks…</Btn>
        )
      }
    >
      {has ? (
          <Panel
            label="Videos"
            left={<Crumb path={sourceFolder} empty="Videos" />}
            end={
              <>
                <Combo<string> ghost sm w={104} label="Formats to scan" value={videoExtension} options={extensionOptions(VIDEO_EXTENSIONS)} onChange={setVideoExtension} />
                <Combo<SortValue> ghost sm w={116} label="Sort" value={sort} options={SORT_OPTIONS} onChange={setSort} />
                <SearchBox value={search} onChange={setSearch} label="Search videos" />
              </>
            }
          >
            <Table
              cols="minmax(0,1fr) 100px 88px 88px"
              head={["Name", " Frame rate", " Duration", " Size"]}
              label="Videos"
              bodyRef={bodyRef}
              onBodyScroll={(event) => shouldVirtualize && setScrollTop(event.currentTarget.scrollTop)}
            >
              {displayFiles.length === 0 ? (
                <div className="log t3">No video matches the search.</div>
              ) : (
                <>
                  {virtualRange.topSpacer > 0 && <div style={{ height: virtualRange.topSpacer }} />}
                  {visibleFiles.map((file, visibleIndex) => {
                    const index = shouldVirtualize ? virtualRange.startIndex + visibleIndex : visibleIndex;
                    return (
                      <Tr
                        key={file.id}
                        on={selectedFileIds.includes(file.id)}
                        onClick={(event) => handleRowClick(event as MouseEvent, index, file.id)}
                        onDoubleClick={() => openEdit(file)}
                        label={file.name}
                      >
                        <span className="cell">
                          <span className="fi" aria-hidden><VideoClipRegular /></span>
                          <MidText text={file.name} tail={40} />
                        </span>
                        <span className="r num t2" style={{ display: "flex" }}>{file.fps ? `${formatFps(file.fps)} fps` : "—"}</span>
                        <span className="r num t2" style={{ display: "flex" }}>{file.duration || "—"}</span>
                        <span className="r num t2" style={{ display: "flex" }}>{formatGb(file.size)}</span>
                      </Tr>
                    );
                  })}
                  {virtualRange.bottomSpacer > 0 && <div style={{ height: virtualRange.bottomSpacer }} />}
                </>
              )}
            </Table>
          </Panel>
      ) : (
        <section className="box">
          {isScanning ? (
            <Empty icon={<VideoClipMultipleRegular />} title="Listing the videos" />
          ) : (
            <Empty icon={<VideoClipMultipleRegular />} title="Drop a folder of videos">
              <Btn icon={<FolderOpenRegular />} onClick={() => void chooseFolder()}>Choose folder</Btn>
            </Empty>
          )}
        </section>
      )}

      <MediaInfoDialog open={isMediaInfoOpen} onOpenChange={setIsMediaInfoOpen} files={selected.slice(0, MEDIA_INFO_MAX)} />
      <ModifyTracksDialog open={isModifyTracksOpen} onOpenChange={setIsModifyTracksOpen} videoFiles={files} selectedVideoId={selectedFileId} onFilesChange={onFilesChange} />
      <VideoFileEditDialog
        open={isEditDialogOpen}
        onOpenChange={setIsEditDialogOpen}
        videoFile={editingFile}
        allVideoFiles={files}
        onSave={handleSaveFile}
        onAddExternalFiles={onAddExternalFiles}
        externalAudioFiles={editingFile ? externalFilesByVideoId?.[editingFile.id]?.audios : []}
        externalSubtitleFiles={editingFile ? externalFilesByVideoId?.[editingFile.id]?.subtitles : []}
        onExternalFilesChange={onExternalFilesChange}
      />
    </PageView>
  );
}
