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

import { PageDock } from "@/app/dock";
import { useShell, usePageCommands, useStatus } from "@/app/shell";
import { useRowReorder } from "@/features/workspace/lib/useRowReorder";
import { useTabState } from "@/features/workspace/store/useTabState";
import { DelayField, delayInputsAreValid } from "@/shared/components/DelayField";
import { pickDirectory, scanMedia } from "@/shared/lib/backend";
import { delaySecondsOrZero, parseDelayInput } from "@/shared/lib/delayInput";
import { CHAPTER_EXTENSIONS } from "@/shared/lib/extensions";
import type { ExternalFile, MuxSettings, Preset, VideoFile } from "@/shared/types";
import { Dialog, PageView, Panel, lcdStatus, type LcdProps } from "@/ui/frame";
import { Btn, Chk, Cmd, Combo, DL, Empty, Links, SheetField, TBox, Table, Toggle, Tr, cx } from "@/ui/kit";

import { SearchBox, extensionOptions, formatDelay, formatFileSize, looksLikeFolder, matchesSearch } from "./common";
import { L } from "./tracks/MeasurePane";

export interface ChaptersPageProps {
  hidden: boolean;
  chapterFiles: ExternalFile[];
  videoFiles: VideoFile[];
  onChapterFilesChange: (files: ExternalFile[]) => void;
  preset?: Preset | null;
  muxSettings: MuxSettings;
  onMuxSettingsChange: (settings: Partial<MuxSettings>) => void;
}

