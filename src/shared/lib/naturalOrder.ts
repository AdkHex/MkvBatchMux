/** File order as Windows Explorer shows it: numbers by value, not digit by
 *  digit ("Ep 2" before "Ep 10"), and case ignored.
 *
 *  Folder listings arrive in whatever order the file system keeps: NTFS by
 *  character ("Ep 10" before "Ep 2"), a NAS share or an exFAT drive in no
 *  particular order. Dubs and subtitles pair with videos by row, so two
 *  folders listed in different orders would pair the wrong episodes. */

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

export const naturalCompare = (a: string, b: string) => collator.compare(a, b);

/** A copy in natural order of each item's path; ties keep their order. */
export function naturalSortByPath<T extends { path: string }>(items: T[]): T[] {
  return [...items].sort((a, b) => naturalCompare(a.path, b.path));
}
