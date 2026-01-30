import { useEffect, useCallback } from "react";

interface ShortcutHandlers {
  onOpenOptions?: () => void;
  onModifyTracks?: () => void;
  onNewTrack?: () => void;
  onShowHelp?: () => void;
  onToggleSidebar?: () => void;
}

export function useKeyboardShortcuts(handlers: ShortcutHandlers) {
  const handleKeyDown = useCallback((event: KeyboardEvent) => {
    // Don't trigger shortcuts when typing in inputs
    const target = event.target as HTMLElement;
    if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable) {
      return;
    }

    // Ctrl+O - Open Options
    if (event.ctrlKey && event.key === 'o') {
      event.preventDefault();
      handlers.onOpenOptions?.();
    }

    // Ctrl+M - Modify Tracks
    if (event.ctrlKey && event.key === 'm') {
      event.preventDefault();
      handlers.onModifyTracks?.();
    }

    // Ctrl+N - New Track
    if (event.ctrlKey && event.key === 'n') {
      event.preventDefault();
      handlers.onNewTrack?.();
    }

    // ? - Show Help
    if (event.key === '?' || (event.shiftKey && event.key === '/')) {
      event.preventDefault();
      handlers.onShowHelp?.();
    }

    // Ctrl+B - Toggle Sidebar
    if (event.ctrlKey && event.key === 'b') {
      event.preventDefault();
      handlers.onToggleSidebar?.();
    }
  }, [handlers]);

  useEffect(() => {
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [handleKeyDown]);
}

export const shortcuts = [
  { keys: ['Ctrl', 'O'], description: 'Open Options dialog' },
  { keys: ['Ctrl', 'M'], description: 'Modify Tracks dialog' },
  { keys: ['Ctrl', 'N'], description: 'Add new track (in Subtitles/Audios tab)' },
  { keys: ['Ctrl', 'B'], description: 'Toggle sidebar collapse' },
  { keys: ['?'], description: 'Show keyboard shortcuts' },
];
