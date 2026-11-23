import { describe, expect, it } from "vitest";

import { isPlaceholder, linkExternalFilesByOrder } from "@/shared/lib/matchUtils";
import type { ExternalFile, VideoFile } from "@/shared/types";

import {
  applyAudioMatches,
  assignByAudio,
  audioMatchJobs,
  conflictMessages,
  defaultPairBy,
  describePairing,
  dropPlaceholders,
  moveByHand,
  moveToRow,
  pairByEpisode,
  pairLabel,
  usableKeys,
} from "./smartPairing";

const video = (name: string, durationSeconds?: number, folder = "/tv/Show/Season 1"): VideoFile => ({
  id: `v:${name}`,
  name,
  path: `${folder}/${name}`,
  size: 1,
  status: "pending",
  tracks: [],
  durationSeconds,
});

const dub = (name: string, extra: Partial<ExternalFile> = {}): ExternalFile => ({
  id: `a:${name}`,
  name,
  path: `/dubs/${name}`,
  type: "audio",
  ...extra,
});

const season = (count: number, s = 1, length = 2700) =>
  Array.from({ length: count }, (_, i) => video(`Show.S0${s}E${String(i + 1).padStart(2, "0")}.1080p.mkv`, length + i * 10));
const dubs = (episodes: number[], s = 1, length = 2700) =>
  episodes.map((e) => dub(`Show.S0${s}E${String(e).padStart(2, "0")}.Hindi.eac3`, { durationSeconds: length + (e - 1) * 10 }));

/** The rows as names, "—" for an empty one. */
const names = (files: ExternalFile[]) => files.map((file) => (isPlaceholder(file) ? "—" : file.name.replace(/^Show\.|\.Hindi\.eac3$/g, "")));

describe("defaultPairBy", () => {
  it("pairs by episode when 80 % of the names on both sides have one", () => {
    const videos = season(5);
    const files = [...dubs([1, 2, 3, 4]), dub("Track 2.eac3")];
    expect(defaultPairBy(files, videos)).toBe("episode");
  });

  it("pairs by order below that, as before", () => {
    const videos = season(3);
    expect(defaultPairBy([...dubs([1]), dub("Track 2.eac3")], videos)).toBe("order");
    expect(defaultPairBy(dubs([1, 2]), [video("Movie.mkv"), video("Other.mkv")])).toBe("order");
    expect(defaultPairBy([dub("a.mka"), dub("b.mka")], season(2))).toBe("order");
  });

  it("counts a bare number only when it is a numbering the list shares", () => {
    const videos = [video("Goblin 01.mkv"), video("Goblin 02.mkv"), video("Goblin 03.mkv")];
    expect(usableKeys(videos).map((key) => key?.episode)).toEqual([1, 2, 3]);
    expect(usableKeys([dub("Track 2.eac3"), dub("Show.Hindi.eac3")])).toEqual([null, null]);
    expect(defaultPairBy([dub("Goblin 01.eac3"), dub("Goblin 02.eac3"), dub("Goblin 03.eac3")], videos)).toBe("episode");
  });

  it("ignores placeholders and is order with nothing on a side", () => {
    expect(defaultPairBy([], season(2))).toBe("order");
    expect(defaultPairBy(dubs([1]), [])).toBe("order");
  });
});

