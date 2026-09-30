/** Edit tracks: one video's own tracks (keep, flags, names, languages,
 *  order) and the files added to it alone — an audio or subtitle file, or
 *  streams imported from another loaded video. The rules are the old dialog's:
 *  a dropped track is marked "remove", a changed one "modify", and the
 *  original name, language and flags are kept so the report can show them. */

import { AddRegular, ArrowDownRegular, ArrowImportRegular, ArrowUpRegular, CheckmarkRegular, DeleteRegular } from "@fluentui/react-icons";
import { useEffect, useState } from "react";

import { moveTrackRow } from "@/features/workspace/lib/modifyTracks";
import { DelayField, delayInputsAreValid } from "@/shared/components/DelayField";
import { CODE_TO_LABEL } from "@/shared/data/languages-iso6393";
import { pickFiles } from "@/shared/lib/backend";
import { delaySecondsOrZero } from "@/shared/lib/delayInput";
import { AUDIO_EXTENSIONS, SUBTITLE_EXTENSIONS } from "@/shared/lib/extensions";
import type { ExternalFile, Track, VideoFile } from "@/shared/types";
import { Dialog, DialogTabs } from "@/ui/frame";
import { Btn, Chk, Cmd, Combo, Fld, LangCombo, TBox, TRow, Toggle } from "@/ui/kit";

import { ImportTrackEditButton, ImportTrackEditDialog, type ImportTrackOverride } from "./ImportTrackEditDialog";
import { TrackRowsTable, type TrackFlag } from "./TrackRowsTable";

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
    config: { trackName: string; language: string; delay: number; isDefault: boolean; isForced: boolean; muxAfter: string },
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
  bitrate?: number;
  external?: boolean;
}

