/** Chapters: chapter files for the videos, paired by position unless linked
 *  to a video by hand. The logic is the old Chapters tab's; linking moved
 *  from a Link button between two lists into the row's Video column, and the
 *  delay dialog into the inspector. */

import {
  ArrowSyncRegular,
  BookmarkMultipleRegular,
  ChevronDoubleDownRegular,
  ChevronDoubleUpRegular,
  ChevronDownRegular,
  ChevronUpRegular,
  DocumentRegular,
  FolderOpenRegular,
  LinkDismissRegular,
} from "@fluentui/react-icons";
import { useCallback, useEffect, useRef, useState } from "react";

import type { QueueAction } from "@/app/Index";
import { PageDock } from "@/app/dock";
import { useShell, usePageCommands } from "@/app/shell";
import { useRowReorder } from "@/features/workspace/lib/useRowReorder";
import { useTabState } from "@/features/workspace/store/useTabState";
import { DelayField, delayInputsAreValid } from "@/shared/components/DelayField";
import { pickDirectory, scanMedia } from "@/shared/lib/backend";
import { delaySecondsOrZero, parseDelayInput } from "@/shared/lib/delayInput";
import { CHAPTER_EXTENSIONS } from "@/shared/lib/extensions";
import type { ExternalFile, MuxSettings, Preset, VideoFile } from "@/shared/types";
import { Box, PageView, type LcdProps } from "@/ui/frame";
import { Btn, Cmd, Combo, DL, Empty, Fld, Links, MidText, TBox, TRow, Table, Toggle, Tr, cx } from "@/ui/kit";

import { QueueBtn, SearchBox, extensionOptions, formatDelay, formatFileSize, looksLikeFolder, matchesSearch } from "./common";
import { L } from "./tracks/MeasurePane";

export interface ChaptersPageProps {
  hidden: boolean;
  chapterFiles: ExternalFile[];
  videoFiles: VideoFile[];
  onChapterFilesChange: (files: ExternalFile[]) => void;
  preset?: Preset | null;
  onMuxSettingsChange: (settings: Partial<MuxSettings>) => void;
  queue: QueueAction;
}