describe("pairByEpisode", () => {
  it("leaves a gap where an episode's dub is missing, so the rest stay with their own videos", () => {
    const videos = season(5);
    const result = pairByEpisode(dubs([1, 2, 4, 5]), videos);
    expect(names(result.files)).toEqual(["S01E01", "S01E02", "—", "S01E04", "S01E05"]);
    expect(result.files.map((file) => file.matchedVideoId)).toEqual(videos.map((v) => v.id));
    expect(result.conflicts).toEqual([]);
    expect(Object.values(result.pairs).every((info) => info.method === "episode" && info.confidence === 1)).toBe(true);
  });

  it("puts files in the videos' order whatever order they came in", () => {
    const videos = season(3);
    const result = pairByEpisode(dubs([3, 1, 2]), videos);
    expect(names(result.files)).toEqual(["S01E01", "S01E02", "S01E03"]);
  });

  it("puts files no video takes after the last video, and says why", () => {
    const videos = season(3);
    const result = pairByEpisode([...dubs([1, 3, 4]), dub("Track 2.eac3")], videos);
    expect(names(result.files)).toEqual(["S01E01", "—", "S01E03", "S01E04", "Track 2.eac3"]);
    expect(result.files[3].matchedVideoId).toBeUndefined();
    expect(result.conflicts.map((c) => [c.row, c.kind, c.short])).toEqual([
      [3, "unmatched", "No S01E04"],
      [4, "unmatched", "No episode"],
    ]);
  });

  it("keeps the first of two files for one episode, preferring the one whose length agrees", () => {
    const videos = season(2);
    const wrongLength = dub("Show.S01E02.Hindi.eac3", { id: "dup-long", durationSeconds: 3600 });
    const right = dub("Show.S01E02.Hindi.v2.eac3", { id: "dup-right", durationSeconds: 2710 });
    const result = pairByEpisode([...dubs([1]), wrongLength, right], videos);
    expect(result.files.map((file) => file.id)).toEqual(["a:Show.S01E01.Hindi.eac3", "dup-right", "dup-long"]);
    expect(result.conflicts).toEqual([
      expect.objectContaining({ kind: "duplicate", row: 2, otherRow: 1, short: "Second S01E02", message: "is a second S01E02: row 2 has Show.S01E02.Hindi.v2.eac3." }),
    ]);
  });

  it("does not pair across seasons, and names the season", () => {
    const videos = season(2, 1);
    const result = pairByEpisode([...dubs([1], 1), ...dubs([2], 2)], videos);
    expect(names(result.files)).toEqual(["S01E01", "—", "S02E02"]);
    expect(result.files[2].matchedVideoId).toBeUndefined();
    expect(result.conflicts[0]).toMatchObject({ kind: "season", short: "Season 2", message: "is S02E02, but the videos are season 1." });
  });

  it("takes the season from the videos' folder", () => {
    const videos = ["Show - 01.mkv", "Show - 02.mkv"].map((name) => video(name, undefined, "/tv/Show/Season 2"));
    const result = pairByEpisode([dub("Show.S02E02.eac3"), dub("Show.S02E01.eac3")], videos);
    expect(names(result.files)).toEqual(["S02E01.eac3", "S02E02.eac3"]);
  });

  it("pairs a name without a season by its episode alone", () => {
    const videos = season(3);
    const result = pairByEpisode([dub("[Group] Show - 03 [1080p].mka"), dub("[Group] Show - 01 [1080p].mka")], videos);
    expect(result.files.map((file) => file.matchedVideoId)).toEqual(videos.map((v) => v.id));
    expect(names(result.files)).toEqual(["[Group] Show - 01 [1080p].mka", "—", "[Group] Show - 03 [1080p].mka"]);
  });

  it("pairs a multi-episode file with the video it starts in, with a warning", () => {
    const videos = season(3);
    const result = pairByEpisode([dub("Show.S01E01-E02.eac3"), ...dubs([3])], videos);
    expect(names(result.files)).toEqual(["S01E01-E02.eac3", "—", "S01E03"]);
    expect(result.pairs["a:Show.S01E01-E02.eac3"].warnings.join(" ")).toContain("covers S01E01–E02");
  });

  it("flags a length more than 5 % off, without refusing the pair", () => {
    const videos = [video("Show.S01E01.mkv", 2700)];
    const result = pairByEpisode([dub("Show.S01E01.eac3", { durationSeconds: 2400 })], videos);
    expect(result.conflicts).toEqual([]);
    expect(result.pairs["a:Show.S01E01.eac3"]).toMatchObject({ method: "episode" });
    expect(result.pairs["a:Show.S01E01.eac3"].warnings[0]).toMatch(/^Its length is 11 % off its video's \(40:00 against 45:00\)/);
    // A PAL speed-up (4 %) is within it.
    expect(pairByEpisode([dub("Show.S01E01.eac3", { durationSeconds: 2592 })], videos).pairs["a:Show.S01E01.eac3"].warnings).toEqual([]);
  });

  it("never flags a subtitle's or a chapter file's length: theirs run from the first line to the last, not the video's", () => {
    const videos = [video("Show.S01E01.mkv", 2700)];
    const subtitle = dub("Show.S01E01.en.srt", { type: "subtitle", durationSeconds: 2400 });
    const chapters = dub("Show.S01E01.chapters.xml", { type: "chapter", durationSeconds: 60 });
    expect(pairByEpisode([subtitle], videos).pairs["a:Show.S01E01.en.srt"].warnings).toEqual([]);
    expect(pairByEpisode([chapters], videos).pairs["a:Show.S01E01.chapters.xml"].warnings).toEqual([]);
  });

  it("keeps a hand link over the names, and pairs the displaced file as a second one", () => {
    const videos = season(3);
    const byHand = dub("Show.S01E03.Hindi.eac3", { matchedVideoId: videos[1].id, isManuallyLinked: true });
    const result = pairByEpisode([...dubs([1, 2]), byHand], videos);
    expect(result.files[1]).toBe(byHand);
    expect(result.pairs[byHand.id]).toMatchObject({ method: "hand", confidence: 1 });
    expect(names(result.files)).toEqual(["S01E01", "S01E03", "—", "S01E02"]);
    expect(result.conflicts).toEqual([expect.objectContaining({ kind: "duplicate", row: 3, otherRow: 1 })]);
  });

  it("keeps a file Match by audio placed, and drops pins to videos that are gone", () => {
    const videos = season(2);
    const heard = dub("Track 2.eac3", { matchedVideoId: videos[1].id, audioMatch: { videoId: videos[1].id, confidence: 0.91 } });
    const gone = dub("Show.S01E01.Hindi.eac3", { matchedVideoId: "v:removed", isManuallyLinked: true });
    const result = pairByEpisode([gone, heard], videos);
    expect(names(result.files)).toEqual(["S01E01", "Track 2.eac3"]);
    expect(result.pairs[heard.id]).toMatchObject({ method: "audio", confidence: 0.91 });
    expect(result.files[0]).toMatchObject({ matchedVideoId: videos[0].id, isManuallyLinked: false });
    expect(pairLabel(result.pairs[heard.id])).toBe("Audio 91%");
  });

  it("gives back the very same list when there is nothing to change", () => {
    const videos = season(4);
    const first = pairByEpisode(dubs([1, 2, 4]), videos);
    const again = pairByEpisode(first.files, videos);
    expect(again.files).toBe(first.files);
    // And files already in order and complete need no placeholders at all.
    const complete = linkExternalFilesByOrder(dubs([1, 2, 3, 4]), videos);
    expect(pairByEpisode(complete, videos).files).toBe(complete);
  });

  it("leaves no empty rows after the last file", () => {
    const result = pairByEpisode(dubs([1, 2]), season(6));
    expect(result.files).toHaveLength(2);
  });

  it("keeps each file's own settings as it moves", () => {
    const videos = season(3);
    const measured = dub("Show.S01E03.Hindi.eac3", { delay: 1.312, delayProvenance: "measured", trackOverrides: { 0: { delay: 0.5 } } });
    const result = pairByEpisode([measured, ...dubs([1])], videos);
    expect(result.files[2]).toMatchObject({ delay: 1.312, delayProvenance: "measured", trackOverrides: { 0: { delay: 0.5 } }, matchedVideoId: videos[2].id });
  });
});

describe("describePairing", () => {
  it("makes a different episode a conflict when pairing by order with clear names", () => {
    const videos = season(3);
    const files = linkExternalFilesByOrder(dubs([1, 3, 2]), videos);
    const report = describePairing(files, videos, "order");
    expect(report.conflicts.map((c) => [c.row, c.kind])).toEqual([
      [1, "mismatch"],
      [2, "mismatch"],
    ]);
    expect(report.conflicts[0].message).toBe("is S01E03, but its video Show.S01E02.1080p.mkv is S01E02.");
    expect(report.pairs[files[0].id]).toMatchObject({ method: "order", confidence: 1 });
  });

  it("names a season mismatch", () => {
    const videos = season(1, 1);
    const files = linkExternalFilesByOrder(dubs([1], 2), videos);
    expect(describePairing(files, videos).conflicts[0]).toMatchObject({ kind: "season", short: "Other season" });
  });

  it("only warns where the names are too weak to be sure", () => {
    const videos = [video("Goblin 01.mkv"), video("Goblin 02.mkv")];
    const files = linkExternalFilesByOrder([dub("Goblin 02.eac3"), dub("Goblin 01.eac3")], videos);
    const report = describePairing(files, videos, "order");
    expect(report.conflicts).toEqual([]);
    expect(report.pairs[files[0].id].warnings[0]).toContain("episode 2");
  });

  it("does not compare absolute numbering with seasons", () => {
    const videos = season(1, 2);
    const files = linkExternalFilesByOrder([dub("[Group] Show - 13 [1080p].mka")], videos);
    expect(describePairing(files, videos).conflicts).toEqual([]);
  });

  it("lets a pairing kept by hand stand", () => {
    const videos = season(2);
    const files = linkExternalFilesByOrder(dubs([2, 1]), videos).map((file) => ({ ...file, isManuallyLinked: true }));
    const report = describePairing(files, videos);
    expect(report.conflicts).toEqual([]);
    expect(report.pairs[files[0].id].method).toBe("hand");
  });

  it("says files past the last video have none, and which row is free for them", () => {
    const videos = season(2);
    const files = linkExternalFilesByOrder([dub("a.mka"), dub("b.mka"), dub("c.mka")], videos);
    expect(describePairing(files, videos).conflicts).toEqual([expect.objectContaining({ row: 2, kind: "unmatched", message: "has no video to go into." })]);
    const twice = linkExternalFilesByOrder([...dubs([1, 2]), ...dubs([2])].map((f, i) => ({ ...f, id: `x${i}` })), videos);
    expect(describePairing(twice, videos).conflicts).toEqual([expect.objectContaining({ row: 2, kind: "duplicate", otherRow: 1 })]);
    const free = linkExternalFilesByOrder([...dubs([1]), dub("x.mka"), ...dubs([2])], videos.slice(0, 1).concat([]));
    expect(describePairing(free, videos).conflicts.map((c) => c.message)).toEqual(["has no video to go into.", "has no video to go into, though Show.S01E02.1080p.mkv has no file."]);
  });

  it("reads the links, so a chapter file linked by hand to another row's video is that video's", () => {
    const videos = season(3);
    const files = [
      { ...dubs([3])[0], matchedVideoId: videos[2].id, isManuallyLinked: true },
      { ...dubs([2])[0], matchedVideoId: videos[1].id },
      { ...dubs([1])[0], matchedVideoId: undefined },
    ];
    const report = describePairing(files, videos);
    expect(report.pairs[files[0].id].method).toBe("hand");
    expect(report.conflicts.map((c) => [c.row, c.kind])).toEqual([[2, "unmatched"]]);
  });

  it("never reports a placeholder", () => {
    const videos = season(3);
    const { files } = pairByEpisode(dubs([1, 3]), videos);
    const report = describePairing(files, videos, "episode");
    expect(report.conflicts).toEqual([]);
    expect(Object.keys(report.pairs)).toEqual(["a:Show.S01E01.Hindi.eac3", "a:Show.S01E03.Hindi.eac3"]);
  });
});

describe("conflictMessages", () => {
  it("names the slot, the row and the file", () => {
    const videos = season(1);
    const files = linkExternalFilesByOrder(dubs([2]), videos);
    expect(conflictMessages(describePairing(files, videos), files, "Audio 1")).toEqual(["Audio 1, row 1: Show.S01E02.Hindi.eac3 is S01E02, but its video Show.S01E01.1080p.mkv is S01E01."]);
  });

  it("sums up a long list", () => {
    const videos = season(1);
    const files = linkExternalFilesByOrder([dub("a.mka"), dub("b.mka"), dub("c.mka"), dub("d.mka"), dub("e.mka")], videos);
    const lines = conflictMessages(describePairing(files, videos), files, "Subtitle 2");
    expect(lines).toEqual(["Subtitle 2, row 2: b.mka has no video to go into.", "Subtitle 2, row 3: c.mka has no video to go into.", "Subtitle 2: 2 more files to pair, rows 4, 5."]);
  });
});

describe("moving rows", () => {
  it("moves a file into an empty row without shifting the others", () => {
    const videos = season(4);
    const { files } = pairByEpisode([...dubs([1, 2, 4]), dub("Track 2.eac3")], videos);
    expect(names(files)).toEqual(["S01E01", "S01E02", "—", "S01E04", "Track 2.eac3"]);
    expect(names(moveToRow(files, "a:Track 2.eac3", 2, videos))).toEqual(["S01E01", "S01E02", "Track 2.eac3", "S01E04"]);
  });

  it("trades places by hand and pins both files", () => {
    const videos = season(3);
    const { files } = pairByEpisode(dubs([1, 2, 3]), videos);
    const moved = moveByHand(files, 0, 2, videos);
    expect(names(moved)).toEqual(["S01E03", "S01E02", "S01E01"]);
    expect(moved[0]).toMatchObject({ isManuallyLinked: true, matchedVideoId: videos[0].id });
    expect(moved[2]).toMatchObject({ isManuallyLinked: true, matchedVideoId: videos[2].id });
    // Arranged again, the hand links hold.
    expect(names(pairByEpisode(moved, videos).files)).toEqual(["S01E03", "S01E02", "S01E01"]);
  });

  it("drops placeholders for pairing by order, keeping the files' order", () => {
    const { files } = pairByEpisode(dubs([1, 3]), season(3));
    expect(names(dropPlaceholders(files))).toEqual(["S01E01", "S01E03"]);
  });
});

describe("match by audio", () => {
  it("listens to the files no video takes against the videos without a file, within 10 % of their length", () => {
    const videos = [...season(3), video("Show.S01E04.mkv", 4000)];
    const track = dub("Track 2.eac3", { durationSeconds: 2720 });
    const arranged = pairByEpisode([...dubs([1]), track], videos);
    const jobs = audioMatchJobs(arranged.files, videos, arranged);
    expect(jobs.map((job) => [job.file.name, job.videos.map((v) => v.name)])).toEqual([["Track 2.eac3", ["Show.S01E02.1080p.mkv", "Show.S01E03.1080p.mkv"]]]);
  });

  it("listens to both files of a duplicate, against that episode's video too", () => {
    const videos = season(3);
    const a = dub("Show.S01E02.Hindi.eac3", { id: "a", durationSeconds: 2710 });
    const b = dub("Show.S01E02.Hindi.eac3", { id: "b", path: "/dubs/other/Show.S01E02.Hindi.eac3", durationSeconds: 2710 });
    const arranged = pairByEpisode([...dubs([1]), a, b], videos);
    const jobs = audioMatchJobs(arranged.files, videos, arranged);
    expect(jobs.map((job) => [job.file.id, job.videos.map((v) => v.name)])).toEqual([
      ["a", ["Show.S01E02.1080p.mkv", "Show.S01E03.1080p.mkv"]],
      ["b", ["Show.S01E02.1080p.mkv", "Show.S01E03.1080p.mkv"]],
    ]);
  });

  it("assigns the surest first, each file and video once, nothing under 0.6", () => {
    const assigned = assignByAudio([
      { fileId: "x", videoId: "v2", confidence: 0.7 },
      { fileId: "y", videoId: "v2", confidence: 0.95 },
      { fileId: "x", videoId: "v3", confidence: 0.65 },
      { fileId: "z", videoId: "v4", confidence: 0.59 },
    ]);
    expect(assigned).toEqual([
      { fileId: "y", videoId: "v2", confidence: 0.95 },
      { fileId: "x", videoId: "v3", confidence: 0.65 },
    ]);
  });

  it("places each heard file beside its video, pinned there, in either pairing", () => {
    const videos = season(3);
    const arranged = pairByEpisode([...dubs([1]), dub("Track 2.eac3", { delay: 2 })], videos);
    const placed = applyAudioMatches(arranged.files, videos, [{ fileId: "a:Track 2.eac3", videoId: videos[2].id, confidence: 0.88 }]);
    expect(names(placed)).toEqual(["S01E01", "—", "Track 2.eac3"]);
    expect(placed[2]).toMatchObject({ matchedVideoId: videos[2].id, audioMatch: { videoId: videos[2].id, confidence: 0.88 }, delay: 2 });
    expect(names(pairByEpisode(placed, videos).files)).toEqual(["S01E01", "—", "Track 2.eac3"]);
    // Pairing by order keeps it there too.
    expect(linkExternalFilesByOrder(placed, videos)[2]).toBe(placed[2]);
  });
});
