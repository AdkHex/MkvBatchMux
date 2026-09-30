/** Mux: the queue, where every loaded video goes to mkvmerge, and the output
 *  settings for the batch. Start, validation, pause and stop live in the
 *  shell (src/app/Index.tsx), which holds the queue; this page shows it and
 *  asks before starting a batch that validation had warnings about — the old
 *  Mux Settings tab's rule. */

import {
  AddRegular,
  CheckmarkStarburstRegular,
  DeleteRegular,
  DismissRegular,
  FolderOpenRegular,
  LayerRegular,
  PauseRegular,
  PlayRegular,
  StopRegular,
  TextBulletListSquareRegular,
  VideoClipRegular,
} from "@fluentui/react-icons";
import { useEffect, useMemo, useState } from "react";

import type { QueueAction } from "@/app/Index";
import { PageDock } from "@/app/dock";
import { muxOutcome, timeLeftText, tookText } from "@/app/history";
import { useShell, usePageCommands, type PageId } from "@/app/shell";
import { pickDirectory } from "@/shared/lib/backend";
import type { MuxJob, MuxPreviewResult, MuxSettings, OutputSettings, VideoFile } from "@/shared/types";
import { Box, Dialog, PageView, type LcdProps } from "@/ui/frame";
import { Btn, Cmd, Empty, Fld, InfoBar, LangCombo, MidText, Status, TBox, TRow, Table, Toggle, Tr, type St } from "@/ui/kit";

import { formatGb } from "./common";

export interface JobReport {
  title: string;
  sections: { title: string; items: { title: string; details: string[] }[] }[];
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
  queue: QueueAction;
  onClearAll: () => void;
  onRemoveJob: (jobId: string) => void;
  onStartMuxing: () => void;
  onPauseMuxing: () => void;
  onResumeMuxing: () => void;
  onStopMuxing: () => void;
  onViewLog: () => void;
  previewResults: Record<string, MuxPreviewResult>;
  previewLoading: boolean;
  onPreviewQueue: () => void;
  getJobReport?: (jobId: string) => JobReport | null;
  /** The batch being muxed: when it started and ended, and whether it is pausing. */
  batch: { startedAt: number | null; finishedAt: number | null; paused: boolean };
  /** A batch is going. */
  running: boolean;
}

const MAX_PARALLEL_JOBS = 16;
/** The confirmation lists this many warnings, then says how many more. */
const LISTED_WARNINGS = 8;

function formatEta(seconds?: number) {
  if (seconds === undefined || seconds <= 0 || Number.isNaN(seconds)) return "—";
  const mins = Math.floor(seconds / 60);
  const secs = seconds % 60;
  return mins <= 0 ? `${secs} s` : `${mins} min`;
}

