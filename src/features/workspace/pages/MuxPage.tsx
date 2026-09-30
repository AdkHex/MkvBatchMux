/** Mux: the queue, where every loaded video goes to mkvmerge. The queue is
 *  simply the loaded videos, so it fills itself; this page shows it, where the
 *  files go (Save to, in the toolbar's middle) and, behind Options, how. A
 *  double-click on a job opens its details. Start, validation, pause and stop
 *  live in the shell (src/app/Index.tsx), which holds the queue; this page
 *  asks before starting a batch that validation had warnings about — the old
 *  Mux Settings tab's rule. */

import {
  AttachRegular,
  BookmarkMultipleRegular,
  BracesRegular,
  CheckmarkStarburstRegular,
  ChevronDownRegular,
  ChevronUpRegular,
  ClosedCaptionRegular,
  CopyRegular,
  DeleteRegular,
  FolderOpenRegular,
  FolderRegular,
  LayerRegular,
  MusicNote2Regular,
  OptionsRegular,
  PauseRegular,
  PlayRegular,
  StopRegular,
  VideoClipRegular,
} from "@fluentui/react-icons";
import { useEffect, useMemo, useRef, useState } from "react";

import { PageDock } from "@/app/dock";
import { muxOutcome, timeLeftText, tookText } from "@/app/history";
import { useShell, usePageCommands, useStatus, type PageId } from "@/app/shell";
import { pickDirectory } from "@/shared/lib/backend";
import type { MuxJob, MuxPreviewResult, MuxSettings, OutputSettings, VideoFile } from "@/shared/types";
import { Dialog, PageView, Panel, Popover, lcdStatus, type LcdProps } from "@/ui/frame";
import { Btn, Chk, Cmd, Combo, Empty, Fld, InfoBar, LangCombo, MidText, Status, TBox, Table, Toggle, Tr, cx, type St } from "@/ui/kit";

import { SearchBox, formatDelay, formatGb } from "./common";
import { languageName } from "./tracks/parts";

/** One track of the file a job writes: kept from the source, added from a
 *  file, or removed. */
export interface ReportTrack {
  type: "video" | "audio" | "subtitle";
  /** ISO 639 code. */
  language?: string;
  name: string;
  /** "Source", or the added file's name. */
  from: string;
  flags: string[];
  delay?: number;
  added?: boolean;
  removed?: boolean;
}

export interface JobReport {
  title: string;
  sections: { title: string; items: { title: string; details: string[] }[] }[];
  /** Every track of the new file, in order, then the removed ones. */
  tracks?: ReportTrack[];
  /** What happens to chapters, attachments and tags. */
  also?: [string, string][];
}

/** What a job adds to its video, for the queue's Adds column. */
export interface JobAdds {
  audio: number;
  subtitle: number;
  chapter: number;
  attachment: number;
}

export interface MuxPageProps {
  hidden: boolean;
  settings: OutputSettings;
  onSettingsChange: (settings: Partial<OutputSettings>) => void;
  muxSettings: MuxSettings;
  onMuxSettingsChange: (settings: Partial<MuxSettings>) => void;
  fastMuxAvailable: boolean;
  /** Why the batch cannot start: files with no video to go into. */
  externalLinkIssues: string[];
  /** The page to fix those on. */
  unlinkedPage: PageId | null;
  jobs: MuxJob[];
  videoFiles: VideoFile[];
  /** What each job adds, by job id. */
  addsByJob?: Record<string, JobAdds>;
  /** Empty the queue, which is to say the loaded videos. */
  onClearQueue: () => void;
  onStartMuxing: () => void;
  onPauseMuxing: () => void;
  onResumeMuxing: () => void;
  onStopMuxing: () => void;
  previewResults: Record<string, MuxPreviewResult>;
  previewLoading: boolean;
  onPreviewQueue: () => void;
  getJobReport?: (jobId: string) => JobReport | null;
  /** The batch being muxed: when it started and ended, and whether it is pausing. */
  batch: { startedAt: number | null; finishedAt: number | null; paused: boolean };
  /** A batch is going. */
  running: boolean;
}

