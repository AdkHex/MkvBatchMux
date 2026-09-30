/** The pieces Audio and Subtitles share: the strip of track slots, the
 *  slot's settings, and the dialogs for importing streams from a loaded video,
 *  setting per-track delays and deleting a slot. Each page keeps its own
 *  logic (the two differed in small ways before and still do); these only
 *  draw. */

import { AddRegular, ClosedCaptionRegular, CopyRegular, DeleteRegular, MusicNote2Regular } from "@fluentui/react-icons";
import { useState } from "react";

import { ImportTrackEditButton, ImportTrackEditDialog, type ImportTrackOverride } from "@/features/workspace/components/ImportTrackEditDialog";
import type { TrackConfig } from "@/features/workspace/store/useTabState";
import { delayInputsAreValid } from "@/shared/components/DelayField";
import { CODE_TO_LABEL } from "@/shared/data/languages-iso6393";
import { parseDelayInput } from "@/shared/lib/delayInput";
import type { ExternalFile, Track, VideoFile } from "@/shared/types";
import { Dialog } from "@/ui/frame";
import { Btn, Chk, Cmd, Combo, Fld, LangCombo, TBox, cx, type Option } from "@/ui/kit";

export type SlotKind = "audio" | "subtitle";

/** "Hindi", from "hin"; the code itself when it has no name. */
export const languageName = (code: string | undefined) => (code ? (CODE_TO_LABEL[code] ?? code) : "Undetermined");

const slotName = (kind: SlotKind) => (kind === "audio" ? "Audio" : "Subtitle");

/** The track slots, as tool modes under the toolbar: Audio 1 · Hindi,
 *  Audio 2 · English, then New track; Duplicate and Delete at the end. */
export function TrackStrip({
  kind,
  slots,
  active,
  configs,
  disabled,
  onPick,
  onNew,
  onDuplicate,
  onDelete,
}: {
  kind: SlotKind;
  slots: string[];
  active: string;
  configs: Record<string, TrackConfig>;
  disabled?: boolean;
  onPick: (slot: string) => void;
  onNew: () => void;
  onDuplicate: () => void;
  onDelete: () => void;
}) {
  const icon = kind === "audio" ? <MusicNote2Regular /> : <ClosedCaptionRegular />;
  return (
    <>
      <span className="row" role="tablist" aria-label={`${slotName(kind)} tracks`} style={{ gap: 2 }}>
        {slots.map((slot) => (
          <button
            key={slot}
            type="button"
            role="tab"
            aria-selected={slot === active}
            className={cx("tool", slot === active && "on")}
            disabled={disabled && slot !== active}
            onClick={() => onPick(slot)}
          >
            <span className="ic" aria-hidden>{icon}</span>
            {slotName(kind)} {slot}
            <span className="t3">· {languageName(configs[slot]?.language)}</span>
          </button>
        ))}
      </span>
      <button type="button" className="tool" disabled={disabled} onClick={onNew} title="New track (Ctrl+N)">
        <span className="ic" aria-hidden><AddRegular /></span>
        New track
      </button>
      <span className="end">
        <Cmd sm icon={<CopyRegular />} title={`Duplicate ${slotName(kind)} ${active}`} disabled={disabled} onClick={onDuplicate} />
        <Cmd sm icon={<DeleteRegular />} title={slots.length > 1 ? `Delete ${slotName(kind)} ${active}` : "The only track cannot be deleted"} disabled={disabled || slots.length <= 1} onClick={onDelete} />
      </span>
    </>
  );
}

