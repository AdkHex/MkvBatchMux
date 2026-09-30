import { EditRegular } from "@fluentui/react-icons";
import { useEffect, useState } from "react";

import { DelayField, delayInputsAreValid } from "@/shared/components/DelayField";
import { parseDelayInput } from "@/shared/lib/delayInput";
import { Dialog } from "@/ui/frame";
import { Btn, Cmd, Fld, LangCombo, TBox } from "@/ui/kit";

/** Per-track overrides applied to an imported stream. */
export interface ImportTrackOverride {
  language?: string;
  trackName?: string;
  delay?: number;
}

interface ImportTrackEditDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Shown as the dialog subtitle so the user knows which stream they are on. */
  trackLabel: string;
  value: ImportTrackOverride;
  onSave: (next: ImportTrackOverride) => void;
  kind: "audio" | "subtitle";
  /** The dialog's title; "Edit the audio stream" by default. */
  title?: string;
}

/** Edits one stream's language, name and delay: a stream being imported, or
 *  one track inside a file. */
export function ImportTrackEditDialog({ open, onOpenChange, trackLabel, value, onSave, kind, title }: ImportTrackEditDialogProps) {
  const [language, setLanguage] = useState(value.language ?? "");
  const [trackName, setTrackName] = useState(value.trackName ?? "");
  const [delay, setDelay] = useState(String(value.delay ?? 0));

  // Reset when a different track is opened, otherwise the previous track's
  // edits would be shown against the new one.
  useEffect(() => {
    if (!open) return;
    setLanguage(value.language ?? "");
    setTrackName(value.trackName ?? "");
    setDelay(String(value.delay ?? 0));
  }, [open, value.language, value.trackName, value.delay]);

  if (!open) return null;

  const handleSave = () => {
    const parsed = parseDelayInput(delay);
    // The button is disabled while this is false, so this is belt-and-braces
    // rather than the path anyone takes.
    if (!parsed.valid) return;
    onSave({ language: language || undefined, trackName: trackName || undefined, delay: parsed.value });
    onOpenChange(false);
  };

  return (
    <Dialog
      size="mid"
      title={title ?? `Edit the ${kind} stream`}
      sub={trackLabel}
      onClose={() => onOpenChange(false)}
      foot={
        <>
          <Btn onClick={() => onOpenChange(false)}>Cancel</Btn>
          <Btn accent disabled={!delayInputsAreValid(delay)} onClick={handleSave}>Save</Btn>
        </>
      }
    >
      <div className="fgrid">
        <Fld label="Language">
          <LangCombo value={language || undefined} onChange={setLanguage} w="100%" placeholder="Keep the original" />
        </Fld>
        <Fld label="Track name">
          <TBox label="Track name" value={trackName} onChange={setTrackName} placeholder="Keep the original" />
        </Fld>
      </div>
      <DelayField value={delay} onChange={setDelay} hint="Positive plays this stream later; negative, earlier. Other streams are unaffected." />
    </Dialog>
  );
}

/** The pencil beside a stream: opens its editor without toggling the row. */
export function ImportTrackEditButton({ onClick, edited, label }: { onClick: () => void; edited?: boolean; label: string }) {
  return (
    <Cmd
      sm
      icon={<EditRegular className={edited ? "acc" : undefined} />}
      title={edited ? "Edited — click to change" : "Language, name and delay"}
      aria-label={label}
      onClick={(event) => {
        event.preventDefault();
        event.stopPropagation();
        onClick();
      }}
    />
  );
}