/** The confirmation lists this many warnings, then says how many more. */
const LISTED_WARNINGS = 8;

/** Jobs at once: 0 is automatic (every job, up to 16). */
const PARALLEL_OPTIONS = [
  { value: 0, label: "Automatic" },
  { value: 1, label: "1" },
  { value: 2, label: "2" },
  { value: 4, label: "4" },
  { value: 8, label: "8" },
];

function formatEta(seconds?: number) {
  if (seconds === undefined || seconds <= 0 || Number.isNaN(seconds)) return "—";
  const mins = Math.floor(seconds / 60);
  const secs = seconds % 60;
  return mins <= 0 ? `${secs} s` : `${mins} min`;
}

const typeIcon = (type: ReportTrack["type"]) => (type === "video" ? <VideoClipRegular /> : type === "audio" ? <MusicNote2Regular /> : <ClosedCaptionRegular />);

export function MuxPage({
  hidden,
  settings,
  onSettingsChange,
  muxSettings,
  onMuxSettingsChange,
  fastMuxAvailable,
  externalLinkIssues,
  unlinkedPage,
  jobs,
  videoFiles,
  addsByJob = {},
  onClearQueue,
  onStartMuxing,
  onPauseMuxing,
  onResumeMuxing,
  onStopMuxing,
  previewResults,
  previewLoading,
  onPreviewQueue,
  getJobReport,
  batch,
  running,
}: MuxPageProps) {
  const shell = useShell();
  const [selectedJobIndex, setSelectedJobIndex] = useState<number | null>(null);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [confirmStartOpen, setConfirmStartOpen] = useState(false);
  const [confirmClearOpen, setConfirmClearOpen] = useState(false);
  const [open, setOpen] = useState<"save" | "options" | null>(null);
  const [search, setSearch] = useState("");
  const saveRef = useRef<HTMLButtonElement>(null);
  const optionsRef = useRef<HTMLButtonElement>(null);

  const hasJobs = jobs.length > 0;
  const measuring = shell.enginePage === "audio";
  const hasExternalLinkIssues = externalLinkIssues.length > 0;

  const namingPreview = useMemo(() => {
    const sample = videoFiles[0]?.name || "Example.E01.mkv";
    const stem = sample.replace(/\.[^/.]+$/, "");
    const pattern = settings.namingPattern.trim() || "{original_filename}";
    return `${pattern
      .split("{original_filename}")
      .join(stem)
      .split("{filename}")
      .join(stem)
      .split("{name}")
      .join(stem)
      .split("{extension}")
      .join("mkv")
      .split("{id}")
      .join(videoFiles[0]?.id || "video-id")}.mkv`;
  }, [settings.namingPattern, videoFiles]);

  /** The warnings themselves, so the confirmation can show what they are
   *  rather than only how many there are. */
  const warnings = useMemo(() => Object.values(previewResults).flatMap((result) => result.warnings), [previewResults]);
  const warnedJobs = useMemo(() => Object.values(previewResults).filter((result) => result.warnings.length > 0).length, [previewResults]);
  // Ask only when starting anyway despite validation problems: a long-running
  // batch with overwrite on is not undoable.
  const startNeedsConfirming = warnings.length > 0;
  const handleStartClick = () => {
    if (startNeedsConfirming) {
      setConfirmStartOpen(true);
      return;
    }
    onStartMuxing();
  };

  const overallProgress = useMemo(() => {
    if (!hasJobs) return 0;
    const sum = jobs.reduce((acc, job) => (job.status === "completed" ? acc + 100 : job.status === "processing" ? acc + job.progress : acc), 0);
    return Math.round(sum / jobs.length);
  }, [hasJobs, jobs]);

  useEffect(() => {
    if (jobs.length === 0) {
      setSelectedJobIndex(null);
      setDetailsOpen(false);
      return;
    }
    if (selectedJobIndex !== null && selectedJobIndex >= jobs.length) setSelectedJobIndex(jobs.length - 1);
  }, [jobs.length, selectedJobIndex]);

  // Settings cannot change while a batch runs: close their panels.
  useEffect(() => {
    if (running) setOpen(null);
  }, [running]);

  const selectedJob = selectedJobIndex !== null ? jobs[selectedJobIndex] : undefined;
  const openDetails = (index: number | null = selectedJobIndex) => {
    if (index === null) return;
    setSelectedJobIndex(index);
    setDetailsOpen(true);
  };

  const finished = batch.finishedAt !== null && !running && hasJobs;
  const stopped = jobs.some((job) => job.status === "stopped");
  const canStart = hasJobs && !hasExternalLinkIssues && !running && !measuring;

  usePageCommands("mux", {
    start: canStart ? handleStartClick : undefined,
    stop: running ? onStopMuxing : undefined,
    clear: hasJobs && !running ? () => setConfirmClearOpen(true) : undefined,
  });

  // --------------------------------------------------------------- display

  const started = jobs.filter((job) => job.status !== "queued").length;
  const processing = jobs.filter((job) => job.status === "processing");
  const into = settings.directory.trim() || "Beside the sources";
  const lcd: LcdProps = running
    ? batch.paused
      ? { icon: "warn", l1: "Pausing after the running jobs", l2: "No new job starts until you resume", pct: overallProgress }
      : {
          icon: "run",
          l1: `Muxing ${Math.max(1, Math.min(jobs.length, started))} of ${jobs.length}`,
          l2: processing.length ? `${processing[0].videoFile.name}${processing.length > 1 ? ` and ${processing.length - 1} more` : ""}` : undefined,
          pct: overallProgress,
          time: batch.startedAt ? (timeLeftText(Date.now() - batch.startedAt, overallProgress / 100) ?? undefined) : undefined,
        }
    : previewLoading
      ? { icon: "run", l1: `Validating ${jobs.length} job${jobs.length === 1 ? "" : "s"}`, pct: null }
      : finished
        ? (() => {
            const outcome = muxOutcome(jobs);
            return {
              icon: (outcome.tone === "ok" ? "ok" : outcome.tone === "bad" ? "bad" : "warn") as LcdProps["icon"],
              l1: outcome.parts.join(" · "),
              l2: stopped ? `${jobs.filter((j) => j.status === "stopped").length} stopped` : `Into ${into} in ${tookText((batch.finishedAt ?? 0) - (batch.startedAt ?? 0))}`,
            };
          })()
        : hasJobs && hasExternalLinkIssues
          ? { icon: "warn", l1: externalLinkIssues[0].replace(/\.$/, ""), l2: "Pair every file before muxing" }
          : hasJobs && warnings.length > 0
            ? { icon: "warn", l1: `Validated · ${warnings.length} warning${warnings.length === 1 ? "" : "s"} in ${warnedJobs} job${warnedJobs === 1 ? "" : "s"}`, l2: "Start asks before it runs" }
            : { l1: "" };
  const own = useStatus("mux", lcdStatus(lcd));
  // Save to keeps the toolbar's middle except while something runs: a
  // finished batch's result is in the Status column, History and Output.
  const status = own?.icon === "run" ? own : null;

  const statusOf = (job: MuxJob): { s: St; text?: string; pct?: number; title?: string } => {
    const jobWarnings = previewResults[job.id]?.warnings ?? [];
    if (job.status === "processing") return { s: "run", pct: job.progress };
    if (job.status === "completed") return { s: "ok" };
    if (job.status === "error") return { s: "bad", title: job.errorMessage };
    if (job.status === "stopped") return { s: "warn", text: "Stopped" };
    if (jobWarnings.length > 0) return { s: "warn", text: `${jobWarnings.length} warning${jobWarnings.length === 1 ? "" : "s"}`, title: jobWarnings.join("\n") };
    return { s: "wait", text: finished && stopped ? "Not started" : "Queued" };
  };

  const query = search.trim().toLowerCase();
  const shown = jobs.map((job, index) => ({ job, index })).filter(({ job }) => !query || job.videoFile.name.toLowerCase().includes(query));
  const totalBytes = jobs.reduce((sum, job) => sum + (job.sizeBefore ?? job.videoFile.size ?? 0), 0);

  const setDirectory = (directory: string) => {
    onSettingsChange({ directory });
    onMuxSettingsChange({ destinationDir: directory });
  };
  const browse = async () => {
    const directory = await pickDirectory();
    if (directory) setDirectory(directory);
  };
  const willOverwrite = settings.directory.trim() === "" && settings.overwriteExisting;
  const keepAudio = muxSettings.onlyKeepAudiosEnabled && muxSettings.onlyKeepAudioLanguages[0] ? muxSettings.onlyKeepAudioLanguages[0] : "all";
  const keepSubs = muxSettings.onlyKeepSubtitlesEnabled && muxSettings.onlyKeepSubtitleLanguages[0] ? muxSettings.onlyKeepSubtitleLanguages[0] : "all";

  const saveTo = (
    <span className="destw">
      <button
        ref={saveRef}
        type="button"
        className={cx("dest", open === "save" && "on")}
        disabled={running}
        aria-expanded={open === "save"}
        title={`Where the files go: ${into}`}
        onClick={() => setOpen(open === "save" ? null : "save")}
      >
        <span className="ic" aria-hidden><FolderRegular /></span>
        {settings.directory.trim() ? <span className="truncate">{settings.directory}</span> : <span className="ph truncate">{settings.overwriteExisting ? "Over the sources" : "Beside the sources"}</span>}
        <span className="nm truncate">\{settings.namingPattern.trim() || "{original_filename}"}.mkv</span>
        <span className="ch" aria-hidden><ChevronDownRegular /></span>
      </button>
      <button type="button" className="destb" title="Choose the folder" aria-label="Choose the output folder" disabled={running} onClick={() => void browse()}>
        <FolderOpenRegular />
      </button>
    </span>
  );

  return (
    <PageView
      hidden={hidden}
      status={status}
      center={saveTo}
      dock={<PageDock common={shell.dock} />}
      tools={
        <>
          <Cmd icon={<CheckmarkStarburstRegular />} disabled={!hasJobs || previewLoading || hasExternalLinkIssues || running || measuring} onClick={onPreviewQueue}>
            {previewLoading ? "Validating…" : "Validate"}
          </Cmd>
          <button ref={optionsRef} type="button" className={cx("cmd", open === "options" && "on")} disabled={running} aria-expanded={open === "options"} onClick={() => setOpen(open === "options" ? null : "options")}>
            <span className="ic" aria-hidden><OptionsRegular /></span>
            <span className="lbl">Options</span>
          </button>
        </>
      }
      primary={
        running ? (
          <>
            {batch.paused ? <Btn icon={<PlayRegular />} onClick={onResumeMuxing}>Resume</Btn> : <Btn icon={<PauseRegular />} onClick={onPauseMuxing}>Pause</Btn>}
            <Btn icon={<StopRegular />} kbd="Esc" onClick={onStopMuxing}>Stop</Btn>
          </>
        ) : (
          <>
            <Btn icon={<DeleteRegular />} title="Clear the queue" aria-label="Clear the queue" disabled={!hasJobs} onClick={() => setConfirmClearOpen(true)} />
            <Btn accent icon={<PlayRegular />} kbd="Enter" title={measuring ? "Measuring is running on Audio" : undefined} disabled={!canStart} onClick={handleStartClick}>
              Start muxing
            </Btn>
          </>
        )
      }
    >
      <Panel
        label="Queue"
        left={
          <span className="crumb">
            Queue
            {hasJobs && <span className="t3">{jobs.length} video{jobs.length === 1 ? "" : "s"} · {formatGb(totalBytes)}</span>}
          </span>
        }
        end={hasJobs && <SearchBox value={search} onChange={setSearch} label="Search the queue" w={180} />}
      >
        {hasJobs && hasExternalLinkIssues && (
          <InfoBar tone="warn" actions={unlinkedPage ? <Btn onClick={() => shell.show(unlinkedPage)}>Show on {unlinkedPage === "audio" ? "Audio" : "Subtitles"}</Btn> : undefined}>
            {externalLinkIssues.join(" ")}
          </InfoBar>
        )}
        {hasJobs && !running && !hasExternalLinkIssues && warnings.length > 0 && (
          <InfoBar
            tone="warn"
            actions={
              <Btn
                onClick={() => {
                  const index = jobs.findIndex((job) => (previewResults[job.id]?.warnings.length ?? 0) > 0);
                  openDetails(index >= 0 ? index : null);
                }}
              >
                Show
              </Btn>
            }
          >
            Validation found {warnings.length} warning{warnings.length === 1 ? "" : "s"} in {warnedJobs} job{warnedJobs === 1 ? "" : "s"}.
          </InfoBar>
        )}
        {hasJobs ? (
          <Table cols="24px minmax(0,1fr) 132px 72px 72px 150px 52px" head={["#", "Name", "Adds", " Before", " After", "Status", " Left"]} label="Queue">
            {shown.map(({ job, index }) => {
              const jobStatus = statusOf(job);
              const adds = addsByJob[job.id];
              return (
                <Tr key={job.id} on={selectedJobIndex === index} onClick={() => setSelectedJobIndex(index)} onDoubleClick={() => openDetails(index)} label={job.videoFile.name}>
                  <span className="num t3">{index + 1}</span>
                  <span className="cell"><span className="fi" aria-hidden><VideoClipRegular /></span><MidText text={job.videoFile.name} tail={40} /></span>
                  {adds ? <Adds adds={adds} /> : <span className="t3">—</span>}
                  <span className="r num t2" style={{ display: "flex" }}>{formatGb(job.sizeBefore ?? job.videoFile.size)}</span>
                  <span className="r num t2" style={{ display: "flex" }}>{job.sizeAfter ? formatGb(job.sizeAfter) : "—"}</span>
                  <span title={jobStatus.title} style={{ minWidth: 0 }}><Status s={jobStatus.s} text={jobStatus.text} pct={jobStatus.pct} /></span>
                  <span className="r num t2" style={{ display: "flex" }}>{job.status === "processing" ? formatEta(job.etaSeconds) : "—"}</span>
                </Tr>
              );
            })}
          </Table>
        ) : (
          <Empty icon={<LayerRegular />} title="The queue is empty">
            <span className="t2">Every video loaded on Videos is muxed.</span>
            <Btn onClick={() => shell.show("videos")}>Go to Videos</Btn>
          </Empty>
        )}
      </Panel>

      {open === "save" && (
        <Popover anchor={saveRef} label="Save to" align="center" onClose={() => setOpen(null)}>
          <div className="fh">Save to</div>
          <Fld label="Folder">
            <span className="row" style={{ gap: 4, minWidth: 0 }}>
              <TBox label="Output folder" className="grow" style={{ minWidth: 0 }} value={settings.directory} placeholder="Beside the source" onChange={setDirectory} />
              <Cmd icon={<FolderOpenRegular />} title="Choose the folder" onClick={() => void browse()} />
            </span>
          </Fld>
          <Fld label="File name">
            <span className="row" style={{ gap: 4, minWidth: 0 }}>
              <TBox
                label="File name template"
                className="grow"
                style={{ minWidth: 0 }}
                mono
                unit=".mkv"
                value={settings.namingPattern}
                placeholder="{original_filename}"
                onChange={(namingPattern) => {
                  onSettingsChange({ namingPattern });
                  onMuxSettingsChange({ outputNamingPattern: namingPattern });
                }}
              />
              <span className="t3" title="Fields: {original_filename}, {id}, {extension}" style={{ display: "grid", fontSize: 16, padding: "0 6px" }} aria-hidden>
                <BracesRegular />
              </span>
            </span>
            <span className="sm t3 truncate" title={namingPreview}>{namingPreview}</span>
          </Fld>
          <label className="ck">
            <Toggle
              name="Overwrite the source when no folder is set"
              on={settings.overwriteExisting}
              onChange={(on) => {
                onSettingsChange({ overwriteExisting: on });
                onMuxSettingsChange({ overwriteSource: on });
              }}
            />
            Overwrite the source when no folder is set
          </label>
          {willOverwrite && <span className="warn sm">This replaces the original files.</span>}
        </Popover>
      )}

      {open === "options" && (
        <Popover anchor={optionsRef} label="Mux options" wide onClose={() => setOpen(null)}>
          <div className="fh">Audio</div>
          <div className="fgrid">
            <Fld label="Keep">
              <LangCombo
                w="100%"
                label="Keep audio in"
                value={keepAudio}
                extra={[{ value: "all", label: "All languages" }]}
                onChange={(value) => onMuxSettingsChange({ onlyKeepAudiosEnabled: value !== "all", onlyKeepAudioLanguages: value !== "all" ? [value] : [] })}
              />
            </Fld>
            <Fld label="Default">
              <LangCombo
                w="100%"
                label="Default audio"
                value={muxSettings.makeAudioDefaultLanguage ?? "none"}
                extra={[{ value: "none", label: "No change" }]}
                onChange={(value) => onMuxSettingsChange({ makeAudioDefaultLanguage: value !== "none" ? value : undefined })}
              />
            </Fld>
          </div>
          <div className="fh">Subtitles</div>
          <div className="fgrid">
            <Fld label="Keep">
              <LangCombo
                w="100%"
                label="Keep subtitles in"
                value={keepSubs}
                extra={[{ value: "all", label: "All languages" }]}
                onChange={(value) => onMuxSettingsChange({ onlyKeepSubtitlesEnabled: value !== "all", onlyKeepSubtitleLanguages: value !== "all" ? [value] : [] })}
              />
            </Fld>
            <Fld label="Default">
              <LangCombo
                w="100%"
                label="Default subtitle"
                value={muxSettings.makeSubtitleDefaultLanguage ?? "none"}
                extra={[{ value: "none", label: "No change" }]}
                onChange={(value) => onMuxSettingsChange({ makeSubtitleDefaultLanguage: value !== "none" ? value : undefined })}
              />
            </Fld>
          </div>
          <div className="fh">Remove from the source</div>
          <div className="row" style={{ gap: 28 }}>
            <label className="ck"><Toggle name="Remove chapters from the source" on={muxSettings.discardOldChapters} onChange={(on) => onMuxSettingsChange({ discardOldChapters: on })} />Chapters</label>
            <label className="ck"><Toggle name="Remove attachments from the source" on={muxSettings.discardOldAttachments} onChange={(on) => onMuxSettingsChange({ discardOldAttachments: on })} />Attachments</label>
            <label className="ck"><Toggle name="Remove global tags from the source" on={muxSettings.removeGlobalTags} onChange={(on) => onMuxSettingsChange({ removeGlobalTags: on })} />Global tags</label>
          </div>
          <div className="fh">Run</div>
          <div className="fgrid">
            <Fld label="Jobs at once">
              <Combo<number> label="Jobs at once" value={muxSettings.maxParallelJobs} options={PARALLEL_OPTIONS} w="100%" onChange={(maxParallelJobs) => onMuxSettingsChange({ maxParallelJobs })} />
            </Fld>
            <span />
            <span style={{ display: "flex" }} title={fastMuxAvailable ? "Names and flags only, with mkvpropedit" : "Only when nothing is added and the sources are overwritten"}>
              <Chk on={muxSettings.useMkvpropedit} disabled={!fastMuxAvailable} onChange={(on) => fastMuxAvailable && onMuxSettingsChange({ useMkvpropedit: on })}>Edit in place when possible</Chk>
            </span>
            <Chk on={muxSettings.keepLogFile} onChange={(on) => onMuxSettingsChange({ keepLogFile: on })}>Keep a log file</Chk>
            <Chk on={muxSettings.abortOnErrors} onChange={(on) => onMuxSettingsChange({ abortOnErrors: on })}>Stop at the first error</Chk>
            <Chk on={muxSettings.addCrc} onChange={(on) => onMuxSettingsChange({ addCrc: on })}>Write a CRC checksum</Chk>
            <span />
            <Chk on={muxSettings.removeOldCrc} onChange={(on) => onMuxSettingsChange({ removeOldCrc: on })}>Remove old CRC tags</Chk>
          </div>
        </Popover>
      )}

      {detailsOpen && selectedJob && (
        <JobDetails
          job={selectedJob}
          index={selectedJobIndex ?? 0}
          total={jobs.length}
          report={getJobReport?.(selectedJob.id) ?? null}
          preview={previewResults[selectedJob.id]}
          into={into}
          onCopy={shell.copy}
          onClose={() => setDetailsOpen(false)}
        />
      )}

      {confirmClearOpen && (
        <Dialog
          alert
          title="Clear the queue?"
          onClose={() => setConfirmClearOpen(false)}
          foot={
            <>
              <Btn
                accent
                onClick={() => {
                  setConfirmClearOpen(false);
                  onClearQueue();
                }}
              >
                Clear
              </Btn>
              <Btn onClick={() => setConfirmClearOpen(false)}>Cancel</Btn>
            </>
          }
        >
          <div className="t2">The queue is the loaded videos, so this takes the {jobs.length} video{jobs.length === 1 ? "" : "s"} off Videos, ready for the next batch. The files themselves stay where they are.</div>
        </Dialog>
      )}

      {confirmStartOpen && (
        <Dialog
          alert
          title={`Start muxing with ${warnings.length} warning${warnings.length === 1 ? "" : "s"}?`}
          onClose={() => setConfirmStartOpen(false)}
          foot={
            <>
              <Btn
                accent
                onClick={() => {
                  setConfirmStartOpen(false);
                  onStartMuxing();
                }}
              >
                Start muxing
              </Btn>
              <Btn onClick={() => setConfirmStartOpen(false)}>Cancel</Btn>
            </>
          }
        >
          <div className="t2">
            {settings.overwriteExisting
              ? "Overwrite is on, so muxing anyway will replace the source files. This cannot be undone."
              : "Muxing anyway may give files that are not what you expect."}
          </div>
          <div className="col sm t2" style={{ gap: 4, padding: "10px 12px", background: "var(--layer)", borderRadius: 4, border: "1px solid var(--divider)" }}>
            {warnings.slice(0, LISTED_WARNINGS).map((warning, index) => (
              <span key={`${warning}-${index}`}>{warning}</span>
            ))}
            {warnings.length > LISTED_WARNINGS && <span className="t3">and {warnings.length - LISTED_WARNINGS} more.</span>}
          </div>
        </Dialog>
      )}
    </PageView>
  );
}