export function ChaptersPage({ hidden, chapterFiles, videoFiles, onChapterFilesChange, preset, onMuxSettingsChange, queue }: ChaptersPageProps) {
  const shell = useShell();
  const { chapterTabState, updateChapterTabState } = useTabState((state) => ({
    chapterTabState: state.chapterTabState,
    updateChapterTabState: state.updateChapterTabState,
  }));
  const [search, setSearch] = useState("");
  const [selectedChapterIndex, setSelectedChapterIndex] = useState<number | null>(null);
  /** Selected by id, not position, so the highlight survives reordering and
   *  Remove never acts on whatever file later took that slot. */
  const selectedChapterIdRef = useRef<string | null>(null);
  const selectChapterIndex = useCallback(
    (index: number | null) => {
      selectedChapterIdRef.current = index === null ? null : (chapterFiles[index]?.id ?? null);
      setSelectedChapterIndex(index);
    },
    [chapterFiles],
  );

  // Applied when the folder value actually changes, not on every preset object
  // identity change, or saving an unrelated option would wipe a typed folder.
  const appliedPresetFolderRef = useRef<string | null>(null);
  useEffect(() => {
    if (!preset) return;
    const presetFolder = preset.Default_Chapter_Directory || "";
    if (appliedPresetFolderRef.current === presetFolder) return;
    appliedPresetFolderRef.current = presetFolder;
    updateChapterTabState({ sourceFolder: presetFolder, extension: "all" });
  }, [preset, updateChapterTabState]);

  const { chaptersEnabled, sourceFolder, extension, discardOldChapters, delay: chapterDelay } = chapterTabState;

  const visibleChapters = chapterFiles.map((file, index) => ({ file, index })).filter(({ file }) => matchesSearch(file, search));
  // Moving rows only makes sense while the list shows every file in mux order.
  const ordered = !search.trim();
  const reorderHelp = ordered ? undefined : "The search hides some chapter files, so the list is not in mux order. Clear it to rearrange.";

  /** Identifies the newest scan, so stale replies can be dropped. */
  const scanRequestRef = useRef(0);
  const scanChapters = async (folderPath: string) => {
    // Only the newest scan may publish its results.
    const requestId = ++scanRequestRef.current;
    if (!folderPath) {
      onChapterFilesChange([]);
      return;
    }
    try {
      const results = await scanMedia({ folder: folderPath, extensions: extension === "all" ? [] : [extension], recursive: false, type: "chapter", include_tracks: false });
      if (requestId !== scanRequestRef.current) return;
      if (!results || !Array.isArray(results)) {
        onChapterFilesChange([]);
        return;
      }
      const normalized = (results as ExternalFile[])
        .filter((file): file is ExternalFile => !!(file && typeof file === "object" && file.id && file.name && file.path))
        .map((file, index) => ({ ...file, type: "chapter" as const, matchedVideoId: videoFiles[index]?.id }));
      onChapterFilesChange(normalized);
      shell.log(`Chapters: ${normalized.length} file${normalized.length === 1 ? "" : "s"} from ${folderPath}`);
    } catch (error) {
      if (requestId !== scanRequestRef.current) return;
      onChapterFilesChange([]);
      shell.log(`Error: could not scan ${folderPath}: ${String(error)}`);
    }
  };

  // Positional pairing is the default; a hand-linked file keeps its link unless
  // that video disappears, in which case it falls back to positional.
  const resolveChapterLink = useCallback(
    (file: ExternalFile, index: number): ExternalFile => {
      if (file.isManuallyLinked && videoFiles.some((video) => video.id === file.matchedVideoId)) return file;
      const positional = videoFiles[index]?.id;
      if (file.matchedVideoId === positional && !file.isManuallyLinked) return file;
      return { ...file, matchedVideoId: positional, isManuallyLinked: false };
    },
    [videoFiles],
  );
  const syncChapterLinks = useCallback((files: ExternalFile[]) => files.map(resolveChapterLink), [resolveChapterLink]);

  useEffect(() => {
    if (chapterFiles.length === 0) return;
    const isSynced = chapterFiles.every((file, index) => resolveChapterLink(file, index) === file);
    if (!isSynced) onChapterFilesChange(syncChapterLinks(chapterFiles));
  }, [chapterFiles, onChapterFilesChange, resolveChapterLink, syncChapterLinks, videoFiles]);

  useEffect(() => {
    const selectedId = selectedChapterIdRef.current;
    if (selectedId === null) return;
    const nextIndex = chapterFiles.findIndex((file) => file.id === selectedId);
    if (nextIndex < 0) selectedChapterIdRef.current = null;
    setSelectedChapterIndex(nextIndex >= 0 ? nextIndex : null);
  }, [chapterFiles]);

  const reorderChapterFile = (fromIndex: number, toIndex: number) => {
    if (toIndex < 0 || toIndex >= chapterFiles.length) return;
    const updated = [...chapterFiles];
    const [moved] = updated.splice(fromIndex, 1);
    updated.splice(toIndex, 0, moved);
    onChapterFilesChange(updated);
    selectChapterIndex(toIndex);
  };

  /** Link a chapter file to a video by hand; it keeps that link from then on. */
  const linkChapterToVideo = (chapterIndex: number, videoId: string) => {
    onChapterFilesChange(chapterFiles.map((file, index) => (index === chapterIndex ? { ...file, matchedVideoId: videoId, isManuallyLinked: true } : file)));
  };
  /** Back to pairing by position. */
  const unlinkChapter = (chapterIndex: number) => {
    onChapterFilesChange(chapterFiles.map((file, index) => (index === chapterIndex ? { ...file, matchedVideoId: videoFiles[index]?.id, isManuallyLinked: false } : file)));
  };

  const applyDelayToAll = () => {
    const delayValue = delaySecondsOrZero(chapterDelay);
    onChapterFilesChange(chapterFiles.map((file) => ({ ...file, delay: delayValue })));
  };

  const setEnabled = (enabled: boolean) => {
    updateChapterTabState({ chaptersEnabled: enabled });
    if (!enabled) onChapterFilesChange([]);
  };

  const chooseFolder = async () => {
    const folder = await pickDirectory();
    if (folder) {
      updateChapterTabState({ sourceFolder: folder });
      void scanChapters(folder);
    }
  };

  const bodyRef = useRef<HTMLDivElement | null>(null);
  const drag = useRowReorder({ bodyRef, rowCount: chapterFiles.length, disabled: !ordered || !chaptersEnabled, onMove: reorderChapterFile });

  const sel = selectedChapterIndex;
  const selected = sel !== null ? chapterFiles[sel] : undefined;
  const canUp = chaptersEnabled && ordered && sel !== null && sel > 0;
  const canDown = chaptersEnabled && ordered && sel !== null && sel < chapterFiles.length - 1;

  usePageCommands("chapters", {
    chooseFolder: chaptersEnabled ? () => void chooseFolder() : undefined,
    clear: chapterFiles.length
      ? () => {
          updateChapterTabState({ sourceFolder: "" });
          onChapterFilesChange([]);
        }
      : undefined,
    moveUp: canUp ? () => reorderChapterFile(sel!, sel! - 1) : undefined,
    moveDown: canDown ? () => reorderChapterFile(sel!, sel! + 1) : undefined,
    drop: (paths) => {
      const folder = paths.find(looksLikeFolder);
      if (!folder) return;
      // Dropping a folder of chapters is asking for them: turn chapters on.
      if (!chaptersEnabled) updateChapterTabState({ chaptersEnabled: true });
      updateChapterTabState({ sourceFolder: folder });
      void scanChapters(folder);
    },
  });

  const linkedByHand = chapterFiles.filter((file) => file.isManuallyLinked).length;
  const linked = chapterFiles.filter((file) => file.matchedVideoId).length;
  const lcd: LcdProps = !chaptersEnabled
    ? { l1: "Chapters are off", l2: "The videos keep the chapters they have" }
    : chapterFiles.length === 0
      ? { l1: "Drop a folder of chapter files" }
      : {
          l1: `${chapterFiles.length} chapter file${chapterFiles.length === 1 ? "" : "s"} · ${linked} linked`,
          l2: `${linkedByHand ? `${linkedByHand} linked by hand · ` : ""}${discardOldChapters ? "old chapters discarded" : "old chapters kept"}`,
        };
  const delayOk = parseDelayInput(chapterDelay).valid;
  const videoOptions = videoFiles.map((video) => ({ value: video.id, label: video.name }));

  return (
    <PageView
      hidden={hidden}
      lcd={lcd}
      dock={<PageDock common={shell.dock} />}
      tools={
        <>
          <Cmd icon={<FolderOpenRegular />} disabled={!chaptersEnabled} onClick={() => void chooseFolder()}>Choose folder</Cmd>
          <Cmd icon={<ArrowSyncRegular />} title="Rescan" disabled={!chaptersEnabled || !sourceFolder} onClick={() => void scanChapters(sourceFolder)} />
          <Cmd icon={<ChevronDoubleUpRegular />} title={reorderHelp ?? "Move to the top"} disabled={!canUp} onClick={() => reorderChapterFile(sel!, 0)} />
          <Cmd icon={<ChevronUpRegular />} title={reorderHelp ?? "Move up (Alt+↑)"} disabled={!canUp} onClick={() => reorderChapterFile(sel!, sel! - 1)} />
          <Cmd icon={<ChevronDownRegular />} title={reorderHelp ?? "Move down (Alt+↓)"} disabled={!canDown} onClick={() => reorderChapterFile(sel!, sel! + 1)} />
          <Cmd icon={<ChevronDoubleDownRegular />} title={reorderHelp ?? "Move to the bottom"} disabled={!canDown} onClick={() => reorderChapterFile(sel!, chapterFiles.length - 1)} />
        </>
      }
      primary={<QueueBtn queue={queue} />}
    >
      {chaptersEnabled && chapterFiles.length > 0 ? (
        <Box
          body={false}
          title="Chapters"
          sub={sourceFolder ? <span title={sourceFolder}>{sourceFolder}</span> : undefined}
          end={
            <>
              <Combo<string> ghost sm w={104} label="Formats to scan" value={extension} options={extensionOptions(CHAPTER_EXTENSIONS)} onChange={(value) => updateChapterTabState({ extension: value })} />
              <SearchBox value={search} onChange={setSearch} label="Search chapters" w={150} />
            </>
          }
        >
          <Table cols="24px minmax(0,1fr) minmax(0,1fr) 72px 88px" head={["#", "Chapter file", "Video", " Delay", "Linked"]} label="Chapters" bodyRef={bodyRef}>
            {visibleChapters.map(({ file, index }) => {
              const dragProps = drag.rowProps(index);
              return (
                <Tr key={file.id} on={sel === index} className={dragProps.className} onPointerDown={dragProps.onPointerDown} onClick={() => selectChapterIndex(index)} label={file.name}>
                  <span className="num t3">{index + 1}</span>
                  <span className="cell"><span className="fi" aria-hidden><DocumentRegular /></span><span className="truncate" title={file.name}>{file.name}</span></span>
                  <span className="pairdub" style={{ minWidth: 0 }}>
                    <Combo<string>
                      ghost
                      sm
                      w="100%"
                      label={`Video for ${file.name}`}
                      value={file.matchedVideoId ?? null}
                      placeholder="No video"
                      options={videoOptions}
                      onChange={(videoId) => linkChapterToVideo(index, videoId)}
                    />
                  </span>
                  <span className="r num t2" style={{ display: "flex" }}>{formatDelay(file.delay)}</span>
                  <span className={file.isManuallyLinked ? "" : "t3"}>{file.isManuallyLinked ? "By hand" : "By order"}</span>
                </Tr>
              );
            })}
          </Table>
        </Box>
      ) : (
        <section className="box">
          {chaptersEnabled ? (
            <Empty icon={<BookmarkMultipleRegular />} title="Drop a folder of chapter files">
              <Btn icon={<FolderOpenRegular />} onClick={() => void chooseFolder()}>Choose folder</Btn>
            </Empty>
          ) : (
            <Empty icon={<BookmarkMultipleRegular />} title="Chapters are off">
              <Btn onClick={() => setEnabled(true)}>Turn on chapters</Btn>
            </Empty>
          )}
        </section>
      )}
      <div className="stack">
        <Box title="Chapters">
          <TRow label="Add chapters from files"><Toggle name="Add chapters from files" on={chaptersEnabled} onChange={setEnabled} /></TRow>
          <Fld label="Delay for every file">
            <div className="row" style={{ gap: 8 }}>
              <span className="grow">
                <TBox
                  label="Delay for every file"
                  className={cx(!delayOk && "invalid")}
                  mono
                  unit="s"
                  value={chapterDelay}
                  disabled={!chaptersEnabled}
                  title={parseDelayInput(chapterDelay).error}
                  aria-invalid={!delayOk}
                  onChange={(value) => updateChapterTabState({ delay: value })}
                />
              </span>
              <Btn disabled={!chaptersEnabled || chapterFiles.length === 0 || !delayInputsAreValid(chapterDelay)} onClick={applyDelayToAll}>Apply to all</Btn>
            </div>
          </Fld>
          <TRow label="Discard the videos' own chapters">
            <Toggle
              name="Discard the videos' own chapters"
              on={discardOldChapters}
              disabled={!chaptersEnabled}
              onChange={(enabled) => {
                updateChapterTabState({ discardOldChapters: enabled });
                onMuxSettingsChange({ discardOldChapters: enabled });
              }}
            />
          </TRow>
        </Box>
        {chaptersEnabled && selected && sel !== null && <ChapterDetails key={selected.id} file={selected} index={sel} videoFiles={videoFiles} onChange={(next) => onChapterFilesChange(chapterFiles.map((f, i) => (i === sel ? next : f)))} onApplyToAll={(delay) => onChapterFilesChange(chapterFiles.map((f) => ({ ...f, delay })))} onUnlink={() => unlinkChapter(sel)} />}
      </div>
    </PageView>
  );
}

