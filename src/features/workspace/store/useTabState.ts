import { create } from "zustand";
import { persist } from "zustand/middleware";

export interface TrackConfig {
  sourceFolder: string;
  extension: string;
  language: string;
  trackName: string;
  delay: string;
  isDefault: boolean;
  isForced: boolean;
  muxAfter: string;
}

const defaultAudioConfig: TrackConfig = {
  sourceFolder: "",
  extension: "all",
  language: "hin",
  trackName: "",
  delay: "0.000",
  isDefault: false,
  isForced: false,
  muxAfter: "video",
};

const defaultSubtitleConfig: TrackConfig = {
  sourceFolder: "",
  extension: "all",
  language: "eng",
  trackName: "",
  delay: "0.000",
  isDefault: false,
  isForced: false,
  muxAfter: "audio",
};

interface ChapterTabState {
  chaptersEnabled: boolean;
  sourceFolder: string;
  extension: string;
  discardOldChapters: boolean;
  delay: string;
}

interface AttachmentTabState {
  attachmentsEnabled: boolean;
  sourceFolder: string;
  extension: string;
  allowDuplicate: boolean;
  discardOld: boolean;
  expertMode: boolean;
}

interface TabState {
  audioTracks: string[];
  activeAudioTrack: string;
  audioTrackConfigs: Record<string, TrackConfig>;
  audioPresetApplied: boolean;
  subtitleTracks: string[];
  activeSubtitleTrack: string;
  subtitleTrackConfigs: Record<string, TrackConfig>;
  subtitlePresetApplied: boolean;
  chapterTabState: ChapterTabState;
  attachmentTabState: AttachmentTabState;
  setAudioTracks: (tracks: string[]) => void;
  setActiveAudioTrack: (track: string) => void;
  updateAudioTrackConfig: (track: string, updates: Partial<TrackConfig>) => void;
  removeAudioTrackConfig: (track: string) => void;
  setAudioPresetApplied: (value: boolean) => void;
  setSubtitleTracks: (tracks: string[]) => void;
  setActiveSubtitleTrack: (track: string) => void;
  updateSubtitleTrackConfig: (track: string, updates: Partial<TrackConfig>) => void;
  removeSubtitleTrackConfig: (track: string) => void;
  setSubtitlePresetApplied: (value: boolean) => void;
  updateChapterTabState: (updates: Partial<ChapterTabState>) => void;
  updateAttachmentTabState: (updates: Partial<AttachmentTabState>) => void;
  resetSession: () => void;
}

const defaultChapterTabState: ChapterTabState = {
  chaptersEnabled: false,
  sourceFolder: "",
  extension: "all",
  discardOldChapters: false,
  delay: "0.000",
};

const defaultAttachmentTabState: AttachmentTabState = {
  attachmentsEnabled: false,
  sourceFolder: "",
  extension: "all",
  allowDuplicate: false,
  discardOld: false,
  expertMode: false,
};

export const useTabState = create<TabState>()(
  persist(
    (set) => ({
      audioTracks: ["1"],
      activeAudioTrack: "1",
      audioTrackConfigs: { "1": { ...defaultAudioConfig } },
      audioPresetApplied: false,
      subtitleTracks: ["1"],
      activeSubtitleTrack: "1",
      subtitleTrackConfigs: { "1": { ...defaultSubtitleConfig } },
      subtitlePresetApplied: false,
      chapterTabState: { ...defaultChapterTabState },
      attachmentTabState: { ...defaultAttachmentTabState },
      setAudioTracks: (tracks) => set({ audioTracks: tracks }),
      setActiveAudioTrack: (track) => set({ activeAudioTrack: track }),
      updateAudioTrackConfig: (track, updates) =>
        set((state) => ({
          audioTrackConfigs: {
            ...state.audioTrackConfigs,
            [track]: {
              ...(state.audioTrackConfigs[track] || defaultAudioConfig),
              ...updates,
            },
          },
        })),
      removeAudioTrackConfig: (track) =>
        set((state) => {
          const next = { ...state.audioTrackConfigs };
          delete next[track];
          return { audioTrackConfigs: next };
        }),
      setAudioPresetApplied: (value) => set({ audioPresetApplied: value }),
      setSubtitleTracks: (tracks) => set({ subtitleTracks: tracks }),
      setActiveSubtitleTrack: (track) => set({ activeSubtitleTrack: track }),
      updateSubtitleTrackConfig: (track, updates) =>
        set((state) => ({
          subtitleTrackConfigs: {
            ...state.subtitleTrackConfigs,
            [track]: {
              ...(state.subtitleTrackConfigs[track] || defaultSubtitleConfig),
              ...updates,
            },
          },
        })),
      removeSubtitleTrackConfig: (track) =>
        set((state) => {
          const next = { ...state.subtitleTrackConfigs };
          delete next[track];
          return { subtitleTrackConfigs: next };
        }),
      setSubtitlePresetApplied: (value) => set({ subtitlePresetApplied: value }),
      updateChapterTabState: (updates) =>
        set((state) => ({
          chapterTabState: { ...state.chapterTabState, ...updates },
        })),
      updateAttachmentTabState: (updates) =>
        set((state) => ({
          attachmentTabState: { ...state.attachmentTabState, ...updates },
        })),
      resetSession: () =>
        set({
          audioTracks: ["1"],
          activeAudioTrack: "1",
          audioTrackConfigs: { "1": { ...defaultAudioConfig } },
          audioPresetApplied: false,
          subtitleTracks: ["1"],
          activeSubtitleTrack: "1",
          subtitleTrackConfigs: { "1": { ...defaultSubtitleConfig } },
          subtitlePresetApplied: false,
          chapterTabState: { ...defaultChapterTabState },
          attachmentTabState: { ...defaultAttachmentTabState },
        }),
    }),
    {
      name: "mkv-tab-state",
      partialize: (state) => ({
        // Only persist audio/subtitle tracks and configs (not chapter/attachment - session only)
        audioTracks: state.audioTracks,
        activeAudioTrack: state.activeAudioTrack,
        audioTrackConfigs: state.audioTrackConfigs,
        audioPresetApplied: state.audioPresetApplied,
        subtitleTracks: state.subtitleTracks,
        activeSubtitleTrack: state.activeSubtitleTrack,
        subtitleTrackConfigs: state.subtitleTrackConfigs,
        subtitlePresetApplied: state.subtitlePresetApplied,
        // chapterTabState and attachmentTabState are NOT persisted (session-only)
      }),
    }
  )
);
