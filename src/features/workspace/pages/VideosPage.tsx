/** Videos: the folder of videos every other page adds to. A list of the
 *  videos with what each holds and where it is in the queue, and an inspector
 *  for the selection. The scan (names first, then track details streamed in
 *  chunks) is the old Videos tab's, unchanged. */

import {
  ArrowSyncRegular,
  ClosedCaptionRegular,
  DeleteRegular,
  EditRegular,
  FolderOpenRegular,
  InfoRegular,
  MusicNote2Regular,
  StopRegular,
  TextBulletListSquareRegular,
  VideoClipMultipleRegular,
  VideoClipRegular,
  VideoRegular,
} from "@fluentui/react-icons";
import { startTransition, useCallback, useEffect, useMemo, useRef, useState, type MouseEvent, type ReactNode } from "react";

import type { QueueAction } from "@/app/Index";
import { PageDock } from "@/app/dock";
import { useShell, usePageCommands } from "@/app/shell";
import { MediaInfoDialog } from "@/features/workspace/components/MediaInfoDialog";
import { ModifyTracksDialog } from "@/features/workspace/components/ModifyTracksDialog";
import { VideoFileEditDialog } from "@/features/workspace/components/VideoFileEditDialog";
import { mergeVideoFiles } from "@/features/workspace/lib/videoMerge";
import { CODE_TO_LABEL } from "@/shared/data/languages-iso6393";
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
import type { ExternalFile, MuxJob, Preset, Track, VideoFile } from "@/shared/types";
import { Box, PageView, type LcdProps } from "@/ui/frame";
import { Btn, Cmd, Combo, DL, Empty, Links, MidText, Status, Table, Tr, cx, type St } from "@/ui/kit";

import {
  QueueBtn,
  SORT_OPTIONS,
  SearchBox,
  extensionOptions,
  formatClockSeconds,
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
  /** Every external file paired with each video, by video id. */
  addedByVideo: Record<string, ExternalFile[]>;
  /** The queue, for each video's Status. */
  jobs: MuxJob[];
  preset?: Preset | null;
  queue: QueueAction;
  /** Files loaded on the Audio and Subtitles pages, for the status display. */
  pendingTracks: { audio: number; subtitles: number };
}

const ROW_HEIGHT = 32;
const OVERSCAN_ROWS = 8;
/** Beyond this many rows only the visible ones are drawn. */
const VIRTUAL_FROM = 120;
/** Media info compares at most this many files. */
const MEDIA_INFO_MAX = 5;

const formatFps = (fps?: number) => (fps ? fps.toFixed(3).replace(/\.?0+$/, "") : "—");
const kept = (tracks: Track[] | undefined, type: Track["type"]) => (tracks ?? []).filter((t) => t.type === type && t.action !== "remove").length;
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** Kept tracks per type, plus the files added to the video, as icons and counts. */
function TrackCounts({ video, added }: { video: VideoFile; added: ExternalFile[] }) {
  if (!video.tracks || video.tracks.length === 0) return <span className="t3">—</span>;
  const a = kept(video.tracks, "audio") + added.filter((f) => f.type === "audio").length;
  const s = kept(video.tracks, "subtitle") + added.filter((f) => f.type === "subtitle").length;
  return (
    <span className="cell sm t2 num" style={{ gap: 10 }} title={`${kept(video.tracks, "video")} video, ${a} audio, ${s} subtitle`}>
      <span className="cell" style={{ gap: 3 }}><VideoRegular aria-hidden />{kept(video.tracks, "video")}</span>
      <span className="cell" style={{ gap: 3 }}><MusicNote2Regular aria-hidden />{a}</span>
      <span className="cell" style={{ gap: 3 }}><ClosedCaptionRegular aria-hidden />{s}</span>
    </span>
  );
}

/** A video's place in the queue, in the one status vocabulary. */
function jobStatus(job: MuxJob | undefined): { s: St; text?: string; pct?: number | null; title?: string } {
  if (!job) return { s: "ready" };
  if (job.status === "queued") return { s: "wait", text: "Queued" };
  if (job.status === "processing") return { s: "run", pct: job.progress };
  if (job.status === "completed") return { s: "ok" };
  if (job.status === "error") return { s: "bad", title: job.errorMessage };
  return { s: "warn", text: "Stopped" };
}

/** "Korean", from "kor"; nothing for undetermined. */
const languageName = (code?: string) => (code && code !== "und" ? (CODE_TO_LABEL[code] ?? code) : null);

const typeIcon = (type: Track["type"]) => (type === "video" ? <VideoRegular /> : type === "audio" ? <MusicNote2Regular /> : <ClosedCaptionRegular />);

