/** Match by audio: which video a file belongs to, found by listening rather
 *  than by its name. Each file the names could not place is measured quickly
 *  against the videos it might be (the engine's analyze, two short windows on
 *  its fast route), and the surest pairs win.
 *
 *  It is the measurement command with a run of its own (`match-…`), so the
 *  delay measurement's listeners ignore it and it ignores theirs. The page
 *  claims the engine around it, as for a measurement. */

import { useCallback, useEffect, useRef, useState } from "react";

import { includedAudioTrackIndices, plannedReferenceTrack } from "@/features/workspace/lib/measurePairs";
import { applyAudioMatches, assignByAudio, type AudioMatchJob, type AudioMatchResult } from "@/features/workspace/lib/smartPairing";
import { listenMeasureDelaysDone, listenMeasureDelaysProgress, listenMeasureDelaysResult, measureDelaysCancel, measureDelaysStart } from "@/shared/lib/backend";
import type { ExternalFile, MeasurementSettings, VideoFile } from "@/shared/types";
import { ENGINE_DEFAULTS, type MeasurePair } from "@/shared/types/audiosync";

/** Short and few: enough to tell one episode from another, not to measure a delay. */
export const AUDIO_MATCH_WINDOWS = { windowCount: 2, windowSeconds: 30 } as const;

export interface AudioMatchSummary {
  /** Every pair tried, with what the engine heard. */
  results: (AudioMatchResult & { fileName: string; videoName: string; error: string | null })[];
  /** The pairs taken. */
  matched: AudioMatchResult[];
  /** Files tried and left where they were. */
  unmatched: string[];
  cancelled: boolean;
  error: string | null;
}

interface UseAudioMatchInput {
  videoFiles: VideoFile[];
  files: ExternalFile[];
  onFilesChange: (files: ExternalFile[]) => void;
  referenceTrackByVideoId: Record<string, number>;
  measurement?: MeasurementSettings;
  /** Called once a run ends, however it ends. */
  onFinished: (summary: AudioMatchSummary) => void;
}

interface Planned {
  fileId: string;
  videoId: string;
  fileName: string;
  videoName: string;
}

export function useAudioMatch({ videoFiles, files, onFilesChange, referenceTrackByVideoId, measurement, onFinished }: UseAudioMatchInput) {
  const [matching, setMatching] = useState(false);
  const [progress, setProgress] = useState<{ processed: number; total: number } | null>(null);

  // Events outlive the render that started the run: read the latest through refs.
  const filesRef = useRef(files);
  filesRef.current = files;
  const videosRef = useRef(videoFiles);
  videosRef.current = videoFiles;
  const onChangeRef = useRef(onFilesChange);
  onChangeRef.current = onFilesChange;
  const onFinishedRef = useRef(onFinished);
  onFinishedRef.current = onFinished;

  const runIdRef = useRef<string | null>(null);
  const plannedRef = useRef<Map<string, Planned>>(new Map());
  const heardRef = useRef<Map<string, { confidence: number; error: string | null }>>(new Map());

  const finish = useCallback((cancelled: boolean, error: string | null) => {
    runIdRef.current = null;
    setMatching(false);
    setProgress(null);
    const planned = [...plannedRef.current.entries()];
    const results = planned.map(([key, pair]) => {
      const heard = heardRef.current.get(key);
      return { fileId: pair.fileId, videoId: pair.videoId, fileName: pair.fileName, videoName: pair.videoName, confidence: heard?.confidence ?? 0, error: heard?.error ?? (heard ? null : "Not measured") };
    });
    // A cancelled or failed run still places what it heard for sure.
    const matched = assignByAudio(results.filter((result) => !result.error));
    if (matched.length > 0) {
      const next = applyAudioMatches(filesRef.current, videosRef.current, matched);
      filesRef.current = next;
      onChangeRef.current(next);
    }
    const placed = new Set(matched.map((match) => match.fileId));
    const unmatched = [...new Set(results.filter((result) => !placed.has(result.fileId)).map((result) => result.fileName))];
    onFinishedRef.current({ results, matched, unmatched, cancelled, error });
  }, []);

  useEffect(() => {
    const unlisteners: Array<() => void> = [];
    let disposed = false;
    const collect = (un: () => void) => {
      if (disposed) un();
      else unlisteners.push(un);
    };
    listenMeasureDelaysProgress((payload) => {
      if (payload.runId !== runIdRef.current) return;
      setProgress({ processed: payload.processed, total: payload.total });
    }).then(collect);
    listenMeasureDelaysResult((payload) => {
      if (payload.runId !== runIdRef.current || !payload.key || !plannedRef.current.has(payload.key)) return;
      const { result } = payload;
      heardRef.current.set(payload.key, { confidence: result.error ? 0 : (result.confidence ?? 0), error: result.error });
    }).then(collect);
    listenMeasureDelaysDone((payload) => {
      if (payload.runId !== runIdRef.current) return;
      finish(payload.cancelled, payload.error);
    }).then(collect);
    return () => {
      disposed = true;
      unlisteners.forEach((un) => un());
    };
  }, [finish]);

  /** Listen to each job's file against its videos. Returns false when there
   *  was nothing to start, or it could not start (the caller gives the engine back). */
  const start = useCallback(
    async (jobs: AudioMatchJob[]): Promise<boolean> => {
      if (runIdRef.current) return false;
      const planned = new Map<string, Planned>();
      const pairs: MeasurePair[] = [];
      for (const job of jobs) {
        const secondaryTrack = includedAudioTrackIndices(job.file)[0]?.streamIndex ?? 0;
        for (const video of job.videos) {
          const key = `match::${job.file.id}::${video.id}`;
          planned.set(key, { fileId: job.file.id, videoId: video.id, fileName: job.file.name, videoName: video.name });
          pairs.push({
            primaryPath: video.path,
            secondaryPath: job.file.path,
            key,
            method: "mkvbatchmux-match",
            score: 1,
            primaryTrack: plannedReferenceTrack(video, referenceTrackByVideoId),
            secondaryTrack,
          });
        }
      }
      if (pairs.length === 0) return false;
      const runId = `match-${Date.now()}`;
      runIdRef.current = runId;
      plannedRef.current = planned;
      heardRef.current = new Map();
      setMatching(true);
      setProgress({ processed: 0, total: pairs.length });
      try {
        await measureDelaysStart({
          runId,
          pairs,
          ...AUDIO_MATCH_WINDOWS,
          maxOffsetMs: measurement?.maxOffsetMs ?? ENGINE_DEFAULTS.maxOffsetMs,
          maxWorkers: ENGINE_DEFAULTS.maxWorkers,
          fast: true,
          timeline: false,
        });
        return true;
      } catch (error) {
        finish(false, String(error));
        return false;
      }
    },
    [finish, measurement?.maxOffsetMs, referenceTrackByVideoId],
  );

  const cancel = useCallback(async () => {
    if (!runIdRef.current) return;
    await measureDelaysCancel().catch(() => undefined);
  }, []);

  return { matching, progress, start, cancel };
}
