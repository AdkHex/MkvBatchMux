/** Audio: external audio (dubs) for each video, in track slots (Audio 1,
 *  Audio 2…), with delay measurement. Row n of the list is video n and file
 *  n, which is how the mux pairs them; pairing by episode arranges the list so
 *  each file is in its episode's row, an empty row where one is missing
 *  (smartPairing). The logic is the old Audio tab's; a double-click opens a
 *  file's popup, its measurement above its settings. */

import {
  ArrowImportRegular,
  ArrowSyncRegular,
  ArrowUndoRegular,
  CheckmarkRegular,
  CopyRegular,
  CutRegular,
  DataBarVerticalRegular,
  DeleteRegular,
  DismissRegular,
  FolderOpenRegular,
  GaugeRegular,
  MusicNote2Regular,
  SoundWaveCircleRegular,
  StopRegular,
  TimelineRegular,
} from "@fluentui/react-icons";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { PageDock } from "@/app/dock";
import { runName, timeLeftText, tookText } from "@/app/history";
import { useShell, usePageCommands, useStatus } from "@/app/shell";
import { ImportTrackEditDialog, type ImportTrackOverride } from "@/features/workspace/components/ImportTrackEditDialog";
import { useAudioMatch, type AudioMatchSummary } from "@/features/workspace/hooks/useAudioMatch";
import { useConform, type ConformSummary } from "@/features/workspace/hooks/useConform";
import { useMeasureDelays } from "@/features/workspace/hooks/useMeasureDelays";
import { usePairing } from "@/features/workspace/hooks/usePairing";
import { acceptWithheldMeasurement, applyAllPendingDelays, applyMeasuredDelay, hasPendingDelay, markDelayAsManual, pendingDelayCount } from "@/features/workspace/lib/applyMeasurement";
import { audioFpsFor, formatAudioFps, needsRateChange } from "@/features/workspace/lib/audioFps";
import { engineHolder } from "@/features/workspace/lib/engineHolder";
import { canConform, conformBlocker, conformedFor, conformedHow, conformedStatus, conformRefusal, measuredAsDifferentCut, offersConform, undoConform } from "@/features/workspace/lib/conform";
import { isMeasuredAgainstAnother, measureFindings, measureOutcome, measureStatus, measurementsOf } from "@/features/workspace/lib/measureVerdict";
import { DEFAULT_REFERENCE_TRACK, measuresEachTrack, plannedReferenceTrack, referenceForEveryVideo, sharedReferenceIndex } from "@/features/workspace/lib/measurePairs";
import { frameOffset } from "@/features/workspace/lib/delayConversion";
import { runFraction } from "@/features/workspace/lib/measureProgress";
import { applyTimelineDelay } from "@/features/workspace/lib/timelineScan";
import { rowsWithFile, shareSettings, type EditScope } from "@/features/workspace/lib/editScope";
import { audioMatchJobs } from "@/features/workspace/lib/smartPairing";
import { referencePositions, trackDetails } from "@/features/workspace/lib/trackDetails";
import { shownTrackDelay, trackDelays } from "@/features/workspace/lib/trackDelays";
import { useRowReorder } from "@/features/workspace/lib/useRowReorder";
import { useTabState, type TrackConfig } from "@/features/workspace/store/useTabState";
import { DelayField, delayInputsAreValid } from "@/shared/components/DelayField";
import { CODE_TO_LABEL, LABEL_TO_CODE } from "@/shared/data/languages-iso6393";
import { inspectPaths, pickDirectory, scanMedia } from "@/shared/lib/backend";
import { delaySecondsOrZero } from "@/shared/lib/delayInput";
import { AUDIO_EXTENSIONS } from "@/shared/lib/extensions";
import { getUnlinkedExternalFiles, isPlaceholder, placeholderFor, realFiles } from "@/shared/lib/matchUtils";
import type { ExternalFile, MeasurementSettings, Preset, StretchSetting, VideoFile } from "@/shared/types";
import { Dialog, PageView, Panel, lcdStatus, type LcdProps } from "@/ui/frame";
import { Btn, Chk, Cmd, Combo, DL, Empty, Fld, Grip, LangCombo, Links, Meter, SheetField, Status, TBox, Table, Tr, cx, type St } from "@/ui/kit";
import { toast } from "@/ui/toast";

import { FILTER_OPTIONS, SearchBox, extensionOptions, formatDelay, formatFileSize, looksLikeFolder, matchesSearch, type FilterValue } from "./common";
import { L, MeasureSection, ReportDetails, TrackDelayList, trackLabel } from "./tracks/MeasurePane";
import { MatchCell, PairByCombo, PairingLinks, pairingLine } from "./tracks/pairing";
import { DeleteSlotDialog, FileTrackRow, FileTracks, ImportStreamsDialog, TrackDelaysDialog, TrackSheet, TrackTabs, languageName, nextSlotId } from "./tracks/parts";

export interface AudioPageProps {
  hidden: boolean;
  audioFiles: ExternalFile[];
  videoFiles: VideoFile[];
  onAudioFilesChange: (files: ExternalFile[]) => void;
  onVideoFilesChange?: (files: VideoFile[]) => void;
  preset?: Preset | null;
  /** Preferences › Measurement; the engine gets these, so they must match AudioSyncMaster's. */
  measurement?: MeasurementSettings;
}

const defaultTrackConfig: TrackConfig = {
  sourceFolder: "",
  extension: "all",
  language: "hin",
  trackName: "",
  delay: "0.000",
  isDefault: true,
  isForced: false,
  muxAfter: "video",
};

const normalizeLanguage = (value: string) => {
  if (!value) return "und";
  const trimmed = value.trim();
  if (CODE_TO_LABEL[trimmed]) return trimmed;
  return LABEL_TO_CODE[trimmed] || LABEL_TO_CODE[trimmed.toLowerCase()] || trimmed.toLowerCase();
};

const audioExtensions = [...AUDIO_EXTENSIONS];

const getAudioTrackIds = (file: ExternalFile) =>
  file.tracks ? file.tracks.filter((t) => t.type === "audio").map((t) => Number(t.id)).filter((id) => Number.isFinite(id)) : [];

const getSubtitleTrackIds = (file: ExternalFile) =>
  file.tracks ? file.tracks.filter((t) => t.type === "subtitle").map((t) => Number(t.id)).filter((id) => Number.isFinite(id)) : [];

const getDefaultIncludeSubtitles = (file: ExternalFile) => (file.includeSubtitles !== undefined ? file.includeSubtitles : getSubtitleTrackIds(file).length > 0);

/** Per-track measurement results for a file, in track order. */
const measuredTrackEntries = (file: ExternalFile) => {
  const overrides = file.trackOverrides;
  if (!overrides) return [];
  return (file.tracks ?? [])
    .filter((track) => track.type === "audio")
    .map((track, index) => {
      const trackId = Number(track.id);
      const override = overrides[trackId];
      if (!Number.isFinite(trackId) || !override?.measuredDelay) return null;
      return { trackId, override, track, label: `${index + 1}` };
    })
    .filter((entry): entry is NonNullable<typeof entry> => entry !== null);
};

