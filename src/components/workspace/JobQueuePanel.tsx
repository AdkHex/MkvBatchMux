import { 
  X, 
  Pause, 
  Play, 
  CheckCircle2, 
  AlertCircle, 
  Clock, 
  Loader2,
  ChevronRight,
  FileText
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { cn } from "@/lib/utils";
import type { MuxJob } from "@/types";

interface JobQueuePanelProps {
  jobs: MuxJob[];
  isOpen: boolean;
  onClose: () => void;
  onPause: () => void;
  onStop: () => void;
  isPaused: boolean;
}

const statusConfig = {
  queued: { icon: Clock, className: "text-muted-foreground", label: "Queued" },
  processing: { icon: Loader2, className: "text-primary animate-spin", label: "Processing" },
  completed: { icon: CheckCircle2, className: "text-success", label: "Completed" },
  error: { icon: AlertCircle, className: "text-destructive", label: "Error" },
};

export function JobQueuePanel({ jobs, isOpen, onClose, onPause, onStop, isPaused }: JobQueuePanelProps) {
  if (!isOpen) return null;

  const completedCount = jobs.filter(j => j.status === 'completed').length;
  const errorCount = jobs.filter(j => j.status === 'error').length;
  const processingJob = jobs.find(j => j.status === 'processing');
  const overallProgress = jobs.length > 0 
    ? Math.round((completedCount / jobs.length) * 100)
    : 0;

  return (
    <div className="fixed inset-y-0 right-0 w-96 bg-card border-l border-border shadow-xl z-50 flex flex-col animate-slide-in-right">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-border bg-panel-header">
        <div>
          <h2 className="text-lg font-semibold">Job Queue</h2>
          <p className="text-sm text-muted-foreground">
            {completedCount} of {jobs.length} complete
          </p>
        </div>
        <Button variant="ghost" size="icon" onClick={onClose}>
          <X className="w-5 h-5" />
        </Button>
      </div>

      {/* Overall Progress */}
      <div className="px-4 py-3 border-b border-border bg-muted/30">
        <div className="flex items-center justify-between mb-2">
          <span className="text-sm font-medium">Overall Progress</span>
          <span className="text-sm font-mono">{overallProgress}%</span>
        </div>
        <Progress value={overallProgress} className="h-2" />
        
        <div className="flex items-center gap-4 mt-3 text-xs">
          <span className="flex items-center gap-1">
            <span className="w-2 h-2 rounded-full bg-success" />
            {completedCount} done
          </span>
          {errorCount > 0 && (
            <span className="flex items-center gap-1">
              <span className="w-2 h-2 rounded-full bg-destructive" />
              {errorCount} error{errorCount !== 1 ? 's' : ''}
            </span>
          )}
          <span className="flex items-center gap-1">
            <span className="w-2 h-2 rounded-full bg-muted-foreground" />
            {jobs.length - completedCount - errorCount} remaining
          </span>
        </div>
      </div>

      {/* Job List */}
      <div className="flex-1 overflow-y-auto scrollbar-thin">
        {jobs.map((job) => {
          const StatusIcon = statusConfig[job.status].icon;
          
          return (
            <div
              key={job.id}
              className={cn(
                "px-4 py-3 border-b border-border",
                job.status === 'processing' && "bg-primary/5"
              )}
            >
              <div className="flex items-start gap-3">
                <StatusIcon className={cn("w-5 h-5 mt-0.5 flex-shrink-0", statusConfig[job.status].className)} />
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium truncate">{job.videoFile.name}</p>
                  <p className="text-xs text-muted-foreground mt-0.5">
                    {statusConfig[job.status].label}
                  </p>
                  
                  {job.status === 'processing' && (
                    <div className="mt-2">
                      <Progress value={job.progress} className="h-1.5" />
                      <p className="text-xs text-muted-foreground mt-1 font-mono">
                        {job.progress}%
                      </p>
                    </div>
                  )}
                  
                  {job.status === 'error' && job.errorMessage && (
                    <p className="text-xs text-destructive mt-1">
                      {job.errorMessage}
                    </p>
                  )}
                </div>
                
                {job.status === 'error' && (
                  <Button variant="ghost" size="icon" className="h-7 w-7">
                    <FileText className="w-4 h-4" />
                  </Button>
                )}
              </div>
            </div>
          );
        })}
      </div>

      {/* Controls */}
      <div className="p-4 border-t border-border bg-panel-header space-y-2">
        <div className="flex gap-2">
          <Button 
            variant="outline" 
            className="flex-1"
            onClick={onPause}
          >
            {isPaused ? (
              <>
                <Play className="w-4 h-4 mr-1.5" />
                Resume
              </>
            ) : (
              <>
                <Pause className="w-4 h-4 mr-1.5" />
                Pause
              </>
            )}
          </Button>
          <Button 
            variant="destructive" 
            className="flex-1"
            onClick={onStop}
          >
            Stop All
          </Button>
        </div>
        
        {processingJob && (
          <p className="text-xs text-center text-muted-foreground">
            Currently processing: {processingJob.videoFile.name}
          </p>
        )}
      </div>
    </div>
  );
}
