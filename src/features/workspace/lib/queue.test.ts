import { describe, expect, it } from "vitest";

import type { MuxJob, VideoFile } from "@/shared/types";
import { jobsToRun, parallelJobs, syncJobs } from "./queue";

const video = (id: string, status: VideoFile["status"] = "pending"): VideoFile => ({ id, name: `${id}.mkv`, path: `/v/${id}.mkv`, size: 100, status, tracks: [] });

describe("syncJobs", () => {
  it("queues every loaded video, in the list's order", () => {
    const jobs = syncJobs([], [video("a"), video("b")]);
    expect(jobs.map((job) => [job.id, job.status])).toEqual([
      ["job-a", "queued"],
      ["job-b", "queued"],
    ]);
  });

  it("leaves out a video that could not be read", () => {
    expect(syncJobs([], [video("a"), video("b", "error")]).map((job) => job.id)).toEqual(["job-a"]);
  });

  it("keeps a job's progress when its video stays, and drops it when the video goes", () => {
    const a = video("a");
    const b = video("b");
    const first = syncJobs([], [a, b]);
    const muxed = first.map((job) => (job.id === "job-a" ? { ...job, status: "completed" as const, progress: 100 } : job));
    const next = syncJobs(muxed, [a]);
    expect(next).toEqual([muxed[0]]);
  });

  it("returns the same array when nothing changed", () => {
    const videos = [video("a")];
    const jobs = syncJobs([], videos);
    expect(syncJobs(jobs, videos)).toBe(jobs);
  });

  it("follows a video that was edited after it was queued", () => {
    const a = video("a");
    const jobs = syncJobs([], [a]);
    const edited = { ...a, tracks: [{ id: "t", type: "audio" as const, codec: "AAC" }] } as VideoFile;
    expect(syncJobs(jobs, [edited])[0].videoFile).toBe(edited);
  });
});

describe("jobsToRun", () => {
  const job = (id: string, status: MuxJob["status"]): MuxJob => ({ id, videoFile: video(id), status, progress: 0 });

  it("sends only what is not muxed yet", () => {
    const jobs = [job("a", "completed"), job("b", "error"), job("c", "queued"), job("d", "stopped")];
    expect(jobsToRun(jobs).map((j) => j.id)).toEqual(["b", "c", "d"]);
  });

  it("sends everything again once all are done", () => {
    const jobs = [job("a", "completed"), job("b", "completed")];
    expect(jobsToRun(jobs)).toBe(jobs);
  });
});

describe("parallelJobs", () => {
  it("is automatic at 0: every job, up to the limit", () => {
    expect(parallelJobs(0, 5, 16)).toBe(5);
    expect(parallelJobs(0, 40, 16)).toBe(16);
  });

  it("follows the setting, never more than there are jobs", () => {
    expect(parallelJobs(4, 16, 16)).toBe(4);
    expect(parallelJobs(8, 3, 16)).toBe(3);
    expect(parallelJobs(2, 0, 16)).toBe(1);
  });
});