/** What every file in a slot is muxed with. */
export function SlotSettings({
  kind,
  slot,
  config,
  onChange,
  muxAfterOptions,
  disabled,
}: {
  kind: SlotKind;
  slot: string;
  config: TrackConfig;
  onChange: (updates: Partial<TrackConfig>) => void;
  muxAfterOptions: Option<string>[];
  disabled?: boolean;
}) {
  const delay = parseDelayInput(config.delay);
  return (
    <section className="box" aria-label={`${slotName(kind)} ${slot} settings`}>
      <div className="box-h"><span className="tt truncate">{slotName(kind)} {slot}</span></div>
      <div className="box-b">
        <div className="fgrid">
          <Fld label="Language">
            <LangCombo value={config.language} onChange={(language) => onChange({ language })} w="100%" disabled={disabled} />
          </Fld>
          <Fld label="Delay">
            <TBox
              label="Delay in seconds"
              className={cx(!delay.valid && "invalid")}
              mono
              unit="s"
              value={config.delay}
              disabled={disabled}
              title={delay.error}
              aria-invalid={!delay.valid}
              onChange={(value) => onChange({ delay: value })}
            />
          </Fld>
          <Fld label="Track name">
            <TBox label="Track name" value={config.trackName} placeholder="Keep the file's name" disabled={disabled} onChange={(trackName) => onChange({ trackName })} />
          </Fld>
          <Fld label="Place after">
            <Combo<string> label="Place after" value={config.muxAfter} options={muxAfterOptions} w="100%" disabled={disabled} onChange={(muxAfter) => onChange({ muxAfter })} />
          </Fld>
        </div>
        <span className="row" style={{ gap: 20 }}>
          <Chk on={config.isDefault} disabled={disabled} onChange={(isDefault) => onChange({ isDefault })}>Default</Chk>
          {kind === "subtitle" && (
            <Chk on={config.isForced} disabled={disabled} onChange={(isForced) => onChange({ isForced })}>Forced</Chk>
          )}
        </span>
      </div>
    </section>
  );
}

const trackText = (track: Track, index: number, fallback: string) =>
  [track.language ? languageName(track.language) : null, track.codec, track.name].filter(Boolean).join(" · ") || `${fallback} ${index + 1}`;

/** Import streams from a loaded video into the selected row. */
export function ImportStreamsDialog({
  kind,
  videoFiles,
  sourceId,
  onSource,
  streams,
  selectedKeys,
  onSelectedKeys,
  overrides,
  onOverride,
  keyOf,
  targetLabel,
  onCancel,
  onImport,
}: {
  kind: SlotKind;
  videoFiles: VideoFile[];
  sourceId: string;
  onSource: (id: string) => void;
  streams: Track[];
  selectedKeys: string[];
  onSelectedKeys: (keys: string[]) => void;
  overrides: Record<string, ImportTrackOverride>;
  onOverride: (key: string, value: ImportTrackOverride) => void;
  keyOf: (index: number, id: string) => string;
  targetLabel: string;
  onCancel: () => void;
  onImport: () => void;
}) {
  const [editing, setEditing] = useState<string | null>(null);
  const noun = kind === "audio" ? "audio" : "subtitle";
  const editingIndex = editing ? Number(editing.split(":")[0]) : -1;
  const editingTrack = editingIndex >= 0 ? streams[editingIndex] : undefined;
  return (
    <>
      <Dialog
        size="mid"
        title={kind === "audio" ? "Import audio from a video" : "Import subtitles from a video"}
        sub={targetLabel}
        onClose={onCancel}
        foot={
          <>
            <Btn onClick={onCancel}>Cancel</Btn>
            <Btn accent disabled={!sourceId || selectedKeys.length === 0} onClick={onImport}>
              {selectedKeys.length ? `Import ${selectedKeys.length}` : "Import"}
            </Btn>
          </>
        }
      >
        <Fld label="From">
          <Combo<string>
            label="Source video"
            value={sourceId || null}
            placeholder="Choose a loaded video"
            options={videoFiles.map((file) => ({ value: file.id, label: file.name }))}
            w="100%"
            onChange={onSource}
          />
        </Fld>
        <div className="frame">
          <div className="dtabs"><span className="tab on">{kind === "audio" ? "Audio streams" : "Subtitle streams"}</span></div>
          <div className="box-b" style={{ gap: 0, padding: "4px 12px 8px 16px" }}>
            {streams.length === 0 ? (
              <span className="t3" style={{ padding: "6px 0" }}>This video has no {noun} streams.</span>
            ) : (
              streams.map((track, index) => {
                const key = keyOf(index, String(track.id));
                const override = overrides[key];
                const edited = Boolean(override && (override.delay || override.language || override.trackName));
                const label = trackText({ ...track, language: override?.language ?? track.language, name: override?.trackName ?? track.name }, index, kind === "audio" ? "Audio" : "Subtitle");
                return (
                  <div key={key} className="trk">
                    <Chk
                      name={`Import stream ${index + 1}`}
                      on={selectedKeys.includes(key)}
                      onChange={(on) => onSelectedKeys(on ? Array.from(new Set([...selectedKeys, key])) : selectedKeys.filter((k) => k !== key))}
                    />
                    <span className="num t3" style={{ width: 14 }}>{index + 1}</span>
                    <span className="grow truncate" title={label}>{label}</span>
                    {edited && override?.delay ? <span className="num acc sm">{override.delay > 0 ? "+" : ""}{override.delay} s</span> : null}
                    <ImportTrackEditButton edited={edited} label={`Edit stream ${index + 1}`} onClick={() => setEditing(key)} />
                  </div>
                );
              })
            )}
          </div>
        </div>
      </Dialog>
      <ImportTrackEditDialog
        open={editing !== null}
        onOpenChange={(open) => !open && setEditing(null)}
        kind={kind}
        trackLabel={editingTrack ? `${editingIndex + 1} · ${trackText(editingTrack, editingIndex, kind === "audio" ? "Audio" : "Subtitle")}` : ""}
        value={editing ? (overrides[editing] ?? {}) : {}}
        onSave={(next) => {
          if (!editing) return;
          onOverride(editing, next);
          // Editing a stream implies wanting it, so select it too.
          if (!selectedKeys.includes(editing)) onSelectedKeys([...selectedKeys, editing]);
        }}
      />
    </>
  );
}

