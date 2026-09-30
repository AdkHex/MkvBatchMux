/** Help › Keyboard shortcuts: every key the app answers to, in one list. */

import { Dialog } from "@/ui/frame";
import { Btn } from "@/ui/kit";

export const SHORTCUTS: [string, string][] = [
  ["Videos · Subtitles · Audio · Chapters · Attachments · Mux", "Ctrl+1 – 6"],
  ["Choose folder", "Ctrl+O"],
  ["New track (Audio, Subtitles)", "Ctrl+N"],
  ["Modify tracks", "Ctrl+M"],
  ["Media info", "Ctrl+I"],
  ["Select all", "Ctrl+A"],
  ["Remove the selection", "Del"],
  ["Move up · down", "Alt+↑ · Alt+↓"],
  ["Run the page's action (Measure delays, Start muxing)", "Enter"],
  ["Start muxing from any page", "Ctrl+Enter"],
  ["Stop", "Esc"],
  ["Output · History", "Ctrl+` · Ctrl+H"],
  ["Preferences", "Ctrl+,"],
  ["This list", "?"],
];

export function KeyboardShortcuts({ open, onClose }: { open: boolean; onClose: () => void }) {
  if (!open) return null;
  return (
    <Dialog size="mid" title="Keyboard shortcuts" onClose={onClose} foot={<Btn accent onClick={onClose}>Close</Btn>}>
      <dl className="keys">
        {SHORTCUTS.map(([what, keys]) => (
          <div key={what} style={{ display: "contents" }}>
            <dt>{what}</dt>
            <dd>{keys}</dd>
          </div>
        ))}
      </dl>
    </Dialog>
  );
}
