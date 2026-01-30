import { 
  Film, 
  FileVideo, 
  Subtitles, 
  Music, 
  BookOpen, 
  Paperclip, 
  FolderOutput,
  Layers
} from "lucide-react";
import { cn } from "@/lib/utils";
import type { NavigationSection } from "@/types";

interface WorkspaceSidebarProps {
  activeSection: NavigationSection;
  onSectionChange: (section: NavigationSection) => void;
  sourceFileCount: number;
}

const navItems: { id: NavigationSection; label: string; icon: React.ElementType; group: 'source' | 'add' | 'output' }[] = [
  { id: 'source-files', label: 'Source Files', icon: FileVideo, group: 'source' },
  { id: 'source-tracks', label: 'Inspect Tracks', icon: Layers, group: 'source' },
  { id: 'add-subtitles', label: 'Subtitles', icon: Subtitles, group: 'add' },
  { id: 'add-audio', label: 'Audio', icon: Music, group: 'add' },
  { id: 'add-chapters', label: 'Chapters', icon: BookOpen, group: 'add' },
  { id: 'attachments', label: 'Attachments', icon: Paperclip, group: 'add' },
  { id: 'output', label: 'Output', icon: FolderOutput, group: 'output' },
];

export function WorkspaceSidebar({ activeSection, onSectionChange, sourceFileCount }: WorkspaceSidebarProps) {
  return (
    <aside className="w-56 bg-sidebar border-r border-sidebar-border flex flex-col">
      {/* Logo/Title */}
      <div className="h-14 px-4 flex items-center gap-2 border-b border-sidebar-border">
        <div className="w-8 h-8 rounded-lg bg-primary flex items-center justify-center">
          <Film className="w-4 h-4 text-primary-foreground" />
        </div>
        <div className="flex flex-col">
          <span className="text-sm font-semibold text-sidebar-foreground">MKV Muxer</span>
          <span className="text-xs text-muted-foreground">Batch GUI</span>
        </div>
      </div>

      {/* Navigation */}
      <nav className="flex-1 py-4 px-2 space-y-6 overflow-y-auto scrollbar-thin">
        {/* Source Section */}
        <div>
          <h3 className="px-3 mb-2 text-xs font-medium uppercase tracking-wider text-muted-foreground">
            Source
          </h3>
          <div className="space-y-1">
            {navItems.filter(item => item.group === 'source').map(item => (
              <button
                key={item.id}
                onClick={() => onSectionChange(item.id)}
                className={cn(
                  "w-full flex items-center gap-3 px-3 py-2 rounded-md text-sm transition-colors",
                  activeSection === item.id
                    ? "bg-sidebar-accent text-sidebar-accent-foreground font-medium"
                    : "text-sidebar-foreground hover:bg-sidebar-accent/50"
                )}
              >
                <item.icon className="w-4 h-4" />
                <span className="flex-1 text-left">{item.label}</span>
                {item.id === 'source-files' && sourceFileCount > 0 && (
                  <span className="px-1.5 py-0.5 text-xs font-medium rounded bg-primary text-primary-foreground">
                    {sourceFileCount}
                  </span>
                )}
              </button>
            ))}
          </div>
        </div>

        {/* Add Tracks Section */}
        <div>
          <h3 className="px-3 mb-2 text-xs font-medium uppercase tracking-wider text-muted-foreground">
            Add Tracks
          </h3>
          <div className="space-y-1">
            {navItems.filter(item => item.group === 'add').map(item => (
              <button
                key={item.id}
                onClick={() => onSectionChange(item.id)}
                className={cn(
                  "w-full flex items-center gap-3 px-3 py-2 rounded-md text-sm transition-colors",
                  activeSection === item.id
                    ? "bg-sidebar-accent text-sidebar-accent-foreground font-medium"
                    : "text-sidebar-foreground hover:bg-sidebar-accent/50"
                )}
              >
                <item.icon className="w-4 h-4" />
                <span className="flex-1 text-left">{item.label}</span>
              </button>
            ))}
          </div>
        </div>

        {/* Output Section */}
        <div>
          <h3 className="px-3 mb-2 text-xs font-medium uppercase tracking-wider text-muted-foreground">
            Finalize
          </h3>
          <div className="space-y-1">
            {navItems.filter(item => item.group === 'output').map(item => (
              <button
                key={item.id}
                onClick={() => onSectionChange(item.id)}
                className={cn(
                  "w-full flex items-center gap-3 px-3 py-2 rounded-md text-sm transition-colors",
                  activeSection === item.id
                    ? "bg-sidebar-accent text-sidebar-accent-foreground font-medium"
                    : "text-sidebar-foreground hover:bg-sidebar-accent/50"
                )}
              >
                <item.icon className="w-4 h-4" />
                <span className="flex-1 text-left">{item.label}</span>
              </button>
            ))}
          </div>
        </div>
      </nav>

      {/* Version */}
      <div className="px-4 py-3 border-t border-sidebar-border">
        <p className="text-xs text-muted-foreground">v1.0.0 • mkvmerge ready</p>
      </div>
    </aside>
  );
}