export function ChaptersPage({ hidden, chapterFiles, videoFiles, onChapterFilesChange, preset, muxSettings, onMuxSettingsChange }: ChaptersPageProps) {
  const shell = useShell();
  const { chapterTabState, updateChapterTabState } = useTabState((state) => ({
    chapterTabState: state.chapterTabState,
    updateChapterTabState: state.updateChapterTabState,
  }));
  const [search, setSearch] = useState("");
  const [selectedChapterIndex, setSelectedChapterIndex] = useState<number | null>(null);
  /** The selected file's details (a double-click on its row). */
  const [detailsOpen, setDetailsOpen] = useState(false);
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

  const status = useStatus("chapters", lcdStatus(lcd));
  // One switch, shown here and in Mux › Options: the mux settings hold it.
  const discard = muxSettings.discardOldChapters;
  const setDiscard = (enabled: boolean) => {
    updateChapterTabState({ discardOldChapters: enabled });
    onMuxSettingsChange({ discardOldChapters: enabled });
  };

  return (
    <PageView
      hidden={hidden}
      status={status}
      dock={<PageDock common={shell.dock} />}
      tools={
        <>
          <Cmd icon={<ArrowSyncRegular />} title="Rescan" disabled={!chaptersEnabled || !sourceFolder} onClick={() => void scanChapters(sourceFolder)} />
          <Cmd icon={<ChevronDoubleUpRegular />} title={reorderHelp ?? "Move to the top"} disabled={!canUp} onClick={() => reorderChapterFile(sel!, 0)} />
          <Cmd icon={<ChevronUpRegular />} title={reorderHelp ?? "Move up (Alt+↑)"} disabled={!canUp} onClick={() => reorderChapterFile(sel!, sel! - 1)} />
          <Cmd icon={<ChevronDownRegular />} title={reorderHelp ?? "Move down (Alt+↓)"} disabled={!canDown} onClick={() => reorderChapterFile(sel!, sel! + 1)} />
          <Cmd icon={<ChevronDoubleDownRegular />} title={reorderHelp ?? "Move to the bottom"} disabled={!canDown} onClick={() => reorderChapterFile(sel!, chapterFiles.length - 1)} />
        </>
      }
    >
      <Panel
        label="Chapters"
        left={
          <span className="crumb">
            Chapters
            {chapterFiles.length > 0 && <span className="t3">{chapterFiles.length} file{chapterFiles.length === 1 ? "" : "s"} · {linked} linked</span>}
          </span>
        }
        end={chapterFiles.length > 0 && <SearchBox value={search} onChange={setSearch} label="Search chapters" w={150} />}
        sheet={
          <>
            <SheetField label="Folder" wide>
              <span className="row" style={{ gap: 4, minWidth: 0 }}>
                <TBox label="Folder" className="grow" style={{ minWidth: 0 }} value={sourceFolder} readOnly placeholder="Choose a folder, or drop one on the window" title={sourceFolder || undefined} />
                <Cmd icon={<FolderOpenRegular />} title="Choose folder (Ctrl+O)" disabled={!chaptersEnabled} onClick={() => void chooseFolder()} />
              </span>
            </SheetField>
            <span className="checks span2">
              <label className="ck"><Toggle name="Add chapters from the files" on={chaptersEnabled} onChange={setEnabled} />Add chapters from the files</label>
              <Chk on={discard} disabled={!chaptersEnabled} onChange={setDiscard}>Discard the videos' own</Chk>
            </span>
            <SheetField label="Formats">
              <Combo<string> label="Formats to scan" value={extension} options={extensionOptions(CHAPTER_EXTENSIONS)} w="100%" disabled={!chaptersEnabled} onChange={(value) => updateChapterTabState({ extension: value })} />
            </SheetField>
            <SheetField label="Delay for all" wide>
              <span className="row" style={{ gap: 8 }}>
                <TBox
                  label="Delay for every file"
                  className={cx(!delayOk && "invalid")}
                  w={130}
                  mono
                  unit="s"
                  value={chapterDelay}
                  disabled={!chaptersEnabled}
                  title={parseDelayInput(chapterDelay).error}
                  aria-invalid={!delayOk}
                  onChange={(value) => updateChapterTabState({ delay: value })}
                />
                <Btn disabled={!chaptersEnabled || chapterFiles.length === 0 || !delayInputsAreValid(chapterDelay)} onClick={applyDelayToAll}>Apply to every file</Btn>
              </span>
            </SheetField>
          </>
        }
      >
        {chaptersEnabled && chapterFiles.length > 0 ? (
          <Table cols="24px minmax(0,1fr) minmax(0,1fr) 64px 72px 88px" head={["#", "Chapter file", "Video", " Size", " Delay", "Linked"]} label="Chapters" bodyRef={bodyRef}>
            {visibleChapters.map(({ file, index }) => {
              const dragProps = drag.rowProps(index);
              return (
                <Tr
                  key={file.id}
                  on={sel === index}
                  className={dragProps.className}
                  onPointerDown={dragProps.onPointerDown}
                  onClick={() => selectChapterIndex(index)}
                  onDoubleClick={() => {
                    selectChapterIndex(index);
                    setDetailsOpen(true);
                  }}
                  label={file.name}
                >
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
                  <span className="r num t2" style={{ display: "flex" }}>{file.size ? formatFileSize(file.size) : "—"}</span>
                  <span className="r num t2" style={{ display: "flex" }}>{formatDelay(file.delay)}</span>
                  <span className={file.isManuallyLinked ? "" : "t3"}>{file.isManuallyLinked ? "By hand" : "By order"}</span>
                </Tr>
              );
            })}
          </Table>
        ) : chaptersEnabled ? (
          <Empty icon={<BookmarkMultipleRegular />} title="Drop a folder of chapter files">
            <Btn icon={<FolderOpenRegular />} onClick={() => void chooseFolder()}>Choose folder</Btn>
          </Empty>
        ) : (
          <Empty icon={<BookmarkMultipleRegular />} title="Chapters are off">
            <Btn onClick={() => setEnabled(true)}>Turn on chapters</Btn>
          </Empty>
        )}
      </Panel>
      {detailsOpen && chaptersEnabled && selected && sel !== null && (
        <ChapterDetails
          key={selected.id}
          file={selected}
          index={sel}
          videoFiles={videoFiles}
          onClose={() => setDetailsOpen(false)}
          onChange={(next) => onChapterFilesChange(chapterFiles.map((f, i) => (i === sel ? next : f)))}
          onApplyToAll={(delay) => onChapterFilesChange(chapterFiles.map((f) => ({ ...f, delay })))}
          onUnlink={() => unlinkChapter(sel)}
        />
      )}
    </PageView>
  );
}

/** A chapter file's details, from a double-click on its row: its video,
 *  and its delay (the old "Edit Chapter Delay" dialog). The delay commits on
 *  Enter, on leaving the box, and on Close. */
function ChapterDetails({
  file,
  index,
  videoFiles,
  onClose,
  onChange,
  onApplyToAll,
  onUnlink,
}: {
  file: ExternalFile;
  index: number;
  videoFiles: VideoFile[];
  onClose: () => void;
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
    <Dialog
      size="mid"
      title={file.name}
      onClose={() => {
        commit();
        onClose();
      }}
      foot={
        <Btn
          accent
          onClick={() => {
            commit();
            onClose();
          }}
        >
          Close
        </Btn>
      }
    >
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
    </Dialog>
  );
}
