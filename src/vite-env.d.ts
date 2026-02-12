/// <reference types="vite/client" />

declare global {
  interface Window {
    __audiosAddTrack?: () => void;
    __subtitlesAddTrack?: () => void;
  }
}