const createExternalId = () =>
  typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}`;

const audioTracksOf = (video: VideoFile | undefined) => (video?.tracks ?? []).filter((track) => track.type === "audio");

/** The worst status among a file's measurements, for its row; a conformed
 *  file's conform, which is what it is muxed as. */
function rowStatus(file: ExternalFile, currentReferenceTrack: number | undefined, currentVideo?: VideoFile): { s: St; text: string } {
  const conformed = conformedStatus(file, currentVideo);
  if (conformed) return { s: conformed.s, text: conformed.text };
  const entries = [
    ...(file.measuredDelay ? [{ m: file.measuredDelay, pending: file.pendingDelay !== undefined }] : []),
    ...measuredTrackEntries(file).map(({ override }) => ({ m: override.measuredDelay!, pending: override.pendingDelay !== undefined })),
  ];
  if (entries.length === 0) return { s: "ready", text: "Ready" };
  const rank: Record<St, number> = { bad: 0, warn: 1, ok: 2, run: 3, writing: 3, wait: 4, ready: 5, written: 2 };
  return entries.map(({ m, pending }) => measureStatus(m, { pending, currentReferenceTrack, currentVideo })).sort((a, b) => rank[a.s] - rank[b.s])[0];
}

export function AudioPage({ hidden, audioFiles, videoFiles, onAudioFilesChange, preset, measurement }: AudioPageProps) {
  const shell = useShell();
  const {
    audioTracks,
    activeAudioTrack,
    audioTrackConfigs,
    audioPresetApplied,
    setAudioTracks,
    setActiveAudioTrack,
    updateAudioTrackConfig,
    removeAudioTrackConfig,
    setAudioPresetApplied,
  } = useTabState((state) => ({
    audioTracks: state.audioTracks,
    activeAudioTrack: state.activeAudioTrack,
    audioTrackConfigs: state.audioTrackConfigs,
    audioPresetApplied: state.audioPresetApplied,
    setAudioTracks: state.setAudioTracks,
    setActiveAudioTrack: state.setActiveAudioTrack,
    updateAudioTrackConfig: state.updateAudioTrackConfig,
    removeAudioTrackConfig: state.removeAudioTrackConfig,
    setAudioPresetApplied: state.setAudioPresetApplied,
  }));
  /** The selected row: video n and audio file n. */
  const [selectedRow, setSelectedRow] = useState<number | null>(null);
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState<FilterValue>("all");
  // Cleared when the search or the filter changes, as on Videos: a hidden row
  // staying selected would let Remove or Duplicate act on a file out of sight.
  useEffect(() => setSelectedRow(null), [search, filter]);
  /** Which audio track of each video to measure against, by video id. Empty
   *  means "the first audio track", as AudioSyncMaster does. */
  const [referenceTrackByVideoId, setReferenceTrackByVideoId] = useState<Record<string, number>>({});

  /** The reference track in force for the video a file is matched to, so a
   *  measurement taken against a different one can be flagged as out of date. */
  const currentReferenceFor = useCallback(
    (file: ExternalFile): number | undefined => {
      if (!file.matchedVideoId) return undefined;
      const video = videoFiles.find((entry) => entry.id === file.matchedVideoId);
      if (!video) return undefined;
      return plannedReferenceTrack(video, referenceTrackByVideoId);
    },
    [videoFiles, referenceTrackByVideoId],
  );

  /** The video a file is paired with now, as measuring and the mux resolve it. */
  const videoOf = useCallback((file: ExternalFile | undefined): VideoFile | undefined => (file?.matchedVideoId ? videoFiles.find((video) => video.id === file.matchedVideoId) : undefined), [videoFiles]);

  const { engine: audiosyncEngine, isMeasuring, progress: measureProgress, start: startMeasuring, cancel: cancelMeasuring } = useMeasureDelays({
    videoFiles,
    audioFiles,
    onAudioFilesChange,
    referenceTrackByVideoId,
    measurement,
  });
  const measurementAvailable = Boolean(audiosyncEngine?.engineAvailable && audiosyncEngine.ffmpegAvailable);

  // ------------------------------------------------------------- pairing
  // Match by audio holds the engine like a measurement: one run at a time.
  const onMatchFinished = useCallback(
    (summary: AudioMatchSummary) => {
      shell.releaseEngine("audio");
      for (const result of summary.results)
        shell.log(`Match by audio: ${result.fileName} in ${result.videoName}: ${result.error ? result.error : `${Math.round(result.confidence * 100)}% sure`}`);
      if (summary.error) {
        toast({ title: "Match by audio failed", description: summary.error, variant: "destructive" });
        return;
      }
      const matched = summary.matched.length;
      const left = summary.unmatched.length;
      shell.log(`Match by audio: ${matched} paired${left ? `, ${left} left as ${left === 1 ? "it was" : "they were"}` : ""}${summary.cancelled ? " (stopped)" : ""}`);
      toast({
        title: matched ? `Paired ${matched} file${matched === 1 ? "" : "s"} by audio` : summary.cancelled ? "Match by audio stopped" : "No file matched by audio",
        description: left ? `Not sure enough for ${summary.unmatched.slice(0, 3).join(", ")}${left > 3 ? ` and ${left - 3} more` : ""}: pair ${left === 1 ? "it" : "them"} by hand.` : "Each is in its video's row.",
      });
    },
    [shell],
  );
  const { matching, progress: matchProgress, start: startMatching, cancel: cancelMatching } = useAudioMatch({
    videoFiles,
    files: audioFiles,
    onFilesChange: onAudioFilesChange,
    referenceTrackByVideoId,
    measurement,
    onFinished: onMatchFinished,
  });
  // ------------------------------------------------------------- conform
  // Conforming holds the engine like a measurement. Its end gives it back,
  // says what it made, and goes into History.
  const onConformFinished = useCallback(
    (summary: ConformSummary) => {
      shell.releaseEngine("audio");
      for (const skipped of summary.skipped) shell.log(`Conform: ${skipped.fileName}: not conformed: ${skipped.reason}`);
      for (const outcome of summary.outcomes) {
        shell.log(`Conform: ${outcome.fileName} onto ${outcome.videoName}: ${outcome.status === "failed" ? `failed: ${outcome.message}` : outcome.message}`);
      }
      const made = summary.outcomes.filter((outcome) => outcome.status !== "failed");
      const failed = summary.outcomes.length - made.length;
      const toCheck = made.filter((outcome) => outcome.status !== "verified").length;
      if (summary.error && summary.outcomes.length === 0) {
        toast({ title: summary.skipped.length ? "Nothing conformed" : "Could not conform", description: summary.error, variant: "destructive" });
        return;
      }
      if (summary.outcomes.length === 0) {
        toast({ title: "Nothing conformed", description: summary.skipped[0]?.reason ?? "There is nothing to conform." });
        return;
      }
      const parts = [`${made.length} conformed`, toCheck ? `${toCheck} to check` : null, failed ? `${failed} failed` : null, summary.skipped.length ? `${summary.skipped.length} skipped` : null].filter(Boolean) as string[];
      shell.log(`Conformed ${made.length} of ${summary.outcomes.length} dub${summary.outcomes.length === 1 ? "" : "s"} in ${tookText(Date.now() - summary.startedAt)}: ${parts.join(", ")}${summary.cancelled ? " (stopped)" : ""}`);
      shell.addHistory({
        id: createExternalId(),
        page: "audio",
        name: runName(summary.outcomes.map((outcome) => outcome.fileName)),
        outcome: { tone: failed && !made.length ? "bad" : failed || toCheck ? "warn" : "ok", text: parts.join(", ") },
        date: new Date().toISOString(),
        files: summary.outcomes.map((outcome) => ({ name: outcome.fileName, tone: outcome.status === "failed" ? "bad" : outcome.status === "verified" ? "ok" : "warn", text: outcome.status === "failed" ? "Conform failed" : outcome.status === "verified" ? "Conformed" : "Conformed, check it" })),
      });
      toast({
        title: summary.cancelled ? `Conform stopped: ${made.length} conformed` : summary.error ? "Conform ended early" : `Conformed ${made.length} dub${made.length === 1 ? "" : "s"}`,
        description: summary.error ?? (failed ? `${failed} could not be conformed: see the rows marked Conform failed.` : toCheck ? `${toCheck} could not be confirmed against the video: check ${toCheck === 1 ? "it" : "them"} before muxing.` : "Each is laid onto its video's cut and checked. The mux takes the conformed track."),
        variant: failed || summary.error ? "destructive" : undefined,
      });
    },
    [shell],
  );
  const { conforming, progress: conformProgress, failures: conformFailures, start: startConform, cancel: cancelConform } = useConform({
    videoFiles,
    audioFiles,
    onAudioFilesChange,
    referenceTrackByVideoId,
    measurement,
    onFinished: onConformFinished,
  });

  /** A run is writing to the list: measuring delays, matching by audio, or conforming. */
  const busy = isMeasuring || matching || conforming;
  const pairing = usePairing({ files: audioFiles, videoFiles, onFilesChange: onAudioFilesChange, frozen: busy });
  const syncAudioLinks = pairing.sync;
  const pairByFor = pairing.pairByFor;
  /** The files, without the empty rows that keep their places. */
  const realAudioFiles = useMemo(() => realFiles(audioFiles), [audioFiles]);
  const matchJobs = useMemo(() => audioMatchJobs(audioFiles, videoFiles, pairing.report), [audioFiles, videoFiles, pairing.report]);
  const beginMatching = useCallback(async () => {
    if (busy || matchJobs.length === 0) return;
    if (!shell.claimEngine("audio")) {
      toast({ title: engineHolder(shell.enginePage) ?? "The engine is busy", description: "Match once it is done, or stop it first." });
      return;
    }
    const tries = matchJobs.reduce((sum, job) => sum + job.videos.length, 0);
    shell.log(`Matching ${matchJobs.length} file${matchJobs.length === 1 ? "" : "s"} by audio: ${tries} quick listen${tries === 1 ? "" : "s"}`);
    if (!(await startMatching(matchJobs))) shell.releaseEngine("audio");
  }, [busy, matchJobs, shell, startMatching]);

  // ------------------------------------------------------------ the engine
  // One command at a time: measuring holds the engine, so Mux cannot start a
  // batch meanwhile, and the other way round.
  const isMeasuringRef = useRef(isMeasuring);
  isMeasuringRef.current = isMeasuring;
  const matchingRef = useRef(matching);
  matchingRef.current = matching;
  const run = useRef<{ ids: Set<string> | null; startedAt: number } | null>(null);
  const conformingRef = useRef(conforming);
  conformingRef.current = conforming;
  const beginMeasuring = useCallback(
    async (options: { onlyAudioFileIds?: string[]; force?: boolean } = {}) => {
      if (isMeasuringRef.current || matchingRef.current || conformingRef.current) return;
      if (!shell.claimEngine("audio")) {
        toast({ title: engineHolder(shell.enginePage) ?? "The engine is busy", description: "Measure once it is done, or stop it first." });
        return;
      }
      run.current = { ids: options.onlyAudioFileIds ? new Set(options.onlyAudioFileIds) : null, startedAt: Date.now() };
      shell.log(`Measuring ${options.onlyAudioFileIds ? "1 file" : "Audio " + activeAudioTrack} against ${measurement?.windowCount ?? 6} × ${measurement?.windowSeconds ?? 45} s windows`);
      await startMeasuring(options);
      // Nothing to measure (a toast said why): give the engine back.
      window.setTimeout(() => {
        if (!isMeasuringRef.current) {
          run.current = null;
          shell.releaseEngine("audio");
        }
      }, 50);
    },
    [shell, startMeasuring, activeAudioTrack, measurement?.windowCount, measurement?.windowSeconds],
  );

  /** Conform these dubs onto their videos' cuts (Preferences › Measurement
   *  says how). */
  const beginConform = useCallback(
    async (fileIds: string[]) => {
      if (fileIds.length === 0 || isMeasuringRef.current || matchingRef.current || conformingRef.current) return;
      if (!shell.claimEngine("audio")) {
        toast({ title: engineHolder(shell.enginePage) ?? "The engine is busy", description: "Conform once it is done, or stop it first." });
        return;
      }
      const lossless = measurement?.conformMode === "lossless";
      shell.log(`Conforming ${fileIds.length} dub${fileIds.length === 1 ? "" : "s"} to ${fileIds.length === 1 ? "its video's" : "their videos'"} cut, ${lossless ? "cut on their own frames" : `re-encoded to the sample${measurement?.conformCodec === "flac" ? " as FLAC" : ""}`}`);
      await startConform(fileIds);
    },
    [shell, startConform, measurement?.conformMode, measurement?.conformCodec],
  );

  // A run that ends: release the engine, record it, and log what it found.
  const wasMeasuring = useRef(false);
  const audioFilesRef = useRef(audioFiles);
  audioFilesRef.current = audioFiles;
  useEffect(() => {
    if (isMeasuring) {
      wasMeasuring.current = true;
      return;
    }
    if (!wasMeasuring.current) return;
    wasMeasuring.current = false;
    shell.releaseEngine("audio");
    const current = run.current;
    run.current = null;
    if (!current) return;
    const files = audioFilesRef.current.filter((file) => (current.ids ? current.ids.has(file.id) : true) && measurementsOf(file).some((m) => Date.parse(m.measuredAt) >= current.startedAt - 1000));
    if (files.length === 0) return;
    for (const file of files) {
      for (const m of measurementsOf(file)) {
        const top = measureFindings(m, currentReferenceFor(file), videoOf(file)).find((finding) => finding.tone !== "ok");
        if (top) shell.log(`${file.name}: ${top.word.toLowerCase()}: ${top.line}`);
      }
    }
    const outcome = measureOutcome(files, videoOf);
    shell.log(`Measured ${files.length} file${files.length === 1 ? "" : "s"} in ${tookText(Date.now() - current.startedAt)}: ${outcome.parts.join(", ")}`);
    shell.addHistory({
      id: createExternalId(),
      page: "audio",
      name: runName(files.map((file) => file.name)),
      outcome: { tone: outcome.tone, text: outcome.parts.join(", ") },
      date: new Date().toISOString(),
      files: files.map((file) => {
        const status = rowStatus(file, currentReferenceFor(file), videoOf(file));
        return { name: file.name, tone: status.s, text: status.text };
      }),
    });
  }, [isMeasuring, shell, currentReferenceFor, videoOf]);

  // ---------------------------------------------------------- measurement

  const setStretchForFile = useCallback(
    (fileId: string, stretch: StretchSetting | undefined) => onAudioFilesChange(audioFiles.map((file) => (file.id === fileId ? { ...file, stretch } : file))),
    [audioFiles, onAudioFilesChange],
  );
  /** The same opt-in, but per track: a container can hold one dub that was
   *  rate-converted and one that was not. */
  const setStretchForTrack = useCallback(
    (fileId: string, trackId: number, stretch: StretchSetting | undefined) =>
      onAudioFilesChange(
        audioFiles.map((file) =>
          file.id === fileId ? { ...file, trackOverrides: { ...file.trackOverrides, [trackId]: { ...(file.trackOverrides?.[trackId] ?? {}), stretch } } } : file,
        ),
      ),
    [audioFiles, onAudioFilesChange],
  );

  /** Re-measure one row, ignoring the skip rules for it alone. */
  const remeasureFile = useCallback((fileId: string) => void beginMeasuring({ onlyAudioFileIds: [fileId], force: true }), [beginMeasuring]);

  /** A file whose pending delays Apply takes: not one measured against
   *  another video than its own now, nor one muxed as its conformed track. */
  const appliable = useCallback((file: ExternalFile) => !isMeasuredAgainstAnother(file, videoOf(file)) && !conformedFor(file, videoOf(file)), [videoOf]);
  // Drives the Apply button, counting each track of a multi-track file; measuredCount separately gates the re-measure offer.
  const pendingCount = useMemo(() => audioFiles.reduce((count, file) => count + (appliable(file) ? pendingDelayCount(file) : 0), 0), [audioFiles, appliable]);
  /** The rows "Conform N dubs" takes: different cuts, measured against their own video, one audio track each. */
  const conformIds = useMemo(() => realFiles(audioFiles).filter((file) => offersConform(file, videoOf(file))).map((file) => file.id), [audioFiles, videoOf]);
  /** Different cuts that can't be conformed as they are (several dubs, or
   *  subtitles that would drop out of the mux), each with why. */
  const conformHeld = useMemo(
    () =>
      new Map(
        realFiles(audioFiles).flatMap((file) => {
          const reason = measuredAsDifferentCut(file) ? conformRefusal(file, videoOf(file)) : null;
          return reason ? [[file.id, reason] as const] : [];
        }),
      ),
    [audioFiles, videoOf],
  );
  const measuredCount = useMemo(() => audioFiles.filter((file) => file.measuredDelay || Object.values(file.trackOverrides ?? {}).some((o) => o.measuredDelay)).length, [audioFiles]);

  const applyAllMeasuredDelays = useCallback(() => {
    onAudioFilesChange(audioFiles.map((file) => (appliable(file) ? applyAllPendingDelays(file) : file)));
    shell.log(`Applied ${pendingCount} measured ${pendingCount === 1 ? "delay" : "delays"}`);
    toast({ title: `Applied ${pendingCount} ${pendingCount === 1 ? "delay" : "delays"}`, description: "The measured values are now the files' delays." });
  }, [audioFiles, onAudioFilesChange, pendingCount, shell, appliable]);

  /** Accept one file's measurement, leaving every other file alone. */
  const applyOneMeasuredDelay = useCallback(
    (fileId: string) => onAudioFilesChange(audioFiles.map((file) => (file.id === fileId ? applyAllPendingDelays(file) : file))),
    [audioFiles, onAudioFilesChange],
  );
  /** Accept one track's measurement, leaving the file's other tracks alone. */
  const applyOneTrackDelay = useCallback(
    (fileId: string, trackId: number) => onAudioFilesChange(audioFiles.map((file) => (file.id === fileId ? applyMeasuredDelay(file, trackId) : file))),
    [audioFiles, onAudioFilesChange],
  );

  const applyCutDelayAnyway = useCallback(
    (fileId: string, trackId: number | null) => {
      const file = audioFiles.find((candidate) => candidate.id === fileId);
      if (!file) return;
      const accepted = acceptWithheldMeasurement(file, trackId);
      if (accepted === file) return;
      onAudioFilesChange(audioFiles.map((candidate) => (candidate.id === fileId ? accepted : candidate)));
      toast({ title: "Delay applied", description: "The measured delay is in despite the warning." });
    },
    [audioFiles, onAudioFilesChange],
  );

  const applyTimelineDelayFor = useCallback(
    (fileId: string, trackId: number | null) => {
      const file = audioFiles.find((candidate) => candidate.id === fileId);
      if (!file) return;
      const updated = applyTimelineDelay(file, trackId);
      if (updated === file) return;
      onAudioFilesChange(audioFiles.map((candidate) => (candidate.id === fileId ? updated : candidate)));
      toast({ title: "Timeline delay applied", description: "The whole-timeline scan's opening offset is now the delay." });
    },
    [audioFiles, onAudioFilesChange],
  );

  // --------------------------------------------------------------- dialogs

  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [trackToDelete, setTrackToDelete] = useState<string | null>(null);
  /** A file's popup (a double-click on its row): its measurement and its
   *  settings, together. Follows the file, not the row, so Duplicate inside it
   *  does not swap the file under the form. */
  const [editDialogOpen, setEditDialogOpen] = useState(false);
  const [editingFileId, setEditingFileId] = useState<string | null>(null);
  const audioFilesCache = useRef<Record<string, ExternalFile[]>>({});
  const [trackEditOpen, setTrackEditOpen] = useState(false);
  const [trackEditTarget, setTrackEditTarget] = useState<{ fileId: string; trackId: number; trackType: "audio" | "subtitle" } | null>(null);
  const [trackEditForm, setTrackEditForm] = useState({ language: "und", delay: "0.000", trackName: "" });
  const [multiDelayOpen, setMultiDelayOpen] = useState(false);
  const [multiDelayFileId, setMultiDelayFileId] = useState<string | null>(null);
  const [multiDelayTrackType, setMultiDelayTrackType] = useState<"audio" | "subtitle">("audio");
  const [multiDelayValues, setMultiDelayValues] = useState<Record<number, string>>({});
  const [multiDelayBulkValue, setMultiDelayBulkValue] = useState("0.000");
  const [importStreamsOpen, setImportStreamsOpen] = useState(false);
  const [importSourceVideoId, setImportSourceVideoId] = useState("");
  const [importSelectedTrackKeys, setImportSelectedTrackKeys] = useState<string[]>([]);
  // Per-stream overrides for an import, keyed by the same track key as the
  // selection above. Cleared whenever the source video changes.
  const [importOverrides, setImportOverrides] = useState<Record<string, ImportTrackOverride>>({});
  const [editForm, setEditForm] = useState({
    trackName: "",
    language: "und",
    delay: "0.000",
    /** Typed into the Delay field. Until then the field follows the file, so
     *  applying a measurement in the same popup is not undone by Save. */
    delayTouched: false,
    isDefault: false,
    isForced: false,
    muxAfter: "video",
    applyDelayToAll: false,
    /** Which rows Save reaches; this one alone unless asked. */
    scope: "row" as EditScope,
    includedTrackIds: [] as number[],
    includeSubtitles: false,
    includedSubtitleTrackIds: [] as number[],
    includedSubtitlesDefault: false,
    includedSubtitlesForced: false,
    includedSubtitlesFirst: false,
  });

  const currentConfig = audioTrackConfigs[activeAudioTrack] || defaultTrackConfig;
  const editingFile = audioFiles.find((file) => file.id === editingFileId) || null;
  const editDelay = editForm.delayTouched || !editingFile ? editForm.delay : (editingFile.delay ?? 0).toFixed(3);
  const multiDelayFile = audioFiles.find((file) => file.id === multiDelayFileId) || null;

  const muxAfterOptions = useMemo(() => {
    const primaryTracks = videoFiles[0]?.tracks || [];
    const trackCount = primaryTracks.length || Math.max(0, ...videoFiles.map((video) => video.tracks?.length || 0));
    const options = [{ value: "video", label: "Video" }];
    for (let i = 1; i <= trackCount; i += 1) {
      const track = primaryTracks[i - 1];
      options.push({ value: `track-${i}`, label: track ? `Track ${i} - ${track.type}${track.language ? ` (${track.language})` : ""}` : `Track ${i}` });
    }
    options.push({ value: "end", label: "End" });
    return options;
  }, [videoFiles]);

  const selectedImportSource = useMemo(() => videoFiles.find((file) => file.id === importSourceVideoId) || null, [videoFiles, importSourceVideoId]);
  const unlinkedCount = useMemo(() => getUnlinkedExternalFiles(audioFiles, videoFiles).length, [audioFiles, videoFiles]);
  const importableTracks = useMemo(
    () => (selectedImportSource ? (selectedImportSource.tracks || []).filter((track) => track.type === "audio" && track.action !== "remove") : []),
    [selectedImportSource],
  );
  const getImportTrackKey = (trackIndex: number, trackId: string) => `${trackIndex}:${trackId}`;

  const updateCurrentConfig = (updates: Partial<TrackConfig>) => updateAudioTrackConfig(activeAudioTrack, updates);

  /** The settings last stamped on each slot's files, by slot: one shared by
   *  every slot would count each switch of tab as a change of settings. */
  const lastAppliedConfig = useRef<Record<string, TrackConfig>>({});
  useEffect(() => {
    if (audioFiles.length === 0) return;
    const prev = lastAppliedConfig.current[activeAudioTrack];
    const same =
      prev &&
      prev.sourceFolder === currentConfig.sourceFolder &&
      prev.extension === currentConfig.extension &&
      prev.language === currentConfig.language &&
      prev.trackName === currentConfig.trackName &&
      prev.delay === currentConfig.delay &&
      prev.isDefault === currentConfig.isDefault &&
      prev.isForced === currentConfig.isForced &&
      prev.muxAfter === currentConfig.muxAfter;
    if (same) return;
    lastAppliedConfig.current[activeAudioTrack] = { ...currentConfig };
    const delayValue = delaySecondsOrZero(currentConfig.delay);
    onAudioFilesChange(
      audioFiles.map((file) => file.placeholder ? file : ({
        ...file,
        // Global default/forced toggles must always apply from the slot's settings.
        isDefault: currentConfig.isDefault,
        isForced: currentConfig.isForced,
        ...(file.isManuallyEdited
          ? {}
          : {
              language: currentConfig.language,
              trackName: currentConfig.trackName,
              // An accepted measurement or a typed delay ("This delay to every
              // row") is the file's own, not a slot for the global default to
              // keep overwriting.
              delay: file.delayProvenance === "measured" || file.delayProvenance === "manual" ? file.delay : delayValue,
              muxAfter: currentConfig.muxAfter,
            }),
      })),
    );
  }, [audioFiles, currentConfig, onAudioFilesChange, activeAudioTrack]);

  useEffect(() => {
    audioFilesCache.current[activeAudioTrack] = audioFiles;
  }, [audioFiles, activeAudioTrack]);
  useEffect(() => {
    const cached = audioFilesCache.current[activeAudioTrack];
    if (!cached || cached === audioFiles) return;
    if (cached.length === audioFiles.length) return;
    onAudioFilesChange(cached);
  }, [activeAudioTrack, audioFiles, onAudioFilesChange]);

  const addNewTrack = useCallback(() => {
    const newTrackNumber = nextSlotId(audioTracks);
    setAudioTracks([...audioTracks, newTrackNumber]);
    updateAudioTrackConfig(newTrackNumber, { ...defaultTrackConfig });
    setActiveAudioTrack(newTrackNumber);
    setSelectedRow(null);
    toast({ title: `Audio ${newTrackNumber} added` });
  }, [audioTracks, setActiveAudioTrack, setAudioTracks, updateAudioTrackConfig]);

  const duplicateTrack = () => {
    const newTrackNumber = nextSlotId(audioTracks);
    const currentSettings = audioTrackConfigs[activeAudioTrack] || defaultTrackConfig;
    setAudioTracks([...audioTracks, newTrackNumber]);
    updateAudioTrackConfig(newTrackNumber, { ...currentSettings });
    setActiveAudioTrack(newTrackNumber);
    toast({ title: `Audio ${newTrackNumber} added`, description: `With the settings of Audio ${activeAudioTrack}.` });
  };

  /** By order the rows between shift; by episode the two files trade videos,
   *  each kept where it was put (smartPairing.moveByHand). */
  const reorderAudioFile = (fromIndex: number, toIndex: number) => {
    const last = (pairing.pairBy === "episode" ? videoFiles.length : audioFiles.length) - 1;
    if (toIndex < 0 || toIndex > last || isPlaceholder(audioFiles[fromIndex])) return;
    pairing.move(fromIndex, toIndex);
    setSelectedRow(toIndex);
  };

  const removeAudioFile = (index: number) => {
    onAudioFilesChange(syncAudioLinks(audioFiles.filter((_, currentIndex) => currentIndex !== index)));
    setSelectedRow(null);
  };

  const duplicateAudioFile = (index: number) => {
    const original = audioFiles[index];
    if (!original || original.placeholder) return;
    if (videoFiles.length === 0) {
      toast({ title: "Nothing to duplicate into", description: "Add video files before duplicating audio.", variant: "destructive" });
      return;
    }
    if (realAudioFiles.length >= videoFiles.length) {
      toast({ title: "Nothing to duplicate into", description: "There cannot be more audio files than videos.", variant: "destructive" });
      return;
    }
    // The copy is kept with its video by hand: the same name twice would
    // otherwise read as a second file for one episode.
    const copy = (row: number): ExternalFile => ({ ...original, id: `audio-dup-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, matchedVideoId: videoFiles[row]?.id, isManuallyLinked: true, audioMatch: undefined });
    const updated = [...audioFiles];
    let row = index + 1;
    if (pairing.pairBy === "episode") {
      // Into the next empty row: every row with a file is that file's episode.
      row = videoFiles.findIndex((_, r) => r > index && (!audioFiles[r] || isPlaceholder(audioFiles[r])));
      if (row < 0) {
        toast({ title: "Nothing to duplicate into", description: "Every video after this one has its file.", variant: "destructive" });
        return;
      }
      while (updated.length < row) updated.push(placeholderFor(videoFiles[updated.length], "audio"));
      updated[row] = copy(row);
    } else if (isPlaceholder(updated[row])) updated[row] = copy(row);
    else updated.splice(row, 0, copy(row));
    onAudioFilesChange(syncAudioLinks(updated));
    setSelectedRow(row);
    toast({ title: "Audio duplicated", description: pairing.pairBy === "episode" ? `${original.name}, beside ${videoFiles[row].name}.` : `${original.name}, paired by row.` });
  };

  /** The form as the popup opened, so a Save that changed nothing only closes:
   *  saving marks the file edited by hand, which stops the slot's settings
   *  reaching it. */
  const editFormAtOpen = useRef("");
  const openEditDialog = (fileId: string) => {
    const file = audioFiles.find((entry) => entry.id === fileId);
    if (!file) return;
    const defaultIncluded = file.tracks && file.tracks.length > 0 ? getAudioTrackIds(file) : [];
    setEditingFileId(fileId);
    const form = {
      trackName: file.trackName || "",
      language: file.language || "und",
      delay: (file.delay ?? 0).toFixed(3),
      delayTouched: false,
      isDefault: file.isDefault || false,
      isForced: file.isForced || false,
      muxAfter: file.muxAfter || "video",
      applyDelayToAll: false,
      scope: "row" as EditScope,
      includedTrackIds: file.includedTrackIds !== undefined ? [...file.includedTrackIds] : defaultIncluded,
      includeSubtitles: getDefaultIncludeSubtitles(file),
      includedSubtitleTrackIds: file.includedSubtitleTrackIds !== undefined ? [...file.includedSubtitleTrackIds] : getSubtitleTrackIds(file),
      includedSubtitlesDefault: file.includedSubtitlesDefault || false,
      includedSubtitlesForced: file.includedSubtitlesForced || false,
      includedSubtitlesFirst: file.includedSubtitlesFirst || false,
    };
    setEditForm(form);
    editFormAtOpen.current = JSON.stringify(form);
    setEditDialogOpen(true);
  };

  /** A track's language, name or delay, on this row only. Other rows with the
   *  same file are paired with other videos and keep their own; the popup's
   *  "Rows with this file" passes languages and names on, never delays. */
  const updateOneFile = useCallback(
    (fileId: string, updater: (file: ExternalFile) => ExternalFile) => onAudioFilesChange(audioFiles.map((file) => (file.id === fileId ? updater(file) : file))),
    [audioFiles, onAudioFilesChange],
  );

  const closeEdit = () => {
    setEditDialogOpen(false);
    setEditingFileId(null);
  };

  const applyEditChanges = () => {
    if (!editingFileId) return;
    if (JSON.stringify(editForm) === editFormAtOpen.current) {
      closeEdit();
      return;
    }
    const delayValue = editForm.delayTouched ? delaySecondsOrZero(editForm.delay) : (audioFiles.find((file) => file.id === editingFileId)?.delay ?? 0);
    if (editForm.scope === "all") {
      // Compute which track INDICES are selected in the editing file, then mirror to all files
      const editingFileData = audioFiles.find((f) => f.id === editingFileId);
      const srcAudioTracks = (editingFileData?.tracks || []).filter((t) => t.type === "audio");
      const srcSubTracks = (editingFileData?.tracks || []).filter((t) => t.type === "subtitle");
      const selAudioIdx = new Set(srcAudioTracks.map((t, i) => ({ i, id: Number(t.id) })).filter(({ id }) => editForm.includedTrackIds.includes(id)).map(({ i }) => i));
      const selSubIdx = new Set(srcSubTracks.map((t, i) => ({ i, id: Number(t.id) })).filter(({ id }) => editForm.includedSubtitleTrackIds.includes(id)).map(({ i }) => i));
      const updated = audioFiles.map((file) => {
        if (file.placeholder) return file;
        const fileAudioTracks = (file.tracks || []).filter((t) => t.type === "audio");
        const fileSubTracks = (file.tracks || []).filter((t) => t.type === "subtitle");
        const newAudioIds = fileAudioTracks.map((t, i) => ({ i, id: Number(t.id) })).filter(({ i }) => selAudioIdx.has(i)).map(({ id }) => id).filter((id) => Number.isFinite(id));
        const newSubIds = fileSubTracks.map((t, i) => ({ i, id: Number(t.id) })).filter(({ i }) => selSubIdx.has(i)).map(({ id }) => id).filter((id) => Number.isFinite(id));
        const base = file.delay !== delayValue ? markDelayAsManual(file, null) : file;
        return {
          ...base,
          language: editForm.language,
          trackName: editForm.trackName,
          delay: delayValue,
          isDefault: editForm.isDefault,
          isForced: editForm.isForced,
          muxAfter: editForm.muxAfter,
          includedTrackIds: fileAudioTracks.length > 0 ? newAudioIds : file.includedTrackIds,
          includeSubtitles: editForm.includeSubtitles,
          includedSubtitleTrackIds: fileSubTracks.length > 0 ? newSubIds : file.includedSubtitleTrackIds,
          includedSubtitlesDefault: editForm.includeSubtitles && editForm.includedSubtitlesDefault,
          includedSubtitlesForced: editForm.includeSubtitles && editForm.includedSubtitlesForced,
          includedSubtitlesFirst: editForm.includeSubtitles && editForm.includedSubtitlesFirst,
          isManuallyEdited: true,
        };
      });
      onAudioFilesChange(updated);
      closeEdit();
      toast({ title: "Applied to every file", description: `${realAudioFiles.length} audio file${realAudioFiles.length === 1 ? "" : "s"}.` });
      return;
    }
    let updated = audioFiles.map((file) => {
      if (file.id === editingFileId) {
        // Only a changed delay counts as hand-typed. Saving the dialog without
        // touching it must not lock the field against a later measurement.
        const base = file.delay !== delayValue ? markDelayAsManual(file, null) : file;
        return {
          ...base,
          trackName: editForm.trackName,
          language: editForm.language,
          delay: delayValue,
          isDefault: editForm.isDefault,
          isForced: editForm.isForced,
          muxAfter: editForm.muxAfter,
          includedTrackIds: editForm.includedTrackIds,
          includeSubtitles: editForm.includeSubtitles,
          includedSubtitleTrackIds: editForm.includedSubtitleTrackIds,
          includedSubtitlesDefault: editForm.includeSubtitles && editForm.includedSubtitlesDefault,
          includedSubtitlesForced: editForm.includeSubtitles && editForm.includedSubtitlesForced,
          includedSubtitlesFirst: editForm.includeSubtitles && editForm.includedSubtitlesFirst,
          trackOverrides: base.trackOverrides,
          isManuallyEdited: true,
        };
      }
      if (editForm.applyDelayToAll && !file.placeholder) return file.delay !== delayValue ? { ...markDelayAsManual(file, null), delay: delayValue } : file;
      return file;
    });
    // Paired: the other rows of this file take its settings, each keeping its own delays.
    const editedTarget = updated.find((file) => file.id === editingFileId);
    const paired = editForm.scope === "file" && editedTarget ? updated.filter((file) => file.id !== editingFileId && file.path === editedTarget.path).length : 0;
    if (paired > 0 && editedTarget) updated = updated.map((file) => (file.id !== editingFileId && file.path === editedTarget.path ? shareSettings(editedTarget, file) : file));
    onAudioFilesChange(updated);
    closeEdit();
    if (paired > 0) toast({ title: `Saved to ${paired + 1} rows`, description: "Every row with this file, each keeping its own delays." });
  };

  const openTrackEdit = (fileId: string, trackId: number, trackType: "audio" | "subtitle") => {
    const file = audioFiles.find((entry) => entry.id === fileId);
    if (!file) return;
    const track = file.tracks?.find((t) => Number(t.id) === trackId);
    const overrides = file.trackOverrides?.[trackId] || {};
    setTrackEditTarget({ fileId, trackId, trackType });
    // The delay the track is muxed with: its own, or else the file's (main.rs).
    // Opening on 0 for a track without one would save 0 over the file's delay.
    setTrackEditForm({ language: overrides.language || track?.language || "und", delay: (overrides.delay ?? file.delay ?? 0).toFixed(3), trackName: overrides.trackName || track?.name || "" });
    setTrackEditOpen(true);
  };

  const openMultiDelayDialog = (fileId: string, trackType: "audio" | "subtitle" = "audio") => {
    const file = audioFiles.find((entry) => entry.id === fileId);
    if (!file) return;
    const targetTracks = (file.tracks || []).filter((track) => track.type === trackType);
    if (targetTracks.length === 0) return;
    const initial: Record<number, string> = {};
    targetTracks.forEach((track) => {
      const trackId = Number(track.id);
      if (!Number.isFinite(trackId)) return;
      initial[trackId] = (file.trackOverrides?.[trackId]?.delay ?? file.delay ?? 0).toFixed(3);
    });
    setMultiDelayFileId(fileId);
    setMultiDelayTrackType(trackType);
    setMultiDelayValues(initial);
    setMultiDelayBulkValue((file.delay ?? 0).toFixed(3));
    setMultiDelayOpen(true);
  };

  /** Committed on Save rather than per keystroke, so Cancel really does cancel. */
  const applyTrackEdit = (next: ImportTrackOverride) => {
    if (!trackEditTarget) return;
    const { fileId, trackId } = trackEditTarget;
    const nextDelay = delaySecondsOrZero(next.delay ?? 0);
    const openedDelay = delaySecondsOrZero(trackEditForm.delay);
    updateOneFile(fileId, (file) => {
      const previous = file.trackOverrides?.[trackId];
      // A changed delay is hand-typed, and clears the measurement it replaces;
      // an unchanged one leaves the existing provenance and metadata intact.
      // Unchanged means as the dialog opened, on the file's delay when the
      // track has none of its own: the track then keeps following the file's,
      // rather than a copy of it that a later change to the file's would miss.
      const changed = nextDelay !== openedDelay;
      const source = changed ? markDelayAsManual(file, trackId) : file;
      const nextOverrides = { ...(source.trackOverrides || {}) };
      nextOverrides[trackId] = { ...nextOverrides[trackId], language: next.language || undefined, delay: changed ? nextDelay : previous?.delay, trackName: next.trackName || undefined };
      return { ...source, trackOverrides: nextOverrides, isManuallyEdited: true };
    });
    setTrackEditOpen(false);
    setTrackEditTarget(null);
  };

  const applyMultiDelayChanges = () => {
    if (!multiDelayFileId) return;
    updateOneFile(multiDelayFileId, (file) => {
      const targetTracks = (file.tracks || []).filter((track) => track.type === multiDelayTrackType);
      const nextOverrides = { ...(file.trackOverrides || {}) };
      targetTracks.forEach((track) => {
        const trackId = Number(track.id);
        if (!Number.isFinite(trackId)) return;
        const nextDelay = delaySecondsOrZero(multiDelayValues[trackId]);
        const prev = nextOverrides[trackId] || {};
        const changed = prev.delay !== nextDelay;
        // Typing a delay here overrides any measurement for that track.
        nextOverrides[trackId] = { ...prev, delay: nextDelay, ...(changed ? { delayProvenance: "manual" as const, measuredDelay: undefined } : {}) };
      });
      return { ...file, trackOverrides: nextOverrides, isManuallyEdited: true };
    });
    setMultiDelayOpen(false);
    setMultiDelayFileId(null);
    setMultiDelayTrackType("audio");
    toast({ title: "Track delays saved" });
  };

  useEffect(() => {
    if (!preset || audioPresetApplied) return;
    audioTracks.forEach((trackId) => {
      updateAudioTrackConfig(trackId, {
        sourceFolder: preset.Default_Audio_Directory || "",
        extension: "all",
        language: preset.Default_Audio_Language ? normalizeLanguage(preset.Default_Audio_Language) : "und",
      });
    });
    setAudioPresetApplied(true);
  }, [preset, audioPresetApplied, audioTracks, updateAudioTrackConfig, setAudioPresetApplied]);

  /** A scan's or a drop's files, keeping the delays measured or typed before. */
  const normalize = useCallback(
    (results: ExternalFile[]) => {
      // Carry over prior measured/typed delays so a refresh doesn't discard them.
      const priorByPath = new Map(audioFilesRef.current.map((file) => [file.path.toLowerCase(), file] as const));
      return results.map((file) => {
        const prior = priorByPath.get(file.path.toLowerCase());
        const keepsOwnDelay = prior && (prior.delayProvenance === "measured" || prior.delayProvenance === "manual");
        return {
          ...file,
          type: "audio" as const,
          language: prior?.language ?? currentConfig.language,
          trackName: prior?.trackName ?? currentConfig.trackName,
          delay: keepsOwnDelay ? prior.delay : delaySecondsOrZero(currentConfig.delay),
          ...(keepsOwnDelay ? { delayProvenance: prior.delayProvenance, measuredDelay: prior.measuredDelay, stretch: prior.stretch } : {}),
          // A conformed track is made from this very file: a rescan keeps it.
          ...(prior?.conformed ? { conformed: prior.conformed } : {}),
          isDefault: currentConfig.isDefault,
          isForced: currentConfig.isForced,
          muxAfter: currentConfig.muxAfter,
          includeSubtitles: getSubtitleTrackIds(file).length > 0,
          includedSubtitleTrackIds: file.includedSubtitleTrackIds?.length ? file.includedSubtitleTrackIds : getSubtitleTrackIds(file),
          // Per-track measurements live here, so they survive a rescan too.
          trackOverrides: prior?.trackOverrides ?? file.trackOverrides ?? {},
          // Kept with the language and name it guards: dropped, the next change
          // of the slot's settings would overwrite what was set by hand.
          isManuallyEdited: prior?.isManuallyEdited,
          includedTrackIds: file.tracks && file.tracks.length > 0 ? getAudioTrackIds(file) : file.includedTrackIds,
        };
      });
    },
    [currentConfig],
  );

  const scanAudios = useCallback(
    async (folderPath: string) => {
      if (!folderPath) {
        onAudioFilesChange([]);
        return;
      }
      const extensions = currentConfig.extension === "all" ? audioExtensions : [currentConfig.extension];
      try {
        const results = await scanMedia({ folder: folderPath, extensions, recursive: false, type: "audio", include_tracks: true });
        const paired = syncAudioLinks(normalize(results as ExternalFile[]));
        onAudioFilesChange(paired);
        const gaps = paired.filter(isPlaceholder).length;
        shell.log(`Audio ${activeAudioTrack}: ${results.length} file${results.length === 1 ? "" : "s"} from ${folderPath}, paired by ${pairByFor(paired) === "episode" ? `episode${gaps ? `, ${gaps} episode${gaps === 1 ? "" : "s"} without one` : ""}` : "row"}`);
      } catch (error) {
        shell.log(`Error: could not scan ${folderPath}: ${String(error)}`);
        toast({ title: "Could not scan the folder", description: String(error), variant: "destructive" });
      }
    },
    [currentConfig.extension, normalize, onAudioFilesChange, syncAudioLinks, shell, activeAudioTrack, pairByFor],
  );

  const confirmDeleteTrack = (trackId: string) => {
    if (audioTracks.length <= 1) return;
    setTrackToDelete(trackId);
    setDeleteDialogOpen(true);
  };

  const deleteTrack = () => {
    if (!trackToDelete || audioTracks.length <= 1) return;
    const deletedNumber = trackToDelete;
    setAudioTracks(audioTracks.filter((track) => track !== trackToDelete));
    removeAudioTrackConfig(trackToDelete);
    if (activeAudioTrack === trackToDelete) setActiveAudioTrack(audioTracks.filter((t) => t !== trackToDelete)[0] || "1");
    setDeleteDialogOpen(false);
    setTrackToDelete(null);
    toast({ title: `Audio ${deletedNumber} deleted` });
  };

  /** The row an import lands in: the selected one, or the first without a
   *  file when that is further down. Row n is file n, so a file cannot sit
   *  past an empty row: pushed onto the end it would pair with the next video,
   *  not the one the dialog named. */
  const importRow = Math.min(selectedRow ?? 0, audioFiles.length);

  const handleImportAudios = () => {
    if (videoFiles.length === 0) {
      toast({ title: "No videos loaded", description: "Load the videos first, then import audio streams from them.", variant: "destructive" });
      return;
    }
    if (selectedRow === null) setSelectedRow(0);
    setImportSourceVideoId(videoFiles[0]?.id || "");
    setImportSelectedTrackKeys([]);
    setImportStreamsOpen(true);
  };

  const handleConfirmImportAudios = () => {
    const targetIndex = importRow;
    const targetVideo = videoFiles[targetIndex];
    if (!targetVideo || !selectedImportSource || importSelectedTrackKeys.length === 0) return;
    const selectedTrackKeySet = new Set(importSelectedTrackKeys);
    const selectedTracks = importableTracks.filter((track, trackIndex) => selectedTrackKeySet.has(getImportTrackKey(trackIndex, String(track.id))));
    if (selectedTracks.length === 0) return;
    const existingAtTarget = audioFiles[targetIndex];
    const mergedTracks = [...(existingAtTarget?.tracks?.filter((track) => track.type === "audio") || [])];
    selectedTracks.forEach((track) => {
      if (!mergedTracks.some((entry) => String(entry.id) === String(track.id))) mergedTracks.push(track);
    });
    const importedFile: ExternalFile = {
      id: createExternalId(),
      name: selectedImportSource.name,
      path: selectedImportSource.path,
      type: "audio",
      source: "per-file",
      language: currentConfig.language,
      trackName: currentConfig.trackName,
      delay: delaySecondsOrZero(currentConfig.delay),
      isDefault: currentConfig.isDefault,
      isForced: currentConfig.isForced,
      muxAfter: currentConfig.muxAfter,
      matchedVideoId: targetVideo.id,
      // Put in this row on purpose: pairing by episode leaves it here.
      isManuallyLinked: true,
      tracks: mergedTracks,
      includedTrackIds: mergedTracks.map((track) => Number(track.id)).filter((id) => Number.isFinite(id)),
      includeSubtitles: false,
      includedSubtitleTrackIds: [],
      // Keyed by track id so the mux job picks up per-stream edits, not the
      // slot's shared delay.
      trackOverrides: (() => {
        const overrides: NonNullable<ExternalFile["trackOverrides"]> = { ...(existingAtTarget?.trackOverrides ?? {}) };
        importableTracks.forEach((track, trackIndex) => {
          const key = getImportTrackKey(trackIndex, String(track.id));
          if (!selectedTrackKeySet.has(key)) return;
          const override = importOverrides[key];
          const id = Number(track.id);
          if (!override || !Number.isFinite(id)) return;
          overrides[id] = { ...(overrides[id] ?? {}), ...override };
        });
        return Object.keys(overrides).length > 0 ? overrides : undefined;
      })(),
    };
    const updated = [...audioFiles];
    if (targetIndex < updated.length) updated[targetIndex] = importedFile;
    else updated.push(importedFile);
    onAudioFilesChange(syncAudioLinks(updated));
    setSelectedRow(targetIndex);
    setImportStreamsOpen(false);
    setImportOverrides({});
    toast({ title: `Imported ${selectedTracks.length} stream${selectedTracks.length > 1 ? "s" : ""}`, description: `Into row ${targetIndex + 1}, beside ${targetVideo.name}.` });
  };

  const chooseFolder = async () => {
    const folder = await pickDirectory();
    if (folder) {
      updateCurrentConfig({ sourceFolder: folder });
      void scanAudios(folder);
    }
  };

  /** Dropped audio files: read and added after the ones already here. */
  const addDropped = async (paths: string[]) => {
    const allowed = new Set(audioExtensions.map((ext) => ext.toLowerCase()));
    const picked = paths.filter((path) => allowed.has(path.split(".").pop()?.toLowerCase() ?? ""));
    if (picked.length === 0) {
      toast({ title: "No audio files in the drop" });
      return;
    }
    const inspected = (await inspectPaths({ paths: picked, type: "audio", include_tracks: true })) as ExternalFile[];
    onAudioFilesChange(syncAudioLinks([...audioFiles, ...normalize(inspected)]));
  };

  // ------------------------------------------------------------------ rows

  const rowCount = Math.max(videoFiles.length, audioFiles.length);
  const rows = useMemo(() => {
    // An empty row (placeholder) shows as a row without a file.
    const all = Array.from({ length: rowCount }, (_, index) => ({ index, video: videoFiles[index], entry: audioFiles[index], file: isPlaceholder(audioFiles[index]) ? undefined : audioFiles[index] }));
    return all.filter(({ video, file }) => {
      const hit = (video && matchesSearch(video, search)) || (file && matchesSearch(file, search));
      if (!hit) return false;
      if (filter === "linked") return Boolean(file?.matchedVideoId && video);
      if (filter === "unlinked") return !(file && video);
      return true;
    });
  }, [rowCount, videoFiles, audioFiles, search, filter]);
  // Moving rows only makes sense while the list shows every row in mux order.
  const ordered = !search.trim() && filter === "all";
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const drag = useRowReorder({
    bodyRef,
    rowCount,
    disabled: !ordered || busy,
    onMove: (from, to) => from < audioFiles.length && reorderAudioFile(from, Math.min(to, (pairing.pairBy === "episode" ? videoFiles.length : audioFiles.length) - 1)),
  });

  const selectedEntry = selectedRow !== null ? audioFiles[selectedRow] : undefined;
  const selectedFile = isPlaceholder(selectedEntry) ? undefined : selectedEntry;
  // An empty row can go while pairing by order (the files below move up); by
  // episode it would only come back.
  const canRemove = !busy && selectedRow !== null && Boolean(selectedFile || (selectedEntry && pairing.pairBy === "order"));
  const lastMovable = (pairing.pairBy === "episode" ? videoFiles.length : audioFiles.length) - 1;
  const canMoveUp = ordered && !busy && Boolean(selectedFile) && selectedRow !== null && selectedRow > 0 && selectedRow <= lastMovable;
  const canMoveDown = ordered && !busy && Boolean(selectedFile) && selectedRow !== null && selectedRow < lastMovable;
  /** What holds the engine when it is not this page: muxing, Subtitles'
   *  sync, or a watch folder. Null when it is free or this page's own. */
  const heldBy = shell.enginePage !== null && shell.enginePage !== "audio" ? engineHolder(shell.enginePage) : null;
  const engineBusy = heldBy !== null;

  usePageCommands("audio", {
    chooseFolder: () => void chooseFolder(),
    importFromVideo: handleImportAudios,
    removeSelected: canRemove ? () => removeAudioFile(selectedRow!) : undefined,
    clear: audioFiles.length && !busy
      ? () => {
          updateCurrentConfig({ sourceFolder: "" });
          onAudioFilesChange([]);
        }
      : undefined,
    moveUp: canMoveUp ? () => reorderAudioFile(selectedRow!, selectedRow! - 1) : undefined,
    moveDown: canMoveDown ? () => reorderAudioFile(selectedRow!, selectedRow! + 1) : undefined,
    newTrack: busy ? undefined : addNewTrack,
    duplicateTrack: busy ? undefined : duplicateTrack,
    start: measurementAvailable && realAudioFiles.length > 0 && !busy && !engineBusy ? () => void beginMeasuring() : undefined,
    stop: isMeasuring ? () => void cancelMeasuring() : matching ? () => void cancelMatching() : conforming ? () => void cancelConform() : undefined,
    // Ctrl+O and File › Import from a video would replace the list under a
    // run, as the toolbar's own buttons, disabled meanwhile, cannot.
    disabled: { chooseFolder: busy, importFromVideo: busy },
    drop: (paths) => {
      if (busy) return;
      const folder = paths.find(looksLikeFolder);
      if (folder) {
        updateCurrentConfig({ sourceFolder: folder });
        void scanAudios(folder);
      } else void addDropped(paths);
    },
  });

  // --------------------------------------------------------------- display

  const summary = useMemo(() => measureOutcome(realFiles(audioFiles), videoOf), [audioFiles, videoOf]);
  const slotLine = `Audio ${activeAudioTrack} · ${languageName(currentConfig.language)}${currentConfig.isDefault ? " · default" : ""} · after ${(muxAfterOptions.find((o) => o.value === currentConfig.muxAfter)?.label ?? "the video").toLowerCase()}`;
  const phaseWord = measureProgress ? { measure: "Measuring", wide: "Searching wider", scan: "Scanning for cuts" }[measureProgress.phase] : "Measuring";
  const conflicts = pairing.report.conflicts;
  const conformStage = conformProgress ? Object.values(conformProgress.active)[0]?.stage : null;
  const lcd: LcdProps = conforming
    ? {
        icon: "run",
        l1: conformProgress ? `Conforming · ${conformProgress.processed} of ${conformProgress.total} done` : "Conforming",
        l2: conformStage ?? (measurement?.conformMode === "lossless" ? "Cutting each dub on its own frames" : "Laying each dub onto its video's cut"),
        pct: conformProgress && conformProgress.total > 0 ? ((conformProgress.processed + Object.values(conformProgress.active).reduce((sum, entry) => sum + entry.percent / 100, 0)) / conformProgress.total) * 100 : null,
      }
    : matching
    ? {
        icon: "run",
        l1: matchProgress ? `Matching by audio · ${matchProgress.processed} of ${matchProgress.total} done` : "Matching by audio",
        l2: "Quick listens to place the files the names could not",
        pct: matchProgress && matchProgress.total > 0 ? (matchProgress.processed / matchProgress.total) * 100 : null,
      }
    : isMeasuring
    ? {
        icon: "run",
        // Several pairs run at once, so the count is of those done, and the
        // bar and time left include how far along the running ones are.
        l1: measureProgress ? `${phaseWord} · ${measureProgress.processed} of ${measureProgress.total} done` : phaseWord,
        l2: measureProgress && Object.keys(measureProgress.active).length ? `${Object.keys(measureProgress.active).length} in progress` : undefined,
        pct: measureProgress && measureProgress.total > 0 ? runFraction(measureProgress) * 100 : null,
        time: run.current && measureProgress ? (timeLeftText(Date.now() - run.current.startedAt, runFraction(measureProgress)) ?? undefined) : undefined,
      }
    : realAudioFiles.length === 0
      ? { l1: `Drop a folder of audio files for Audio ${activeAudioTrack}` }
      : audiosyncEngine && !measurementAvailable
        ? { icon: "warn", l1: "The audio analysis engine is missing", l2: audiosyncEngine.message ?? "Measuring needs it · Preferences › Tools" }
        : conflicts.length > 0
          ? {
              icon: "warn",
              l1: unlinkedCount === conflicts.length ? `${unlinkedCount} audio file${unlinkedCount === 1 ? " has" : "s have"} no video` : `${conflicts.length} audio file${conflicts.length === 1 ? "" : "s"} to pair`,
              l2: `Row ${conflicts[0].row + 1}: ${audioFiles[conflicts[0].row]?.name} ${conflicts[0].message.replace(/\.$/, "")}`,
            }
          : measuredCount > 0 && pendingCount > 0
            ? { icon: summary.problems ? "warn" : "ok", l1: summary.problems ? `${summary.parts[0]} · ${summary.problems} to check` : summary.parts[0], l2: summary.problems ? summary.parts.slice(1).join(" · ") : slotLine, time: `${pendingCount} to apply${conformIds.length ? ` · ${conformIds.length} to conform` : ""}` }
            : measuredCount > 0
              ? { icon: summary.problems ? "warn" : "ok", l1: summary.problems ? `${summary.parts[0]} · ${summary.problems} to check` : `${measuredCount} delays in`, l2: summary.problems ? summary.parts.slice(1).join(" · ") : slotLine, time: conformIds.length ? `${conformIds.length} to conform` : undefined }
              : { l1: `${realAudioFiles.length} audio file${realAudioFiles.length === 1 ? "" : "s"} · ${realAudioFiles.length - unlinkedCount} paired by ${pairing.pairBy === "episode" ? "episode" : "row"}`, l2: slotLine };

  const measureTitle = audiosyncEngine === null ? "Checking for the audio analysis engine…" : (audiosyncEngine.message ?? (engineBusy ? heldBy : realAudioFiles.length === 0 ? "Add audio files to measure their delays." : "Measure each file's delay against the video it will be muxed into."));
  const folder = currentConfig.sourceFolder;

  /** The reference track picker for a video: which of its audio tracks the
   *  measurement compares against. */
  const againstFor = (video: VideoFile | undefined) => {
    if (!video) return undefined;
    const tracks = (video.tracks ?? []).filter((track) => track.type === "audio");
    if (tracks.length === 0) return undefined;
    const value = referenceTrackByVideoId[video.id] ?? DEFAULT_REFERENCE_TRACK;
    if (tracks.length === 1) return <span className="truncate" title={trackDetails(tracks[0], 0)}>{trackDetails(tracks[0], 0)}</span>;
    const withChoice = videoFiles.filter((v) => (v.tracks ?? []).filter((t) => t.type === "audio").length > 1);
    return (
      <span className="col" style={{ gap: 2, minWidth: 0 }}>
        <Combo<number>
          sm
          w="100%"
          label="Measure against"
          disabled={isMeasuring}
          value={value}
          options={tracks.map((track, index) => ({ value: index, label: trackDetails(track, index) }))}
          onChange={(index) => setReferenceTrackByVideoId((prev) => ({ ...prev, [video.id]: index }))}
        />
        {withChoice.length > 1 && (
          <button
            type="button"
            className="acc sm"
            style={{ textAlign: "left" }}
            disabled={isMeasuring}
            onClick={() => {
              const next = { ...referenceTrackByVideoId };
              // Clamp: not every video necessarily has that many tracks.
              withChoice.forEach((v) => (next[v.id] = Math.min(value, (v.tracks ?? []).filter((t) => t.type === "audio").length - 1)));
              setReferenceTrackByVideoId(next);
            }}
          >
            Same for every video
          </button>
        )}
      </span>
    );
  };

  const fileLinks = (index: number) => (
    <>
      <L icon={<CopyRegular />} onClick={() => duplicateAudioFile(index)} disabled={busy}>Duplicate</L>
      <L icon={<DeleteRegular />} onClick={() => removeAudioFile(index)} disabled={busy}>Remove</L>
    </>
  );

  /** The top of a file's popup: the measurement in full (what the right panel
   *  used to show), every track's delay for a file measured track by track, or
   *  its format before it is measured. Its settings follow, in editFields. */
  const details = (file: ExternalFile) => {
    const index = audioFiles.findIndex((entry) => entry.id === file.id);
    const video = videoFiles[index];
    const fps = audioFpsFor(file, videoFiles.find((v) => v.id === file.matchedVideoId));
    const currentRef = currentReferenceFor(file);
    const canMeasure = measurementAvailable && !engineBusy;
    const format = (() => {
      const track = file.tracks?.find((t) => t.type === "audio");
      return [track?.codec, track?.name, track?.bitrate ? `${Math.round(track.bitrate / 1000)} kb/s` : null].filter(Boolean).join(" · ") || file.name.split(".").pop()?.toUpperCase() || "—";
    })();
    const fpsRow = fps ? ([["Frame rate", <span key="fps" className={needsRateChange(fps) || fps.ambiguous ? "warn" : undefined}>{formatAudioFps(fps)}</span>]] as [string, JSX.Element][]) : [];
    if (!video)
      return (
        <>
          <div><div className="t3">Video</div><div className="big warn">None</div><div className="t2">Row {index + 1} is past the last video, so this file is not muxed.</div></div>
          <DL rows={[["Format", format], ["Size", file.size ? formatFileSize(file.size) : "—"]]} />
          <Links><L icon={<DeleteRegular />} onClick={() => removeAudioFile(index)}>Remove</L></Links>
        </>
      );
    const against = againstFor(video);
    if (measuresEachTrack(file) || (!file.measuredDelay && measuredTrackEntries(file).length > 0)) {
      const tracks = trackDelays(file);
      const pending = pendingDelayCount(file);
      return (
        <>
          <Links>
            {pending > 0 && appliable(file) && <L icon={<CheckmarkRegular />} onClick={() => applyOneMeasuredDelay(file.id)} disabled={isMeasuring}>Apply {pending} {pending === 1 ? "delay" : "delays"}</L>}
            {canMeasure && (
              <L icon={<GaugeRegular />} onClick={() => remeasureFile(file.id)} disabled={isMeasuring}>
                {tracks.some((entry) => entry.measured) ? "Measure every track again" : "Measure every track"}
              </L>
            )}
            {fileLinks(index)}
          </Links>
          <DL
            rows={[
              ["Video", <span key="v" className="truncate" title={video.name}>{video.name}</span>],
              ...fpsRow,
              ...(against ? ([["Against", against]] as [string, JSX.Element][]) : []),
            ]}
          />
          <TrackDelayList entries={tracks} fps={video.fps} currentReferenceTrack={currentRef} currentVideo={videoOf(file)} />
          {tracks
            .filter((entry) => entry.measured)
            .map((entry) => (
              <div key={entry.trackId} className="col" style={{ gap: 12 }}>
                <div className="hr" />
                <span className="sec">Track {entry.index + 1} · {trackLabel(entry)}</span>
                <MeasureSection
                  measured={entry.measured!}
                  pending={entry.pending !== undefined}
                  currentReferenceTrack={currentRef}
                  currentVideo={videoOf(file)}
                  replaced={conformedFor(file, videoOf(file))}
                  stretch={file.trackOverrides?.[entry.trackId]?.stretch}
                  onStretch={(next) => setStretchForTrack(file.id, entry.trackId, next)}
                  busy={isMeasuring}
                  onApply={() => applyOneTrackDelay(file.id, entry.trackId)}
                  onApplyAnyway={() => applyCutDelayAnyway(file.id, entry.trackId)}
                  onUseTimelineDelay={() => applyTimelineDelayFor(file.id, entry.trackId)}
                />
              </div>
            ))}
        </>
      );
    }
    if (file.measuredDelay)
      return (
        <MeasureSection
          measured={file.measuredDelay}
          pending={file.pendingDelay !== undefined}
          currentReferenceTrack={currentRef}
          currentVideo={videoOf(file)}
          replaced={conformedFor(file, videoOf(file))}
          against={against}
          stretch={file.stretch}
          onStretch={(next) => setStretchForFile(file.id, next)}
          busy={isMeasuring}
          onApply={() => applyOneMeasuredDelay(file.id)}
          onApplyAnyway={() => applyCutDelayAnyway(file.id, null)}
          onUseTimelineDelay={() => applyTimelineDelayFor(file.id, null)}
          onMeasureAgain={canMeasure ? () => remeasureFile(file.id) : undefined}
          more={fileLinks(index)}
        />
      );
    return (
      <>
        {/* No Delay row: the Delay field is right below, in the settings. */}
        <DL
          rows={[
            ["Video", <span key="v" className="truncate" title={video.name}>{video.name}</span>],
            ["Format", format],
            ["Size", file.size ? formatFileSize(file.size) : "—"],
            ["Duration", file.duration || "—"],
            ...fpsRow,
            ...(against ? ([["Against", against]] as [string, JSX.Element][]) : []),
          ]}
        />
        <Links>
          {canMeasure && <L icon={<GaugeRegular />} onClick={() => remeasureFile(file.id)} disabled={isMeasuring}>Measure</L>}
          {fileLinks(index)}
        </Links>
      </>
    );
  };

  /** The engine's check of a conformed track, in full, when asked for. */
  const [checkText, setCheckText] = useState<string | null>(null);
  /** The popup's Conform part: the conformed track and its check, with
   *  Undo; or the offer to conform, or why this file cannot be. */
  const conformPart = (file: ExternalFile) => {
    const video = videoOf(file);
    const failure = conformFailures[file.id];
    const inFlight = conforming ? conformProgress?.active[file.id] : undefined;
    const canRun = measurementAvailable && !engineBusy && !busy;
    if (file.conformed) {
      const state = conformedStatus(file, video)!;
      const c = file.conformed;
      return (
        <>
          <div className="hr" />
          <span className="sec">Conform</span>
          <div>
            <div className={state.s === "ok" ? "ok" : "warn"}>{state.text}</div>
            <div className="t2">{state.detail}</div>
          </div>
          <DL
            rows={[
              ["How", conformedHow(c)],
              ["File", <span key="p" className="truncate" title={c.path}>{c.path.replace(/^.*[\\/]/, "")}</span>],
              ...(c.fallbackReason ? ([["Re-encoded", c.fallbackReason]] as [string, string][]) : []),
              ["Muxed", conformedFor(file, video) ? "This track, at delay 0, instead of the file" : "The original file: this was made for another video"],
            ]}
          />
          <Links>
            <L icon={<ArrowUndoRegular />} onClick={() => updateOneFile(file.id, undoConform)} disabled={busy}>Undo: mux the original</L>
            {c.verificationText && c.verificationText.includes("\n") && <L icon={<DataBarVerticalRegular />} onClick={() => setCheckText(c.verificationText)}>Check details</L>}
            {canConform(file, video) && <L icon={<CutRegular />} onClick={() => void beginConform([file.id])} disabled={!canRun}>Conform again</L>}
          </Links>
        </>
      );
    }
    const blocker = conformBlocker(file, video);
    const cut = measuredAsDifferentCut(file);
    if (!cut && !canConform(file, video) && !failure) return null;
    return (
      <>
        <div className="hr" />
        <span className="sec">Conform</span>
        {inFlight ? (
          <Status s="run" pct={inFlight.percent} text={inFlight.stage ?? undefined} />
        ) : failure ? (
          <div className="bad">Conform failed: {failure}</div>
        ) : null}
        <div className="t2">
          {blocker && cut
            ? blocker
            : isMeasuredAgainstAnother(file, video)
              ? "Measure this row again against its video before conforming it."
              : `Lays the dub onto ${video?.name ?? "the video"}'s cut from the engine's plan, as a new file beside it: ${measurement?.conformMode === "lossless" ? "cut on its own frames, not re-encoded" : "re-encoded to the sample"}. The original stays as it is, and Undo goes back to it.`}
        </div>
        {canConform(file, video) && (
          <Links>
            <L icon={<CutRegular />} onClick={() => void beginConform([file.id])} disabled={!canRun}>{cut ? "Conform to this cut" : "Conform anyway"}</L>
          </Links>
        )}
      </>
    );
  };

  const status = useStatus("audio", lcdStatus(lcd));

  // Reference: which audio track of each video its dub is measured against,
  // set for every video at once by position; a video with fewer takes its
  // last one. Each video's own track is written out in full under Against.
  const referenceChoices = referencePositions(videoFiles);
  const withAudio = videoFiles.filter((video) => audioTracksOf(video).length > 0);
  const sharedReference = sharedReferenceIndex(videoFiles, referenceTrackByVideoId);
  const setReferenceForAll = (index: number) => setReferenceTrackByVideoId(referenceForEveryVideo(videoFiles, index));

  return (
    <PageView
      hidden={hidden}
      status={status}
      dock={<PageDock common={shell.dock} />}
      tools={
        <>
          <Cmd icon={<ArrowImportRegular />} disabled={busy} onClick={handleImportAudios}>Import from a video</Cmd>
          <Cmd icon={<ArrowSyncRegular />} title="Rescan" disabled={!folder || busy} onClick={() => void scanAudios(folder)} />
          <Cmd icon={<CopyRegular />} title="Duplicate the file" disabled={!selectedFile || busy} onClick={() => selectedRow !== null && duplicateAudioFile(selectedRow)} />
          <Cmd icon={<DeleteRegular />} title="Remove (Del)" disabled={!canRemove} onClick={() => selectedRow !== null && removeAudioFile(selectedRow)} />
          {selectedFile && (selectedFile.conformed || canConform(selectedFile, videoOf(selectedFile))) && (
            selectedFile.conformed ? (
              <Cmd icon={<ArrowUndoRegular />} title="Mux the original file instead of its conformed track" disabled={busy} onClick={() => updateOneFile(selectedFile.id, undoConform)}>
                Undo conform
              </Cmd>
            ) : (
              <Cmd
                icon={<CutRegular />}
                title={engineBusy ? heldBy : "Lay this dub onto its video's cut, as a new file beside it"}
                disabled={busy || !measurementAvailable || engineBusy}
                onClick={() => void beginConform([selectedFile.id])}
              >
                Conform
              </Cmd>
            )
          )}
          {(matching || matchJobs.length > 0) && (
            <Cmd
              icon={<SoundWaveCircleRegular />}
              title={engineBusy ? heldBy : !measurementAvailable ? (audiosyncEngine?.message ?? "Matching needs the audio analysis engine") : "Listen to the files the names could not place, against the videos without a file"}
              disabled={busy || !measurementAvailable || engineBusy}
              onClick={() => void beginMatching()}
            >
              Match by audio
            </Cmd>
          )}
        </>
      }
      primary={
        matching ? (
          <Btn icon={<StopRegular />} kbd="Esc" onClick={() => void cancelMatching()}>Stop</Btn>
        ) : isMeasuring ? (
          <Btn icon={<StopRegular />} kbd="Esc" onClick={() => void cancelMeasuring()}>Stop</Btn>
        ) : conforming ? (
          <Btn icon={<StopRegular />} kbd="Esc" onClick={() => void cancelConform()}>Stop</Btn>
        ) : pendingCount > 0 || conformIds.length > 0 || conformHeld.size > 0 ? (
          <>
            <Btn icon={<ArrowSyncRegular />} title="Measure every file again, including ones already measured" aria-label="Measure every file again" disabled={!measurementAvailable || engineBusy} onClick={() => void beginMeasuring({ force: true })} />
            {(conformIds.length > 0 || conformHeld.size > 0) && (
              <Btn
                accent={pendingCount === 0 && conformIds.length > 0}
                icon={<CutRegular />}
                title={
                  engineBusy
                    ? heldBy
                    : [
                        conformIds.length > 0 ? "Lay each dub measured as a different cut onto its video's cut, as a new file beside it." : null,
                        conformHeld.size > 0
                          ? `${conformHeld.size} ${conformHeld.size === 1 ? "different cut can't" : "different cuts can't"} be conformed as ${conformHeld.size === 1 ? "it is" : "they are"}: ${[...conformHeld.values()][0]}`
                          : null,
                      ]
                        .filter(Boolean)
                        .join(" ")
                }
                disabled={!measurementAvailable || engineBusy || conformIds.length === 0}
                onClick={() => void beginConform(conformIds)}
              >
                {conformIds.length > 0
                  ? `Conform ${conformIds.length} ${conformIds.length === 1 ? "dub" : "dubs"}`
                  : `Can't conform ${conformHeld.size} ${conformHeld.size === 1 ? "dub" : "dubs"}`}
              </Btn>
            )}
            {pendingCount > 0 && <Btn accent icon={<CheckmarkRegular />} onClick={applyAllMeasuredDelays}>Apply {pendingCount} {pendingCount === 1 ? "delay" : "delays"}</Btn>}
          </>
        ) : measuredCount > 0 ? (
          <Btn icon={<ArrowSyncRegular />} title="Measure every file again, including ones already measured" disabled={!measurementAvailable || engineBusy} onClick={() => void beginMeasuring({ force: true })}>
            Measure again
          </Btn>
        ) : (
          <Btn accent icon={<GaugeRegular />} kbd="Enter" title={measureTitle} disabled={!measurementAvailable || realAudioFiles.length === 0 || engineBusy} onClick={() => void beginMeasuring()}>
            Measure delays
          </Btn>
        )
      }
    >
      <Panel
        label={`Audio ${activeAudioTrack}`}
        left={
          <TrackTabs
            kind="audio"
            slots={audioTracks}
            active={activeAudioTrack}
            configs={audioTrackConfigs}
            disabled={busy}
            onPick={(slot) => {
              setActiveAudioTrack(slot);
              setSelectedRow(null);
            }}
            onNew={addNewTrack}
            onDuplicate={duplicateTrack}
            onDelete={confirmDeleteTrack}
          />
        }
        end={
          realAudioFiles.length > 0 && (
            <>
              <PairByCombo value={pairing.pairBy} chosen={pairing.chosen} disabled={busy} onChange={pairing.choose} />
              <Combo<FilterValue> ghost sm w={96} label="Rows" value={filter} options={FILTER_OPTIONS} onChange={setFilter} />
              <SearchBox value={search} onChange={setSearch} label="Search audio" w={150} />
            </>
          )
        }
        sheet={
          <TrackSheet
            kind="audio"
            config={currentConfig}
            onChange={updateCurrentConfig}
            muxAfterOptions={muxAfterOptions}
            disabled={busy}
            folder={folder}
            onBrowse={() => void chooseFolder()}
            formats={{ value: currentConfig.extension, options: extensionOptions(AUDIO_EXTENSIONS), onChange: (extension) => updateCurrentConfig({ extension }) }}
            extra={
              <SheetField label="Reference" wide>
                {referenceChoices.length > 1 ? (
                  <Combo<number>
                    label="Measure every dub against"
                    value={sharedReference ?? -1}
                    options={[...referenceChoices, ...(sharedReference === null ? [{ value: -1, label: "Chosen video by video: see Against" }] : [])]}
                    w="100%"
                    disabled={isMeasuring}
                    onChange={(index) => index >= 0 && setReferenceForAll(index)}
                  />
                ) : (
                  // Nothing to choose: say why, rather than offer a list of one.
                  <span className="t2 truncate">
                    {withAudio.length === 0 ? "No video loaded yet" : "Each video has one audio track, so each is measured against it: see Against"}
                  </span>
                )}
              </SheetField>
            }
          />
        }
      >
        {realAudioFiles.length > 0 ? (
          <Table
            cols="24px minmax(0,1fr) minmax(0,1fr) 104px minmax(0,1.25fr) 72px 56px 104px 196px"
            head={["#", "Video", "Audio file", "Match", "Against", " Delay", " Frames", "Confidence", "Status"]}
            label={`Audio ${activeAudioTrack}`}
            bodyRef={bodyRef}
          >
            {rows.map(({ index, video, entry, file }) => {
              const dragProps = drag.rowProps(index);
              const inRun = Boolean(isMeasuring && file && (!run.current?.ids || run.current.ids.has(file.id)));
              const fps = file && video ? audioFpsFor(file, video) : null;
              const pairedVideo = file ? (videoOf(file) ?? video) : undefined;
              const measuredStatus = file && video ? rowStatus(file, currentReferenceFor(file), pairedVideo) : null;
              const conformedInUse = Boolean(file && conformedFor(file, pairedVideo));
              const conformRun = file && conforming ? conformProgress?.active[file.id] : undefined;
              const conformFailure = file ? conformFailures[file.id] : undefined;
              const conformOffer = Boolean(file && !busy && conformIds.includes(file.id));
              const conformHeldReason = file && !busy ? conformHeld.get(file.id) : undefined;
              const rowState = !file
                ? null
                : !video
                  ? { s: "warn" as St, text: "No video" }
                  : measuredStatus!.s === "ready" && fps && needsRateChange(fps)
                    ? { s: "warn" as St, text: formatAudioFps(fps) }
                    : measuredStatus!;
              const pending = file ? hasPendingDelay(file) : false;
              // In flight: the engine names a pair by its video.
              const runningPct = inRun && video ? measureProgress?.active[video.name] : undefined;
              // A file of several dubs: one delay when its tracks agree, else how
              // many, each listed on hover and in full in the popup.
              const perTrack = file && measuresEachTrack(file) ? trackDelays(file) : null;
              const trackValues = perTrack?.map(shownTrackDelay) ?? [];
              const tracksAgree = trackValues.every((value) => value === trackValues[0]);
              const shownDelay = perTrack ? trackValues[0] : file ? (file.pendingDelay ?? file.delay) : undefined;
              const delayText = !file ? "" : conformedInUse ? formatDelay(0) : perTrack && !tracksAgree ? `${perTrack.length} delays` : formatDelay(shownDelay);
              const delayTitle = conformedInUse ? "The conformed track is laid on the video's timeline, so it is muxed at 0" : perTrack ? perTrack.map((entry) => `${entry.index + 1} · ${trackLabel(entry)}: ${formatDelay(shownTrackDelay(entry))} s`).join("\n") : undefined;
              const trackMeasurements = (perTrack ?? []).map((entry) => entry.measured).filter((m): m is NonNullable<typeof m> => Boolean(m && !m.error));
              const measured = perTrack
                ? ([...trackMeasurements].sort((a, b) => (a.confidence ?? 1) - (b.confidence ?? 1))[0] ?? null)
                : file?.measuredDelay && !file.measuredDelay.error ? file.measuredDelay : null;
              // Frames are the Delay column's, in frames: only when that delay is
              // the measured one, never a withheld measurement beside a 0.000.
              const delayIsMeasured = perTrack
                ? tracksAgree && perTrack.every((entry) => entry.measured && !entry.measured.error && (entry.pending !== undefined || entry.provenance === "measured"))
                : Boolean(measured && (pending || file?.delayProvenance === "measured"));
              const frames = !conformedInUse && delayIsMeasured && shownDelay !== undefined ? frameOffset(shownDelay * 1000, video?.fps ?? measured?.primaryFps) : null;
              return (
                <Tr
                  key={entry?.id ?? `video-${video?.id}`}
                  on={selectedRow === index}
                  className={dragProps.className}
                  onPointerDown={file ? dragProps.onPointerDown : undefined}
                  onClick={() => setSelectedRow(index)}
                  onDoubleClick={() => {
                    if (!file) return;
                    setSelectedRow(index);
                    openEditDialog(file.id);
                  }}
                  label={file?.name ?? video?.name}
                >
                  <span className="num t3">{index + 1}</span>
                  {video ? <span className="t2 truncate" title={video.name}>{video.name}</span> : <span className="warn">No video</span>}
                  {file ? (
                    <span className="cell">
                      <Grip />
                      <span className="truncate" title={conformedInUse ? `${file.name}\nMuxed as ${file.conformed!.path}` : file.name}>{file.name}</span>
                      {perTrack && <span className="t3" style={{ flexShrink: 0 }} title={delayTitle}>{perTrack.length} tracks</span>}
                      {conformedInUse && <span className="t3" style={{ flexShrink: 0 }} title={file.conformed!.path}>conformed</span>}
                    </span>
                  ) : (
                    <span className="nil" title={entry ? "No file for this video: the files after it stay with their own" : undefined}>—</span>
                  )}
                  <MatchCell file={file} info={file ? pairing.infoOf(file.id) : undefined} conflict={file ? pairing.conflictOf(file.id) : undefined} />
                  {video && audioTracksOf(video).length > 1 ? (
                    // This video's own tracks, in full: three "Chinese" differ in codec, channels or name.
                    <span style={{ minWidth: 0 }} title={trackDetails(audioTracksOf(video)[plannedReferenceTrack(video, referenceTrackByVideoId)], plannedReferenceTrack(video, referenceTrackByVideoId))}>
                      <Combo<number>
                        ghost
                        sm
                        w="100%"
                        label={`Measure ${file?.name ?? video.name} against`}
                        value={plannedReferenceTrack(video, referenceTrackByVideoId)}
                        options={audioTracksOf(video).map((track, i) => ({ value: i, label: trackDetails(track, i) }))}
                        disabled={busy}
                        onChange={(i) => setReferenceTrackByVideoId((prev) => ({ ...prev, [video.id]: i }))}
                      />
                    </span>
                  ) : (
                    // Inset as far as the picker's text in the rows that have one (its padding and border), so the column lines up.
                    <span className="t3 truncate" style={{ paddingLeft: 12 }} title={video && audioTracksOf(video)[0] ? trackDetails(audioTracksOf(video)[0], 0) : undefined}>
                      {video && audioTracksOf(video)[0] ? trackDetails(audioTracksOf(video)[0], 0) : "—"}
                    </span>
                  )}
                  <span className={cx("r num", pending ? "acc" : "t2")} style={{ display: "flex" }} title={delayTitle}>{delayText}</span>
                  <span className="r num t2" style={{ display: "flex" }}>{frames === null ? (file ? "—" : "") : `${frames > 0 ? "+" : ""}${frames}`}</span>
                  {measured?.confidence != null ? (
                    <span className="cell num t2"><Meter pct={measured.confidence * 100} />{Math.round(measured.confidence * 100)}%</span>
                  ) : (
                    <span className="t3">{file ? "—" : ""}</span>
                  )}
                  {!file ? (
                    <span />
                  ) : runningPct !== undefined ? (
                    <Status s="run" pct={runningPct} />
                  ) : inRun && rowState?.s === "ready" ? (
                    <Status s="wait" />
                  ) : conformRun ? (
                    <Status s="run" pct={conformRun.percent} text={conformRun.stage ?? undefined} />
                  ) : conformFailure ? (
                    <span className="cell" title={conformFailure} style={{ minWidth: 0 }}><Status s="bad" text="Conform failed" /></span>
                  ) : conformOffer ? (
                    <span className="cell" style={{ minWidth: 0, gap: 6 }} title={rowState!.text}>
                      <Status s={rowState!.s} text={rowState!.text} />
                      <button
                        type="button"
                        className="acc sm"
                        style={{ flexShrink: 0 }}
                        title={engineBusy ? heldBy : "Lay this dub onto its video's cut, as a new file beside it"}
                        disabled={!measurementAvailable || engineBusy}
                        onClick={(event) => {
                          event.stopPropagation();
                          void beginConform([file.id]);
                        }}
                        onDoubleClick={(event) => event.stopPropagation()}
                        onPointerDown={(event) => event.stopPropagation()}
                      >
                        Conform
                      </button>
                    </span>
                  ) : conformHeldReason ? (
                    // Disabled, so the cell carries the reason on hover.
                    <span className="cell" style={{ minWidth: 0, gap: 6 }} title={conformHeldReason}>
                      <Status s={rowState!.s} text={rowState!.text} />
                      <button type="button" className="t3 sm" style={{ flexShrink: 0 }} disabled aria-label={`Can't conform: ${conformHeldReason}`}>
                        Conform
                      </button>
                    </span>
                  ) : (
                    <span className="cell" style={{ minWidth: 0 }} title={file.conformed ? conformedStatus(file, pairedVideo)?.detail : rowState!.text}><Status s={rowState!.s} text={rowState!.text} /></span>
                  )}
                </Tr>
              );
            })}
          </Table>
        ) : (
          <Empty icon={<MusicNote2Regular />} title="Drop a folder of audio files">
            <Btn icon={<FolderOpenRegular />} onClick={() => void chooseFolder()}>Choose folder</Btn>
            <Btn icon={<ArrowImportRegular />} onClick={handleImportAudios}>Import from a video</Btn>
          </Empty>
        )}
      </Panel>

      {importStreamsOpen && (
        <ImportStreamsDialog
          kind="audio"
          videoFiles={videoFiles}
          sourceId={importSourceVideoId}
          onSource={(value) => {
            setImportSourceVideoId(value);
            setImportSelectedTrackKeys([]);
            setImportOverrides({});
          }}
          streams={importableTracks}
          selectedKeys={importSelectedTrackKeys}
          onSelectedKeys={setImportSelectedTrackKeys}
          overrides={importOverrides}
          onOverride={(key, value) => setImportOverrides((prev) => ({ ...prev, [key]: value }))}
          keyOf={getImportTrackKey}
          targetLabel={`Into row ${importRow + 1}${videoFiles[importRow] ? `, beside ${videoFiles[importRow].name}` : ""}${importRow < (selectedRow ?? 0) ? ", the first without a file" : ""}`}
          onCancel={() => {
            setImportStreamsOpen(false);
            setImportOverrides({});
          }}
          onImport={handleConfirmImportAudios}
        />
      )}

      {editDialogOpen && editingFile && (
        <Dialog
          size="xl"
          bodyClass="flush"
          title={editingFile.name}
          sub={(() => {
            const index = audioFiles.findIndex((file) => file.id === editingFile.id);
            const others = rowsWithFile(audioFiles, editingFile.id).filter((row) => row !== index);
            return [
              videoFiles[index] ? `Row ${index + 1} · with ${videoFiles[index].name}` : `Row ${index + 1} · no video`,
              others.length ? `same file in row${others.length === 1 ? "" : "s"} ${others.map((row) => row + 1).join(", ")}` : null,
            ]
              .filter(Boolean)
              .join(" · ");
          })()}
          onClose={closeEdit}
          left={(() => {
            const rows = rowsWithFile(audioFiles, editingFile.id).map((row) => row + 1);
            const scopes: { value: EditScope; label: string }[] = [
              { value: "row", label: "This row only" },
              ...(rows.length > 1 ? [{ value: "file" as const, label: `Rows ${rows.join(", ")}: this file, each its own delays` }] : []),
              { value: "all", label: "Every row: every setting, delay too" },
            ];
            return (
              <>
                <span className="t3">Save to</span>
                <span title={editForm.scope === "all" ? "Track choices apply by position" : editForm.scope === "file" ? "Track and subtitle choices, language, names and flags; never a delay" : undefined}>
                  <Combo<EditScope> sm label="Save to" value={editForm.scope} options={scopes} w={290} onChange={(scope) => setEditForm((prev) => ({ ...prev, scope }))} />
                </span>
                {editForm.scope !== "all" && (
                  <Chk on={editForm.applyDelayToAll} onChange={(applyDelayToAll) => setEditForm((prev) => ({ ...prev, applyDelayToAll }))}>This delay to every row</Chk>
                )}
              </>
            );
          })()}
          foot={
            <>
              <Btn onClick={closeEdit}>Cancel</Btn>
              <Btn accent disabled={!delayInputsAreValid(editDelay)} onClick={applyEditChanges}>Save</Btn>
            </>
          }
        >
          <div className="box-b">
          {details(editingFile)}
          {conformPart(editingFile)}
          {(() => {
            const info = pairing.infoOf(editingFile.id);
            const conflict = pairing.conflictOf(editingFile.id);
            return (
              <>
                <DL rows={[["Paired", pairingLine(info, conflict, editingFile)]]} />
                <Links>
                  <PairingLinks info={info} conflict={conflict} disabled={busy} onKeep={() => pairing.keep(editingFile.id)} onRelease={() => pairing.release(editingFile.id)} />
                </Links>
              </>
            );
          })()}
          <div className="hr" />
          <span className="sec">Settings</span>
          <div className="egrid">
            <Fld label="Language"><LangCombo value={editForm.language} onChange={(language) => setEditForm((prev) => ({ ...prev, language }))} w="100%" /></Fld>
            <Fld label="Track name"><TBox label="Track name" value={editForm.trackName} placeholder="Keep the file's name" onChange={(trackName) => setEditForm((prev) => ({ ...prev, trackName }))} /></Fld>
            <DelayField
              value={editDelay}
              hint={measuresEachTrack(editingFile) ? "For a track without a delay of its own" : undefined}
              onChange={(delay) => setEditForm((prev) => ({ ...prev, delay, delayTouched: true }))}
            />
            <Fld label="Place after"><Combo<string> label="Place after" value={editForm.muxAfter} options={muxAfterOptions} w="100%" onChange={(muxAfter) => setEditForm((prev) => ({ ...prev, muxAfter }))} /></Fld>
          </div>
          {/* No "Forced": audio is never forced in practice. */}
          <div className="row" style={{ gap: 28 }}>
            <span title="The first included track becomes the default">
              <Chk on={editForm.isDefault} onChange={(isDefault) => setEditForm((prev) => ({ ...prev, isDefault }))}>Default</Chk>
            </span>
          </div>
          {editingFile.tracks && editingFile.tracks.length > 0 && (
            <FileTracks
              title="Audio tracks in this file"
              tools={
                <>
                  {editingFile.tracks.filter((track) => track.type === "audio").length > 1 && (
                    <Cmd sm icon={<TimelineRegular />} onClick={() => openMultiDelayDialog(editingFile.id, "audio")}>Track delays…</Cmd>
                  )}
                  <Cmd sm icon={<CheckmarkRegular />} onClick={() => setEditForm((prev) => ({ ...prev, includedTrackIds: getAudioTrackIds(editingFile) }))}>All</Cmd>
                  <Cmd sm icon={<DismissRegular />} onClick={() => setEditForm((prev) => ({ ...prev, includedTrackIds: [] }))}>None</Cmd>
                </>
              }
            >
              {editingFile.tracks
                .filter((track) => track.type === "audio")
                .map((track, index) => {
                  const trackId = Number(track.id);
                  return (
                    <FileTrackRow
                      key={track.id}
                      index={index}
                      label={[languageName(track.language), track.codec, track.name].filter(Boolean).join(" · ")}
                      on={editForm.includedTrackIds.includes(trackId)}
                      onChange={(on) => {
                        const next = new Set(editForm.includedTrackIds);
                        if (on) {
                          if (!Number.isNaN(trackId)) next.add(trackId);
                        } else next.delete(trackId);
                        setEditForm((prev) => ({ ...prev, includedTrackIds: Array.from(next) }));
                      }}
                      isDefault={track.isDefault}
                      note={(() => {
                        const own = editingFile.trackOverrides?.[trackId]?.delay;
                        return own === undefined ? undefined : `${formatDelay(own)} s`;
                      })()}
                      onEdit={() => openTrackEdit(editingFile.id, trackId, "audio")}
                    />
                  );
                })}
            </FileTracks>
          )}
          {editingFile.tracks?.some((track) => track.type === "subtitle") && (
            <>
              <div className="row" style={{ gap: 28 }}>
                <span title="Subtitle tracks inside this audio file">
                  <Chk
                    on={editForm.includeSubtitles}
                    onChange={(on) =>
                      setEditForm((prev) => ({
                        ...prev,
                        includeSubtitles: on,
                        includedSubtitleTrackIds: on ? getSubtitleTrackIds(editingFile) : [],
                        includedSubtitlesDefault: on ? prev.includedSubtitlesDefault : false,
                        includedSubtitlesForced: on ? prev.includedSubtitlesForced : false,
                        includedSubtitlesFirst: on ? prev.includedSubtitlesFirst : false,
                      }))
                    }
                  >
                    Copy its subtitles
                  </Chk>
                </span>
                <span title="Before the video's own subtitles, the first one default">
                  <Chk
                    on={editForm.includedSubtitlesFirst && editForm.includedSubtitlesDefault}
                    onChange={(on) =>
                      setEditForm((prev) => ({
                        ...prev,
                        includeSubtitles: true,
                        includedSubtitleTrackIds: prev.includedSubtitleTrackIds.length ? prev.includedSubtitleTrackIds : getSubtitleTrackIds(editingFile),
                        includedSubtitlesFirst: on,
                        includedSubtitlesDefault: on,
                      }))
                    }
                  >
                    First and default
                  </Chk>
                </span>
                <span title="Forced display for the copied subtitles">
                  <Chk
                    on={editForm.includedSubtitlesForced}
                    onChange={(on) =>
                      setEditForm((prev) => ({
                        ...prev,
                        includeSubtitles: true,
                        includedSubtitleTrackIds: prev.includedSubtitleTrackIds.length ? prev.includedSubtitleTrackIds : getSubtitleTrackIds(editingFile),
                        includedSubtitlesForced: on,
                      }))
                    }
                  >
                    Forced
                  </Chk>
                </span>
              </div>
              <FileTracks
                title="Subtitles in this file"
                tools={
                  <>
                    {editingFile.tracks.filter((track) => track.type === "subtitle").length > 1 && (
                      <Cmd sm icon={<TimelineRegular />} onClick={() => openMultiDelayDialog(editingFile.id, "subtitle")}>Track delays…</Cmd>
                    )}
                    <Cmd sm icon={<CheckmarkRegular />} onClick={() => setEditForm((prev) => ({ ...prev, includeSubtitles: true, includedSubtitleTrackIds: getSubtitleTrackIds(editingFile) }))}>All</Cmd>
                    <Cmd
                      sm
                      icon={<DismissRegular />}
                      onClick={() =>
                        setEditForm((prev) => ({ ...prev, includeSubtitles: false, includedSubtitleTrackIds: [], includedSubtitlesDefault: false, includedSubtitlesForced: false, includedSubtitlesFirst: false }))
                      }
                    >
                      None
                    </Cmd>
                  </>
                }
              >
                {editingFile.tracks
                  .filter((track) => track.type === "subtitle")
                  .map((track, index) => {
                    const trackId = Number(track.id);
                    return (
                      <FileTrackRow
                        key={track.id}
                        index={index}
                        label={[languageName(track.language), track.codec, track.name].filter(Boolean).join(" · ")}
                        on={editForm.includedSubtitleTrackIds.includes(trackId)}
                        onChange={(on) => {
                          const next = new Set(editForm.includedSubtitleTrackIds);
                          if (on) {
                            if (!Number.isNaN(trackId)) next.add(trackId);
                          } else next.delete(trackId);
                          setEditForm((prev) => ({ ...prev, includeSubtitles: true, includedSubtitleTrackIds: Array.from(next) }));
                        }}
                        onEdit={() => openTrackEdit(editingFile.id, trackId, "subtitle")}
                      />
                    );
                  })}
              </FileTracks>
            </>
          )}
          </div>
        </Dialog>
      )}

      {checkText && <ReportDetails title="Conformed track check" sub="The engine's check of the conformed track against the video" text={checkText} onClose={() => setCheckText(null)} />}

      {multiDelayOpen && multiDelayFile && (
        <TrackDelaysDialog
          kind={multiDelayTrackType}
          file={multiDelayFile}
          values={multiDelayValues}
          onValues={setMultiDelayValues}
          bulk={multiDelayBulkValue}
          onBulk={setMultiDelayBulkValue}
          onCancel={() => {
            setMultiDelayOpen(false);
            setMultiDelayFileId(null);
            setMultiDelayTrackType("audio");
            setMultiDelayValues({});
          }}
          onSave={applyMultiDelayChanges}
        />
      )}

      <ImportTrackEditDialog
        open={trackEditOpen}
        onOpenChange={(open) => {
          setTrackEditOpen(open);
          if (!open) setTrackEditTarget(null);
        }}
        kind={trackEditTarget?.trackType ?? "audio"}
        title="Edit a track"
        trackLabel={trackEditTarget ? `Track ${trackEditTarget.trackId}` : ""}
        value={{ language: trackEditForm.language, trackName: trackEditForm.trackName, delay: delaySecondsOrZero(trackEditForm.delay) }}
        onSave={applyTrackEdit}
      />

      {deleteDialogOpen && trackToDelete && (
        <DeleteSlotDialog
          kind="audio"
          slot={trackToDelete}
          onCancel={() => {
            setDeleteDialogOpen(false);
            setTrackToDelete(null);
          }}
          onDelete={deleteTrack}
        />
      )}
    </PageView>
  );
}
