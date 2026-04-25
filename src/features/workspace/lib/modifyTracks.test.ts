import { describe, expect, it } from "vitest";
import type { Track, VideoFile } from "@/shared/types";
import { applyTrackRowsToVideo, type TrackRowDraft } from "./modifyTracks";

const makeAudioTrack = (id: string, name: string, language: string): Track => ({
  id,
  type: "audio",
  name,
  language,
  action: "keep",
});

const makeVideoFile = (): VideoFile => ({
  id: "video-1",
  name: "sample.mkv",
  path: "/videos/sample.mkv",
  size: 100,
  status: "pending",
  tracks: [
    { id: "v", type: "video", name: "Main Video", action: "keep" },
    makeAudioTrack("a1", "Hindi", "hin"),
    makeAudioTrack("a2", "Tamil", "tam"),
    makeAudioTrack("a3", "Telugu", "tel"),
  ],
});

describe("applyTrackRowsToVideo", () => {
  it("reorders audio tracks using the visible row order and keeps labels aligned", () => {
    const file = makeVideoFile();
    const rows: TrackRowDraft[] = [
      {
        id: "audio-0",
        trackIndex: 1,
        sourceTrackPosition: 0,
        copyTrack: true,
        setDefault: false,
        setForced: false,
        trackName: "Hindi",
        language: "hin",
      },
      {
        id: "audio-2",
        trackIndex: 2,
        sourceTrackPosition: 2,
        copyTrack: true,
        setDefault: false,
        setForced: false,
        trackName: "Telugu",
        language: "tel",
      },
      {
        id: "audio-1",
        trackIndex: 3,
        sourceTrackPosition: 1,
        copyTrack: true,
        setDefault: false,
        setForced: false,
        trackName: "Tamil",
        language: "tam",
      },
    ];

    const updated = applyTrackRowsToVideo(file, rows, "audio");
    const audioTracks = updated.tracks.filter((track) => track.type === "audio");

    expect(audioTracks.map((track) => track.id)).toEqual(["a1", "a3", "a2"]);
    expect(audioTracks.map((track) => track.name)).toEqual(["Hindi", "Telugu", "Tamil"]);
    expect(audioTracks.map((track) => track.language)).toEqual(["hin", "tel", "tam"]);
  });
});
