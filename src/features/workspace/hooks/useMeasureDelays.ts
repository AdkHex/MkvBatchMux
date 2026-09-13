/** Drives a delay-measurement run, applying results as they arrive so a
 *  cancelled batch keeps everything it already measured. */

import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "@/shared/hooks/use-toast";
import type { ExternalFile, MeasurementSettings, VideoFile } from "@/shared/types";
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
  /** Engine parameters; must match AudioSyncMaster's settings for the two to agree. */
  measurement?: MeasurementSettings;
}

export function useMeasureDelays({
  videoFiles,
  audioFiles,
  onAudioFilesChange,
  measurement,
  referenceTrackByVideoId,
}: UseMeasureDelaysInput) {
  const [engine, setEngine] = useState<EngineStatus | null>(null);
  const [isMeasuring, setIsMeasuring] = useState(false);
  const [progress, setProgress] = useState<MeasureProgress | null>(null);

  // Event handlers outlive the render that created them, so state is read
  // through refs to avoid writing into a stale copy of the file list.
  const audioFilesRef = useRef(audioFiles);
  audioFilesRef.current = audioFiles;
  const onChangeRef = useRef(onAudioFilesChange);
  onChangeRef.current = onAudioFilesChange;

  const runIdRef = useRef<string | null>(null);
  const planRef = useRef<Map<string, PlannedMeasurement>>(new Map());
  const forcedRef = useRef(false);

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
            engineVersion: null,
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
    // Registration is async, so cleanup can run before the handles arrive;
    // track that with `disposed` and unlisten immediately once it does.
    let disposed = false;
    const collect = (un: () => void) => {
      if (disposed) un();
      else unlisteners.push(un);
    };

    listenMeasureDelaysProgress((payload) => {
      if (payload.runId !== runIdRef.current) return;
      setProgress({
        processed: payload.processed,
        total: payload.total,
        current: payload.current,
      });
    }).then(collect);

    listenMeasureDelaysResult((payload) => {
      if (payload.runId !== runIdRef.current) return;
      applyResult(payload.key, payload.result);
    }).then(collect);

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
        // Measuring only records results, not the delay field itself.
        toast({
          title: "Measurement complete",
          description: "Review the results, then Apply to fill in the delays.",
        });
      }
    }).then(collect);

    return () => {
      disposed = true;
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

        setIsMeasuring(true);
      setProgress({ processed: 0, total: plan.measurements.length, current: null });

      try {
        await measureDelaysStart({
          runId,
          pairs: plan.measurements.map((m) => m.pair),
          ...ENGINE_DEFAULTS,
          ...measurement,
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
    [engine, isMeasuring, referenceTrackByVideoId, videoFiles, measurement],
  );

  const cancel = useCallback(async () => {
    try {
      await measureDelaysCancel();
      // Deliberately "requested", not "cancelled": the engine doesn't read
      // stdin mid-batch, so this only takes effect once it ends.
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
