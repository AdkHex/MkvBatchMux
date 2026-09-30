/** Attachments: files (fonts, cover art) added to every queued video. The
 *  logic is the old Attachments tab's. */

import { AddRegular, ArrowSyncRegular, AttachRegular, DeleteRegular, DocumentRegular, FolderOpenRegular, ImageRegular, TextFontRegular } from "@fluentui/react-icons";
import { useEffect, useMemo, useRef, useState } from "react";

import { PageDock } from "@/app/dock";
import { useShell, usePageCommands, useStatus } from "@/app/shell";
import { useTabState } from "@/features/workspace/store/useTabState";
import { pickDirectory, pickFiles, scanMedia } from "@/shared/lib/backend";
import { ATTACHMENT_EXTENSIONS } from "@/shared/lib/extensions";
import type { ExternalFile, MuxSettings, Preset } from "@/shared/types";
import { PageView, Panel, lcdStatus, type LcdProps } from "@/ui/frame";
import { Btn, Chk, Cmd, Combo, Empty, MidText, SheetField, TBox, Table, Toggle, Tr } from "@/ui/kit";
import { toast } from "@/ui/toast";

import { SORT_OPTIONS, SearchBox, extensionOf, extensionOptions, formatFileSize, looksLikeFolder, matchesSearch, parentFolder, type SortValue } from "./common";

export interface AttachmentsPageProps {
  hidden: boolean;
  attachmentFiles: ExternalFile[];
  onAttachmentFilesChange: (files: ExternalFile[]) => void;
  preset?: Preset | null;
  muxSettings: MuxSettings;
  onMuxSettingsChange: (settings: Partial<MuxSettings>) => void;
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

export function AttachmentsPage({ hidden, attachmentFiles, onAttachmentFilesChange, preset, muxSettings, onMuxSettingsChange }: AttachmentsPageProps) {
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

  const { attachmentsEnabled, sourceFolder, extension, allowDuplicate, expertMode } = attachmentTabState;

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

  const bytes = attachmentFiles.reduce((sum, file) => sum + (file.size || 0), 0);
  const lcd: LcdProps = !attachmentsEnabled
    ? { l1: "Attachments are off", l2: "The videos keep the attachments they have" }
    : attachmentFiles.length === 0
      ? { l1: "Drop fonts or a folder of attachments" }
      : { l1: `${attachmentFiles.length} attachment${attachmentFiles.length === 1 ? "" : "s"} · ${formatFileSize(bytes)}`, l2: "Added to every queued video" };

  const status = useStatus("attachments", lcdStatus(lcd));
  // One switch, shown here and in Mux › Options: the mux settings hold it.
  const discard = muxSettings.discardOldAttachments;
  const setDiscard = (enabled: boolean) => {
    updateAttachmentTabState({ discardOld: enabled });
    onMuxSettingsChange({ discardOldAttachments: enabled });
  };

  return (
    <PageView
      hidden={hidden}
      status={status}
      dock={<PageDock common={shell.dock} />}
      tools={
        <>
          <Cmd icon={<AddRegular />} disabled={!attachmentsEnabled} onClick={() => void handleAddFiles()}>Add files</Cmd>
          <Cmd icon={<ArrowSyncRegular />} title="Rescan" disabled={!attachmentsEnabled || !sourceFolder} onClick={() => void scanAttachments(sourceFolder)} />
          <Cmd icon={<DeleteRegular />} title="Remove (Del)" disabled={!attachmentsEnabled || selectedIndex === null} onClick={handleRemove} />
        </>
      }
    >
      <Panel
        label="Attachments"
        left={
          <span className="crumb">
            Attachments
            {attachmentFiles.length > 0 && <span className="t3">{attachmentFiles.length} file{attachmentFiles.length === 1 ? "" : "s"} · {formatFileSize(bytes)}</span>}
          </span>
        }
        end={attachmentFiles.length > 0 && <SearchBox value={search} onChange={setSearch} label="Search attachments" w={150} />}
        sheet={
          <>
            <SheetField label="Folder" wide>
              <span className="row" style={{ gap: 4, minWidth: 0 }}>
                <TBox label="Folder" className="grow" style={{ minWidth: 0 }} value={sourceFolder} readOnly placeholder="Choose a folder, or drop one on the window" title={sourceFolder || undefined} />
                <Cmd icon={<FolderOpenRegular />} title="Choose folder (Ctrl+O)" disabled={!attachmentsEnabled} onClick={() => void chooseFolder()} />
              </span>
            </SheetField>
            <span className="checks span2">
              <label className="ck"><Toggle name="Add to every queued video" on={attachmentsEnabled} onChange={setEnabled} />Add to every queued video</label>
              <Chk on={discard} disabled={!attachmentsEnabled} onChange={setDiscard}>Discard the videos' own</Chk>
            </span>
            <SheetField label="Formats">
              <Combo<string> label="Formats to scan" value={extension} options={extensionOptions(ATTACHMENT_EXTENSIONS)} w="100%" disabled={!attachmentsEnabled} onChange={(value) => updateAttachmentTabState({ extension: value })} />
            </SheetField>
            <SheetField label="Order">
              <Combo<SortValue> label="Sort" value={sort} options={SORT_OPTIONS} w="100%" onChange={setSort} />
            </SheetField>
            <span className="checks span2">
              <Chk
                on={allowDuplicate}
                disabled={!attachmentsEnabled}
                onChange={(enabled) => {
                  updateAttachmentTabState({ allowDuplicate: enabled });
                  onMuxSettingsChange({ allowDuplicateAttachments: enabled });
                }}
              >
                Allow duplicate names
              </Chk>
              <Chk
                on={expertMode}
                disabled={!attachmentsEnabled}
                onChange={(enabled) => {
                  updateAttachmentTabState({ expertMode: enabled });
                  onMuxSettingsChange({ attachmentsExpertMode: enabled });
                }}
              >
                Expert mode
              </Chk>
            </span>
          </>
        }
      >
        {attachmentsEnabled && attachmentFiles.length > 0 ? (
          <Table cols="24px minmax(0,1fr) 120px 80px minmax(0,1fr)" head={["#", "Name", "Type", " Size", "Folder"]} label="Attachments">
            {visibleAttachments.map(({ file, index }) => (
              <Tr key={file.id} on={selectedIndex === index} onClick={() => selectAttachmentIndex(index)} label={file.name}>
                <span className="num t3">{index + 1}</span>
                <span className="cell"><span className="fi" aria-hidden>{iconFor(file.name)}</span><MidText text={file.name} tail={30} /></span>
                <span className="t2 truncate">{kindOf(file.name)}</span>
                <span className="r num t2" style={{ display: "flex" }}>{file.size ? formatFileSize(file.size) : "—"}</span>
                <span className="t3 truncate" title={parentFolder(file.path)}>{parentFolder(file.path) || "—"}</span>
              </Tr>
            ))}
          </Table>
        ) : attachmentsEnabled ? (
          <Empty icon={<AttachRegular />} title="Drop fonts or a folder of attachments">
            <Btn icon={<AddRegular />} onClick={() => void handleAddFiles()}>Add files</Btn>
            <Btn icon={<FolderOpenRegular />} onClick={() => void chooseFolder()}>Choose folder</Btn>
          </Empty>
        ) : (
          <Empty icon={<AttachRegular />} title="Attachments are off">
            <Btn onClick={() => setEnabled(true)}>Turn on attachments</Btn>
          </Empty>
        )}
      </Panel>
    </PageView>
  );
}
