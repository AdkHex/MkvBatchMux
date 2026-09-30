/** Small pieces the pages share: the search box and sort/filter choices in a
 *  list's header, and file helpers. */

import { SearchRegular } from "@fluentui/react-icons";

/** The search box in a list's header. */
export function SearchBox({ value, onChange, w = 150, label = "Search" }: { value: string; onChange: (value: string) => void; w?: number; label?: string }) {
  return (
    <label className="tbox" style={{ width: w }}>
      <SearchRegular className="t3" aria-hidden />
      <input aria-label={label} placeholder="Search" value={value} onChange={(event) => onChange(event.target.value)} />
    </label>
  );
}

/** "All formats" and then each extension, for a scan's extension filter. */
export const extensionOptions = (extensions: readonly string[]) => [
  { value: "all", label: "All formats" },
  ...extensions.map((ext) => ({ value: ext, label: ext.toUpperCase() })),
];

export function formatFileSize(bytes: number): string {
  if (bytes >= 1048576) return (bytes / 1048576).toFixed(1) + " MB";
  if (bytes >= 1024) return (bytes / 1024).toFixed(0) + " KB";
  return bytes + " B";
}

/** A file's extension, lower case, without the dot; "" when it has none. */
export const extensionOf = (name: string) => {
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
};

/** The folder a path sits in, on either platform. */
export const parentFolder = (path: string) => {
  const trimmed = path.replace(/[\\/]+$/, "");
  const at = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
  return at > 0 ? trimmed.slice(0, at) : at === 0 ? trimmed.slice(0, 1) : "";
};

/** A dropped path that names a folder. The drop event carries bare paths, so
 *  this is read from the name the same way the window's drop label reads it:
 *  no extension means a folder. */
export const looksLikeFolder = (path: string) => !/\.[a-z0-9]{1,5}$/i.test(path.replace(/[\\/]+$/, "").replace(/^.*[\\/]/, ""));

/** A delay the way the lists show it: signed, three decimals, "0.000" at zero. */
export const formatDelay = (seconds: number | undefined) => {
  const value = Number(seconds) || 0;
  return value > 0 ? `+${value.toFixed(3)}` : value.toFixed(3);
};

/** The sort choices every list offers, in the old top bar's order. */
export type SortValue = "loaded" | "name-asc" | "name-desc" | "size-desc";
export const SORT_OPTIONS: { value: SortValue; label: string }[] = [
  { value: "loaded", label: "Loaded order" },
  { value: "name-asc", label: "Name A–Z" },
  { value: "name-desc", label: "Name Z–A" },
  { value: "size-desc", label: "Largest first" },
];

/** Which rows a paired list shows. */
export type FilterValue = "all" | "linked" | "unlinked";
export const FILTER_OPTIONS: { value: FilterValue; label: string }[] = [
  { value: "all", label: "All rows" },
  { value: "linked", label: "Paired" },
  { value: "unlinked", label: "Not paired" },
];

/** The old top bar's sort, unchanged. */
export function sortFiles<T extends { name: string; size?: number }>(items: T[], sort: SortValue): T[] {
  if (sort === "name-asc") return [...items].sort((a, b) => a.name.localeCompare(b.name));
  if (sort === "name-desc") return [...items].sort((a, b) => b.name.localeCompare(a.name));
  if (sort === "size-desc") return [...items].sort((a, b) => (b.size || 0) - (a.size || 0));
  return items;
}

/** Whether a file's name or path holds the search text. */
export const matchesSearch = (file: { name: string; path: string }, search: string) => {
  const term = search.trim().toLowerCase();
  return !term || `${file.name} ${file.path}`.toLowerCase().includes(term);
};

export function formatGb(bytes?: number): string {
  if (!Number.isFinite(bytes)) return "—";
  return `${((bytes as number) / 1073741824).toFixed(2)} GB`;
}

/** 4003 → "1:06:43". */
export function formatClockSeconds(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  return `${Math.floor(s / 3600)}:${String(Math.floor((s % 3600) / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
}
