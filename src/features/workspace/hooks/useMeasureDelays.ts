/** Drives a delay-measurement run, applying results as they arrive so a
 *  cancelled batch keeps everything it already measured. */

import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "@/ui/toast";
import type { ExternalFile, MeasurementSettings, VideoFile } from "@/shared/types";
import type { EngineStatus, MeasureStartRequest, SyncResult, TimelineScan } from "@/shared/types/audiosync";
import { ENGINE_DEFAULTS, WIDE_SEARCH_MS } from "@/shared/types/audiosync";
import {
  audiosyncEngineStatus,
  listenMeasureDelaysDone,
  listenMeasureDelaysFile,
  listenMeasureDelaysProgress,
  listenMeasureDelaysResult,
  listenTimelineScanDone,
  listenTimelineScanProgress,
  listenTimelineScanResult,
  measureDelaysCancel,
  measureDelaysStart,
  scanTimelineStart,
} from "@/shared/lib/backend";
import { applyMeasurement } from "@/features/workspace/lib/applyMeasurement";
import { needsWiderSearch } from "@/features/workspace/lib/delayConversion";
import {
  attachTimelineScan,
  isRateChange,
  summarizeTimeline,
} from "@/features/workspace/lib/timelineScan";
import {
  buildMeasurementPlan,
  isSameTrack,
  parseMeasurementKey,
  sameTrackResult,
  type PlannedMeasurement,
} from "@/features/workspace/lib/measurePairs";
import { pairDone, pairMoved, type RunProgress } from "@/features/workspace/lib/measureProgress";

export interface MeasureProgress extends RunProgress {
  /** Measuring delays; then either searching wider for the pairs that found nothing, or, when
   *  the whole-timeline option is on, scanning each pair's full timeline for cuts. */
  phase: "measure" | "wide" | "scan";
  /** The video of the pair that finished last. */
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
  // Fixed for the length of a run, so changing Settings mid-run cannot mix routes.
  const fullTimelineRef = useRef(false);
  const passRef = useRef<"measure" | "wide">("measure");
  // Pairs the survey could not place, for the wide search that follows it.
  const retryKeysRef = useRef<Set<string>>(new Set());
  const settingsRef = useRef<Omit<MeasureStartRequest, "runId" | "pairs" | "fast" | "timeline">>({
    ...ENGINE_DEFAULTS,
  });
  const maxWorkersRef = useRef<number>(ENGINE_DEFAULTS.maxWorkers);
  const scansRef = useRef<TimelineScan[]>([]);
  // Videos whose pair finished this pass, so a late event cannot put one back in flight.
  const finishedRef = useRef<Set<string>>(new Set());
  // Pairs the engine already laid along the whole timeline while measuring: their plan came
  // back with the result, so scanning them again would only repeat the slowest work.
  const scannedByMeasureRef = useRef<Set<string>>(new Set());

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
    const scan = result.timeline
      ? summarizeTimeline(result.timeline, result.timelineDescription ?? null, null, measuredAt)
      : null;