/** The selected chapter file, with its delay (the old "Edit Chapter Delay"
 *  dialog, in place). The delay commits on Enter or leaving the box. */
function ChapterDetails({
  file,
  index,
  videoFiles,
  onChange,
  onApplyToAll,
  onUnlink,
}: {
  file: ExternalFile;
  index: number;
  videoFiles: VideoFile[];
  onChange: (file: ExternalFile) => void;
  onApplyToAll: (delay: number) => void;
  onUnlink: () => void;
}) {
  const [delay, setDelay] = useState((file.delay ?? 0).toFixed(3));
  useEffect(() => setDelay((file.delay ?? 0).toFixed(3)), [file.delay]);
  const video = videoFiles.find((v) => v.id === file.matchedVideoId);
  const commit = () => {
    if (!delayInputsAreValid(delay)) return;
    const value = delaySecondsOrZero(delay);
    if (value !== (file.delay ?? 0)) onChange({ ...file, delay: value });
  };
  return (
    <Box title={<MidText text={file.name} tail={20} />}>
      <DL
        rows={[
          ["Video", video ? <span key="v" className="truncate" title={video.name}>{video.name}</span> : <span key="v" className="warn">None</span>],
          ["Linked", file.isManuallyLinked ? "By hand" : `By order, row ${index + 1}`],
          ["Size", file.size ? formatFileSize(file.size) : "—"],
        ]}
      />
      <div
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === "Enter") commit();
        }}
      >
        <DelayField value={delay} onChange={setDelay} hint="Positive plays the chapters later; negative, earlier." />
      </div>
      <Links>
        <L icon={<BookmarkMultipleRegular />} disabled={!delayInputsAreValid(delay)} onClick={() => onApplyToAll(delaySecondsOrZero(delay))}>Use this delay for every file</L>
        {file.isManuallyLinked && <L icon={<LinkDismissRegular />} onClick={onUnlink}>Link by order again</L>}
      </Links>
    </Box>
  );
}
