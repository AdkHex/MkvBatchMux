import * as React from "react";
import { Pencil } from "lucide-react";
import { BaseModal } from "@/shared/components/BaseModal";
import { Button } from "@/shared/ui/button";
import { Input } from "@/shared/ui/input";
import { LanguageSelect } from "./LanguageSelect";

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
}

/**
 * Edits one imported stream's language, name and delay.
 *
 * Imports used to take the tab's shared settings for every stream, so a batch
 * that needed a different offset per track could not be expressed at all --
 * the delay had to be fixed afterwards, file by file.
 */
export function ImportTrackEditDialog({
  open,
  onOpenChange,
  trackLabel,
  value,
  onSave,
  kind,
}: ImportTrackEditDialogProps) {
  const [language, setLanguage] = React.useState(value.language ?? "");
  const [trackName, setTrackName] = React.useState(value.trackName ?? "");
  const [delay, setDelay] = React.useState(String(value.delay ?? 0));

  // Reset when a different track is opened, otherwise the previous track's
  // edits would be shown against the new one.
  React.useEffect(() => {
    if (!open) return;
    setLanguage(value.language ?? "");
    setTrackName(value.trackName ?? "");
    setDelay(String(value.delay ?? 0));
  }, [open, value.language, value.trackName, value.delay]);

  const handleSave = () => {
    const parsed = Number(delay);
    onSave({
      language: language || undefined,
      trackName: trackName || undefined,
      delay: Number.isFinite(parsed) ? parsed : 0,
    });
    onOpenChange(false);
  };

  return (
    <BaseModal
      open={open}
      onOpenChange={onOpenChange}
      title={`Edit ${kind} stream`}
      subtitle={trackLabel}
      className="max-w-md"
      footerRight={
        <>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={handleSave}>Save</Button>
        </>
      }
    >
      <div className="space-y-3">
        <div className="space-y-1.5">
          <label className="text-xs text-muted-foreground">Language</label>
          <LanguageSelect value={language} onChange={setLanguage} />
        </div>
        <div className="space-y-1.5">
          <label className="text-xs text-muted-foreground">Track name</label>
          <Input
            value={trackName}
            onChange={(event) => setTrackName(event.target.value)}
            placeholder="Leave empty to keep the original"
          />
        </div>
        <div className="space-y-1.5">
          <label className="text-xs text-muted-foreground">Delay (seconds)</label>
          <Input
            value={delay}
            onChange={(event) => setDelay(event.target.value)}
            className="font-mono"
            inputMode="decimal"
          />
          <p className="text-xs text-muted-foreground">
            Positive delays this stream; negative plays it earlier. Other streams are unaffected.
          </p>
        </div>
      </div>
    </BaseModal>
  );
}

/** The pencil affordance shown on each importable stream row. */
export function ImportTrackEditButton({
  onClick,
  edited,
  label,
}: {
  onClick: () => void;
  edited: boolean;
  label: string;
}) {
  return (
    <Button
      variant="ghost"
      size="icon"
      className="h-[26px] w-[26px] shrink-0"
      onClick={(event) => {
        // The row is a <label> wrapping a checkbox; without this the click
        // would toggle selection instead of opening the editor.
        event.preventDefault();
        event.stopPropagation();
        onClick();
      }}
      aria-label={label}
      title={edited ? "Edited — click to change" : "Set delay, name or language"}
    >
      <Pencil className={edited ? "w-3.5 h-3.5 text-primary" : "w-3.5 h-3.5"} />
    </Button>
  );
}
