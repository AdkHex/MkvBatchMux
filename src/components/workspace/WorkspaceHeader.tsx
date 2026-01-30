import { Sun, Moon, ListOrdered, Settings, HelpCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";

interface WorkspaceHeaderProps {
  jobsCount: number;
  processingCount: number;
  onToggleJobQueue: () => void;
  isDarkMode: boolean;
  onToggleTheme: () => void;
}

export function WorkspaceHeader({ 
  jobsCount, 
  processingCount, 
  onToggleJobQueue,
  isDarkMode,
  onToggleTheme,
}: WorkspaceHeaderProps) {
  return (
    <header className="h-12 bg-panel-header border-b border-panel-border flex items-center justify-between px-4">
      <div className="flex items-center gap-4">
        <h1 className="text-sm font-medium text-muted-foreground">
          MKV Muxing Batch GUI
        </h1>
      </div>

      <div className="flex items-center gap-2">
        {jobsCount > 0 && (
          <Button
            variant="outline"
            size="sm"
            onClick={onToggleJobQueue}
            className="relative"
          >
            <ListOrdered className="w-4 h-4 mr-1.5" />
            Job Queue
            <Badge 
              variant={processingCount > 0 ? "default" : "secondary"}
              className="ml-2"
            >
              {jobsCount}
            </Badge>
            {processingCount > 0 && (
              <span className="absolute -top-1 -right-1 w-2.5 h-2.5 bg-primary rounded-full animate-pulse-subtle" />
            )}
          </Button>
        )}

        <div className="w-px h-6 bg-border mx-1" />

        <Tooltip>
          <TooltipTrigger asChild>
            <Button variant="ghost" size="icon" className="h-8 w-8" onClick={onToggleTheme}>
              {isDarkMode ? <Sun className="w-4 h-4" /> : <Moon className="w-4 h-4" />}
            </Button>
          </TooltipTrigger>
          <TooltipContent>Toggle theme</TooltipContent>
        </Tooltip>

        <Tooltip>
          <TooltipTrigger asChild>
            <Button variant="ghost" size="icon" className="h-8 w-8">
              <Settings className="w-4 h-4" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>Settings</TooltipContent>
        </Tooltip>

        <Tooltip>
          <TooltipTrigger asChild>
            <Button variant="ghost" size="icon" className="h-8 w-8">
              <HelpCircle className="w-4 h-4" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>Help</TooltipContent>
        </Tooltip>
      </div>
    </header>
  );
}
