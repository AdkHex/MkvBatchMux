/** Before a session opens: what it replaces, which of its files are missing
 *  (listed one by one, so nothing is dropped unseen), and anything it
 *  couldn't read. Shown only when there is something to say. */

import { describeMissing } from "@/features/workspace/lib/session";
import { Dialog } from "@/ui/frame";
import { Btn, InfoBar } from "@/ui/kit";

import type { PendingSession } from "./useWorkspaceSession";

const KIND: Record<string, string> = { video: "Video", audio: "Audio", subtitle: "Subtitle", chapter: "Chapters", attachment: "Attachment" };
const MAX_LISTED = 200;

export function SessionOpenDialog({ pending, onOpen, onCancel }: { pending: PendingSession | null; onOpen: () => void; onCancel: () => void }) {
  if (!pending) return null;
  const { missing, warnings, replaces, label } = pending;
  const heading = missing.length ? `${describeMissing(missing)[0].toUpperCase()}${describeMissing(missing).slice(1)}` : `Open ${label}?`;
  return (
    <Dialog
      size="mid"
      title={heading}
      sub={missing.length ? `In ${label}. They stay in their lists until you remove them or put them back.` : undefined}
      onClose={onCancel}
      foot={
        <>
          <Btn onClick={onCancel}>Cancel</Btn>
          <Btn accent onClick={onOpen}>{missing.length ? "Open anyway" : "Open"}</Btn>
        </>
      }
    >
      {replaces && <InfoBar tone="info">It replaces the files loaded now. Save them first with File › Save session if you want them back later.</InfoBar>}
      {warnings.map((warning) => (
        <InfoBar key={warning} tone="warn">{warning}</InfoBar>
      ))}
      {missing.length > 0 && (
        <dl className="keys" aria-label="Missing files">
          {missing.slice(0, MAX_LISTED).map((file) => (
            <div key={`${file.kind}-${file.path}`} style={{ display: "contents" }}>
              <dt className="truncate mono" title={file.path}>{file.path}</dt>
              <dd>{KIND[file.kind] ?? file.kind}{file.slot && file.kind !== "video" && /^\d+$/.test(file.slot) ? ` ${file.slot}` : ""}</dd>
            </div>
          ))}
        </dl>
      )}
      {missing.length > MAX_LISTED && <div className="t3">…and {missing.length - MAX_LISTED} more, listed in Output.</div>}
    </Dialog>
  );
}
