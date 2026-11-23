import { describe, expect, it } from "vitest";
import type { Track, VideoFile } from "@/shared/types";
import { aggregateTrackRows, applyTrackRowsToVideo, moveTrackRow, type TrackRowDraft } from "./modifyTracks";

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

  it("marks a deleted middle track as removed without shifting its neighbours", () => {
    const file = makeVideoFile();
    // The Tamil row (source position 1) was deleted in the dialog, so it simply
    // is not in the row list any more.
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
    ];

    const updated = applyTrackRowsToVideo(file, rows, "audio");
    const audioTracks = updated.tracks.filter((track) => track.type === "audio");

    // Every source track is still represented exactly once: no track is dropped
    // silently and none is duplicated.
    expect(audioTracks.map((track) => track.id)).toEqual(["a1", "a3", "a2"]);
    expect(audioTracks.map((track) => track.name)).toEqual(["Hindi", "Telugu", "Tamil"]);
    // Only the deleted one is marked for removal.
    expect(audioTracks.map((track) => track.action)).toEqual(["keep", "keep", "remove"]);
  });

  it("marks a deleted last track as removed rather than keeping it", () => {
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
        id: "audio-1",
        trackIndex: 2,
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

    expect(audioTracks.map((track) => track.id)).toEqual(["a1", "a2", "a3"]);
    expect(audioTracks.find((track) => track.id === "a3")?.action).toBe("remove");
  });

  it("leaves tracks of other types untouched when audio rows are deleted", () => {
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
    ];

    const updated = applyTrackRowsToVideo(file, rows, "audio");
    const videoTracks = updated.tracks.filter((track) => track.type === "video");

    expect(videoTracks).toHaveLength(1);
    expect(videoTracks[0].action).toBe("keep");
    expect(updated.tracks).toHaveLength(4);
  });
});

/** Two videos that disagree at audio position 1: Japanese and default in one,
 *  undetermined and not default in the other. Neither track is named. */
const mixedVideos = (): VideoFile[] => [
  {
    id: "ep1",
    name: "ep1.mkv",
    path: "/v/ep1.mkv",
    size: 1,
    status: "pending",
    tracks: [
      { id: "0", type: "video", codec: "HEVC", language: "und", isDefault: true, action: "keep" },
      { id: "1", type: "audio", codec: "AAC", language: "jpn", isDefault: true, isForced: false, action: "keep" },
    ],
  },
  {
    id: "ep2",
    name: "ep2.mkv",
    path: "/v/ep2.mkv",
    size: 1,
    status: "pending",
    tracks: [
      { id: "0", type: "video", codec: "HEVC", language: "und", isDefault: true, action: "keep" },
      { id: "1", type: "audio", codec: "AAC", language: "und", isDefault: false, isForced: false, action: "keep" },
    ],
  },
];

/** What Modify tracks' Apply does with these rows, for every type. */
const applyAll = (files: VideoFile[], rowsByType: Partial<Record<"video" | "audio" | "subtitle", TrackRowDraft[]>> = {}) =>
  files.map((file) =>
    (["video", "subtitle", "audio"] as const).reduce(
      (updated, type) => applyTrackRowsToVideo(updated, rowsByType[type] ?? aggregateTrackRows(files, type), type),
      file,
    ),
  );

const audioOf = (file: VideoFile) => file.tracks.filter((track) => track.type === "audio");

describe("Modify tracks rows (aggregateTrackRows + applyTrackRowsToVideo)", () => {
  it("changes nothing when applied untouched, though the videos disagree", () => {
    const files = mixedVideos();
    const updated = applyAll(files);

    updated.forEach((file, index) => {
      const before = files[index].tracks;
      file.tracks.forEach((track, t) => {
        expect(track.language).toBe(before[t].language);
        expect(track.isDefault).toBe(before[t].isDefault);
        expect(track.isForced).toBe(before[t].isForced);
        expect(track.name).toBe(before[t].name);
        expect(track.action).toBe("keep");
      });
    });
  });

  it("shows a value the videos disagree on as mixed, not as one of them", () => {
    const [row] = aggregateTrackRows(mixedVideos(), "audio");

    expect(row.language).toBe("");
    expect(row.mixed).toMatchObject({ language: true, setDefault: true, setForced: false, trackName: false });
  });

  it("changes only the field the user set, in every video", () => {
    const files = mixedVideos();
    const [row] = aggregateTrackRows(files, "audio");
    const updated = applyAll(files, { audio: [{ ...row, setForced: true }] });

    expect(audioOf(updated[0])[0]).toMatchObject({ language: "jpn", isDefault: true, isForced: true, action: "modify" });
    expect(audioOf(updated[1])[0]).toMatchObject({ language: "und", isDefault: false, isForced: true, action: "modify" });
    expect(audioOf(updated[0])[0].name).toBeUndefined();
  });

  it("sets a mixed language for every video once the user picks one", () => {
    const files = mixedVideos();
    const [row] = aggregateTrackRows(files, "audio");
    const updated = applyAll(files, { audio: [{ ...row, language: "eng" }] });

    expect(updated.map((file) => audioOf(file)[0].language)).toEqual(["eng", "eng"]);
    expect(updated.map((file) => audioOf(file)[0].isDefault)).toEqual([true, false]);
  });

  it("keeps an unnamed track unnamed instead of naming it after its codec", () => {
    const files = mixedVideos();
    const [row] = aggregateTrackRows(files, "audio");

    expect(row.trackName).toBe("");
    expect(row.namePlaceholder).toBe("AAC");
    expect(applyAll(files).map((file) => audioOf(file)[0].name)).toEqual([undefined, undefined]);

    const renamed = applyAll(files, { audio: [{ ...row, trackName: "Japanese" }] });
    expect(renamed.map((file) => audioOf(file)[0].name)).toEqual(["Japanese", "Japanese"]);
  });

  it("keeps a track one video drops dropped, and the other kept, when Copy is untouched", () => {
    const files = mixedVideos();
    files[1].tracks[1] = { ...files[1].tracks[1], action: "remove" };
    const updated = applyAll(files);

    expect(updated.map((file) => audioOf(file)[0].action)).toEqual(["keep", "remove"]);
  });
});

describe("moveTrackRow", () => {
  // The drop line follows this: moving down, the row lands after the one it
  // was dropped on; moving up, before it.
  it("places a row dragged down after the target and one dragged up before it", () => {
    expect(moveTrackRow(["A", "B", "C", "D"], 0, 2)).toEqual(["B", "C", "A", "D"]);
    expect(moveTrackRow(["A", "B", "C", "D"], 3, 1)).toEqual(["A", "D", "B", "C"]);
  });
});