/** A video's tracks as the inspector lists them: kept, removed, and added. */
export function TrackList({ video, added = [] }: { video: VideoFile; added?: ExternalFile[] }) {
  const rows: { key: string; type: Track["type"]; text: string; flag: string; off?: boolean }[] = [];
  const tracks = (video.tracks ?? []).filter((t) => t.type !== "chapter");
  for (const type of ["video", "audio", "subtitle"] as const) {
    tracks
      .filter((t) => t.type === type)
      .forEach((t) =>
        rows.push({
          key: `${type}-${t.id}`,
          type,
          text: [type === "video" ? null : languageName(t.language), t.codec, t.name].filter(Boolean).join(" · ") || "Unnamed",
          flag: t.action === "remove" ? "Removed" : t.isDefault ? "Default" : t.isForced ? "Forced" : "",
          off: t.action === "remove",
        }),
      );
    if (type === "video") continue;
    added
      .filter((f) => f.type === type)
      .forEach((f) => {
        const codec = f.tracks?.find((t) => t.type === type)?.codec;
        rows.push({ key: `added-${f.id}`, type, text: [languageName(f.language), codec, f.trackName].filter(Boolean).join(" · ") || f.name, flag: "Added" });
      });
  }
  if (rows.length === 0) return <span className="t3">Track details are still being read.</span>;
  return (
    <div className="col">
      {rows.map((row) => (
        <div key={row.key} className={cx("trk", row.off && "off")}>
          <span className="fi" aria-hidden>{typeIcon(row.type)}</span>
          <span className="grow truncate" title={row.text}>{row.text}</span>
          <span className="fl">{row.flag}</span>
        </div>
      ))}
    </div>
  );
}

/** A layout of kept tracks, to tell whether every video holds the same ones. */
const layoutOf = (video: VideoFile) =>
  (video.tracks ?? [])
    .filter((t) => t.type !== "chapter")
    .map((t) => `${t.type}:${t.language ?? ""}:${t.codec ?? ""}`)
    .join("|");

export function VideosPage({
  hidden,
  files,
  sourceFolder,
  onSourceFolderChange,
  onFilesChange,
  onAddExternalFiles,
  externalFilesByVideoId,
  onExternalFilesChange,
  addedByVideo,
  jobs,
  preset,
  queue,
  pendingTracks,
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
  const jobByVideo = useMemo(() => new Map(jobs.map((job) => [job.videoFile.id, job])), [jobs]);
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

  const totalBytes = files.reduce((sum, f) => sum + (f.size || 0), 0);
  const toAdd = [
    pendingTracks.audio ? plural(pendingTracks.audio, "audio file") : null,
    pendingTracks.subtitles ? plural(pendingTracks.subtitles, "subtitle file") : null,
  ].filter(Boolean);
  const lcd: LcdProps = isScanning
    ? {
        icon: "run",
        l1: scanProgress.total > 0 ? `Reading media info ${Math.min(scanProgress.current, scanProgress.total)} of ${scanProgress.total}` : "Listing the videos",
        l2: sourceFolder || undefined,
        pct: scanProgress.total > 0 ? (scanProgress.current / scanProgress.total) * 100 : null,
      }
    : files.length === 0
      ? { l1: "Drop a folder of videos to begin" }
      : { l1: `${plural(files.length, "video")} · ${formatGb(totalBytes)}`, l2: toAdd.length ? `${toAdd.join(" · ")} to add` : undefined };

  const dock = <PageDock common={shell.dock} />;

  const has = files.length > 0;

  return (
    <PageView
      hidden={hidden}
      lcd={lcd}
      dock={dock}
      cols={has ? "minmax(0,1fr) 300px" : "minmax(0,1fr)"}
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
          <>
            <Btn icon={<TextBulletListSquareRegular />} disabled={!has} onClick={() => setIsModifyTracksOpen(true)}>Modify tracks…</Btn>
            <QueueBtn queue={queue} />
          </>
        )
      }
    >
      {has ? (
        <>
          <Box
            body={false}
            title="Videos"
            sub={sourceFolder ? <span title={sourceFolder}>{sourceFolder}</span> : undefined}
            end={
              <>
                <Combo<string> ghost sm w={104} label="Formats to scan" value={videoExtension} options={extensionOptions(VIDEO_EXTENSIONS)} onChange={setVideoExtension} />
                <Combo<SortValue> ghost sm w={116} label="Sort" value={sort} options={SORT_OPTIONS} onChange={setSort} />
                <SearchBox value={search} onChange={setSearch} label="Search videos" />
              </>
            }
          >
            <Table
              cols="minmax(0,1fr) 108px 60px 68px 72px 88px"
              head={["Name", "Tracks", " FPS", " Duration", " Size", "Status"]}
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
                    const read = Boolean(file.tracks && file.tracks.length > 0);
                    const job = jobStatus(jobByVideo.get(file.id));
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
                          <MidText text={file.name} tail={22} />
                        </span>
                        <TrackCounts video={file} added={addedByVideo[file.id] ?? []} />
                        <span className="r num t2" style={{ display: "flex" }}>{formatFps(file.fps)}</span>
                        <span className="r num t2" style={{ display: "flex" }}>{file.duration || "—"}</span>
                        <span className="r num t2" style={{ display: "flex" }}>{formatGb(file.size)}</span>
                        {isScanning && !read ? (
                          <Status s="wait" />
                        ) : (
                          <span title={job.title} style={{ minWidth: 0 }}><Status s={job.s} text={job.text} pct={job.pct} /></span>
                        )}
                      </Tr>
                    );
                  })}
                  {virtualRange.bottomSpacer > 0 && <div style={{ height: virtualRange.bottomSpacer }} />}
                </>
              )}
            </Table>
          </Box>
          <Inspector
            files={files}
            selected={selected}
            sourceFolder={sourceFolder}
            addedByVideo={addedByVideo}
            onEdit={openEdit}
            onMediaInfo={() => setIsMediaInfoOpen(true)}
            onModify={() => setIsModifyTracksOpen(true)}
            onRemove={removeSelected}
          />
        </>
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

