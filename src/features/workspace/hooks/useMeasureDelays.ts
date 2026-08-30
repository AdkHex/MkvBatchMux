/** Drives a delay-measurement run: builds the pairs, streams the engine's
 *  results back into the audio files, and reports progress.
 *
 *  Results are applied as they arrive rather than at the end, so a cancelled
 *  batch keeps everything it already measured.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "@/shared/hooks/use-toast";
import type { ExternalFile, VideoFile } from "@/shared/types";
import type { EngineStatus, SyncResult } from "@/shared/types/audiosync";
import { ENGINE_DEFAULTS } from "@/shared/types/audiosync";
import {
  audiosyncEngineStatus,
  listenMeasureDelaysDone,
  listenMeasureDelaysProgress,
  listenMeasureDelaysResult,
  measureDelaysCancel,
  measureDelaysStart,
} from "@/shared/lib/backend";
import { applyMeasurement } from "@/features/workspace/lib/applyMeasurement";
import { isAutoFillable } from "@/features/workspace/lib/delayConversion";
import {
  buildMeasurementPlan,
  parseMeasurementKey,
  type PlannedMeasurement,
} from "@/features/workspace/lib/measurePairs";

export interface MeasureProgress {
  processed: number;
  total: number;
  current: string | null;
}

interface UseMeasureDelaysInput {
  videoFiles: VideoFile[];
  audioFiles: ExternalFile[];
  onAudioFilesChange: (files: ExternalFile[]) => void;
  referenceTrackByVideoId: Record<string, number>;
}

export function useMeasureDelays({
  videoFiles,
  audioFiles,
  onAudioFilesChange,
  referenceTrackByVideoId,
}: UseMeasureDelaysInput) {
  const [engine, setEngine] = useState<EngineStatus | null>(null);
  const [isMeasuring, setIsMeasuring] = useState(false);
  const [progress, setProgress] = useState<MeasureProgress | null>(null);

  // The event handlers below outlive the render that created them, so the
  // current file list and the run's plan are read through refs rather than
  // captured -- otherwise a result arriving after any edit would write into a
  // stale copy of the list and silently discard that edit.
  const audioFilesRef = useRef(audioFiles);
  audioFilesRef.current = audioFiles;
  const onChangeRef = useRef(onAudioFilesChange);
  onChangeRef.current = onAudioFilesChange;

  const runIdRef = useRef<string | null>(null);
  const planRef = useRef<Map<string, PlannedMeasurement>>(new Map());
  const forcedRef = useRef(false);
  // Best score seen per file this run (usability tier + confidence). When a video's audio tracks give
  // no clue which one matches the dub, several are measured and the sharpest
  // correlation wins -- so a later, worse result must not overwrite a better
  // one that already arrived.
  const bestConfidenceRef = useRef<Map<string, number>>(new Map());

  useEffect(() => {
    let cancelled = false;
    audiosyncEngineStatus()
      .then((status) => {
        if (!cancelled) setEngine(status);
      })
      .catch(() => {
        if (!cancelled) {
          setEngine({
            engineAvailable: false,
            ffmpegAvailable: false,
            enginePath: null,
            message: "The audio analysis engine could not be reached.",
          });
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const applyResult = useCallback((key: string | null, result: SyncResult) => {
    if (!key) return;
    const planned = planRef.current.get(key);
    if (!planned) return;

    const { audioFileId, trackId } = parseMeasurementKey(key);

    // Results arrive in whatever order the workers finish, so compare against
    // the best so far rather than assuming the first one is authoritative.
    //
    // Usability outranks confidence. A candidate that correlated beautifully
    // against the wrong track still reports a cut, or an offset too large to
    // be real, and letting it win on score alone would discard the usable
    // answer sitting behind it -- which is exactly the pairing the user wants.
    // Within a tier the sharper correlation wins as before.
    const usable = isAutoFillable(result);
    const score = (result.confidence ?? 0) + (usable ? 1 : 0);
    const scope = `${audioFileId}::${trackId ?? "file"}`;
    const best = bestConfidenceRef.current.get(scope);
    if (best !== undefined && score <= best) return;
    bestConfidenceRef.current.set(scope, score);

    const measuredAt = new Date().toISOString();

    const next = audioFilesRef.current.map((file) =>
      file.id === audioFileId
        ? applyMeasurement({
            file,
            result,
            trackId,
            referenceTrack: planned.pair.primaryTrack,
            measuredAt,
            force: forcedRef.current,
          })
        : file,
    );
    onChangeRef.current(next);
  }, []);

  useEffect(() => {
    const unlisteners: Array<() => void> = [];

    listenMeasureDelaysProgress((payload) => {
      if (payload.runId !== runIdRef.current) return;
      setProgress({
        processed: payload.processed,
        total: payload.total,
        current: payload.current,
      });
    }).then((un) => unlisteners.push(un));

    listenMeasureDelaysResult((payload) => {
      if (payload.runId !== runIdRef.current) return;
      applyResult(payload.key, payload.result);
    }).then((un) => unlisteners.push(un));

    listenMeasureDelaysDone((payload) => {
      if (payload.runId !== runIdRef.current) return;
      setIsMeasuring(false);
      setProgress(null);
      runIdRef.current = null;

      if (payload.error) {
        toast({
          title: "Measurement failed",
          description: payload.error,
          variant: "destructive",
        });
      } else if (payload.cancelled) {
        toast({
          title: "Measurement cancelled",
          description: "Delays measured before cancelling have been kept.",
        });
      } else {
        // Measuring no longer writes the delay field, so say what to do next
        // rather than implying the work is finished.
        toast({
          title: "Measurement complete",
          description: "Review the results, then Apply to fill in the delays.",
        });
      }
    }).then((un) => unlisteners.push(un));

    return () => {
      unlisteners.forEach((un) => un());
    };
  }, [applyResult]);

  const start = useCallback(
    async (options: { onlyAudioFileIds?: string[]; force?: boolean } = {}) => {
      if (isMeasuring) return;

      if (!engine?.engineAvailable || !engine.ffmpegAvailable) {
        toast({
          title: "Cannot measure delays",
          description: engine?.message ?? "The audio analysis engine is unavailable.",
          variant: "destructive",
        });
        return;
      }

      const plan = buildMeasurementPlan({
        videoFiles,
        audioFiles: audioFilesRef.current,
        referenceTrackByVideoId,
        force: options.force,
        onlyAudioFileIds: options.onlyAudioFileIds,
      });

      if (plan.measurements.length === 0) {
        const reason =
          plan.unmatched.length > 0
            ? `${plan.unmatched.length} audio file(s) match no video, so there is nothing to measure against.`
            : plan.skipped.length > 0
              ? "Every audio file has already been measured. Use Re-measure all, or the re-measure button on a row."
              : "Add audio files first.";
        toast({ title: "Nothing to measure", description: reason });
        return;
      }

      if (plan.unmatched.length > 0) {
        toast({
          title: `Skipping ${plan.unmatched.length} unmatched file(s)`,
          description: "They do not match any loaded video, so there is nothing to measure against.",
        });
      }

      const runId = `measure-${Date.now()}`;
      runIdRef.current = runId;
      forcedRef.current = Boolean(options.force);
      planRef.current = new Map(plan.measurements.map((m) => [m.pair.key, m]));

      bestConfidenceRef.current = new Map();
      setIsMeasuring(true);
      setProgress({ processed: 0, total: plan.measurements.length, current: null });

      try {
        await measureDelaysStart({
          runId,
          pairs: plan.measurements.map((m) => m.pair),
          ...ENGINE_DEFAULTS,
        });
      } catch (error) {
        setIsMeasuring(false);
        setProgress(null);
        runIdRef.current = null;
        toast({
          title: "Could not start measurement",
          description: String(error),
          variant: "destructive",
        });
      }
    },
    [engine, isMeasuring, referenceTrackByVideoId, videoFiles],
  );

  const cancel = useCallback(async () => {
    try {
      await measureDelaysCancel();
      // Deliberately "requested", not "cancelled": the engine's command loop
      // does not read stdin while a batch is running, so the request lands
      // when the current batch ends rather than interrupting it. Claiming it
      // stopped would be a lie the progress bar immediately contradicts.
      toast({
        title: "Cancellation requested",
        description:
          "The engine finishes the files already in flight before stopping. Delays measured so far are kept.",
      });
    } catch (error) {
      toast({
        title: "Could not cancel",
        description: String(error),
        variant: "destructive",
      });
    }
  }, []);

  return { engine, isMeasuring, progress, start, cancel };
}
