/** The track table shared by Edit tracks and Modify tracks: one row per
 *  track, with Copy / Default / Forced, the name (double-click to rename), the
 *  language, and remove (its × shows on the row under the pointer). Rows
 *  reorder by dragging with the pointer. The checkbox rules are the old
 *  dialogs': turning Copy off clears Default and Forced, and Default or Forced
 *  can only be set on a copied track (setting them for every row copies every
 *  row). */

import { DismissRegular } from "@fluentui/react-icons";
import { useRef, useState } from "react";

import { rowFieldMixed, type TrackRowDraft } from "@/features/workspace/lib/modifyTracks";
import { useRowReorder } from "@/features/workspace/lib/useRowReorder";
import { Chk, Cmd, Grip, LangCombo, Table, Tr, cx } from "@/ui/kit";

export interface TrackRowView {
  id: string;
  copyTrack: boolean;
  setDefault: boolean;
  setForced: boolean;
  trackName: string;
  language: string;
  bitrate?: number;
  /** A file added to the video, not one of its own tracks. */
  external?: boolean;
  /** Shown dim while the name is empty (an unnamed track's codec). */
  namePlaceholder?: string;
  /** Modify tracks: the row as first shown, and which fields the videos
   *  disagree on — shown as mixed until the user sets them. */
  initial?: TrackRowDraft["initial"];
  mixed?: TrackRowDraft["mixed"];
}

export type TrackFlag = "copyTrack" | "setDefault" | "setForced";

export function TrackRowsTable<R extends TrackRowView>({
  rows,
  audio,
  selectedId,
  onSelect,
  onChange,
  onSetAll,
  onDelete,
  onMove,
  label,
}: {
  rows: R[];
  /** Audio rows show their bitrate. */
  audio?: boolean;
  selectedId: string | null;
  onSelect: (id: string) => void;
  onChange: (id: string, field: TrackFlag | "trackName" | "language", value: boolean | string) => void;
  onSetAll: (field: TrackFlag, value: boolean) => void;
  /** Absent: rows cannot be removed (the video track). */
  onDelete?: (id: string) => void;
  onMove: (from: number, to: number) => void;
  label: string;
}) {
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingName, setEditingName] = useState("");
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const drag = useRowReorder({ bodyRef, rowCount: rows.length, onMove, disabled: editingId !== null });

  const all = (field: TrackFlag) => rows.length > 0 && rows.every((row) => row[field]);
  const finishEditing = () => {
    if (editingId && editingName.trim()) onChange(editingId, "trackName", editingName.trim());
    setEditingId(null);
    setEditingName("");
  };

  const cols = `16px 24px 64px 72px 68px ${audio ? "80px " : ""}minmax(0,1fr) 200px 28px`;
  const head = [
    "",
    "#",
    <Chk key="c" name="Copy every track" on={all("copyTrack")} onChange={(on) => onSetAll("copyTrack", on)}>Copy</Chk>,
    <Chk key="d" name="Make every track default" on={all("setDefault")} onChange={(on) => onSetAll("setDefault", on)}>Default</Chk>,
    <Chk key="f" name="Make every track forced" on={all("setForced")} onChange={(on) => onSetAll("setForced", on)}>Forced</Chk>,
    ...(audio ? [" Bitrate"] : []),
    "Name",
    "Language",
    "",
  ];

  return (
    <Table cols={cols} head={head} label={label} bodyRef={bodyRef}>
      {rows.length === 0 ? (
        <div className="log t3">No tracks of this kind.</div>
      ) : (
        rows.map((row, index) => {
          const dragProps = drag.rowProps(index);
          return (
            <Tr key={row.id} on={selectedId === row.id} className={dragProps.className} onPointerDown={(event) => {
              onSelect(row.id);
              dragProps.onPointerDown(event);
            }} onClick={() => onSelect(row.id)} label={row.trackName || row.namePlaceholder}>
              <Grip />
              <span className="num t3">{String(index + 1).padStart(2, "0")}</span>
              <span className="cell">
                <Chk name={`Copy track ${index + 1}`} on={row.copyTrack} onChange={(on) => onChange(row.id, "copyTrack", on)} />
                {rowFieldMixed(row, "copyTrack") && <Mixed />}
              </span>
              <span className="cell">
                <Chk name={`Default track ${index + 1}`} on={row.setDefault} disabled={!row.copyTrack} onChange={(on) => onChange(row.id, "setDefault", on)} />
                {rowFieldMixed(row, "setDefault") && <Mixed />}
              </span>
              <span className="cell">
                <Chk name={`Forced track ${index + 1}`} on={row.setForced} disabled={!row.copyTrack} onChange={(on) => onChange(row.id, "setForced", on)} />
                {rowFieldMixed(row, "setForced") && <Mixed />}
              </span>
              {audio && <span className="r num t2" style={{ display: "flex" }}>{row.bitrate ? `${Math.round(row.bitrate / 1000)} kb/s` : "—"}</span>}
              {editingId === row.id ? (
                <label className="tbox" style={{ height: 26 }}>
                  <input
                    aria-label="Track name"
                    autoFocus
                    value={editingName}
                    onChange={(event) => setEditingName(event.target.value)}
                    onBlur={finishEditing}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") finishEditing();
                      if (event.key === "Escape") {
                        event.stopPropagation();
                        setEditingId(null);
                        setEditingName("");
                      }
                    }}
                  />
                </label>
              ) : (
                <span
                  className="cell"
                  title="Double-click to rename"
                  onDoubleClick={() => {
                    setEditingId(row.id);
                    setEditingName(row.trackName);
                  }}
                >
                  <span className={cx("truncate", (!row.copyTrack || !row.trackName) && "t3")}>{row.trackName || row.namePlaceholder}</span>
                  {row.external && <span className="t3 sm">Added</span>}
                </span>
              )}
              <LangCombo sm ghost w="100%" label={`Language of track ${index + 1}`} value={row.language} placeholder={rowFieldMixed(row, "language") ? "Multiple" : undefined} onChange={(language) => onChange(row.id, "language", language)} />
              {onDelete ? (
                <span className="rx">
                  <Cmd sm icon={<DismissRegular />} title="Remove from the list" onClick={() => onDelete(row.id)} />
                </span>
              ) : (
                <span />
              )}
            </Tr>
          );
        })
      )}
    </Table>
  );
}

/** Beside a checkbox whose value differs between the videos: left alone, each
 *  video keeps its own. */
function Mixed() {
  return <span className="t3 sm" title="Differs between the videos; left as is unless you change it">Mixed</span>;
}
