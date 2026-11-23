/** Drives a conform run: lays each chosen dub onto its video's cut and keeps
 *  the new track on the file as it arrives, so a stopped run keeps what it
 *  finished. The caller claims the engine first and releases it in
 *  `onFinished`; cancelling goes through `measure_delays_cancel`, like
 *  measuring. */

import { useCallback, useEffect, useRef, useState } from "react";

import type { ExternalFile, MeasurementSettings, VideoFile } from "@/shared/types";
import type { ConformRequest, ConformResultEvent } from "@/shared/types/engineFeatures";
import { CONFORM_DEFAULTS } from "@/shared/types/engineFeatures";
import { measureDelaysCancel } from "@/shared/lib/backend";
import { conformDubsStart, conformStatus, listenConformDone, listenConformProgress, listenConformResult } from "@/shared/lib/engineFeatures";
import { applyConformResult, buildConformPlan, type PlannedConform } from "@/features/workspace/lib/conform";

export interface ConformProgress {
  processed: number;
  total: number;
  /** Each pair in flight: its percent and stage, by file id. */
  active: Record<string, { percent: number; stage: string | null }>;
}

export interface ConformOutcome {
  fileId: string;
  fileName: string;
  videoName: string;
  status: ReturnType<typeof conformStatus>;
  /** What went wrong, or the check in words. */
  message: string;
  fallbackReason: string | null;
}

export interface ConformSummary {
  outcomes: ConformOutcome[];
  /** Files that were not sent, with why. */
  skipped: Array<{ fileName: string; reason: string }>;
  cancelled: boolean;
  error: string | null;
  startedAt: number;
}

interface UseConformInput {
  videoFiles: VideoFile[];
  audioFiles: ExternalFile[];
  onAudioFilesChange: (files: ExternalFile[]) => void;
  referenceTrackByVideoId?: Record<string, number>;
  /** Preferences › Measurement: mode, codec and output folder. */
  measurement?: MeasurementSettings;
  /** Every `start` ends here exactly once, also one that sent nothing. */
  onFinished: (summary: ConformSummary) => void;
}

/** What a run sends, from Preferences › Measurement, with the defaults the
 *  contract fixes: render, the dub's own codec, beside the dub. */
export function conformOptions(measurement?: MeasurementSettings) {
  return {
    mode: measurement?.conformMode === "lossless" ? ("lossless" as const) : CONFORM_DEFAULTS.mode,
    codec: measurement?.conformCodec === "flac" ? ("flac" as const) : CONFORM_DEFAULTS.codec,
    outputDir: measurement?.conformOutputDir?.trim() ? measurement.conformOutputDir.trim() : null,
    maxWorkers: CONFORM_DEFAULTS.maxWorkers,
  };
}

/** The command a conform run sends for these planned pairs. */
export function buildConformRequest(planned: PlannedConform[], runId: string, measurement?: MeasurementSettings): ConformRequest {
  return { runId, pairs: planned.map((entry) => entry.pair), ...conformOptions(measurement) };
}

