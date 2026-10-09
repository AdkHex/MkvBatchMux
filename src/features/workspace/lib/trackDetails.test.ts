import { describe, expect, it } from "vitest";
import type { Track, VideoFile } from "@/shared/types";
import { sharedReferenceIndex } from "./measurePairs";
import { channelLayout, referencePositions, trackDetails } from "./trackDetails";

const video = (id: string, tracks: Partial<Track>[]): VideoFile => ({
  id,
  name: `${id}.mkv`,
  path: `/v/${id}.mkv`,
  size: 1,
  status: "pending",
  tracks: tracks.map((track, i) => ({ id: String(i + 1), type: "audio", ...track })),
});

const chinese = { language: "chi", codec: "E-AC-3", channels: 6, name: "Zh-cn [Dolby Digital Plus 5.1]" };

describe("the reference for every video", () => {
  it("does not offer one video's track as everyone's", () => {
    // The screenshot: three videos, only the third with three Chinese tracks.
    const videos = [
      video("shou-zhe-tian", [{ ...chinese, codec: "AC-3", bitrate: 448_000 }]),
      video("remux", [{ language: "chi", codec: "DTS-HD Master Audio", channels: 6 }]),
      video("web-dl", [chinese, { language: "chi", codec: "AAC", channels: 2 }, { language: "chi", codec: "DTS", channels: 6 }]),
    ];

    expect(referencePositions(videos).map((choice) => choice.label)).toEqual([
      "Track 1 of each video · differs by video, see Against",
      "Track 2 of each video · only 1 of 3 have one, the rest use their last",
      "Track 3 of each video · only 1 of 3 have one, the rest use their last",
    ]);
  });

  it("names the track when every video has the same one there", () => {
    // Bitrate and the default flag differ from file to file for the same track.
    const videos = [video("e01", [{ ...chinese, bitrate: 640_000, isDefault: true }]), video("e02", [{ ...chinese, bitrate: 448_000 }])];
    expect(referencePositions(videos)[0].label).toBe("Track 1 of each video · Chinese · E-AC-3 · 5.1 · Zh-cn [Dolby Digital Plus 5.1]");
  });

  it("still reads as one choice when videos with fewer tracks took their last", () => {
    const videos = [video("a", [chinese]), video("b", [chinese, chinese, chinese])];
    expect(sharedReferenceIndex(videos, {})).toBe(0);
    expect(sharedReferenceIndex(videos, { a: 0, b: 2 })).toBe(2);
    // Set apart by hand: one video on its second track, the other on its third, both having three.
    expect(sharedReferenceIndex([video("a", [chinese, chinese, chinese]), videos[1]], { a: 1, b: 2 })).toBeNull();
  });
});

describe("trackDetails", () => {
  it("tells apart three tracks in the same language", () => {
    const labels = [
      { language: "chi", codec: "E-AC-3", channels: 6, bitrate: 640_000, name: "Zh-cn [Dolby Digital Plus 5.1]", isDefault: true },
      { language: "chi", codec: "AAC", channels: 2, bitrate: 128_000, name: "Cantonese" },
      { language: "chi", codec: "DTS", channels: 8 },
    ].map((track, index) => trackDetails(track, index));

    expect(labels).toEqual([
      "1 · Chinese · E-AC-3 · 5.1 · 640 kb/s · Zh-cn [Dolby Digital Plus 5.1] · default",
      "2 · Chinese · AAC · 2.0 · 128 kb/s · Cantonese",
      "3 · Chinese · DTS · 7.1",
    ]);
  });

  it("leaves out what the file does not say", () => {
    expect(trackDetails({ name: "  " }, 0)).toBe("1");
    expect(trackDetails({ language: "xyz" }, 1)).toBe("2 · xyz");
  });

  it("names the usual channel layouts", () => {
    expect([1, 2, 6, 8, 4, undefined].map(channelLayout)).toEqual(["1.0", "2.0", "5.1", "7.1", "4 ch", null]);
  });
});
