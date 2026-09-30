/** The mux queue is every loaded video: there is no separate "add to queue"
 *  step. These keep the queue in step with the Videos list and pick what a
 *  run sends. */

import type { MuxJob, VideoFile } from "@/shared/types";

export const jobIdOf = (video: VideoFile) => `job-${video.id}`;

/** One job per video that can be muxed (not one that failed to read), in the
 *  list's order. A video already in the queue keeps its job, and so its
 *  progress and result; a new one starts queued. Returns the same array when
 *  nothing changed, so setting it is a no-op. */
export function syncJobs(jobs: MuxJob[], videos: VideoFile[]): MuxJob[] {
  const byId = new Map(jobs.map((job) => [job.id, job] as const));
  const next = videos
    .filter((video) => video.status !== "error")
    .map((video): MuxJob => {
      const job = byId.get(jobIdOf(video));
      if (!job) return { id: jobIdOf(video), videoFile: video, status: "queued", progress: 0, sizeBefore: video.size };
      return job.videoFile === video ? job : { ...job, videoFile: video, sizeBefore: video.size };
    });
  const same = next.length === jobs.length && next.every((job, index) => job === jobs[index]);
  return same ? jobs : next;
}

/** The jobs a run sends: those not muxed yet (queued, failed, stopped). When
 *  every one is done, all of them, so Start muxes the batch again. */
export function jobsToRun(jobs: MuxJob[]): MuxJob[] {
  const pending = jobs.filter((job) => job.status !== "completed");
  return pending.length > 0 ? pending : jobs;
}

/** How many jobs run at once: the setting when there is one (0 is automatic:
 *  every job, up to the limit), never more than there are jobs. */
export function parallelJobs(setting: number, jobCount: number, limit: number): number {
  const wanted = setting > 0 ? setting : limit;
  return Math.max(1, Math.min(wanted, limit, jobCount || 1));
}
