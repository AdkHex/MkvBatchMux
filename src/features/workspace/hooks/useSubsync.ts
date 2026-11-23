/** Drives Sync subtitles: measures each subtitle against its video and keeps
 *  each result on its file as it arrives. Rows synced against a subtitle
 *  track inside the video and rows synced against its speech are two engine
 *  runs (the engine takes one reference kind per run), one after the other.
 *  The caller claims the engine first and releases it in `onFinished`. */

import { useCallback, useEffect, useRef, useState } from "react";

import type { EngineStatus } from "@/shared/types/audiosync";
import type { ExternalFile, VideoFile } from "@/shared/types";
import type { SubsyncEngine, SubsyncRequest, SubsyncResultEvent } from "@/shared/types/engineFeatures";
import { audiosyncEngineStatus, measureDelaysCancel } from "@/shared/lib/backend";
import { listenSubsyncDone, listenSubsyncProgress, listenSubsyncResult, subsyncStart } from "@/shared/lib/engineFeatures";
import { applySubsyncResult, buildSubsyncPlan, subsyncRuns, syncRecord, type PlannedSync } from "@/features/workspace/lib/subsync";
import type { SubtitleSync } from "@/shared/types";

export interface SubsyncProgress {
  /** Which run: against the videos' subtitle tracks, or their speech. */
  engine: SubsyncEngine;
  processed: number;
  total: number;
  /** Rows in flight: percent and stage, by file id. */
  active: Record<string, { percent: number; stage: string | null }>;
}

export interface SubsyncSummary {
  /** Every row measured or answered, with what it came to. */
  results: Array<{ fileId: string; fileName: string; videoName: string; record: SubtitleSync }>;
  skipped: Array<{ fileName: string; reason: string }>;
  cancelled: boolean;
  error: string | null;
  startedAt: number;
}

interface UseSubsyncInput {
  videoFiles: VideoFile[];
  subtitleFiles: ExternalFile[];
  onSubtitleFilesChange: (files: ExternalFile[]) => void;
  /** Every `start` ends here exactly once, also one that sent nothing. */
  onFinished: (summary: SubsyncSummary) => void;
}

interface Phase {
  runId: string;
  engine: SubsyncEngine;
  request: SubsyncRequest;
}

