import { create } from "zustand";
import type { VideoFile, ExternalFile, MuxJob, MuxSettings, OutputSettings } from "@/types";

export interface SessionState {
  version: string;
  timestamp: number;
  videoFiles: VideoFile[];
  audioFiles: Record<string, ExternalFile[]>;
  subtitleFiles: Record<string, ExternalFile[]>;
  chapterFiles: ExternalFile[];
  attachmentFiles: ExternalFile[];
  perVideoExternal: Record<string, { audios: ExternalFile[]; subtitles: ExternalFile[] }>;
  jobs: MuxJob[];
  muxSettings: MuxSettings;
  outputSettings: OutputSettings;
  activeTab: string;
  videoSourceFolder: string;
}

interface SessionStoreState {
  /** Whether a pending session was found on startup and is awaiting user decision. */
  hasPendingSession: boolean;
  /** The pending session data found on disk. */
  pendingSession: SessionState | null;
  /** Whether a save is currently in progress. */
  isSaving: boolean;
  /** Last successful save timestamp. */
  lastSavedAt: number | null;
  /** Last save error. */
  lastSaveError: string | null;

  setPendingSession: (session: SessionState | null) => void;
  clearPendingSession: () => void;
  setIsSaving: (saving: boolean) => void;
  setLastSavedAt: (ts: number) => void;
  setLastSaveError: (err: string | null) => void;
}

export const useSessionStore = create<SessionStoreState>()((set) => ({
  hasPendingSession: false,
  pendingSession: null,
  isSaving: false,
  lastSavedAt: null,
  lastSaveError: null,

  setPendingSession: (session) =>
    set({ pendingSession: session, hasPendingSession: session !== null }),
  clearPendingSession: () => set({ pendingSession: null, hasPendingSession: false }),
  setIsSaving: (saving) => set({ isSaving: saving }),
  setLastSavedAt: (ts) => set({ lastSavedAt: ts, lastSaveError: null }),
  setLastSaveError: (err) => set({ lastSaveError: err }),
}));