const TABS: { id: TrackTab; label: string; type: Track["type"] }[] = [
  { id: "videos", label: "Videos", type: "video" },
  { id: "subtitles", label: "Subtitles", type: "subtitle" },
  { id: "audios", label: "Audio", type: "audio" },
];

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
      bitrate: t.bitrate,
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
    external: true,
  }));

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
  const [addExternalOpen, setAddExternalOpen] = useState(false);
  const [pendingExternalPaths, setPendingExternalPaths] = useState<string[]>([]);
  const [addExternalType, setAddExternalType] = useState<"audio" | "subtitle" | null>(null);
  const [addExternalForm, setAddExternalForm] = useState({ trackName: "", language: "und", delay: "0.000", isDefault: false, isForced: false, muxAfter: "audio" });
  const [importStreamsOpen, setImportStreamsOpen] = useState(false);
  const [importSourceVideoId, setImportSourceVideoId] = useState("");
  const [importSelectedTrackIds, setImportSelectedTrackIds] = useState<number[]>([]);
  // Per-stream language, name and delay for an import, keyed by track id.
  const [importOverrides, setImportOverrides] = useState<Record<number, ImportTrackOverride>>({});
  const [importEditingId, setImportEditingId] = useState<number | null>(null);

  const load = () => {
    if (!videoFile) return;
    const fileTracks = videoFile.tracks || [];
    const externalAudio = (externalAudioFiles || []).filter((file) => file.matchedVideoId === videoFile.id);
    const externalSubtitle = (externalSubtitleFiles || []).filter((file) => file.matchedVideoId === videoFile.id);
    setVideoTracks(toTrackRows(fileTracks, "video"));
    setSubtitleTracks([...toTrackRows(fileTracks, "subtitle"), ...toExternalRows(externalSubtitle)]);
    setAudioTracks([...toTrackRows(fileTracks, "audio"), ...toExternalRows(externalAudio)]);
  };

  useEffect(() => {
    if (videoFile && open) load();
    // Re-read whenever the video or its added files change while open.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [videoFile, open, externalAudioFiles, externalSubtitleFiles]);

  useEffect(() => {
    if (!open) {
      setAddExternalOpen(false);
      setPendingExternalPaths([]);
      setAddExternalType(null);
      setImportStreamsOpen(false);
      setImportSourceVideoId("");
      setImportSelectedTrackIds([]);
      setImportOverrides({});
      setImportEditingId(null);
    }
  }, [open]);

  const currentTracks = activeTab === "videos" ? videoTracks : activeTab === "subtitles" ? subtitleTracks : audioTracks;
  const setCurrentTracks = activeTab === "videos" ? setVideoTracks : activeTab === "subtitles" ? setSubtitleTracks : setAudioTracks;
  const importableSourceVideos = (allVideoFiles && allVideoFiles.length > 0 ? allVideoFiles : videoFile ? [videoFile] : []).filter((file) => file.id !== videoFile?.id);
  const selectedImportSource = importableSourceVideos.find((file) => file.id === importSourceVideoId) || null;
  const importStreamType: Track["type"] | null = activeTab === "audios" ? "audio" : activeTab === "subtitles" ? "subtitle" : null;
  const importableTracks =
    importStreamType && selectedImportSource ? (selectedImportSource.tracks || []).filter((track) => track.type === importStreamType && track.action !== "remove") : [];
  const selectedIndex = currentTracks.findIndex((t) => t.id === selectedTrackId);

  const handleTrackChange = (trackId: string, field: TrackFlag | "trackName" | "language", value: boolean | string) => {
    setCurrentTracks((prev) =>
      prev.map((t) => {
        if (t.id !== trackId) return t;
        if (field === "copyTrack" && value === false) return { ...t, copyTrack: false, setDefault: false, setForced: false };
        return { ...t, [field]: value };
      }),
    );
  };

  const setAll = (field: TrackFlag, value: boolean) =>
    setCurrentTracks((prev) =>
      prev.map((track) =>
        field === "copyTrack"
          ? { ...track, copyTrack: value, setDefault: value ? track.setDefault : false, setForced: value ? track.setForced : false }
          : { ...track, copyTrack: value ? true : track.copyTrack, [field]: value },
      ),
    );

  const deleteTrack = (trackId: string) => {
    setCurrentTracks((prev) => prev.filter((t) => t.id !== trackId));
    if (selectedTrackId === trackId) setSelectedTrackId(null);
  };

  const moveTrack = (direction: "up" | "down") => {
    const idx = selectedIndex;
    if (idx < 0) return;
    if (direction === "up" && idx > 0) setCurrentTracks((prev) => moveTrackRow(prev, idx, idx - 1));
    else if (direction === "down" && idx < currentTracks.length - 1) setCurrentTracks((prev) => moveTrackRow(prev, idx, idx + 1));
  };

  const handleApplyChanges = () => {
    if (!videoFile) return;
    const rowsToTracks = (rows: TrackRow[]): Track[] =>
      rows
        .filter((row) => row.source === "internal" && row.originalTrack)
        .map((row) => {
          const original = row.originalTrack!;
          const originalName = original.originalName ?? original.name ?? original.codec ?? "";
          const originalLanguage = original.originalLanguage ?? original.language ?? "";
          const originalDefault = original.originalDefault !== undefined ? original.originalDefault : (original.isDefault ?? false);
          const originalForced = original.originalForced !== undefined ? original.originalForced : (original.isForced ?? false);
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
    const updatedTracks: Track[] = [...rowsToTracks(videoTracks), ...rowsToTracks(subtitleTracks), ...rowsToTracks(audioTracks)];
    if (onExternalFilesChange) {
      const external = (rows: TrackRow[]) =>
        rows
          .filter((row) => row.source === "external" && row.externalFile && row.copyTrack)
          .map((row) => ({ ...row.externalFile!, trackName: row.trackName, language: row.language, isDefault: row.setDefault, isForced: row.setForced, matchedVideoId: videoFile.id }));
      onExternalFilesChange(videoFile.id, "audio", external(audioTracks));
      onExternalFilesChange(videoFile.id, "subtitle", external(subtitleTracks));
    }
    onSave({ ...videoFile, tracks: updatedTracks });
    onOpenChange(false);
  };

  const openAddExternalDialog = async (type: "audio" | "subtitle") => {
    const filters = type === "subtitle" ? [{ name: "Subtitle Files", extensions: [...SUBTITLE_EXTENSIONS] }] : [{ name: "Audio Files", extensions: [...AUDIO_EXTENSIONS] }];
    const files = await pickFiles(filters);
    if (files.length === 0) return;
    setPendingExternalPaths(files);
    setAddExternalType(type);
    setAddExternalForm({ trackName: "", language: "und", delay: "0.000", isDefault: false, isForced: false, muxAfter: type === "subtitle" ? "audio" : "video" });
    setAddExternalOpen(true);
  };

  const handleConfirmAddExternal = () => {
    if (!videoFile || !addExternalType || !onAddExternalFiles) return;
    onAddExternalFiles(addExternalType, videoFile.id, pendingExternalPaths, {
      trackName: addExternalForm.trackName,
      language: addExternalForm.language || "und",
      delay: delaySecondsOrZero(addExternalForm.delay),
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
        // Each imported stream becomes its own ExternalFile, so overrides
        // belong at file level rather than in trackOverrides.
        const override = Number.isFinite(numericId) ? importOverrides[numericId] : undefined;
        const trackLabel = override?.trackName || track.name || track.codec || `${importStreamType === "audio" ? "Audio" : "Subtitle"} ${idx + 1}`;
        const language = override?.language || track.language || "und";
        const delay = override?.delay ?? 0;
        const externalFile: ExternalFile = {
          id: `import-${importStreamType}-${selectedImportSource.id}-${track.id}-${Date.now()}-${idx}`,
          name: selectedImportSource.name,
          path: selectedImportSource.path,
          type: importStreamType as ExternalFile["type"],
          source: "per-file",
          language,
          trackName: trackLabel,
          delay,
          // A hand-typed delay must not be overwritten by a later measurement
          // pass, which is exactly what "manual" means everywhere else.
          ...(delay !== 0 ? { delayProvenance: "manual" as const } : {}),
          isDefault: false,
          isForced: false,
          matchedVideoId: videoFile.id,
          tracks: [track],
          includedTrackIds: Number.isFinite(numericId) ? [numericId] : [],
        };
        return { id: externalFile.id, trackIndex: 0, copyTrack: true, setDefault: false, setForced: false, trackName: trackLabel, language, source: "external" as const, externalFile, external: true };
      });
    if (rows.length === 0) return;
    if (activeTab === "audios") setAudioTracks((prev) => [...prev, ...rows]);
    else if (activeTab === "subtitles") setSubtitleTracks((prev) => [...prev, ...rows]);
    setImportStreamsOpen(false);
    setImportSourceVideoId("");
    setImportSelectedTrackIds([]);
    // Consumed by the rows just created; leaving them would silently reapply
    // to the next import from a different source.
    setImportOverrides({});
  };

  if (!videoFile || !open) return null;
  const counts: Record<TrackTab, number> = { videos: videoTracks.length, subtitles: subtitleTracks.length, audios: audioTracks.length };
  const noun = activeTab === "audios" ? "audio" : "subtitle";
  const editingTrack = importEditingId !== null ? importableTracks.find((t) => Number(t.id) === importEditingId) : undefined;

  return (
    <>
      <Dialog
        size="xl"
        title="Edit tracks"
        sub={videoFile.name}
        onClose={() => onOpenChange(false)}
        left={<Btn onClick={load}>Reset</Btn>}
        bar={
          <DialogTabs<TrackTab>
            tabs={TABS.map((t) => ({ id: t.id, label: t.label, count: counts[t.id] }))}
            on={activeTab}
            onTab={setActiveTab}
            tools={
              <>
                {activeTab !== "videos" && onAddExternalFiles && (
                  <Cmd sm icon={<AddRegular />} onClick={() => void openAddExternalDialog(activeTab === "audios" ? "audio" : "subtitle")}>
                    {activeTab === "audios" ? "Add an audio file…" : "Add a subtitle file…"}
                  </Cmd>
                )}
                {activeTab !== "videos" && <Cmd sm icon={<ArrowImportRegular />} onClick={handleOpenImportStreams}>Import from a video…</Cmd>}
                {activeTab !== "videos" && <span className="vsep" />}
                <Cmd sm icon={<ArrowUpRegular />} title="Move up" disabled={selectedIndex <= 0} onClick={() => moveTrack("up")} />
                <Cmd sm icon={<ArrowDownRegular />} title="Move down" disabled={selectedIndex < 0 || selectedIndex >= currentTracks.length - 1} onClick={() => moveTrack("down")} />
              </>
            }
          />
        }
        foot={
          <>
            <Btn onClick={() => onOpenChange(false)}>Cancel</Btn>
            <Btn accent onClick={handleApplyChanges}>Apply</Btn>
          </>
        }
      >
        <TrackRowsTable
          rows={currentTracks}
          audio={activeTab === "audios"}
          label={`${TABS.find((t) => t.id === activeTab)!.label} tracks`}
          selectedId={selectedTrackId}
          onSelect={setSelectedTrackId}
          onChange={handleTrackChange}
          onSetAll={setAll}
          onDelete={deleteTrack}
          onMove={(from, to) => setCurrentTracks((prev) => moveTrackRow(prev, from, to))}
        />
      </Dialog>

      {addExternalOpen && addExternalType && (
        <Dialog
          size="mid"
          title={addExternalType === "audio" ? "Add an audio file" : "Add a subtitle file"}
          sub={pendingExternalPaths.length === 1 ? pendingExternalPaths[0] : `${pendingExternalPaths.length} files`}
          onClose={() => setAddExternalOpen(false)}
          foot={
            <>
              <Btn onClick={() => setAddExternalOpen(false)}>Cancel</Btn>
              <Btn accent disabled={!delayInputsAreValid(addExternalForm.delay)} onClick={handleConfirmAddExternal}>Add</Btn>
            </>
          }
        >
          <div className="fgrid">
            <Fld label="Language"><LangCombo value={addExternalForm.language} onChange={(language) => setAddExternalForm((prev) => ({ ...prev, language }))} w="100%" /></Fld>
            <Fld label="Track name"><TBox label="Track name" value={addExternalForm.trackName} placeholder="Optional" onChange={(trackName) => setAddExternalForm((prev) => ({ ...prev, trackName }))} /></Fld>
          </div>
          <DelayField value={addExternalForm.delay} onChange={(delay) => setAddExternalForm((prev) => ({ ...prev, delay }))} />
          <div className="col" style={{ gap: 4 }}>
            <TRow label="Default"><Toggle name="Default" on={addExternalForm.isDefault} onChange={(isDefault) => setAddExternalForm((prev) => ({ ...prev, isDefault }))} /></TRow>
            <TRow label="Forced"><Toggle name="Forced" on={addExternalForm.isForced} onChange={(isForced) => setAddExternalForm((prev) => ({ ...prev, isForced }))} /></TRow>
          </div>
        </Dialog>
      )}

      {importStreamsOpen && (
        <Dialog
          size="mid"
          title={activeTab === "audios" ? "Import audio from a video" : "Import subtitles from a video"}
          sub={`Into ${videoFile.name}`}
          onClose={() => {
            setImportStreamsOpen(false);
            setImportOverrides({});
          }}
          foot={
            <>
              <Btn
                onClick={() => {
                  setImportStreamsOpen(false);
                  setImportOverrides({});
                }}
              >
                Cancel
              </Btn>
              <Btn accent disabled={!selectedImportSource || importSelectedTrackIds.length === 0} onClick={handleConfirmImportStreams}>
                {importSelectedTrackIds.length ? `Import ${importSelectedTrackIds.length}` : "Import"}
              </Btn>
            </>
          }
        >
          <Fld label="From">
            <Combo<string>
              label="Source video"
              w="100%"
              value={importSourceVideoId || null}
              placeholder={importableSourceVideos.length ? "Choose a loaded video" : "No other loaded videos"}
              disabled={importableSourceVideos.length === 0}
              options={importableSourceVideos.map((file) => ({ value: file.id, label: file.name }))}
              onChange={(value) => {
                setImportSourceVideoId(value);
                setImportSelectedTrackIds([]);
                setImportOverrides({});
              }}
            />
          </Fld>
          <div className="frame">
            <div className="dtabs">
              <span className="tab on">{activeTab === "audios" ? "Audio streams" : "Subtitle streams"}</span>
              {importableTracks.length > 0 && (
                <span className="tools">
                  <Cmd sm icon={<CheckmarkRegular />} onClick={() => setImportSelectedTrackIds(importableTracks.map((t) => Number(t.id)).filter(Number.isFinite))}>All</Cmd>
                  <Cmd sm icon={<DeleteRegular />} onClick={() => setImportSelectedTrackIds([])}>None</Cmd>
                </span>
              )}
            </div>
            <div className="box-b" style={{ gap: 0, padding: "4px 12px 8px 16px" }}>
              {!selectedImportSource ? (
                <span className="t3" style={{ padding: "6px 0" }}>Choose a video to list its streams.</span>
              ) : importableTracks.length === 0 ? (
                <span className="t3" style={{ padding: "6px 0" }}>This video has no {noun} streams.</span>
              ) : (
                importableTracks.map((track, index) => {
                  const id = Number(track.id);
                  const override = importOverrides[id];
                  const edited = Boolean(override && (override.delay || override.language || override.trackName));
                  const lang = override?.language || track.language;
                  const label = [lang ? (CODE_TO_LABEL[lang] ?? lang) : null, track.codec, override?.trackName || track.name].filter(Boolean).join(" · ") || "Unnamed";
                  return (
                    <div key={`${track.id}-${index}`} className="trk">
                      <Chk
                        name={`Import stream ${index + 1}`}
                        on={importSelectedTrackIds.includes(id)}
                        onChange={(on) => setImportSelectedTrackIds((prev) => (on ? [...new Set([...prev, id])] : prev.filter((x) => x !== id)))}
                      />
                      <span className="num t3" style={{ width: 14 }}>{index + 1}</span>
                      <span className="grow truncate">{label}</span>
                      {edited && override?.delay ? <span className="num acc sm">{override.delay > 0 ? "+" : ""}{override.delay} s</span> : null}
                      <ImportTrackEditButton edited={edited} label={`Edit stream ${index + 1}`} onClick={() => setImportEditingId(id)} />
                    </div>
                  );
                })
              )}
            </div>
          </div>
        </Dialog>
      )}

      <ImportTrackEditDialog
        open={importEditingId !== null}
        onOpenChange={(value) => !value && setImportEditingId(null)}
        kind={noun}
        trackLabel={editingTrack ? [editingTrack.codec, editingTrack.name].filter(Boolean).join(" · ") : ""}
        value={importEditingId !== null ? (importOverrides[importEditingId] ?? {}) : {}}
        onSave={(next) => {
          if (importEditingId === null) return;
          setImportOverrides((prev) => ({ ...prev, [importEditingId]: next }));
          // Editing a stream implies wanting it, so select it too.
          setImportSelectedTrackIds((prev) => (prev.includes(importEditingId) ? prev : [...prev, importEditingId]));
        }}
      />
    </>
  );
}
