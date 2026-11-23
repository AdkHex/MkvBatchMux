/** A page's pairing of its file list with the videos: by episode or by order,
 *  the choice per page (automatic until picked), and the list kept in step
 *  with it as files and videos come and go. */

import { useCallback, useEffect, useMemo, useState } from "react";

import { defaultPairBy, describePairing, dropPlaceholders, moveByHand, pairByEpisode, type PairBy, type PairInfo, type PairingConflict } from "@/features/workspace/lib/smartPairing";
import { linkExternalFilesByOrder } from "@/shared/lib/matchUtils";
import type { ExternalFile, VideoFile } from "@/shared/types";

interface UsePairingInput {
  files: ExternalFile[];
  videoFiles: VideoFile[];
  onFilesChange: (files: ExternalFile[]) => void;
  /** Pairing by order for this list. Audio and subtitles pair row n with
   *  video n; chapters keep hand links where they are and pass their own. */
  linkByOrder?: (files: ExternalFile[]) => ExternalFile[];
  /** Leave the list alone (a run writes to it): rearranging under it would
   *  have results land on a list that has moved on. */
  frozen?: boolean;
}

export function usePairing({ files, videoFiles, onFilesChange, linkByOrder, frozen = false }: UsePairingInput) {
  /** Null until the user picks: then the 80 % rule decides, list by list. */
  const [choice, setChoice] = useState<PairBy | null>(null);
  const byOrder = useCallback((next: ExternalFile[]) => (linkByOrder ? linkByOrder(next) : linkExternalFilesByOrder(next, videoFiles)), [linkByOrder, videoFiles]);
  const pairByFor = useCallback((next: ExternalFile[]) => choice ?? defaultPairBy(next, videoFiles), [choice, videoFiles]);
  const pairBy = useMemo(() => pairByFor(files), [pairByFor, files]);

  /** A new or changed list, paired the page's way. */
  const sync = useCallback((next: ExternalFile[]) => (pairByFor(next) === "episode" ? pairByEpisode(next, videoFiles).files : byOrder(next)), [pairByFor, videoFiles, byOrder]);

  // Videos added, removed or reordered, files dropped or rescanned: pair again.
  // Both ways give back the same list when it is already in step, so this settles.
  useEffect(() => {
    if (frozen || files.length === 0) return;
    const next = pairBy === "episode" ? pairByEpisode(files, videoFiles).files : linkByOrder ? files : linkExternalFilesByOrder(files, videoFiles);
    if (next !== files) onFilesChange(next);
  }, [files, videoFiles, pairBy, frozen, linkByOrder, onFilesChange]);

  const report = useMemo(() => describePairing(files, videoFiles, pairBy), [files, videoFiles, pairBy]);
  const conflictByFile = useMemo(() => new Map<string, PairingConflict>(report.conflicts.map((conflict) => [conflict.fileId, conflict])), [report]);

  /** Pick a way to pair. Back to order, the empty rows go and every file keeps
   *  its place among the others; to episode, the effect arranges the list. */
  const choose = useCallback(
    (next: PairBy) => {
      setChoice(next);
      if (next === "order" && files.length > 0) {
        const plain = byOrder(dropPlaceholders(files));
        if (plain !== files) onFilesChange(plain);
      }
    },
    [files, byOrder, onFilesChange],
  );

  /** A row moved by hand. By order, the files after it shift; by episode, the
   *  two files trade videos and both stay where they were put. */
  const move = useCallback(
    (from: number, to: number) => {
      if (pairBy === "episode") {
        const moved = moveByHand(files, from, Math.min(to, videoFiles.length - 1), videoFiles);
        if (moved !== files) onFilesChange(pairByEpisode(moved, videoFiles).files);
        return;
      }
      if (to < 0 || to >= files.length || from === to) return;
      const updated = [...files];
      const [moved] = updated.splice(from, 1);
      updated.splice(to, 0, moved);
      onFilesChange(byOrder(updated));
    },
    [pairBy, files, videoFiles, byOrder, onFilesChange],
  );

  /** Pair a file by its name or its row again, after a hand link or an audio match. */
  const release = useCallback(
    (fileId: string) => {
      const next = files.map((file) => (file.id === fileId ? { ...file, isManuallyLinked: false, audioMatch: undefined } : file));
      onFilesChange(sync(next));
    },
    [files, onFilesChange, sync],
  );

  /** Keep a file beside the video it is with, whatever its name says. */
  const keep = useCallback(
    (fileId: string) => onFilesChange(files.map((file) => (file.id === fileId && file.matchedVideoId ? { ...file, isManuallyLinked: true } : file))),
    [files, onFilesChange],
  );

  return {
    pairBy,
    /** True once the user picked; false while the 80 % rule decides. */
    chosen: choice !== null,
    /** How a given list would be paired: the choice, or the 80 % rule on it. */
    pairByFor,
    choose,
    sync,
    move,
    release,
    keep,
    report,
    infoOf: (fileId: string): PairInfo | undefined => report.pairs[fileId],
    conflictOf: (fileId: string): PairingConflict | undefined => conflictByFile.get(fileId),
  };
}