export function useSubsync({ videoFiles, subtitleFiles, onSubtitleFilesChange, onFinished }: UseSubsyncInput) {
  const [engine, setEngine] = useState<EngineStatus | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [progress, setProgress] = useState<SubsyncProgress | null>(null);

  const filesRef = useRef(subtitleFiles);
  filesRef.current = subtitleFiles;
  const onChangeRef = useRef(onSubtitleFilesChange);
  onChangeRef.current = onSubtitleFilesChange;
  const onFinishedRef = useRef(onFinished);
  onFinishedRef.current = onFinished;

  const runRef = useRef<{ phases: Phase[]; current: number; plan: Map<string, PlannedSync>; summary: SubsyncSummary } | null>(null);

  useEffect(() => {
    let cancelled = false;
    audiosyncEngineStatus()
      .then((status) => !cancelled && setEngine(status))
      .catch(() => !cancelled && setEngine({ engineAvailable: false, ffmpegAvailable: false, enginePath: null, engineVersion: null, message: "The audio analysis engine could not be reached." }));
    return () => {
      cancelled = true;
    };
  }, []);

  /** Write one row's record, starting from the last write: results can come
   *  faster than the parent re-renders. */
  const write = useCallback((fileId: string, update: (file: ExternalFile) => ExternalFile) => {
    const next = filesRef.current.map((file) => (file.id === fileId ? update(file) : file));
    filesRef.current = next;
    onChangeRef.current(next);
  }, []);

  const finish = useCallback((cancelled: boolean, error: string | null) => {
    const run = runRef.current;
    runRef.current = null;
    setSyncing(false);
    setProgress(null);
    if (run) onFinishedRef.current({ ...run.summary, cancelled, error });
  }, []);

  /** Start the run's next phase; false when there is none left or it could not start. */
  const startPhase = useCallback(async (index: number): Promise<boolean> => {
    const run = runRef.current;
    const phase = run?.phases[index];
    if (!run || !phase) return false;
    run.current = index;
    setProgress({ engine: phase.engine, processed: 0, total: phase.request.jobs.length, active: {} });
    try {
      await subsyncStart(phase.request);
      return true;
    } catch (error) {
      finish(false, String(error));
      return false;
    }
  }, [finish]);

  useEffect(() => {
    const unlisteners: Array<() => void> = [];
    let disposed = false;
    const collect = (un: () => void) => {
      if (disposed) un();
      else unlisteners.push(un);
    };
    const phaseOf = (runId: string) => {
      const run = runRef.current;
      return run && run.phases[run.current]?.runId === runId ? run : null;
    };
    listenSubsyncProgress((payload) => {
      const run = phaseOf(payload.runId);
      if (!run) return;
      const fileId = payload.key ? run.plan.get(payload.key)?.fileId : undefined;
      setProgress((prev) => {
        const active = { ...(prev?.active ?? {}) };
        if (fileId) {
          if (payload.percent >= 100) delete active[fileId];
          else active[fileId] = { percent: payload.percent, stage: payload.stage };
        }
        return { engine: run.phases[run.current].engine, processed: payload.processed, total: payload.total, active };
      });
    }).then(collect);
    listenSubsyncResult((payload: SubsyncResultEvent) => {
      const run = phaseOf(payload.runId);
      const planned = run && payload.key ? run.plan.get(payload.key) : undefined;
      if (!run || !planned) return;
      const record = syncRecord(payload, planned, new Date().toISOString());
      run.summary.results.push({ fileId: planned.fileId, fileName: planned.fileName, videoName: planned.videoName, record });
      write(planned.fileId, (file) => applySubsyncResult(file, record, planned.trackId));
    }).then(collect);
    listenSubsyncDone(async (payload) => {
      const run = phaseOf(payload.runId);
      if (!run) return;
      if (!payload.cancelled && !payload.error && (await startPhase(run.current + 1))) return;
      if (runRef.current === run) finish(payload.cancelled, payload.error);
    }).then(collect);
    return () => {
      disposed = true;
      unlisteners.forEach((un) => un());
    };
  }, [finish, startPhase, write]);

  /** Sync these files (all of them when `fileIds` is absent). */
  const start = useCallback(
    async (fileIds?: string[]): Promise<boolean> => {
      if (runRef.current) return false;
      const plan = buildSubsyncPlan({ videoFiles, files: filesRef.current, fileIds });
      const startedAt = Date.now();
      const summary: SubsyncSummary = { results: [], skipped: plan.skipped.map(({ file, reason }) => ({ fileName: file.name, reason })), cancelled: false, error: null, startedAt };
      // Pictures, and rows with nothing to sync against, are answered here.
      const measuredAt = new Date(startedAt).toISOString();
      for (const { file, video, outcome, message } of plan.answered) {
        const record: SubtitleSync = {
          engine: "subtitle",
          videoPath: video.path,
          videoName: video.name,
          referenceTrack: 0,
          outcome,
          offsetS: null,
          ratio: null,
          splits: 0,
          score: null,
          confidence: null,
          held: false,
          description: message,
          framerate: null,
          warnings: [],
          retimedPath: null,
          measuredAt,
        };
        summary.results.push({ fileId: file.id, fileName: file.name, videoName: video.name, record });
        write(file.id, (current) => applySubsyncResult(current, record, null));
      }
      const phases: Phase[] = subsyncRuns(plan.planned, startedAt).map(({ request }) => ({ runId: request.runId, engine: request.engine, request }));
      if (phases.length === 0) {
        onFinishedRef.current(summary);
        return true;
      }
      runRef.current = { phases, current: 0, plan: new Map(plan.planned.map((entry) => [entry.job.key, entry])), summary };
      setSyncing(true);
      await startPhase(0);
      return true;
    },
    [videoFiles, startPhase, write],
  );

  const cancel = useCallback(async () => {
    await measureDelaysCancel();
  }, []);

  return { engine, syncing, progress, start, cancel };
}
