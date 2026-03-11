import { Undo2, Redo2, History } from "lucide-react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { useHistoryStore } from "@/stores/useHistoryStore";
import { IconButton } from "@/components/shared/IconButton";
import { cn } from "@/lib/utils";

export function HistoryToolbar() {
  const { canUndo, canRedo, undoDescription, redoDescription, recentHistory, undo, redo } =
    useHistoryStore();

  return (
    <div className="flex items-center gap-0.5">
      <Tooltip>
        <TooltipTrigger asChild>
          <span>
            <IconButton
              onClick={undo}
              disabled={!canUndo}
              aria-label="Undo"
              className={cn(!canUndo && "opacity-40 cursor-not-allowed")}
            >
              <Undo2 />
            </IconButton>
          </span>
        </TooltipTrigger>
        <TooltipContent side="bottom">
          {canUndo ? `Undo: ${undoDescription}` : "Nothing to undo"} (Ctrl+Z)
        </TooltipContent>
      </Tooltip>

      <Tooltip>
        <TooltipTrigger asChild>
          <span>
            <IconButton
              onClick={redo}
              disabled={!canRedo}
              aria-label="Redo"
              className={cn(!canRedo && "opacity-40 cursor-not-allowed")}
            >
              <Redo2 />
            </IconButton>
          </span>
        </TooltipTrigger>
        <TooltipContent side="bottom">
          {canRedo ? `Redo: ${redoDescription}` : "Nothing to redo"} (Ctrl+Y)
        </TooltipContent>
      </Tooltip>

      <Popover>
        <PopoverTrigger asChild>
          <span>
            <IconButton aria-label="History">
              <History />
            </IconButton>
          </span>
        </PopoverTrigger>
        <PopoverContent align="end" className="w-72 p-0">
          <div className="px-3 py-2 border-b">
            <p className="text-sm font-medium">Recent Actions</p>
          </div>
          {recentHistory.length === 0 ? (
            <p className="px-3 py-4 text-sm text-muted-foreground text-center">No actions yet</p>
          ) : (
            <ul className="py-1">
              {[...recentHistory].reverse().map((cmd, i) => (
                <li
                  key={cmd.id}
                  className={cn(
                    "px-3 py-1.5 text-sm flex items-center gap-2",
                    i === 0 ? "text-foreground" : "text-muted-foreground",
                  )}
                >
                  <span className="shrink-0 w-1.5 h-1.5 rounded-full bg-current opacity-60" />
                  {cmd.description}
                </li>
              ))}
            </ul>
          )}
        </PopoverContent>
      </Popover>
    </div>
  );
}
