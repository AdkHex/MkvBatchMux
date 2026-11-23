import { describe, expect, it } from "vitest";

import type { MuxJobRequest } from "@/shared/lib/backend";
import { attachOutputNames, describeCollisions } from "./outputNames";

const request = (id: string, path: string): MuxJobRequest => ({
  id: `job-${id}`,
  video: { id, name: path.replace(/^.*[\\/]/, ""), path, size: 1, status: "pending", tracks: [] },
  audios: [],
  subtitles: [],
  chapters: [],
  attachments: [],
});

describe("per-job output names", () => {
  it("leaves patterns main.rs renders alone", () => {
    const requests = [request("a", "W:\\Show\\Show.S01E01.mkv")];
    expect(attachOutputNames(requests, "{original_filename} [muxed]").requests).toBe(requests);
    expect(attachOutputNames(requests, undefined).requests).toBe(requests);
  });

  it("fills outputName from the episode tokens", () => {
    const { requests, collisions } = attachOutputNames([request("a", "W:\\Show\\Season 1\\Show.S01E01.1080p.mkv"), request("b", "W:\\Show\\Season 1\\Show.S01E02.1080p.mkv")], "{show} - {episode}");
    expect(requests.map((item) => item.outputName)).toEqual(["Show - S01E01", "Show - S01E02"]);
    expect(collisions).toEqual([]);
    expect(attachOutputNames([request("a", "W:\\x\\Show.S01E01.mkv")], "{show} {episode}", { show: "Goblin: Lonely" }).requests[0].outputName).toBe("Goblin_ Lonely S01E01");
  });

  it("finds names two jobs would share in one folder, as Windows compares them", () => {
    const jobs = [request("a", "W:\\A\\Show.S01E01.mkv"), request("b", "W:\\B\\show.s01e01.v2.mkv"), request("c", "W:\\A\\Show.S01E02.mkv")];
    // Beside their sources, the two E01s go into different folders.
    expect(attachOutputNames(jobs, "{show} - {episode}").collisions).toEqual([]);
    const { collisions } = attachOutputNames(jobs, "Show - {episode}", { destination: "W:\\Out" });
    expect(collisions).toEqual([{ stem: "Show - S01E01", videos: ["Show.S01E01.mkv", "show.s01e01.v2.mkv"] }]);
    expect(describeCollisions(collisions)).toBe("Show.S01E01.mkv and show.s01e01.v2.mkv would both be saved as Show - S01E01.mkv. Change the output name on the Mux page, or the recipe's.");
    expect(describeCollisions([])).toBe("");
  });
});
