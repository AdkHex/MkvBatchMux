import { FolderOpen, Play, Info, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import type { OutputSettings } from "@/types";

interface OutputSettingsPanelProps {
  settings: OutputSettings;
  onSettingsChange: (settings: Partial<OutputSettings>) => void;
  onStartMuxing: () => void;
  sourceFileCount: number;
  isProcessing: boolean;
}

export function OutputSettingsPanel({
  settings,
  onSettingsChange,
  onStartMuxing,
  sourceFileCount,
  isProcessing,
}: OutputSettingsPanelProps) {
  const namingPatternVariables = [
    { var: '{original_filename}', desc: 'Original file name without extension' },
    { var: '{index}', desc: 'File number in batch (01, 02, 03...)' },
    { var: '{date}', desc: 'Current date (YYYY-MM-DD)' },
  ];

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-panel-border bg-panel-header">
        <h2 className="text-lg font-semibold">Output Settings</h2>
      </div>

      <div className="flex-1 overflow-y-auto scrollbar-thin">
        <div className="p-6 max-w-2xl space-y-8">
          {/* Output Directory */}
          <div className="space-y-3">
            <Label className="text-sm font-medium">Output Directory</Label>
            <div className="flex gap-2">
              <Input
                value={settings.directory}
                onChange={(e) => onSettingsChange({ directory: e.target.value })}
                placeholder="/path/to/output"
                className="flex-1 font-mono text-sm"
              />
              <Button variant="outline">
                <FolderOpen className="w-4 h-4 mr-1.5" />
                Browse
              </Button>
            </div>
            <p className="text-xs text-muted-foreground">
              Leave empty to save files in the same directory as the source files.
            </p>
          </div>

          {/* Naming Pattern */}
          <div className="space-y-3">
            <div className="flex items-center gap-2">
              <Label className="text-sm font-medium">Naming Pattern</Label>
              <Tooltip>
                <TooltipTrigger>
                  <Info className="w-4 h-4 text-muted-foreground" />
                </TooltipTrigger>
                <TooltipContent side="right" className="max-w-xs">
                  <p className="text-sm">Use variables to create dynamic file names. The extension (.mkv) is added automatically.</p>
                </TooltipContent>
              </Tooltip>
            </div>
            <Input
              value={settings.namingPattern}
              onChange={(e) => onSettingsChange({ namingPattern: e.target.value })}
              placeholder="{original_filename}-muxed"
              className="font-mono text-sm"
            />
            <div className="flex flex-wrap gap-1.5">
              {namingPatternVariables.map(v => (
                <button
                  key={v.var}
                  className="px-2 py-1 text-xs rounded bg-muted hover:bg-accent transition-colors font-mono"
                  onClick={() => onSettingsChange({ 
                    namingPattern: settings.namingPattern + v.var 
                  })}
                >
                  {v.var}
                </button>
              ))}
            </div>
            <div className="p-3 rounded-lg bg-muted/50 border border-border">
              <p className="text-xs text-muted-foreground mb-1">Preview:</p>
              <p className="text-sm font-mono">
                {settings.namingPattern
                  .replace('{original_filename}', 'My_Video')
                  .replace('{index}', '01')
                  .replace('{date}', new Date().toISOString().split('T')[0])
                }.mkv
              </p>
            </div>
          </div>

          {/* Options */}
          <div className="space-y-4">
            <Label className="text-sm font-medium">Options</Label>
            
            <div className="flex items-center justify-between p-3 rounded-lg bg-card border border-border">
              <div>
                <p className="text-sm font-medium">Overwrite Existing Files</p>
                <p className="text-xs text-muted-foreground">
                  Replace files with the same name in the output directory
                </p>
              </div>
              <Switch
                checked={settings.overwriteExisting}
                onCheckedChange={(checked) => onSettingsChange({ overwriteExisting: checked })}
              />
            </div>
          </div>

          {/* Summary */}
          <div className="p-4 rounded-lg bg-primary/5 border border-primary/20">
            <h3 className="text-sm font-semibold mb-2 text-primary">Ready to Mux</h3>
            <ul className="space-y-1 text-sm text-muted-foreground">
              <li>• {sourceFileCount} source video file{sourceFileCount !== 1 ? 's' : ''}</li>
              <li>• Output: {settings.directory || 'Same as source'}</li>
              <li>• Pattern: {settings.namingPattern || '{original_filename}'}.mkv</li>
            </ul>
          </div>
        </div>
      </div>

      {/* Footer with Start Button */}
      <div className="p-4 border-t border-panel-border bg-panel-header">
        <Button 
          size="lg" 
          className="w-full glow-primary"
          onClick={onStartMuxing}
          disabled={sourceFileCount === 0 || isProcessing}
        >
          {isProcessing ? (
            <>
              <RefreshCw className="w-4 h-4 mr-2 animate-spin" />
              Processing...
            </>
          ) : (
            <>
              <Play className="w-4 h-4 mr-2" />
              Start Muxing ({sourceFileCount} file{sourceFileCount !== 1 ? 's' : ''})
            </>
          )}
        </Button>
      </div>
    </div>
  );
}