    // The measurement and the plan it came with go in as one update: attached separately, the
    // second write would start from a list that does not have the first in it yet.
    const next = audioFilesRef.current.map((file) => {
      if (file.id !== audioFileId) return file;
      const measured = applyMeasurement({
        file,
        result,
        trackId,
        referenceTrack: planned.pair.primaryTrack,
        measuredAt,
        force: forcedRef.current,
      });
      return scan ? attachTimelineScan(measured, trackId, scan) : measured;
    });
    if (scan) {
      scansRef.current.push(scan);
      scannedByMeasureRef.current.add(key);
    }
    if (passRef.current === "measure" && !fullTimelineRef.current && needsWiderSearch(result)) {
      retryKeysRef.current.add(key);
    }
    // Results can arrive faster than the parent re-renders; the next one must start from this.
    audioFilesRef.current = next;
    onChangeRef.current(next);
  }, []);

  const applyScan = useCallback((key: string | null, scan: TimelineScan) => {
    if (!key || !planRef.current.has(key)) return;
    const { audioFileId, trackId } = parseMeasurementKey(key);
    scansRef.current.push(scan);
    const next = audioFilesRef.current.map((file) =>
      file.id === audioFileId ? attachTimelineScan(file, trackId, scan) : file,
    );
    audioFilesRef.current = next;
    onChangeRef.current(next);
  }, []);

  /** Sum up what the timeline found across the run, as the closing toast. */
  const reportFindings = useCallback((cancelled: boolean) => {
    const scans = scansRef.current;
    const withCuts = scans.filter((scan) => scan.cuts.length > 0).length;
    const rateChanges = scans.filter((scan) => !scan.error && isRateChange(scan)).length;
    const failed = scans.filter((scan) => scan.error).length;
    const findings = [
      withCuts > 0 ? `${withCuts} with cuts` : null,
      rateChanges > 0 ? `${rateChanges} with a frame-rate change` : null,
      failed > 0 ? `${failed} could not be scanned` : null,
    ].filter(Boolean);
    toast({
      title: cancelled ? "Timeline scan cancelled" : "Measurement and timeline scan complete",
      description:
        findings.length > 0
          ? `Of ${scans.length} pair(s): ${findings.join(", ")}. Check the warnings on those rows, then Apply.`
          : `No cuts or frame-rate changes across ${scans.length} pair(s). Review the results, then Apply.`,
      variant: withCuts > 0 || rateChanges > 0 || failed > 0 ? "destructive" : undefined,
    });
  }, []);

  const finish = useCallback(() => {
    setIsMeasuring(false);
    setProgress(null);
    runIdRef.current = null;
  }, []);

  /** Follow a finished measurement with the full-timeline scan of the same pairs. Returns
   *  false when it could not start, so the caller reports the measurement as the end. */
  const startScan = useCallback(async (runId: string): Promise<boolean> => {
    const pairs = [...planRef.current.values()]
      .map((planned) => planned.pair)
      .filter((pair) => !scannedByMeasureRef.current.has(pair.key));
    if (pairs.length === 0) return false;
    setProgress({ phase: "scan", processed: 0, total: pairs.length, current: null, active: {} });
    try {
      await scanTimelineStart({ runId, pairs, maxWorkers: maxWorkersRef.current });
      return true;
    } catch (error) {
      toast({ title: "Could not scan for cuts", description: String(error), variant: "destructive" });
      return false;
    }
  }, []);

  /** Measure again the pairs the survey could not place, with the engine's fast route over a
   *  five-minute search. Returns false when there is none, or it could not start. */
  const startWideSearch = useCallback(async (runId: string): Promise<boolean> => {
    const pairs = [...retryKeysRef.current]
      .map((key) => planRef.current.get(key)?.pair)
      .filter((pair): pair is PlannedMeasurement["pair"] => pair !== undefined);
    if (pairs.length === 0) return false;
    const settings = settingsRef.current;
    passRef.current = "wide";
    runIdRef.current = runId;
    finishedRef.current = new Set();
    setProgress({ phase: "wide", processed: 0, total: pairs.length, current: null, active: {} });
    try {
      await measureDelaysStart({
        runId,
        pairs,
        ...settings,
        maxOffsetMs: Math.max(settings.maxOffsetMs, WIDE_SEARCH_MS),
        fast: true,
        timeline: false,
      });
      return true;
    } catch (error) {
      toast({ title: "Could not search wider", description: String(error), variant: "destructive" });
      return false;
    }
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
      // The engine names the pair that just finished, not one being measured.
      if (payload.current) finishedRef.current.add(payload.current);
      setProgress((prev) => ({
        ...pairDone(prev ?? { active: {}, processed: 0, total: payload.total }, payload.current, payload.processed, payload.total),
        phase: passRef.current,
        current: payload.current,
      }));
    }).then(collect);

    listenMeasureDelaysFile((payload) => {
      if (payload.runId !== runIdRef.current) return;
      setProgress((prev) => (prev ? pairMoved(prev, payload.file, payload.percent, finishedRef.current) : prev));
    }).then(collect);

    listenMeasureDelaysResult((payload) => {
      if (payload.runId !== runIdRef.current) return;
      applyResult(payload.key, payload.result);
    }).then(collect);

    listenMeasureDelaysDone(async (payload) => {
      if (payload.runId !== runIdRef.current) return;

      if (!payload.error && !payload.cancelled && passRef.current === "measure") {
        if (fullTimelineRef.current) {
          const scanRunId = `${payload.runId}-scan`;
          runIdRef.current = scanRunId;
          if (await startScan(scanRunId)) return;
        } else if (await startWideSearch(`${payload.runId}-wide`)) {
          return;
        }
      }
      finish();

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
      } else if (scansRef.current.length > 0) {
        // Every pair was laid along its timeline while measuring; there was nothing left to scan.
        reportFindings(false);
      } else {
        // Measuring only records results, not the delay field itself.
        toast({
          title: "Measurement complete",
          description: "Review the results, then Apply to fill in the delays.",
        });
      }
    }).then(collect);

    listenTimelineScanProgress((payload) => {
      if (payload.runId !== runIdRef.current) return;
      const video = (payload.key ? planRef.current.get(payload.key) : undefined)?.videoName;
      setProgress((prev) => {
        const base: MeasureProgress = { active: prev?.active ?? {}, phase: "scan", processed: payload.processed, total: payload.total, current: null };
        if (!video) return base;
        return payload.percent >= 100 ? pairDone(base, video, payload.processed, payload.total) : { ...base, active: { ...base.active, [video]: payload.percent } };
      });
    }).then(collect);

    listenTimelineScanResult((payload) => {
      if (payload.runId !== runIdRef.current) return;
      applyScan(
        payload.key,
        summarizeTimeline(payload.plan, payload.description, payload.error, new Date().toISOString()),
      );
    }).then(collect);

    listenTimelineScanDone((payload) => {
      if (payload.runId !== runIdRef.current) return;
      finish();
      if (payload.error) {
        toast({ title: "Timeline scan failed", description: payload.error, variant: "destructive" });
        return;
      }
      reportFindings(payload.cancelled);
    }).then(collect);

    return () => {
      disposed = true;
      unlisteners.forEach((un) => un());
    };
  }, [applyResult, applyScan, finish, reportFindings, startScan, startWideSearch]);

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
      scansRef.current = [];
      scannedByMeasureRef.current = new Set();
      retryKeysRef.current = new Set();
      finishedRef.current = new Set();
      passRef.current = "measure";
      planRef.current = new Map(plan.measurements.map((m) => [m.pair.key, m]));

      // An audio file that is the video itself, same track, is zero by
      // definition: answered here rather than measured for minutes.
      const same = plan.measurements.filter((m) => isSameTrack(m.pair));
      const toMeasure = plan.measurements.filter((m) => !isSameTrack(m.pair));
      for (const m of same) applyResult(m.pair.key, sameTrackResult(m.pair, videoFiles.find((video) => video.id === m.videoId)?.fps));
      if (toMeasure.length === 0) {
        runIdRef.current = null;
        toast({
          title: same.length === 1 ? "That audio file is the video itself" : `${same.length} audio files are their videos themselves`,
          description: "Same file, same track: the delay is 0. Check the pairing if that is not what you meant.",
        });
        return;
      }

      setIsMeasuring(true);
      setProgress({ phase: "measure", processed: 0, total: toMeasure.length, current: null, active: {} });

      // Built field by field: settings saved by older versions carry keys the engine must not see.
      const settings = {
        windowSeconds: measurement?.windowSeconds ?? ENGINE_DEFAULTS.windowSeconds,
        windowCount: measurement?.windowCount ?? ENGINE_DEFAULTS.windowCount,
        maxOffsetMs: measurement?.maxOffsetMs ?? ENGINE_DEFAULTS.maxOffsetMs,
        maxWorkers: ENGINE_DEFAULTS.maxWorkers,
      };
      settingsRef.current = settings;
      maxWorkersRef.current = settings.maxWorkers;
      fullTimelineRef.current = measurement?.fullTimeline ?? false;

      try {
        await measureDelaysStart({
          runId,
          pairs: toMeasure.map((m) => m.pair),
          ...settings,
          fast: false,
          timeline: fullTimelineRef.current,
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
    [engine, isMeasuring, referenceTrackByVideoId, videoFiles, measurement, applyResult],
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
