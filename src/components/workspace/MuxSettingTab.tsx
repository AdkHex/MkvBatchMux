import { useMemo, useState } from "react";
import {
  FolderOpen,
  Pause,
  Play,
  Square,
  Trash2,
  ListPlus,
  Package,
  FileText,
  AlertTriangle,
  CheckCircle2,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Progress } from "@/components/ui/progress";
import { cn } from "@/lib/utils";
import type { OutputSettings, MuxJob, VideoFile, MuxSettings, MuxPreviewResult } from "@/types";
import { pickDirectory } from "@/lib/backend";
import { BaseModal } from "@/components/shared/BaseModal";

interface MuxSettingTabProps {
  settings: OutputSettings;
  onSettingsChange: (settings: Partial<OutputSettings>) => void;
  muxSettings: MuxSettings;
  onMuxSettingsChange: (settings: Partial<MuxSettings>) => void;
  fastMuxAvailable: boolean;
  jobs: MuxJob[];
  videoFiles: VideoFile[];
  onAddToQueue: () => void;
  onClearAll: () => void;
  onStartMuxing: () => void;
  onPauseMuxing: () => void;
  onResumeMuxing: () => void;
  onStopMuxing: () => void;
  onViewLog: () => void;
  previewResults: Record<string, MuxPreviewResult>;
  previewLoading: boolean;
  onPreviewQueue: () => void;
  getJobReport?: (
    jobId: string,
  ) => { title: string; sections: { title: string; items: { title: string; details: string[] }[] }[] } | null;
}

function formatFileSize(bytes?: number): string {
  if (!Number.isFinite(bytes)) return "—";
  const gb = bytes / 1073741824;
  return gb.toFixed(2) + " GB";
}

function formatEta(seconds?: number) {
  if (seconds === undefined || seconds <= 0 || Number.isNaN(seconds)) return "—";
  const mins = Math.floor(seconds / 60);
  const secs = seconds % 60;
  if (mins <= 0) return `~${secs}s`;
  return `~${mins}m ${secs}s`;
}