/** The right-hand pane: the selection, or the folder when nothing is selected. */
function Inspector({
  files,
  selected,
  sourceFolder,
  addedByVideo,
  onEdit,
  onMediaInfo,
  onModify,
  onRemove,
}: {
  files: VideoFile[];
  selected: VideoFile[];
  sourceFolder: string;
  addedByVideo: Record<string, ExternalFile[]>;
  onEdit: (file: VideoFile) => void;
  onMediaInfo: () => void;
  onModify: () => void;
  onRemove: () => void;
}) {
  const L = ({ icon, children, onClick }: { icon: ReactNode; children: ReactNode; onClick: () => void }) => (
    <button type="button" className="cmd" onClick={onClick}>
      <span className="ic" aria-hidden>{icon}</span>
      {children}
    </button>
  );
  const bytes = (list: VideoFile[]) => list.reduce((sum, f) => sum + (f.size || 0), 0);
  const seconds = (list: VideoFile[]) => list.reduce((sum, f) => sum + (f.durationSeconds || 0), 0);
  const fps = (list: VideoFile[]) => {
    const rates = [...new Set(list.map((f) => formatFps(f.fps)).filter((r) => r !== "—"))];
    return rates.length === 0 ? "—" : rates.length === 1 ? `${rates[0]} fps` : "Mixed";
  };
  const folder = (path: string) => <span className="truncate" title={path}>{path || "—"}</span>;

  if (selected.length > 1) {
    const audio = selected.reduce((n, f) => n + kept(f.tracks, "audio"), 0);
    const subs = selected.reduce((n, f) => n + kept(f.tracks, "subtitle"), 0);
    return (
      <Box title={`${selected.length} videos`}>
        <DL rows={[["Size", formatGb(bytes(selected))], ["Duration", formatClockSeconds(seconds(selected))], ["Frame rate", fps(selected)], ["Tracks", `${plural(audio, "audio")} · ${plural(subs, "subtitle", "subtitles")}`]]} />
        <Links>
          <L icon={<InfoRegular />} onClick={onMediaInfo}>Media info</L>
          <L icon={<TextBulletListSquareRegular />} onClick={onModify}>Modify tracks…</L>
          <L icon={<DeleteRegular />} onClick={onRemove}>Remove</L>
        </Links>
      </Box>
    );
  }
  if (selected.length === 1) {
    const video = selected[0];
    const dir = video.path.replace(/[\\/][^\\/]*$/, "");
    return (
      <Box title={<MidText text={video.name} tail={14} />}>
        <DL rows={[["Duration", video.duration || "—"], ["Frame rate", video.fps ? `${formatFps(video.fps)} fps` : "—"], ["Size", formatGb(video.size)], ["Folder", folder(dir)]]} />
        <div className="col" style={{ gap: 4 }}>
          <span className="sec">Tracks</span>
          <TrackList video={video} added={addedByVideo[video.id] ?? []} />
        </div>
        <Links>
          <L icon={<EditRegular />} onClick={() => onEdit(video)}>Edit tracks…</L>
          <L icon={<InfoRegular />} onClick={onMediaInfo}>Media info</L>
        </Links>
      </Box>
    );
  }
  const exts = [...new Set(files.map((f) => f.name.split(".").pop()?.toUpperCase()).filter(Boolean))].join(", ");
  const first = files[0];
  const same = files.every((f) => layoutOf(f) === layoutOf(first));
  const name = sourceFolder.replace(/[\\/]+$/, "").replace(/^.*[\\/]/, "") || "Videos";
  return (
    <Box title={name}>
      <DL rows={[["Folder", folder(sourceFolder)], ["Videos", `${files.length} · ${exts || "—"}`], ["Size", formatGb(bytes(files))], ["Duration", formatClockSeconds(seconds(files))], ["Frame rate", fps(files)]]} />
      {first && (
        <div className="col" style={{ gap: 4 }}>
          <span className="sec">{same ? "In every video" : "In the first video"}</span>
          <TrackList video={first} />
        </div>
      )}
      <Links>
        <L icon={<TextBulletListSquareRegular />} onClick={onModify}>Modify tracks…</L>
      </Links>
    </Box>
  );
}
