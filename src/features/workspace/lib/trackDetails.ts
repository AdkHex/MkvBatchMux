/** A track written out in full, so tracks that share a language can be told
 *  apart: three "Chinese" tracks differ in codec, channels, bitrate or name. */

import { CODE_TO_LABEL } from "@/shared/data/languages-iso6393";
import type { Track, VideoFile } from "@/shared/types";

const LAYOUTS: Record<number, string> = { 1: "1.0", 2: "2.0", 3: "2.1", 6: "5.1", 7: "6.1", 8: "7.1" };

/** "5.1" for 6 channels; the count itself for an unusual one. */
export function channelLayout(channels: number | undefined): string | null {
  if (!channels || !Number.isFinite(channels)) return null;
  return LAYOUTS[channels] ?? `${channels} ch`;
}

type Described = Pick<Track, "language" | "codec" | "channels" | "bitrate" | "name" | "isDefault">;

/** "Chinese · E-AC-3 · 5.1 · 640 kb/s · Zh-cn [Dolby Digital Plus 5.1] · default".
 *  `brief` leaves out the bitrate and the default flag, which differ from file
 *  to file for what is the same track. */
export function trackDescription(track: Described, { brief = false }: { brief?: boolean } = {}): string {
  return [
    track.language ? (CODE_TO_LABEL[track.language] ?? track.language) : null,
    track.codec ?? null,
    channelLayout(track.channels),
    !brief && track.bitrate ? `${Math.round(track.bitrate / 1000)} kb/s` : null,
    track.name?.trim() || null,
    !brief && track.isDefault ? "default" : null,
  ]
    .filter(Boolean)
    .join(" · ");
}

/** The description after the track's number. `index` counts among the file's audio tracks, from 0. */
export function trackDetails(track: Described, index: number): string {
  const description = trackDescription(track);
  return description ? `${index + 1} · ${description}` : `${index + 1}`;
}

/** The reference for every video at once, by position: "Track 2 of each
 *  video". One video's track is not everyone's, so a choice names a track only
 *  when every video has the same one there; each video's own is written out
 *  under Against. */
export function referencePositions(videos: VideoFile[]): { value: number; label: string }[] {
  const audio = videos.map((video) => (video.tracks ?? []).filter((track) => track.type === "audio")).filter((tracks) => tracks.length > 0);
  const most = Math.max(0, ...audio.map((tracks) => tracks.length));
  return Array.from({ length: most }, (_, index) => {
    const position = `Track ${index + 1} of each video`;
    const here = audio.filter((tracks) => tracks.length > index).map((tracks) => trackDescription(tracks[index], { brief: true }));
    if (here.length < audio.length) return { value: index, label: `${position} · only ${here.length} of ${audio.length} have one, the rest use their last` };
    if (new Set(here).size === 1 && here[0]) return { value: index, label: `${position} · ${here[0]}` };
    return { value: index, label: `${position} · differs by video, see Against` };
  });
}