export function MuxSettingTab({
  settings,
  onSettingsChange,
  muxSettings,
  onMuxSettingsChange,
  fastMuxAvailable,
  jobs,
  videoFiles,
  onAddToQueue,
  onClearAll,
  onStartMuxing,
  onPauseMuxing,
  onResumeMuxing,
  onStopMuxing,
  onViewLog,
  previewResults,
  previewLoading,
  onPreviewQueue,
  getJobReport,
}: MuxSettingTabProps) {
  const [selectedJobIndex, setSelectedJobIndex] = useState<number | null>(null);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [reportJobId, setReportJobId] = useState<string | null>(null);
  const [reportOpen, setReportOpen] = useState(false);

  const onlyKeepAudios = muxSettings.onlyKeepAudiosEnabled;
  const onlyKeepSubtitles = muxSettings.onlyKeepSubtitlesEnabled;
  const audioKeepLanguage = muxSettings.onlyKeepAudioLanguages[0] || 'all';
  const subtitleKeepLanguage = muxSettings.onlyKeepSubtitleLanguages[0] || 'all';
  const makeAudioDefault = Boolean(muxSettings.makeAudioDefaultLanguage);
  const makeSubtitleDefault = Boolean(muxSettings.makeSubtitleDefaultLanguage);
  const audioDefaultLanguage = muxSettings.makeAudioDefaultLanguage || 'none';
  const subtitleDefaultLanguage = muxSettings.makeSubtitleDefaultLanguage || 'none';
  const addCrc = muxSettings.addCrc;
  const abortOnErrors = muxSettings.abortOnErrors;
  const removeOldCrc = muxSettings.removeOldCrc;
  const keepLogFile = muxSettings.keepLogFile;
  const discardOldChapters = muxSettings.discardOldChapters;
  const discardOldAttachments = muxSettings.discardOldAttachments;
  const removeGlobalTags = muxSettings.removeGlobalTags;
  const fileCount = jobs.length > 0 ? jobs.length : videoFiles.length;
  const autoParallelJobs = Math.min(fileCount, 12);
  const isProcessing = jobs.some((job) => job.status === 'processing');
  const hasJobs = jobs.length > 0;
  const completedJobs = jobs.filter((job) => job.status === 'completed').length;
  const statusLabel = isProcessing ? "Running" : "Idle";
  const selectedJob = selectedJobIndex !== null ? jobs[selectedJobIndex] : null;
  const warningCount = useMemo(
    () => Object.values(previewResults).reduce((acc, result) => acc + result.warnings.length, 0),
    [previewResults],
  );
  const overallProgress = useMemo(() => {
    if (!hasJobs) return 0;
    const sum = jobs.reduce((acc, job) => {
      if (job.status === 'completed') return acc + 100;
      if (job.status === 'processing') return acc + job.progress;
      return acc;
    }, 0);
    return Math.round(sum / jobs.length);
  }, [hasJobs, jobs]);
  const reportData = reportJobId && getJobReport ? getJobReport(reportJobId) : null;

  return (
    <div className="flex flex-col h-full">
      <div className="px-5 pt-2">
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-panel-border/30 bg-panel-header/50 px-4 py-2">
          <div className="flex items-center gap-4 text-xs text-muted-foreground">
            <div className="flex items-center gap-2">
              <span className="uppercase tracking-wider text-[10px] text-muted-foreground/70">Queue</span>
              <span className="text-foreground font-medium">{jobs.length || videoFiles.length}</span>
            </div>
            <div className="h-3 w-px bg-panel-border/50" />
            <div className="flex items-center gap-2">
              <span className="uppercase tracking-wider text-[10px] text-muted-foreground/70">Warnings</span>
              <span className={cn("font-medium", warningCount ? "text-warning" : "text-muted-foreground")}>
                {warningCount || 0}
              </span>
            </div>
          </div>
          <Button
            variant="outline"
            size="sm"
            className="h-8 px-3 text-xs gap-1.5 border-panel-border/40 bg-card/40 hover:bg-panel-header/60"
            onClick={onPreviewQueue}
            disabled={previewLoading || (jobs.length === 0 && videoFiles.length === 0)}
          >
            <CheckCircle2 className="w-3.5 h-3.5" />
            {previewLoading ? "Validating..." : "Validate Queue"}
          </Button>
        </div>
      </div>
      {/* Output Configuration */}
      <div className="px-5 pt-2 pb-2 space-y-2.5">
        {/* Output Destination Card */}
        <div className="rounded-lg border border-panel-border/30 bg-panel-header/50 px-4 py-2 space-y-2 shadow-[inset_0_0_0_1px_hsl(var(--primary)/0.12)]">
          <div className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Output Folder</div>
          <div className="flex items-center gap-2">
            <Input
              value={settings.directory}
              onChange={(e) => {
                onSettingsChange({ directory: e.target.value });
                onMuxSettingsChange({ destinationDir: e.target.value });
              }}
              placeholder="Leave empty to overwrite source files"
              className="app-input flex-1 h-9"
            />
            <Button
              variant="ghost"
              size="icon"
              className="h-9 w-9 shrink-0 border border-panel-border/40 bg-card/50 text-muted-foreground hover:text-foreground hover:bg-panel-header/60"
              onClick={async () => {
                const directory = await pickDirectory();
                if (directory) {
                  onSettingsChange({ directory });
                  onMuxSettingsChange({ destinationDir: directory });
                }
              }}
            >
              <FolderOpen className="w-4 h-4" />
            </Button>
          </div>
          <div className="flex items-center gap-2 pt-0.5">
            <Checkbox
              id="overwrite-source"
              checked={settings.overwriteExisting}
              onCheckedChange={(checked) => {
                onSettingsChange({ overwriteExisting: checked as boolean });
                onMuxSettingsChange({ overwriteSource: checked as boolean });
              }}
              className="h-3.5 w-7"
            />
            <label htmlFor="overwrite-source" className="text-xs text-muted-foreground cursor-pointer">
              If empty, source files are overwritten
            </label>
          </div>
          <p className="text-[11px] text-muted-foreground/70">
            Files are written to this folder when set.
          </p>
        </div>

        {/* Cleanup (Outside Advanced) */}
        <div className="rounded-lg border border-panel-border/25 bg-card px-4 py-2 space-y-2.5">
          <div className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Cleanup</div>
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <div className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Remove From Source</div>
              <div className="flex items-center gap-2">
                <Checkbox
                  id="discard-chapters"
                  checked={discardOldChapters}
                  onCheckedChange={(checked) => onMuxSettingsChange({ discardOldChapters: checked as boolean })}
                  className="h-3.5 w-7"
                />
                <label htmlFor="discard-chapters" className="text-xs cursor-pointer">Remove Chapters</label>
              </div>
              <div className="flex items-center gap-2">
                <Checkbox
                  id="discard-attachments"
                  checked={discardOldAttachments}
                  onCheckedChange={(checked) => onMuxSettingsChange({ discardOldAttachments: checked as boolean })}
                  className="h-3.5 w-7"
                />
                <label htmlFor="discard-attachments" className="text-xs cursor-pointer">Remove Attachments</label>
              </div>
              <div className="flex items-center gap-2">
                <Checkbox
                  id="remove-global-tags"
                  checked={removeGlobalTags}
                  onCheckedChange={(checked) => onMuxSettingsChange({ removeGlobalTags: checked as boolean })}
                  className="h-3.5 w-7"
                />
                <label htmlFor="remove-global-tags" className="text-xs cursor-pointer">Remove Global Tags</label>
              </div>
            </div>
            <div className="space-y-2">
              <div className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Notes</div>
              <p className="text-[11px] text-muted-foreground/70">
                These options strip metadata from the source file when muxing.
              </p>
            </div>
          </div>
        </div>

        {/* Advanced Section */}
        <Collapsible open={advancedOpen} onOpenChange={setAdvancedOpen}>
          <div className="pb-1.5">
            <CollapsibleTrigger className="w-full">
              <div className="flex items-center justify-between rounded-lg border border-panel-border/25 bg-card px-4 py-2 text-left">
                <div>
                  <div className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Advanced</div>
                  <div className="text-[11px] text-muted-foreground/70">Track rules, safety checks, and logging</div>
                </div>
                <div className="text-xs text-muted-foreground">{advancedOpen ? "Hide" : "Show"}</div>
              </div>
            </CollapsibleTrigger>
          </div>
          <CollapsibleContent>
            <div className="pb-2.5 space-y-2.5">
            <div className="rounded-lg border border-panel-border/25 bg-card px-4 py-2 space-y-2.5">
              <div className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Track Options</div>
              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-2.5 rounded-lg bg-panel-header/60 border border-panel-border/30 px-3 py-2">
                  <h4 className="text-xs font-semibold text-foreground uppercase tracking-wide flex items-center gap-2">
                    <span className="w-1.5 h-1.5 rounded-full bg-primary" />
                    Audio Rules
                  </h4>
                  <div className="space-y-2.5">
                    <div className="flex items-center justify-between gap-2">
                      <div className="flex items-center gap-2">
                        <Checkbox 
                          id="only-keep-audios"
                          checked={onlyKeepAudios}
                          onCheckedChange={(checked) => {
                            const enabled = checked as boolean;
                            onMuxSettingsChange({
                              onlyKeepAudiosEnabled: enabled,
                              onlyKeepAudioLanguages: enabled && audioKeepLanguage !== 'all' ? [audioKeepLanguage] : [],
                            });
                          }}
                          className="h-3.5 w-7"
                        />
                        <label htmlFor="only-keep-audios" className="text-xs cursor-pointer">Keep Only</label>
                      </div>
                      <Select
                        value={audioKeepLanguage}
                        onValueChange={(value) => {
                          onMuxSettingsChange({
                            onlyKeepAudioLanguages: value !== 'all' ? [value] : [],
                          });
                        }}
                        disabled={!onlyKeepAudios}
                      >
                        <SelectTrigger className="w-24 h-7 text-xs bg-input border-0">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="all">All</SelectItem>
                          <SelectItem value="eng">English</SelectItem>
                          <SelectItem value="hin">Hindi</SelectItem>
                          <SelectItem value="jpn">Japanese</SelectItem>
                        </SelectContent>
                      </Select>
                    </div>
                    <div className="flex items-center justify-between gap-2">
                      <div className="flex items-center gap-2">
                        <Checkbox 
                          id="make-audio-default"
                          checked={makeAudioDefault}
                          onCheckedChange={(checked) => {
                            const enabled = checked as boolean;
                            onMuxSettingsChange({
                              makeAudioDefaultLanguage: enabled && audioDefaultLanguage !== 'none' ? audioDefaultLanguage : undefined,
                            });
                          }}
                          className="h-3.5 w-7"
                        />
                        <label htmlFor="make-audio-default" className="text-xs cursor-pointer">Set Default</label>
                      </div>
                      <Select
                        value={audioDefaultLanguage}
                        onValueChange={(value) => {
                          onMuxSettingsChange({
                            makeAudioDefaultLanguage: value !== 'none' ? value : undefined,
                          });
                        }}
                        disabled={!makeAudioDefault}
                      >
                        <SelectTrigger className="w-24 h-7 text-xs bg-input border-0">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="none">None</SelectItem>
                          <SelectItem value="eng">English</SelectItem>
                          <SelectItem value="hin">Hindi</SelectItem>
                          <SelectItem value="jpn">Japanese</SelectItem>
                        </SelectContent>
                      </Select>
                    </div>
                  </div>
                </div>

                <div className="space-y-2.5 rounded-lg bg-panel-header/60 border border-panel-border/30 px-3 py-2">
                  <h4 className="text-xs font-semibold text-foreground uppercase tracking-wide flex items-center gap-2">
                    <span className="w-1.5 h-1.5 rounded-full bg-accent-teal" />
                    Subtitle Rules
                  </h4>
                  <div className="space-y-2.5">
                    <div className="flex items-center justify-between gap-2">
                      <div className="flex items-center gap-2">
                        <Checkbox 
                          id="only-keep-subtitles"
                          checked={onlyKeepSubtitles}
                          onCheckedChange={(checked) => {
                            const enabled = checked as boolean;
                            onMuxSettingsChange({
                              onlyKeepSubtitlesEnabled: enabled,
                              onlyKeepSubtitleLanguages: enabled && subtitleKeepLanguage !== 'all' ? [subtitleKeepLanguage] : [],
                            });
                          }}
                          className="h-3.5 w-7"
                        />
                        <label htmlFor="only-keep-subtitles" className="text-xs cursor-pointer">Keep Only</label>
                      </div>
                      <Select
                        value={subtitleKeepLanguage}
                        onValueChange={(value) => {
                          onMuxSettingsChange({
                            onlyKeepSubtitleLanguages: value !== 'all' ? [value] : [],
                          });
                        }}
                        disabled={!onlyKeepSubtitles}
                      >
                        <SelectTrigger className="w-24 h-7 text-xs bg-input border-0">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="all">All</SelectItem>
                          <SelectItem value="eng">English</SelectItem>
                          <SelectItem value="hin">Hindi</SelectItem>
                          <SelectItem value="jpn">Japanese</SelectItem>
                        </SelectContent>
                      </Select>
                    </div>
                    <div className="flex items-center justify-between gap-2">
                      <div className="flex items-center gap-2">
                        <Checkbox 
                          id="make-subtitle-default"
                          checked={makeSubtitleDefault}
                          onCheckedChange={(checked) => {
                            const enabled = checked as boolean;
                            onMuxSettingsChange({
                              makeSubtitleDefaultLanguage: enabled && subtitleDefaultLanguage !== 'none' ? subtitleDefaultLanguage : undefined,
                            });
                          }}
                          className="h-3.5 w-7"
                        />
                        <label htmlFor="make-subtitle-default" className="text-xs cursor-pointer">Set Default</label>
                      </div>
                      <Select
                        value={subtitleDefaultLanguage}
                        onValueChange={(value) => {
                          onMuxSettingsChange({
                            makeSubtitleDefaultLanguage: value !== 'none' ? value : undefined,
                          });
                        }}
                        disabled={!makeSubtitleDefault}
                      >
                        <SelectTrigger className="w-24 h-7 text-xs bg-input border-0">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="none">None</SelectItem>
                          <SelectItem value="eng">English</SelectItem>
                          <SelectItem value="hin">Hindi</SelectItem>
                          <SelectItem value="jpn">Japanese</SelectItem>
                        </SelectContent>
                      </Select>
                    </div>
                  </div>
                </div>
              </div>
            </div>

            <div className="rounded-lg border border-panel-border/25 bg-card px-4 py-2 space-y-2.5">
              <div className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Safety & Logging</div>
              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-2">
                  <div className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Safety</div>
                  <div className="flex items-center gap-2">
                    <Checkbox 
                      id="add-crc"
                      checked={addCrc}
                      onCheckedChange={(checked) => onMuxSettingsChange({ addCrc: checked as boolean })}
                      className="h-3.5 w-7"
                    />
                    <label htmlFor="add-crc" className="text-xs cursor-pointer">Write CRC</label>
                  </div>
                  <div className="flex items-center gap-2">
                    <Checkbox 
                      id="remove-crc"
                      checked={removeOldCrc}
                      onCheckedChange={(checked) => onMuxSettingsChange({ removeOldCrc: checked as boolean })}
                      className="h-3.5 w-7"
                    />
                    <label htmlFor="remove-crc" className="text-xs cursor-pointer">Remove CRC Tags</label>
                  </div>
                  <div className="flex items-center gap-2">
                    <Checkbox 
                      id="abort-errors"
                      checked={abortOnErrors}
                      onCheckedChange={(checked) => onMuxSettingsChange({ abortOnErrors: checked as boolean })}
                      className="h-3.5 w-7"
                    />
                    <label htmlFor="abort-errors" className="text-xs cursor-pointer">Stop on Errors</label>
                  </div>
                </div>
                <div className="space-y-2">
                  <div className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Logging</div>
                  <div className="flex items-center gap-2">
                    <Checkbox 
                      id="keep-log"
                      checked={keepLogFile}
                      onCheckedChange={(checked) => onMuxSettingsChange({ keepLogFile: checked as boolean })}
                      className="h-3.5 w-7"
                    />
                    <label htmlFor="keep-log" className="text-xs cursor-pointer">Keep Log</label>
                  </div>
                </div>
              </div>
            </div>
            </div>
          </CollapsibleContent>
        </Collapsible>

        {/* Execution Card */}
        <div className="rounded-lg border border-panel-border/35 bg-panel-header/70 px-4 py-2 space-y-2.5">
          <div className="flex items-center justify-between">
            <div className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Mux Engine</div>
            <div className="flex items-center gap-2">
              <Button
                variant="ghost"
                size="sm"
                className="h-8 px-3 text-xs gap-1.5 text-muted-foreground hover:text-destructive hover:bg-destructive/10"
                onClick={onClearAll}
              >
                <Trash2 className="w-3 h-3" />
                Clear
              </Button>
              <Button
                variant="default"
                size="sm"
                className="h-8 px-4 text-xs gap-1.5 font-medium"
                onClick={onAddToQueue}
              >
                <ListPlus className="w-3 h-3" />
                Add To Queue
              </Button>
            </div>
          </div>
          <div className="grid grid-cols-2 gap-5">
            <div className="space-y-2">
              <div className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Performance</div>
              <div className="flex items-center gap-2">
                <Checkbox
                  id="fast-mux"
                  checked={muxSettings.useMkvpropedit}
                  onCheckedChange={(checked) => {
                    if (!fastMuxAvailable) return;
                    onMuxSettingsChange({ useMkvpropedit: checked as boolean });
                  }}
                  className="h-3.5 w-7"
                  disabled={!fastMuxAvailable}
                />
                <label
                  htmlFor="fast-mux"
                  className={cn(
                    "text-xs cursor-pointer",
                    !fastMuxAvailable && "text-muted-foreground/60 cursor-not-allowed"
                  )}
                  title={
                    fastMuxAvailable
                      ? undefined
                      : "Fast mux only works without external tracks, removals, or language filters."
                  }
                >
                  Fast Mux (metadata-only)
                </label>
              </div>
            </div>
            <div className="space-y-2">
              <div className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Parallel Jobs</div>
              <div className="inline-flex items-center gap-2">
                <span className="inline-flex items-center justify-center h-7 px-2.5 rounded-md border border-panel-border/40 bg-input text-xs">
                  Auto{autoParallelJobs > 0 ? ` • ${autoParallelJobs}` : ""}
                </span>
                <span className="text-[11px] text-muted-foreground/70">
                  Matches file count (max 12)
                </span>
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Job Queue Section */}
      <div className="px-5 pt-1 pb-2 flex items-center justify-between">
        <div className="section-label">Job Queue</div>
        <div className="text-xs text-muted-foreground">Queue: {jobs.length} items</div>
      </div>
      {hasJobs && (
        <div className="px-5 pb-2">
          <div className="flex items-center justify-between text-[10px] text-muted-foreground mb-1">
            <span>Overall Progress</span>
            <span>{overallProgress}%</span>
          </div>
          <Progress value={overallProgress} className="h-2" />
        </div>
      )}

          <div className="flex-1 flex flex-col rounded-lg border border-panel-border/25 bg-card overflow-hidden mx-5 mb-2.5">
        <div className="flex-1 overflow-y-auto scrollbar-thin">
          <div className="table-header sticky top-0 z-10">
            <div className="grid grid-cols-[1fr_90px_90px_140px_90px] gap-0">
              <div className="px-4 py-2 text-xs text-muted-foreground">Name</div>
              <div className="px-3 py-2 text-xs text-center text-muted-foreground">Status</div>
              <div className="px-3 py-2 text-xs text-center text-muted-foreground">Before</div>
              <div className="px-3 py-2 text-xs text-center text-muted-foreground">Progress</div>
              <div className="px-3 py-2 text-xs text-center text-muted-foreground">After</div>
            </div>
          </div>

          {jobs.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-full text-center py-12">
              <div className="w-11 h-11 rounded-lg bg-muted/50 flex items-center justify-center mb-3">
                <Package className="w-6 h-6 text-muted-foreground/50" />
              </div>
              <p className="text-muted-foreground text-sm">Queue is ready</p>
              <p className="text-muted-foreground/60 text-xs mt-0.5">Add files to the queue, then start muxing.</p>
            </div>
          ) : (
            jobs.map((job, index) => {
              const warnings = previewResults[job.id]?.warnings ?? [];
              return (
                <div
                  key={job.id}
                  onClick={() => setSelectedJobIndex(index)}
                  onDoubleClick={() => {
                    if (!getJobReport) return;
                    setReportJobId(job.id);
                    setReportOpen(true);
                  }}
                  className={cn(
                    "grid grid-cols-[1fr_90px_90px_140px_90px] gap-0 h-11 border-b border-panel-border/25 cursor-pointer transition-smooth",
                    selectedJobIndex === index
                      ? "bg-selection border-l-2 border-l-selection-border"
                      : "hover:bg-accent/30"
                  )}
                >
                  <div className="px-4 text-sm truncate font-mono flex items-center">
                    <span className="text-muted-foreground/60 mr-2">{index + 1}.</span>
                    {warnings.length > 0 && (
                      <AlertTriangle
                        className="w-3.5 h-3.5 text-warning mr-2 shrink-0"
                        title={warnings.join("\n")}
                      />
                    )}
                    {job.videoFile.name}
                  </div>
                  <div className="px-3 text-center flex items-center justify-center">
                    <span className={cn(
                      "text-[10px] font-medium px-2 py-0.5 rounded",
                      job.status === 'completed' && "bg-success/20 text-success",
                      job.status === 'error' && "bg-destructive/20 text-destructive",
                      job.status === 'processing' && "bg-primary/20 text-primary",
                      job.status === 'queued' && "bg-muted text-muted-foreground"
                    )}>
                      {job.status === 'queued' ? 'Queued' : job.status}
                    </span>
                  </div>
                  <div className="px-3 text-xs text-center text-muted-foreground font-mono flex items-center justify-center">
                    {job.sizeBefore ? formatFileSize(job.sizeBefore) : formatFileSize(job.videoFile.size)}
                  </div>
                  <div className="px-3 flex items-center">
                    {job.status === 'processing' ? (
                      <div className="flex flex-col gap-1 w-full">
                        <Progress value={job.progress} className="h-1.5" />
                        <div className="flex items-center justify-between text-[10px] text-muted-foreground font-mono">
                          <span>{job.progress}%</span>
                          <span>ETA {formatEta(job.etaSeconds)}</span>
                        </div>
                      </div>
                    ) : job.status === 'completed' ? (
                      <div className="flex flex-col gap-1 w-full">
                        <Progress value={100} className="h-1.5" />
                        <div className="flex items-center justify-between text-[10px] text-muted-foreground font-mono">
                          <span>100%</span>
                          <span>ETA —</span>
                        </div>
                      </div>
                    ) : null}
                  </div>
                  <div className="px-3 text-xs text-center text-muted-foreground font-mono flex items-center justify-center">
                    {job.sizeAfter ? formatFileSize(job.sizeAfter) : '—'}
                  </div>
                </div>
              );
            })
          )}
        </div>
      </div>

      {/* Action Bar */}
      <div className="flex items-center justify-between gap-3 px-5 h-12 border-t border-panel-border bg-panel-header">
      <div className="flex items-center gap-3">
        <Button
          variant="ghost"
          size="sm"
          className="h-8 px-3 text-xs gap-1.5 text-muted-foreground hover:text-foreground"
          onClick={onViewLog}
        >
          <FileText className="w-3.5 h-3.5" />
          View Log
        </Button>
        <div className="text-xs text-muted-foreground">
          {statusLabel} • {jobs.length} queued • {completedJobs} completed
        </div>
      </div>

        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            className="h-8 px-3 text-xs gap-1.5 border-panel-border/40 bg-card/40 hover:bg-panel-header/60"
            onClick={onPauseMuxing}
            disabled={!isProcessing}
          >
            <Pause className="w-3.5 h-3.5" />
            Pause
          </Button>
          <Button
            variant="outline"
            size="sm"
            className="h-8 px-3 text-xs gap-1.5 border-panel-border/40 bg-card/40 hover:bg-panel-header/60"
            onClick={onResumeMuxing}
            disabled={!isProcessing}
          >
            <Play className="w-3.5 h-3.5" />
            Resume
          </Button>
          {isProcessing && (
            <Button
              variant="destructive"
              size="sm"
              className="h-8 px-3 text-xs gap-1.5"
              onClick={onStopMuxing}
            >
              <Square className="w-3.5 h-3.5" />
              Stop
            </Button>
          )}
          <Button 
            variant="default" 
            size="sm" 
            className="h-8 px-5 gap-2 text-xs font-medium"
            onClick={onStartMuxing}
            disabled={!hasJobs || isProcessing}
          >
            <Play className="w-3.5 h-3.5" />
            Start Muxing
          </Button>
        </div>
      </div>

      <BaseModal
        open={reportOpen}
        onOpenChange={setReportOpen}
        title={reportData?.title || "Modification Report"}
        subtitle="Changes that will be applied for this queued job"
        icon={<FileText className="w-5 h-5 text-primary" />}
        className="max-w-2xl"
        bodyClassName="px-5 py-4"
      >
        {!reportData ? (
          <div className="text-sm text-muted-foreground">No report available for this item.</div>
        ) : (
          <div className="space-y-4">
            {reportData.sections.length === 0 ? (
              <div className="text-sm text-muted-foreground">No modifications detected.</div>
            ) : (
              reportData.sections.map((section) => (
                <div key={section.title} className="space-y-2">
                  <div className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                    {section.title}
                  </div>
                  <div className="space-y-2">
                    {section.items.map((item, idx) => (
                      <div
                        key={`${section.title}-${idx}`}
                        className="rounded-md border border-panel-border/40 bg-panel-header/40 px-3 py-2"
                      >
                        <div className="text-sm font-medium text-foreground">{item.title}</div>
                        {item.details.length > 0 && (
                          <div className="mt-1 text-xs text-muted-foreground">
                            {item.details.join(" • ")}
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                </div>
              ))
            )}
          </div>
        )}
      </BaseModal>
    </div>
  );
}