export function useConform({ videoFiles, audioFiles, onAudioFilesChange, referenceTrackByVideoId, measurement, onFinished }: UseConformInput) {
  const [conforming, setConforming] = useState(false);
  const [progress, setProgress] = useState<ConformProgress | null>(null);
  /** The last run's failures by file id, shown on their rows until the next run. */
  const [failures, setFailures] = useState<Record<string, string>>({});

  const filesRef = useRef(audioFiles);
  filesRef.current = audioFiles;
  const onChangeRef = useRef(onAudioFilesChange);
  onChangeRef.current = onAudioFilesChange;
  const onFinishedRef = useRef(onFinished);
  onFinishedRef.current = onFinished;

  const runRef = useRef<{ runId: string; plan: Map<string, PlannedConform>; summary: ConformSummary } | null>(null);

  const finish = useCallback((cancelled: boolean, error: string | null) => {
    const run = runRef.current;
    runRef.current = null;
    setConforming(false);
    setProgress(null);
    if (run) onFinishedRef.current({ ...run.summary, cancelled, error });
  }, []);

  const applyResult = useCallback((result: ConformResultEvent) => {
    const run = runRef.current;
    const planned = result.key ? run?.plan.get(result.key) : undefined;
    if (!run || !planned) return;
    const status = conformStatus(result);
    run.summary.outcomes.push({
      fileId: planned.fileId,
      fileName: planned.fileName,
      videoName: planned.videoName,
      status,
      message: status === "failed" ? (result.error ?? "Nothing was written.") : (result.verificationText ?? "Not checked."),
      fallbackReason: result.fallbackReason ?? null,
    });
    if (status === "failed") {
      setFailures((prev) => ({ ...prev, [planned.fileId]: result.error ?? "Nothing was written." }));
      return;
    }
    // Results can come faster than the parent re-renders: start from the last write.
    const next = filesRef.current.map((file) => (file.id === planned.fileId ? applyConformResult(file, result, planned) : file));
    filesRef.current = next;
    onChangeRef.current(next);
  }, []);

  useEffect(() => {
    const unlisteners: Array<() => void> = [];
    let disposed = false;
    const collect = (un: () => void) => {
      if (disposed) un();
      else unlisteners.push(un);
    };
    listenConformProgress((payload) => {
      const run = runRef.current;
      if (!run || payload.runId !== run.runId) return;
      const fileId = payload.key ? run.plan.get(payload.key)?.fileId : undefined;
      setProgress((prev) => {
        const active = { ...(prev?.active ?? {}) };
        if (fileId) {
          if (payload.percent >= 100) delete active[fileId];
          else active[fileId] = { percent: payload.percent, stage: payload.stage };
        }
        return { processed: payload.processed, total: payload.total, active };
      });
    }).then(collect);
    listenConformResult((payload) => {
      if (payload.runId !== runRef.current?.runId) return;
      applyResult(payload);
    }).then(collect);
    listenConformDone((payload) => {
      if (payload.runId !== runRef.current?.runId) return;
      finish(payload.cancelled, payload.error);
    }).then(collect);
    return () => {
      disposed = true;
      unlisteners.forEach((un) => un());
    };
  }, [applyResult, finish]);

  /** Conform these files. Ends in `onFinished`, whether or not anything was
   *  sent (the summary says why not); false only while a run is going. */
  const start = useCallback(
    async (fileIds: string[]): Promise<boolean> => {
      if (runRef.current) return false;
      const { planned, skipped } = buildConformPlan({ videoFiles, files: filesRef.current, fileIds, referenceTrackByVideoId });
      const startedAt = Date.now();
      const summary: ConformSummary = {
        outcomes: [],
        skipped: skipped.map(({ file, reason }) => ({ fileName: file.name, reason })),
        cancelled: false,
        error: null,
        startedAt,
      };
      if (planned.length === 0) {
        onFinishedRef.current({ ...summary, error: skipped.length ? null : "There is nothing to conform." });
        return true;
      }
      const runId = `conform-${startedAt}`;
      runRef.current = { runId, plan: new Map(planned.map((entry) => [entry.pair.key, entry])), summary };
      setFailures((prev) => {
        const next = { ...prev };
        planned.forEach((entry) => delete next[entry.fileId]);
        return next;
      });
      setConforming(true);
      setProgress({ processed: 0, total: planned.length, active: {} });
      try {
        await conformDubsStart(buildConformRequest(planned, runId, measurement));
        return true;
      } catch (error) {
        finish(false, String(error));
        return true;
      }
    },
    [videoFiles, referenceTrackByVideoId, measurement, finish],
  );

  const cancel = useCallback(async () => {
    await measureDelaysCancel();
  }, []);

  return { conforming, progress, failures, start, cancel };
}
