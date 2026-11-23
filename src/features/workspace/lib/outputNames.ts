/** Per-job output names for a naming pattern that only the frontend can
 *  resolve ({show} {season} {episode}): each job request carries its name to
 *  main.rs as `outputName`, and two episodes that would land on the same name
 *  are found before the mux, not by the second one overwriting the first. */

import type { MuxJobRequest } from "@/shared/lib/backend";
import { resolveOutputNames, usesEpisodeTokens } from "./recipes";

export interface NameCollision {
  /** The output name, without ".mkv". */
  stem: string;
  /** The videos' file names, in queue order. */
  videos: string[];
}

export interface NamedRequests {
  requests: MuxJobRequest[];
  collisions: NameCollision[];
}

/** The requests with `outputName` filled in when the pattern needs it, and the
 *  names two or more jobs would share. Patterns main.rs renders alone pass
 *  through untouched (the same array), so nothing changes for them. Jobs
 *  going beside their sources into different folders can't collide; only
 *  jobs that share a folder are compared. */
export function attachOutputNames(
  requests: MuxJobRequest[],
  pattern: string | undefined,
  { show, destination }: { show?: string; destination?: string } = {},
): NamedRequests {
  if (!usesEpisodeTokens(pattern) || requests.length === 0) return { requests, collisions: [] };
  const { names } = resolveOutputNames(
    requests.map((request) => request.video),
    pattern,
    { show },
  );
  const named = requests.map((request) => ({ ...request, outputName: names[request.video.id]?.stem ?? undefined }));

  const folderOf = (path: string) => (destination?.trim() ? "" : path.replace(/[\\/][^\\/]*$/, "").toLowerCase());
  const byKey = new Map<string, MuxJobRequest[]>();
  for (const request of named) {
    const key = `${folderOf(request.video.path)}\u0000${(request.outputName ?? "").toLowerCase()}`;
    byKey.set(key, [...(byKey.get(key) ?? []), request]);
  }
  const collisions = [...byKey.values()]
    .filter((group) => group.length > 1)
    .map((group) => ({ stem: group[0].outputName ?? "", videos: group.map((request) => request.video.name) }));
  return { requests: named, collisions };
}

/** One sentence for the first collision, for the toast that stops the mux. */
export function describeCollisions(collisions: NameCollision[]): string {
  if (collisions.length === 0) return "";
  const [first] = collisions;
  const list = first.videos.length > 2 ? `${first.videos.slice(0, 2).join(", ")} and ${first.videos.length - 2} more` : first.videos.join(" and ");
  const more = collisions.length > 1 ? ` ${collisions.length - 1} more name${collisions.length === 2 ? " is" : "s are"} shared too.` : "";
  return `${list} would ${first.videos.length === 2 ? "both" : "all"} be saved as ${first.stem}.mkv.${more} Change the output name on the Mux page, or the recipe's.`;
}
