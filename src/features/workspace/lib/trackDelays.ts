/** The delay each audio track of a file goes into the mux with, for a file
 *  that carries several (Hindi, Tamil and Telugu in one container). */

import type { DelayProvenance, ExternalFile, MeasuredDelay, Track } from "@/shared/types";
import { includedAudioTrackIndices } from "./measurePairs";

export interface TrackDelay {
  trackId: number;
  /** Among the file's audio tracks, from 0. */
  index: number;
  track: Track;
  /** What the mux uses: the track's own delay, or else the file's (main.rs). */
  delay: number;
  /** The delay is the track's own, not the file's. */
  own: boolean;
  /** A measured delay not applied yet. */
  pending?: number;
  measured?: MeasuredDelay;
  provenance?: DelayProvenance;
}

/** Every audio track of the file that is muxed, in track order. */
export function trackDelays(file: ExternalFile): TrackDelay[] {
  const audio = (file.tracks ?? []).filter((track) => track.type === "audio");
  return includedAudioTrackIndices(file).map(({ trackId, streamIndex }) => {
    const override = file.trackOverrides?.[trackId];
    return {
      trackId,
      index: streamIndex,
      track: audio[streamIndex],
      delay: override?.delay ?? file.delay ?? 0,
      own: override?.delay !== undefined,
      pending: override?.pendingDelay,
      measured: override?.measuredDelay,
      provenance: override?.delayProvenance,
    };
  });
}

/** The delay a track shows: the one waiting to be applied, else the one in force. */
export const shownTrackDelay = (entry: TrackDelay) => entry.pending ?? entry.delay;
