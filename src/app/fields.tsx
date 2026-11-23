/** Small form pieces the Recipes and Watch folders dialogs share. */

import { DismissRegular, FolderOpenRegular } from "@fluentui/react-icons";
import type { ReactNode } from "react";

import { pickDirectory } from "@/shared/lib/backend";
import { Cmd, TBox } from "@/ui/kit";

/** A setting in a dialog's group: what it is on the left, the control on the right. */
export const SetRow = ({ h, d, children }: { h: ReactNode; d?: ReactNode; children?: ReactNode }) => (
  <div className="srow" style={{ minHeight: 48 }}>
    <div className="tx">
      <div>{h}</div>
      {d && <div className="d">{d}</div>}
    </div>
    {children}
  </div>
);

/** A folder: typed, or chosen with the folder picker; cleared with ×. */
export function FolderField({ label, value, onChange, w = 300, placeholder = "Not set" }: { label: string; value: string; onChange: (value: string) => void; w?: number; placeholder?: string }) {
  return (
    <span className="row" style={{ gap: 2 }}>
      <TBox label={label} value={value} placeholder={placeholder} w={w} mono onChange={onChange} />
      <Cmd
        icon={<FolderOpenRegular />}
        title={`Choose the ${label.toLowerCase()}`}
        onClick={async () => {
          const folder = await pickDirectory();
          if (folder) onChange(folder);
        }}
      />
      <Cmd icon={<DismissRegular />} title={`Clear the ${label.toLowerCase()}`} disabled={!value} onClick={() => onChange("")} />
    </span>
  );
}

/** "hin, eng" ⇄ ["hin", "eng"]. */
export const listText = (list: string[] | undefined) => (list ?? []).join(", ");
export const textList = (text: string) =>
  text
    .split(/[\s,;]+/)
    .map((item) => item.trim())
    .filter(Boolean);