/** What a job adds, as icons and counts; a missing dub in amber. */
function Adds({ adds }: { adds: JobAdds }) {
  return (
    <span className="adds" title={`${adds.audio} audio, ${adds.subtitle} subtitle, ${adds.chapter} chapter, ${adds.attachment} attachment file${adds.attachment === 1 ? "" : "s"}`}>
      <span><span className="ic" aria-hidden><MusicNote2Regular /></span>{adds.audio}</span>
      <span><span className="ic" aria-hidden><ClosedCaptionRegular /></span>{adds.subtitle}</span>
      <span><span className="ic" aria-hidden><BookmarkMultipleRegular /></span>{adds.chapter}</span>
      <span><span className="ic" aria-hidden><AttachRegular /></span>{adds.attachment}</span>
    </span>
  );
}

/** A job, in full: its warnings, every track of the file it writes and where
 *  each comes from (the removed ones folded away), what happens to chapters,
 *  attachments and tags, and the mkvmerge command once validated. */
export function JobDetails({
  job,
  index,
  total,
  report,
  preview,
  into,
  onCopy,
  onClose,
}: {
  job: MuxJob;
  index: number;
  total: number;
  report: JobReport | null;
  preview?: MuxPreviewResult;
  into: string;
  onCopy: (text: string) => void;
  onClose: () => void;
}) {
  const [showRemoved, setShowRemoved] = useState(false);
  const tracks = report?.tracks ?? [];
  const kept = tracks.filter((track) => !track.removed);
  const removed = tracks.filter((track) => track.removed);
  const shown = showRemoved ? [...kept, ...removed] : kept;
  const statusWord = job.status === "processing" ? `Muxing · ${Math.round(job.progress)}%` : job.status === "completed" ? "Done" : job.status === "error" ? "Failed" : job.status === "stopped" ? "Stopped" : "Queued";
  return (
    <Dialog
      size="xl"
      bodyClass="flush compact"
      title={job.videoFile.name}
      sub={`Job ${index + 1} of ${total} · ${statusWord} · ${formatGb(job.sizeBefore ?? job.videoFile.size)}`}
      onClose={onClose}
      left={preview?.command ? <Btn icon={<CopyRegular />} onClick={() => onCopy(preview.command)}>Copy command</Btn> : undefined}
      foot={<Btn accent onClick={onClose}>Close</Btn>}
    >
      {(preview?.warnings.length || (job.status === "error" && job.errorMessage)) && (
        <div className="col" style={{ gap: 8, padding: "12px 16px 0" }}>
          {job.status === "error" && job.errorMessage && <InfoBar tone="bad">{job.errorMessage}</InfoBar>}
          {preview && preview.warnings.length > 0 && (
            <InfoBar tone="warn">
              {preview.warnings.length} warning{preview.warnings.length === 1 ? "" : "s"} · {preview.warnings.join(" · ")}
            </InfoBar>
          )}
        </div>
      )}
      <div className="sect">
        Tracks in the new file <span className="t3">· {kept.length} kept or added</span>
        {removed.length > 0 && (
          <button type="button" className="drop" aria-expanded={showRemoved} onClick={() => setShowRemoved(!showRemoved)}>
            {removed.length} removed
            <span className="ic" aria-hidden>{showRemoved ? <ChevronUpRegular /> : <ChevronDownRegular />}</span>
          </button>
        )}
      </div>
      {tracks.length === 0 ? (
        <div className="t3" style={{ padding: "0 16px 8px" }}>The video's tracks are read when it is scanned.</div>
      ) : (
        <Table style={{ flex: "none" }} cols="20px 18px 96px minmax(0,.8fr) minmax(0,1.3fr) 96px 72px" head={["#", "", "Language", "Track", "From", "Flags", " Delay"]} label="Tracks in the new file">
          {shown.map((track, i) => (
            <Tr key={i}>
              <span className="num t3">{track.removed ? "" : i + 1}</span>
              <span className="t3" style={{ display: "grid", fontSize: 16 }} aria-hidden>{typeIcon(track.type)}</span>
              <span className={cx("truncate", track.removed && "t3 strike")}>{track.type === "video" ? "—" : languageName(track.language)}</span>
              <span className={cx("truncate", track.removed && "t3 strike")} title={track.name}>{track.name}</span>
              <span className={cx("truncate", !track.added && "t3")} title={track.from}>
                {track.from}
                {track.added && <span className="t3"> · added</span>}
              </span>
              <span className={track.removed ? "t3" : "t2"}>{track.removed ? "Removed" : track.flags.join(", ")}</span>
              <span className="r num t2" style={{ display: "flex" }}>{track.delay ? `${formatDelay(track.delay)} s` : ""}</span>
            </Tr>
          ))}
        </Table>
      )}
      <div className="sect">Also</div>
      <div className="also">
        {(report?.also ?? []).map(([key, value]) => (
          <span key={key} style={{ display: "contents" }}>
            <span className="k">{key}</span>
            <span>{value}</span>
          </span>
        ))}
        <span className="k">Into</span>
        <span className="truncate" title={into}>{into}</span>
      </div>
      <div className="sect">Command</div>
      {preview?.command ? <pre className="cmdline">{preview.command}</pre> : <div className="t3" style={{ padding: "0 16px 16px" }}>Validate to see the mkvmerge command for this job.</div>}
    </Dialog>
  );
}
