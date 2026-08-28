import { invoke } from "@tauri-apps/api/tauri";
import { open } from "@tauri-apps/api/dialog";
import { listen } from "@tauri-apps/api/event";
import type { OptionsData, VideoFile, ExternalFile, MuxSettings } from "@/shared/types";
import type {
  EngineStatus,
  MeasureDoneEvent,
  MeasureProgressEvent,
  MeasureResultEvent,
  MeasureStartRequest,
  TrackListing,
} from "@/shared/types/audiosync";

export interface AppPaths {
  app_data_dir: string;
  options_path: string;
  log_path: string;
}

export interface ScanRequest {
  folder: string;
  extensions: string[];
  recursive: boolean;
  include_patterns?: string[];
  exclude_patterns?: string[];
  ignore_patterns?: string[];
  type: "video" | "audio" | "subtitle" | "chapter" | "attachment";
  include_tracks: boolean;
}

export interface MuxJobRequest {
  id: string;
  video: VideoFile;
  audios: ExternalFile[];
  subtitles: ExternalFile[];
  chapters: ExternalFile[];
  attachments: ExternalFile[];
}

export interface MuxStartRequest {
  settings: MuxSettings;
  jobs: MuxJobRequest[];
}

export interface MuxPreviewPlan {
  video: string;
  output: string;
  audios: ExternalFile[];
  subtitles: ExternalFile[];
  chapters: ExternalFile[];
  attachments: ExternalFile[];
}

export interface MuxPreviewResult {
  jobId: string;
  command: string;
  warnings: string[];
  plan: MuxPreviewPlan;
}

export interface InspectRequest {
  paths: string[];
  type: "video" | "audio" | "subtitle" | "chapter" | "attachment";
  include_tracks: boolean;
}

export interface InspectStreamRequest {
  scan_id: string;
  paths: string[];
  type: "video" | "audio" | "subtitle" | "chapter" | "attachment";
  include_tracks: boolean;
  batch_size?: number;
}

export interface InspectStreamChunkEvent {
  scanId: string;
  processed: number;
  total: number;
  items: (VideoFile | ExternalFile)[];
}

export interface InspectStreamDoneEvent {
  scanId: string;
  total: number;
}

export interface InspectStreamErrorEvent {
  scanId: string;
  message: string;
}

export interface MuxProgressEvent {
  job_id: string;
  status: "queued" | "processing" | "completed" | "error" | "stopped";
  progress: number;
  message?: string;
  size_after?: number;
  error_message?: string;
}

export async function getAppPaths() {
  return invoke<AppPaths>("get_app_paths");
}

export async function loadOptions() {
  return invoke<OptionsData>("load_options");
}

export async function saveOptions(options: OptionsData) {
  return invoke<void>("save_options", { options });
}

export async function scanMedia(request: ScanRequest) {
  return invoke<(VideoFile | ExternalFile)[]>("scan_media", { request });
}

export async function inspectPaths(request: InspectRequest) {
  return invoke<(VideoFile | ExternalFile)[]>("inspect_paths", { request });
}

export async function inspectPathsStream(request: InspectStreamRequest) {
  return invoke<void>("inspect_paths_stream", { request });
}

export async function cancelScan(scanId: string) {
  return invoke<void>("cancel_scan", { scanId });
}

export async function startMuxing(request: MuxStartRequest) {
  return invoke<void>("start_muxing", { request });
}

export async function previewMux(request: MuxStartRequest) {
  return invoke<MuxPreviewResult[]>("preview_mux", { request });
}

export async function pauseMuxing() {
  return invoke<void>("pause_muxing");
}

export async function resumeMuxing() {
  return invoke<void>("resume_muxing");
}

export async function stopMuxing() {
  return invoke<void>("stop_muxing");
}

export async function openLogFile() {
  return invoke<void>("open_log_file");
}

export async function pickDirectory() {
  const result = await open({ directory: true, multiple: false });
  if (typeof result === "string") {
    return result;
  }
  return null;
}

export async function pickFiles(filters?: { name: string; extensions: string[] }[]) {
  const result = await open({ multiple: true, filters });
  if (Array.isArray(result)) {
    return result;
  }
  return [];
}

export function listenMuxProgress(handler: (payload: MuxProgressEvent) => void) {
  return listen<MuxProgressEvent>("mux-progress", (event) => handler(event.payload));
}

export function listenMuxLog(handler: (payload: { job_id: string; line: string }) => void) {
  return listen<{ job_id: string; line: string }>("mux-log", (event) => handler(event.payload));
}

export function listenInspectPathsStreamChunk(
  handler: (payload: InspectStreamChunkEvent) => void,
) {
  return listen<InspectStreamChunkEvent>("inspect-paths-stream-chunk", (event) =>
    handler(event.payload),
  );
}

export function listenInspectPathsStreamDone(
  handler: (payload: InspectStreamDoneEvent) => void,
) {
  return listen<InspectStreamDoneEvent>("inspect-paths-stream-done", (event) =>
    handler(event.payload),
  );
}

export function listenInspectPathsStreamError(
  handler: (payload: InspectStreamErrorEvent) => void,
) {
  return listen<InspectStreamErrorEvent>("inspect-paths-stream-error", (event) =>
    handler(event.payload),
  );
}

export async function audiosyncEngineStatus() {
  return invoke<EngineStatus>("audiosync_engine_status");
}

export async function listReferenceTracks(paths: string[]) {
  return invoke<{ files: TrackListing[] }>("list_reference_tracks", { paths });
}

export async function measureDelaysStart(request: MeasureStartRequest) {
  return invoke<void>("measure_delays_start", { request });
}

export async function measureDelaysCancel() {
  return invoke<void>("measure_delays_cancel");
}

export function listenMeasureDelaysProgress(handler: (payload: MeasureProgressEvent) => void) {
  return listen<MeasureProgressEvent>("measure-delays-progress", (event) =>
    handler(event.payload),
  );
}

export function listenMeasureDelaysResult(handler: (payload: MeasureResultEvent) => void) {
  return listen<MeasureResultEvent>("measure-delays-result", (event) => handler(event.payload));
}

export function listenMeasureDelaysDone(handler: (payload: MeasureDoneEvent) => void) {
  return listen<MeasureDoneEvent>("measure-delays-done", (event) => handler(event.payload));
}

export function listenAudiosyncLog(handler: (line: string) => void) {
  return listen<string>("audiosync-log", (event) => handler(event.payload));
}
