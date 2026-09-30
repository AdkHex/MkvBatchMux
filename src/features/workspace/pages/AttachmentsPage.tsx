/** Attachments: files (fonts, cover art) added to every queued video. The
 *  logic is the old Attachments tab's. */

import { AddRegular, ArrowSyncRegular, AttachRegular, DeleteRegular, DocumentRegular, FolderOpenRegular, ImageRegular, TextFontRegular } from "@fluentui/react-icons";
import { useEffect, useMemo, useRef, useState } from "react";

import type { QueueAction } from "@/app/Index";
import { PageDock } from "@/app/dock";
import { useShell, usePageCommands } from "@/app/shell";
import { useTabState } from "@/features/workspace/store/useTabState";
import { pickDirectory, pickFiles, scanMedia } from "@/shared/lib/backend";
import { ATTACHMENT_EXTENSIONS } from "@/shared/lib/extensions";
import type { ExternalFile, MuxSettings, Preset } from "@/shared/types";
import { Box, PageView, type LcdProps } from "@/ui/frame";
import { Btn, Cmd, Combo, DL, Empty, Links, MidText, TRow, Table, Toggle, Tr } from "@/ui/kit";
import { toast } from "@/ui/toast";

import { QueueBtn, SORT_OPTIONS, SearchBox, extensionOf, extensionOptions, formatFileSize, looksLikeFolder, matchesSearch, parentFolder, type SortValue } from "./common";
import { L } from "./tracks/MeasurePane";

export interface AttachmentsPageProps {
  hidden: boolean;
  attachmentFiles: ExternalFile[];
  onAttachmentFilesChange: (files: ExternalFile[]) => void;
  preset?: Preset | null;
  onMuxSettingsChange: (settings: Partial<MuxSettings>) => void;
  queue: QueueAction;
}

const FONT = new Set(["ttf", "otf", "ttc", "woff", "woff2"]);
const IMAGE = new Set(["jpg", "jpeg", "png", "webp", "gif", "bmp"]);
const iconFor = (name: string) => {
  const ext = extensionOf(name);
  return FONT.has(ext) ? <TextFontRegular /> : IMAGE.has(ext) ? <ImageRegular /> : <DocumentRegular />;
};
const kindOf = (name: string) => {
  const ext = extensionOf(name);
  if (ext === "otf") return "OpenType font";
  if (FONT.has(ext)) return "Font";
  if (IMAGE.has(ext)) return "Image";
  return ext ? ext.toUpperCase() : "File";
};