/** Separate delays for each track of a file that holds several. */
export function TrackDelaysDialog({
  kind,
  file,
  values,
  onValues,
  bulk,
  onBulk,
  onCancel,
  onSave,
}: {
  kind: SlotKind;
  file: ExternalFile;
  values: Record<number, string>;
  onValues: (values: Record<number, string>) => void;
  bulk: string;
  onBulk: (value: string) => void;
  onCancel: () => void;
  onSave: () => void;
}) {
  const tracks = (file.tracks ?? []).filter((track) => track.type === kind);
  const bulkOk = parseDelayInput(bulk).valid;
  return (
    <Dialog
      size="mid"
      title={kind === "audio" ? "Audio track delays" : "Subtitle track delays"}
      sub={file.name}
      onClose={onCancel}
      foot={
        <>
          <Btn onClick={onCancel}>Cancel</Btn>
          <Btn accent disabled={!delayInputsAreValid(...Object.values(values))} onClick={onSave}>Save</Btn>
        </>
      }
    >
      <div className="row" style={{ gap: 8 }}>
        <TBox label="Delay for every track" className={cx(!bulkOk && "invalid")} mono unit="s" w={140} value={bulk} onChange={onBulk} aria-invalid={!bulkOk} />
        <Btn
          disabled={!bulkOk}
          onClick={() => {
            const next = { ...values };
            tracks.forEach((track) => {
              const id = Number(track.id);
              if (Number.isFinite(id)) next[id] = bulk;
            });
            onValues(next);
          }}
        >
          Set for every track
        </Btn>
      </div>
      <div className="col">
        {tracks.map((track, index) => {
          const id = Number(track.id);
          const included = kind === "subtitle" && !file.includeSubtitles
            ? false
            : !(kind === "audio" ? file.includedTrackIds : file.includedSubtitleTrackIds)?.length ||
              (kind === "audio" ? file.includedTrackIds : file.includedSubtitleTrackIds)!.includes(id);
          const value = Number.isFinite(id) ? (values[id] ?? "0.000") : "0.000";
          const parsed = parseDelayInput(value);
          return (
            <div key={`${track.id}-${index}`} className="trow" style={{ minHeight: 44 }}>
              <span className="grow">
                <div className="truncate">{index + 1} · {trackText(track, index, kind === "audio" ? "Audio" : "Subtitle")}</div>
                <div className="d">ID {track.id} · {included ? "Included" : "Not included"}</div>
              </span>
              <TBox
                label={`Delay for track ${index + 1}`}
                className={cx(!parsed.valid && "invalid")}
                mono
                unit="s"
                w={120}
                value={value}
                title={parsed.error}
                aria-invalid={!parsed.valid}
                onChange={(next) => Number.isFinite(id) && onValues({ ...values, [id]: next })}
              />
            </div>
          );
        })}
      </div>
    </Dialog>
  );
}

/** Deleting a slot takes its settings and its files out of the mux. */
export function DeleteSlotDialog({ kind, slot, onCancel, onDelete }: { kind: SlotKind; slot: string; onCancel: () => void; onDelete: () => void }) {
  return (
    <Dialog
      title={`Delete ${slotName(kind)} ${slot}?`}
      onClose={onCancel}
      foot={
        <>
          <Btn accent onClick={onDelete}>Delete</Btn>
          <Btn onClick={onCancel}>Cancel</Btn>
        </>
      }
    >
      <div className="t2">Its settings go, and none of its files are muxed.</div>
    </Dialog>
  );
}