type Tab = "report";

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
  queue,
  onClearAll,
  onRemoveJob,
  onStartMuxing,
  onPauseMuxing,
  onResumeMuxing,
  onStopMuxing,
  onViewLog,
  previewResults,
  previewLoading,
  onPreviewQueue,
  getJobReport,
  batch,
  running,
}: MuxPageProps) {
  const shell = useShell();
  const [selectedJobIndex, setSelectedJobIndex] = useState<number | null>(null);
  const [reportOpen, setReportOpen] = useState(false);
  const [confirmStartOpen, setConfirmStartOpen] = useState(false);

  const fileCount = jobs.length > 0 ? jobs.length : videoFiles.length;
  const autoParallelJobs = Math.max(1, Math.min(fileCount || 1, MAX_PARALLEL_JOBS));
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
      setReportOpen(false);
      return;
    }
    if (selectedJobIndex !== null && selectedJobIndex >= jobs.length) setSelectedJobIndex(jobs.length - 1);
  }, [jobs.length, selectedJobIndex]);

  const selectedJob = selectedJobIndex !== null ? jobs[selectedJobIndex] : undefined;
  const openReport = (index: number | null = selectedJobIndex) => {
    if (index === null) return;
    setSelectedJobIndex(index);
    setReportOpen(true);
    shell.dock.setTab(null);
  };

  const finished = batch.finishedAt !== null && !running && hasJobs;
  const stopped = jobs.some((job) => job.status === "stopped");
  const canStart = hasJobs && !hasExternalLinkIssues && !running && !measuring && jobs.some((job) => job.status === "queued");

  usePageCommands("mux", {
    start: canStart ? handleStartClick : undefined,
    stop: running ? onStopMuxing : undefined,
    removeSelected: selectedJob && !running ? () => onRemoveJob(selectedJob.id) : undefined,
    clear: hasJobs && !running ? onClearAll : undefined,
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
      : !hasJobs
        ? { l1: "The queue is empty", l2: queue.count ? `${queue.count} video${queue.count === 1 ? " is" : "s are"} ready to add` : "Load videos on Videos first" }
        : finished
          ? (() => {
              const outcome = muxOutcome(jobs);
              return {
                icon: (outcome.tone === "ok" ? "ok" : outcome.tone === "bad" ? "bad" : "warn") as LcdProps["icon"],
                l1: outcome.parts.join(" · "),
                l2: stopped ? `${jobs.filter((j) => j.status === "stopped").length} stopped` : `Into ${into} in ${tookText((batch.finishedAt ?? 0) - (batch.startedAt ?? 0))}`,
              };
            })()
          : hasExternalLinkIssues
            ? { icon: "warn", l1: externalLinkIssues[0].replace(/\.$/, ""), l2: "Pair every file before muxing" }
            : warnings.length > 0
              ? { icon: "warn", l1: `Validated · ${warnings.length} warning${warnings.length === 1 ? "" : "s"} in ${warnedJobs} job${warnedJobs === 1 ? "" : "s"}`, l2: "Start asks before it runs" }
              : { l1: `${jobs.length} in the queue`, l2: `Into ${into} · ${autoParallelJobs} at a time` };

  const statusOf = (job: MuxJob): { s: St; text?: string; pct?: number; title?: string } => {
    const jobWarnings = previewResults[job.id]?.warnings ?? [];
    if (job.status === "processing") return { s: "run", pct: job.progress };
    if (job.status === "completed") return { s: "ok" };
    if (job.status === "error") return { s: "bad", title: job.errorMessage };
    if (job.status === "stopped") return { s: "warn", text: "Stopped" };
    if (jobWarnings.length > 0) return { s: "warn", text: `${jobWarnings.length} warning${jobWarnings.length === 1 ? "" : "s"}`, title: jobWarnings.join("\n") };
    return { s: "wait", text: finished && stopped ? "Not started" : "Queued" };
  };

  const report = selectedJob ? getJobReport?.(selectedJob.id) : null;
  const preview = selectedJob ? previewResults[selectedJob.id] : undefined;
  const reportBody = (
    <div className="rep">
      {!selectedJob ? (
        <span className="t3">Select a job to see what muxing changes in it.</span>
      ) : (
        <>
          {preview && preview.warnings.length > 0 && (
            <div className="col">
              <span className="sec warn">{preview.warnings.length} warning{preview.warnings.length === 1 ? "" : "s"}</span>
              {preview.warnings.map((warning, i) => <span key={i} className="it t2">{warning}</span>)}
            </div>
          )}
          {selectedJob.status === "error" && selectedJob.errorMessage && (
            <div className="col">
              <span className="sec bad">Failed</span>
              <span className="it t2">{selectedJob.errorMessage}</span>
            </div>
          )}
          {!report || report.sections.length === 0 ? (
            <span className="t3">Nothing changes in this video beyond remuxing it.</span>
          ) : (
            report.sections.map((section) => (
              <div key={section.title} className="col">
                <span className="sec">{section.title}</span>
                {section.items.map((item, i) => (
                  <span key={i} className="it t2" title={item.details.join(" · ")}>
                    <span className="truncate">{item.title}{item.details.length ? ` · ${item.details.join(" · ")}` : ""}</span>
                  </span>
                ))}
              </div>
            ))
          )}
          {preview?.command && <pre>{preview.command}</pre>}
        </>
      )}
    </div>
  );

  const dock = (
    <PageDock<Tab>
      common={shell.dock}
      own={[{ id: "report", label: "Report", body: reportBody, tools: selectedJob ? <span className="t3 sm truncate" style={{ paddingRight: 6, maxWidth: 420 }}>{selectedJob.videoFile.name}</span> : undefined }]}
      ownTab={reportOpen ? "report" : null}
      onOwnTab={() => setReportOpen(true)}
    />
  );

  const keepAudio = muxSettings.onlyKeepAudiosEnabled && muxSettings.onlyKeepAudioLanguages[0] ? muxSettings.onlyKeepAudioLanguages[0] : "all";
  const keepSubs = muxSettings.onlyKeepSubtitlesEnabled && muxSettings.onlyKeepSubtitleLanguages[0] ? muxSettings.onlyKeepSubtitleLanguages[0] : "all";
  const willOverwrite = settings.directory.trim() === "" && settings.overwriteExisting;

  return (
    <PageView
      hidden={hidden}
      lcd={lcd}
      dock={dock}
      tools={
        <>
          <Cmd icon={<AddRegular />} disabled={queue.count === 0 || running} onClick={queue.add}>Add to queue</Cmd>
          <Cmd icon={<CheckmarkStarburstRegular />} disabled={!hasJobs || previewLoading || hasExternalLinkIssues || running || measuring} onClick={onPreviewQueue}>
            {previewLoading ? "Validating…" : "Validate"}
          </Cmd>
          <Cmd icon={<TextBulletListSquareRegular />} title="Report for the selected job" disabled={!selectedJob} onClick={() => openReport()} />
          <Cmd icon={<DeleteRegular />} title="Remove the selected job (Del)" disabled={!selectedJob || running} onClick={() => selectedJob && onRemoveJob(selectedJob.id)} />
          <Cmd icon={<DismissRegular />} title="Clear the queue" disabled={!hasJobs || running} onClick={onClearAll} />
        </>
      }
      primary={
        running ? (
          <>
            {batch.paused ? <Btn icon={<PlayRegular />} onClick={onResumeMuxing}>Resume</Btn> : <Btn icon={<PauseRegular />} onClick={onPauseMuxing}>Pause</Btn>}
            <Btn icon={<StopRegular />} kbd="Esc" onClick={onStopMuxing}>Stop</Btn>
          </>
        ) : finished && !jobs.some((job) => job.status === "queued") ? (
          <Btn icon={<DismissRegular />} onClick={onClearAll}>Clear the queue</Btn>
        ) : (
          <Btn accent icon={<PlayRegular />} kbd="Enter" title={measuring ? "Measuring is running on Audio" : undefined} disabled={!canStart} onClick={handleStartClick}>
            Start muxing
          </Btn>
        )
      }
    >
      {hasJobs ? (
        <Box body={false} title="Queue" sub={`${jobs.length} job${jobs.length === 1 ? "" : "s"}`}>
          {hasExternalLinkIssues && (
            <InfoBar tone="warn" actions={unlinkedPage ? <Btn onClick={() => shell.show(unlinkedPage)}>Show on {unlinkedPage === "audio" ? "Audio" : "Subtitles"}</Btn> : undefined}>
              {externalLinkIssues.join(" ")}
            </InfoBar>
          )}
          {!running && !hasExternalLinkIssues && warnings.length > 0 && (
            <InfoBar
              tone="warn"
              actions={
                <Btn
                  onClick={() => {
                    const index = jobs.findIndex((job) => (previewResults[job.id]?.warnings.length ?? 0) > 0);
                    openReport(index >= 0 ? index : null);
                  }}
                >
                  Show
                </Btn>
              }
            >
              Validation found {warnings.length} warning{warnings.length === 1 ? "" : "s"} in {warnedJobs} job{warnedJobs === 1 ? "" : "s"}.
            </InfoBar>
          )}
          <Table cols="24px minmax(0,1fr) 144px 72px 72px 64px" head={["#", "Name", "Status", " Before", " After", " Left"]} label="Queue">
            {jobs.map((job, index) => {
              const status = statusOf(job);
              return (
                <Tr key={job.id} on={selectedJobIndex === index} onClick={() => setSelectedJobIndex(index)} onDoubleClick={() => openReport(index)} label={job.videoFile.name}>
                  <span className="num t3">{index + 1}</span>
                  <span className="cell"><span className="fi" aria-hidden><VideoClipRegular /></span><MidText text={job.videoFile.name} tail={22} /></span>
                  <span title={status.title} style={{ minWidth: 0 }}><Status s={status.s} text={status.text} pct={status.pct} /></span>
                  <span className="r num t2" style={{ display: "flex" }}>{formatGb(job.sizeBefore ?? job.videoFile.size)}</span>
                  <span className="r num t2" style={{ display: "flex" }}>{job.sizeAfter ? formatGb(job.sizeAfter) : "—"}</span>
                  <span className="r num t2" style={{ display: "flex" }}>{job.status === "processing" ? formatEta(job.etaSeconds) : "—"}</span>
                </Tr>
              );
            })}
          </Table>
        </Box>
      ) : (
        <section className="box">
          <Empty icon={<LayerRegular />} title="The queue is empty">
            <Btn icon={<AddRegular />} disabled={queue.count === 0} onClick={queue.add}>{queue.count ? `Add ${queue.count} video${queue.count === 1 ? "" : "s"}` : "Add videos"}</Btn>
          </Empty>
        </section>
      )}

      <Box title="Output">
        <Fld label="Folder">
          <div className="row" style={{ gap: 4 }}>
            <span className="grow">
              <TBox
                label="Output folder"
                value={settings.directory}
                placeholder="Beside the source"
                disabled={running}
                onChange={(directory) => {
                  onSettingsChange({ directory });
                  onMuxSettingsChange({ destinationDir: directory });
                }}
              />
            </span>
            <Cmd
              icon={<FolderOpenRegular />}
              title="Choose folder"
              disabled={running}
              onClick={async () => {
                const directory = await pickDirectory();
                if (directory) {
                  onSettingsChange({ directory });
                  onMuxSettingsChange({ destinationDir: directory });
                }
              }}
            />
          </div>
        </Fld>
        <Fld label="File name">
          <TBox
            label="File name template"
            mono
            value={settings.namingPattern}
            placeholder="{original_filename}"
            disabled={running}
            title="{original_filename}, {id}, {extension}"
            onChange={(namingPattern) => {
              onSettingsChange({ namingPattern });
              onMuxSettingsChange({ outputNamingPattern: namingPattern });
            }}
          />
          <span className="sm t3 truncate" title={namingPreview}>{namingPreview}</span>
        </Fld>
        <TRow label="Overwrite the source when no folder is set" d={willOverwrite ? <span className="warn">This replaces the original files</span> : undefined}>
          <Toggle
            name="Overwrite the source when no folder is set"
            on={settings.overwriteExisting}
            disabled={running}
            onChange={(on) => {
              onSettingsChange({ overwriteExisting: on });
              onMuxSettingsChange({ overwriteSource: on });
            }}
          />
        </TRow>
        <div className="hr" />
        <span className="sec">Remove from the source</span>
        <TRow label="Chapters"><Toggle name="Remove chapters from the source" on={muxSettings.discardOldChapters} onChange={(on) => onMuxSettingsChange({ discardOldChapters: on })} /></TRow>
        <TRow label="Attachments"><Toggle name="Remove attachments from the source" on={muxSettings.discardOldAttachments} onChange={(on) => onMuxSettingsChange({ discardOldAttachments: on })} /></TRow>
        <TRow label="Global tags"><Toggle name="Remove global tags from the source" on={muxSettings.removeGlobalTags} onChange={(on) => onMuxSettingsChange({ removeGlobalTags: on })} /></TRow>
        <div className="hr" />
        <span className="sec">Track rules</span>
        <TRow label="Keep audio in">
          <LangCombo
            sm
            w={132}
            label="Keep audio in"
            value={keepAudio}
            extra={[{ value: "all", label: "All languages" }]}
            onChange={(value) => onMuxSettingsChange({ onlyKeepAudiosEnabled: value !== "all", onlyKeepAudioLanguages: value !== "all" ? [value] : [] })}
          />
        </TRow>
        <TRow label="Default audio">
          <LangCombo
            sm
            w={132}
            label="Default audio"
            value={muxSettings.makeAudioDefaultLanguage ?? "none"}
            extra={[{ value: "none", label: "No change" }]}
            onChange={(value) => onMuxSettingsChange({ makeAudioDefaultLanguage: value !== "none" ? value : undefined })}
          />
        </TRow>
        <TRow label="Keep subtitles in">
          <LangCombo
            sm
            w={132}
            label="Keep subtitles in"
            value={keepSubs}
            extra={[{ value: "all", label: "All languages" }]}
            onChange={(value) => onMuxSettingsChange({ onlyKeepSubtitlesEnabled: value !== "all", onlyKeepSubtitleLanguages: value !== "all" ? [value] : [] })}
          />
        </TRow>
        <TRow label="Default subtitle">
          <LangCombo
            sm
            w={132}
            label="Default subtitle"
            value={muxSettings.makeSubtitleDefaultLanguage ?? "none"}
            extra={[{ value: "none", label: "No change" }]}
            onChange={(value) => onMuxSettingsChange({ makeSubtitleDefaultLanguage: value !== "none" ? value : undefined })}
          />
        </TRow>
        <div className="hr" />
        <span className="sec">Safety</span>
        <TRow label="Write a CRC checksum"><Toggle name="Write a CRC checksum" on={muxSettings.addCrc} onChange={(on) => onMuxSettingsChange({ addCrc: on })} /></TRow>
        <TRow label="Remove old CRC tags"><Toggle name="Remove old CRC tags" on={muxSettings.removeOldCrc} onChange={(on) => onMuxSettingsChange({ removeOldCrc: on })} /></TRow>
        <TRow label="Stop at the first error"><Toggle name="Stop at the first error" on={muxSettings.abortOnErrors} onChange={(on) => onMuxSettingsChange({ abortOnErrors: on })} /></TRow>
        <TRow label="Keep a log file"><Toggle name="Keep a log file" on={muxSettings.keepLogFile} onChange={(on) => onMuxSettingsChange({ keepLogFile: on })} /></TRow>
        <div className="hr" />
        <span className="sec">Performance</span>
        <TRow label="Fast mux" d="Metadata only, in place, nothing added">
          <span title={fastMuxAvailable ? undefined : "Fast mux only works for in-place metadata-only edits with overwrite source enabled."}>
            <Toggle
              name="Fast mux"
              on={muxSettings.useMkvpropedit}
              disabled={!fastMuxAvailable || running}
              onChange={(on) => fastMuxAvailable && onMuxSettingsChange({ useMkvpropedit: on })}
            />
          </span>
        </TRow>
        <TRow label="Jobs at once"><span className="t2 num" title="Follows the number of queued files, up to 16.">{autoParallelJobs} · follows the queue</span></TRow>
      </Box>

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