export function AttachmentsPage({ hidden, attachmentFiles, onAttachmentFilesChange, preset, onMuxSettingsChange, queue }: AttachmentsPageProps) {
  const shell = useShell();
  const { attachmentTabState, updateAttachmentTabState } = useTabState((state) => ({
    attachmentTabState: state.attachmentTabState,
    updateAttachmentTabState: state.updateAttachmentTabState,
  }));
  const [search, setSearch] = useState("");
  const [sort, setSort] = useState<SortValue>("loaded");
  const [selectedIndex, setSelectedIndex] = useState<number | null>(null);
  /** The highlight follows the file, not the row number, so a rescan cannot
   *  leave Remove pointed at a different attachment. */
  const selectedAttachmentIdRef = useRef<string | null>(null);
  const selectAttachmentIndex = (index: number | null) => {
    selectedAttachmentIdRef.current = index === null ? null : (attachmentFiles[index]?.id ?? null);
    setSelectedIndex(index);
  };
  useEffect(() => {
    const selectedId = selectedAttachmentIdRef.current;
    if (selectedId === null) return;
    const nextIndex = attachmentFiles.findIndex((file) => file.id === selectedId);
    if (nextIndex < 0) selectedAttachmentIdRef.current = null;
    setSelectedIndex(nextIndex >= 0 ? nextIndex : null);
  }, [attachmentFiles]);

  // Keyed on the folder value, not the preset object, so saving an unrelated
  // option does not discard a folder the user just typed.
  const appliedPresetFolderRef = useRef<string | null>(null);
  useEffect(() => {
    if (!preset) return;
    const presetFolder = preset.Default_Attachment_Directory || "";
    if (appliedPresetFolderRef.current === presetFolder) return;
    appliedPresetFolderRef.current = presetFolder;
    updateAttachmentTabState({ sourceFolder: presetFolder });
  }, [preset, updateAttachmentTabState]);

  const { attachmentsEnabled, sourceFolder, extension, allowDuplicate, discardOld, expertMode } = attachmentTabState;

  const visibleAttachments = useMemo(
    () =>
      attachmentFiles
        .map((file, index) => ({ file, index }))
        .filter(({ file }) => matchesSearch(file, search))
        .sort((a, b) => {
          if (sort === "name-asc") return a.file.name.localeCompare(b.file.name);
          if (sort === "name-desc") return b.file.name.localeCompare(a.file.name);
          if (sort === "size-desc") return (b.file.size || 0) - (a.file.size || 0);
          return a.index - b.index;
        }),
    [attachmentFiles, search, sort],
  );

  /** Identifies the newest scan, so stale replies can be dropped. */
  const scanRequestRef = useRef(0);
  const scanAttachments = async (folderPath: string) => {
    // Only the newest scan may publish: a slower reply for a folder the user
    // has moved on from would otherwise overwrite the current listing.
    const requestId = ++scanRequestRef.current;
    if (!folderPath) {
      onAttachmentFilesChange([]);
      return;
    }
    try {
      const results = await scanMedia({ folder: folderPath, extensions: extension === "all" ? [] : [extension], recursive: false, type: "attachment", include_tracks: false });
      if (requestId !== scanRequestRef.current) return;
      const normalized = ((results as ExternalFile[]) || []).map((file) => ({ ...file, type: "attachment" as const, matchedVideoId: undefined }));
      onAttachmentFilesChange(normalized);
      shell.log(`Attachments: ${normalized.length} file${normalized.length === 1 ? "" : "s"} from ${folderPath}`);
    } catch (error) {
      if (requestId !== scanRequestRef.current) return;
      // Leaving the previous folder's listing on screen with no explanation
      // reads as "this folder has those files in it".
      onAttachmentFilesChange([]);
      toast({ title: "Could not scan attachments", description: String(error), variant: "destructive" });
    }
  };

  const addPaths = (paths: string[]) => {
    const newFiles = paths.map((path, index) => ({ id: `attachment-${Date.now()}-${index}`, name: path.split(/[\\/]/).pop() || path, path, type: "attachment" as const }));
    onAttachmentFilesChange([...attachmentFiles, ...newFiles]);
  };

  const handleAddFiles = async () => {
    const filters = extension === "all" ? undefined : [{ name: extension.toUpperCase(), extensions: [extension] }];
    const files = await pickFiles(filters);
    if (files.length) addPaths(files);
  };

  const handleRemove = () => {
    if (selectedIndex === null) return;
    onAttachmentFilesChange(attachmentFiles.filter((_, i) => i !== selectedIndex));
    selectAttachmentIndex(null);
  };

  const setEnabled = (enabled: boolean) => {
    updateAttachmentTabState({ attachmentsEnabled: enabled });
    if (!enabled) onAttachmentFilesChange([]);
  };

  const chooseFolder = async () => {
    const folder = await pickDirectory();
    if (folder) {
      updateAttachmentTabState({ sourceFolder: folder });
      void scanAttachments(folder);
    }
  };

  usePageCommands("attachments", {
    chooseFolder: attachmentsEnabled ? () => void chooseFolder() : undefined,
    addFiles: attachmentsEnabled ? () => void handleAddFiles() : undefined,
    removeSelected: attachmentsEnabled && selectedIndex !== null ? handleRemove : undefined,
    clear: attachmentFiles.length
      ? () => {
          updateAttachmentTabState({ sourceFolder: "" });
          onAttachmentFilesChange([]);
        }
      : undefined,
    drop: (paths) => {
      // Dropping attachments is asking for them: turn attachments on.
      if (!attachmentsEnabled) updateAttachmentTabState({ attachmentsEnabled: true });
      const folder = paths.find(looksLikeFolder);
      if (folder) {
        updateAttachmentTabState({ sourceFolder: folder });
        void scanAttachments(folder);
      } else addPaths(paths);
    },
  });

  const selected = selectedIndex !== null ? attachmentFiles[selectedIndex] : undefined;
  const bytes = attachmentFiles.reduce((sum, file) => sum + (file.size || 0), 0);
  const lcd: LcdProps = !attachmentsEnabled
    ? { l1: "Attachments are off", l2: "The videos keep the attachments they have" }
    : attachmentFiles.length === 0
      ? { l1: "Drop fonts or a folder of attachments" }
      : { l1: `${attachmentFiles.length} attachment${attachmentFiles.length === 1 ? "" : "s"} · ${formatFileSize(bytes)}`, l2: "Added to every queued video" };

  return (
    <PageView
      hidden={hidden}
      lcd={lcd}
      dock={<PageDock common={shell.dock} />}
      tools={
        <>
          <Cmd icon={<AddRegular />} disabled={!attachmentsEnabled} onClick={() => void handleAddFiles()}>Add files</Cmd>
          <Cmd icon={<FolderOpenRegular />} title="Choose folder" disabled={!attachmentsEnabled} onClick={() => void chooseFolder()} />
          <Cmd icon={<ArrowSyncRegular />} title="Rescan" disabled={!attachmentsEnabled || !sourceFolder} onClick={() => void scanAttachments(sourceFolder)} />
          <Cmd icon={<DeleteRegular />} title="Remove (Del)" disabled={!attachmentsEnabled || selectedIndex === null} onClick={handleRemove} />
        </>
      }
      primary={<QueueBtn queue={queue} />}
    >
      {attachmentsEnabled && attachmentFiles.length > 0 ? (
        <Box
          body={false}
          title="Attachments"
          sub={sourceFolder ? <span title={sourceFolder}>{sourceFolder}</span> : undefined}
          end={
            <>
              <Combo<string> ghost sm w={104} label="Formats to scan" value={extension} options={extensionOptions(ATTACHMENT_EXTENSIONS)} onChange={(value) => updateAttachmentTabState({ extension: value })} />
              <Combo<SortValue> ghost sm w={116} label="Sort" value={sort} options={SORT_OPTIONS} onChange={setSort} />
              <SearchBox value={search} onChange={setSearch} label="Search attachments" w={150} />
            </>
          }
        >
          <Table cols="24px minmax(0,1fr) 72px 80px" head={["#", "Name", "Type", " Size"]} label="Attachments">
            {visibleAttachments.map(({ file, index }) => (
              <Tr key={file.id} on={selectedIndex === index} onClick={() => selectAttachmentIndex(index)} label={file.name}>
                <span className="num t3">{index + 1}</span>
                <span className="cell"><span className="fi" aria-hidden>{iconFor(file.name)}</span><MidText text={file.name} /></span>
                <span className="t2">{extensionOf(file.name).toUpperCase() || "—"}</span>
                <span className="r num t2" style={{ display: "flex" }}>{file.size ? formatFileSize(file.size) : "—"}</span>
              </Tr>
            ))}
          </Table>
        </Box>
      ) : (
        <section className="box">
          {attachmentsEnabled ? (
            <Empty icon={<AttachRegular />} title="Drop fonts or a folder of attachments">
              <Btn icon={<AddRegular />} onClick={() => void handleAddFiles()}>Add files</Btn>
              <Btn icon={<FolderOpenRegular />} onClick={() => void chooseFolder()}>Choose folder</Btn>
            </Empty>
          ) : (
            <Empty icon={<AttachRegular />} title="Attachments are off">
              <Btn onClick={() => setEnabled(true)}>Turn on attachments</Btn>
            </Empty>
          )}
        </section>
      )}
      <div className="stack">
        <Box title="Attachments">
          <TRow label="Add attachments" d="To every queued video"><Toggle name="Add attachments" on={attachmentsEnabled} onChange={setEnabled} /></TRow>
          <TRow label="Discard the videos' own attachments">
            <Toggle
              name="Discard the videos' own attachments"
              on={discardOld}
              disabled={!attachmentsEnabled}
              onChange={(enabled) => {
                updateAttachmentTabState({ discardOld: enabled });
                onMuxSettingsChange({ discardOldAttachments: enabled });
              }}
            />
          </TRow>
          <TRow label="Allow duplicate names">
            <Toggle
              name="Allow duplicate names"
              on={allowDuplicate}
              disabled={!attachmentsEnabled}
              onChange={(enabled) => {
                updateAttachmentTabState({ allowDuplicate: enabled });
                onMuxSettingsChange({ allowDuplicateAttachments: enabled });
              }}
            />
          </TRow>
          <TRow label="Expert mode">
            <Toggle
              name="Expert mode"
              on={expertMode}
              disabled={!attachmentsEnabled}
              onChange={(enabled) => {
                updateAttachmentTabState({ expertMode: enabled });
                onMuxSettingsChange({ attachmentsExpertMode: enabled });
              }}
            />
          </TRow>
        </Box>
        {attachmentsEnabled && selected && (
          <Box title={<MidText text={selected.name} tail={20} />}>
            <DL
              rows={[
                ["Type", kindOf(selected.name)],
                ["Size", selected.size ? formatFileSize(selected.size) : "—"],
                ["Folder", <span key="f" className="truncate" title={parentFolder(selected.path)}>{parentFolder(selected.path) || "—"}</span>],
              ]}
            />
            <Links><L icon={<DeleteRegular />} onClick={handleRemove}>Remove</L></Links>
          </Box>
        )}
      </div>
    </PageView>
  );
}
