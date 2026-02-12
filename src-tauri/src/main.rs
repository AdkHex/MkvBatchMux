#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use crc32fast::Hasher;
use fs2::available_space;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs::{self, File, OpenOptions};
use std::io::{BufRead, BufReader, Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;
use std::sync::{Arc, Mutex, mpsc};
use std::sync::atomic::{AtomicU64, Ordering};
use std::thread;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Manager, State};
use walkdir::WalkDir;

#[cfg(target_os = "windows")]
const CREATE_NO_WINDOW: u32 = 0x08000000;

#[derive(Debug, Serialize, Deserialize, Clone)]
struct Preset {
    #[serde(rename = "Preset_Name")]
    preset_name: String,
    #[serde(rename = "Default_Video_Directory")]
    default_video_directory: String,
    #[serde(rename = "Default_Video_Extensions")]
    default_video_extensions: Vec<String>,
    #[serde(rename = "Default_Subtitle_Directory")]
    default_subtitle_directory: String,
    #[serde(rename = "Default_Subtitle_Extensions")]
    default_subtitle_extensions: Vec<String>,
    #[serde(rename = "Default_Subtitle_Language")]
    default_subtitle_language: String,
    #[serde(rename = "Default_Audio_Directory")]
    default_audio_directory: String,
    #[serde(rename = "Default_Audio_Extensions")]
    default_audio_extensions: Vec<String>,
    #[serde(rename = "Default_Audio_Language")]
    default_audio_language: String,
    #[serde(rename = "Default_Chapter_Directory")]
    default_chapter_directory: String,
    #[serde(rename = "Default_Chapter_Extensions")]
    default_chapter_extensions: Vec<String>,
    #[serde(rename = "Default_Attachment_Directory")]
    default_attachment_directory: String,
    #[serde(rename = "Default_Destination_Directory")]
    default_destination_directory: String,
    #[serde(rename = "Default_Favorite_Subtitle_Languages")]
    default_favorite_subtitle_languages: Vec<String>,
    #[serde(rename = "Default_Favorite_Audio_Languages")]
    default_favorite_audio_languages: Vec<String>,
}

impl Default for Preset {
    fn default() -> Self {
        Self {
            preset_name: "Preset #1".to_string(),
            default_video_directory: String::new(),
            default_video_extensions: vec!["MKV".to_string()],
            default_subtitle_directory: String::new(),
            default_subtitle_extensions: vec!["ASS".to_string()],
            default_subtitle_language: "English".to_string(),
            default_audio_directory: String::new(),
            default_audio_extensions: vec!["AAC".to_string()],
            default_audio_language: "English".to_string(),
            default_chapter_directory: String::new(),
            default_chapter_extensions: vec!["XML".to_string()],
            default_attachment_directory: String::new(),
            default_destination_directory: String::new(),
            default_favorite_subtitle_languages: vec!["English".to_string(), "Arabic".to_string()],
            default_favorite_audio_languages: vec!["English".to_string(), "Arabic".to_string()],
        }
    }
}

#[derive(Debug, Serialize, Deserialize, Clone)]
struct OptionsData {
    #[serde(rename = "Presets")]
    presets: Vec<Preset>,
    #[serde(rename = "FavoritePresetId")]
    favorite_preset_id: usize,
    #[serde(rename = "Dark_Mode")]
    dark_mode: bool,
    #[serde(rename = "Attachment_Expert_Mode_Info_Message_Show")]
    attachment_expert_mode_info_message_show: bool,
    #[serde(rename = "Choose_Preset_On_Startup")]
    choose_preset_on_startup: bool,
}

impl Default for OptionsData {
    fn default() -> Self {
        Self {
            presets: vec![Preset::default()],
            favorite_preset_id: 0,
            dark_mode: false,
            attachment_expert_mode_info_message_show: true,
            choose_preset_on_startup: false,
        }
    }
}

#[derive(Debug, Serialize, Deserialize, Clone)]
struct TrackInfo {
    id: String,
    #[serde(rename = "type")]
    track_type: String,
    codec: Option<String>,
    language: Option<String>,
    name: Option<String>,
    #[serde(rename = "isDefault")]
    is_default: Option<bool>,
    #[serde(rename = "isForced")]
    is_forced: Option<bool>,
    bitrate: Option<u64>, // Bitrate in bits per second
    action: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
struct VideoFileInfo {
    id: String,
    name: String,
    path: String,
    size: u64,
    duration: Option<String>,
    fps: Option<f64>,
    status: String,
    tracks: Vec<TrackInfo>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
struct ExternalFileInfo {
    id: String,
    name: String,
    path: String,
    #[serde(rename = "type")]
    file_type: String,
    #[serde(rename = "source")]
    source: Option<String>,
    language: Option<String>,
    #[serde(rename = "trackName")]
    track_name: Option<String>,
    delay: Option<f64>,
    #[serde(rename = "isDefault")]
    is_default: Option<bool>,
    #[serde(rename = "isForced")]
    is_forced: Option<bool>,
    #[serde(rename = "muxAfter")]
    mux_after: Option<String>,
    #[serde(rename = "matchedVideoId")]
    matched_video_id: Option<String>,
    size: Option<u64>,
    bitrate: Option<u64>,
    duration: Option<String>,
    #[serde(rename = "trackId")]
    track_id: Option<u64>,
    #[serde(default)]
    tracks: Vec<TrackInfo>,
    #[serde(rename = "includedTrackIds", default)]
    included_track_ids: Option<Vec<u64>>,
    #[serde(rename = "includeSubtitles")]
    include_subtitles: Option<bool>,
    #[serde(rename = "includedSubtitleTrackIds", default)]
    included_subtitle_track_ids: Option<Vec<u64>>,
    #[serde(rename = "trackOverrides", default)]
    track_overrides: HashMap<String, TrackOverride>,
    #[serde(skip)]
    apply_language: bool,
}

#[derive(Debug, Serialize, Deserialize, Clone, Default)]
struct TrackOverride {
    language: Option<String>,
    delay: Option<f64>,
    #[serde(rename = "trackName")]
    track_name: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
struct ScanRequest {
    folder: String,
    extensions: Vec<String>,
    recursive: bool,
    #[serde(rename = "type")]
    file_type: String,
    include_tracks: bool,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
struct InspectRequest {
    paths: Vec<String>,
    #[serde(rename = "type")]
    file_type: String,
    include_tracks: bool,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct MuxSettings {
    destination_dir: String,
    overwrite_source: bool,
    add_crc: bool,
    remove_old_crc: bool,
    keep_log_file: bool,
    abort_on_errors: bool,
    max_parallel_jobs: Option<usize>,
    only_keep_audios_enabled: bool,
    only_keep_subtitles_enabled: bool,
    only_keep_audio_languages: Vec<String>,
    only_keep_subtitle_languages: Vec<String>,
    discard_old_chapters: bool,
    discard_old_attachments: bool,
    allow_duplicate_attachments: bool,
    attachments_expert_mode: bool,
    remove_global_tags: bool,
    make_audio_default_language: Option<String>,
    make_subtitle_default_language: Option<String>,
    use_mkvpropedit: bool,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
struct MuxJobRequest {
    id: String,
    video: VideoFileInfo,
    audios: Vec<ExternalFileInfo>,
    subtitles: Vec<ExternalFileInfo>,
    chapters: Vec<ExternalFileInfo>,
    attachments: Vec<ExternalFileInfo>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
struct MuxStartRequest {
    settings: MuxSettings,
    jobs: Vec<MuxJobRequest>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct MuxPreviewPlan {
    video: String,
    output: String,
    audios: Vec<ExternalFileInfo>,
    subtitles: Vec<ExternalFileInfo>,
    chapters: Vec<ExternalFileInfo>,
    attachments: Vec<ExternalFileInfo>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct MuxPreviewResult {
    job_id: String,
    command: String,
    warnings: Vec<String>,
    plan: MuxPreviewPlan,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
struct MuxProgressEvent {
    job_id: String,
    status: String,
    progress: u8,
    message: Option<String>,
    size_after: Option<u64>,
    error_message: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
struct AppPaths {
    app_data_dir: PathBuf,
    options_path: PathBuf,
    log_path: PathBuf,
}

#[derive(Debug)]
struct MuxState {
    running: bool,
    pause: bool,
    stop: bool,
    queue: Vec<MuxJobRequest>,
    settings: Option<MuxSettings>,
    children: HashMap<String, Arc<Mutex<Child>>>,
}

#[derive(Clone)]
struct AppState {
    paths: AppPaths,
    mux_state: Arc<Mutex<MuxState>>,
}

impl Default for MuxState {
    fn default() -> Self {
        Self {
            running: false,
            pause: false,
            stop: false,
            queue: Vec::new(),
            settings: None,
            children: HashMap::new(),
        }
    }
}

fn ensure_dir(path: &Path) -> Result<(), String> {
    fs::create_dir_all(path).map_err(|e| format!("Failed to create directory: {e}"))
}

fn read_options(path: &Path) -> Result<OptionsData, String> {
    if path.exists() {
        let content = fs::read_to_string(path).map_err(|e| format!("Failed to read options: {e}"))?;
        serde_json::from_str(&content).map_err(|e| format!("Failed to parse options JSON: {e}"))
    } else {
        Ok(OptionsData::default())
    }
}

fn write_options(path: &Path, options: &OptionsData) -> Result<(), String> {
    let content = serde_json::to_string_pretty(options).map_err(|e| format!("Failed to encode options: {e}"))?;
    fs::write(path, content).map_err(|e| format!("Failed to write options: {e}"))
}

fn normalize_extension_list(extensions: &[String]) -> Vec<String> {
    extensions
        .iter()
        .map(|ext| ext.trim_start_matches('.').to_ascii_lowercase())
        .filter(|ext| !ext.is_empty())
        .collect()
}

fn should_include_file(path: &Path, allowed_extensions: &[String]) -> bool {
    if allowed_extensions.is_empty() || allowed_extensions.iter().any(|ext| ext == "all") {
        return true;
    }
    path.extension()
        .and_then(|ext| ext.to_str())
        .map(|ext| allowed_extensions.contains(&ext.to_ascii_lowercase()))
        .unwrap_or(false)
}

fn hidden_command(program: &str) -> Command {
    #[cfg(target_os = "windows")]
    {
        let mut command = Command::new(program);
        command.creation_flags(CREATE_NO_WINDOW);
        return command;
    }

    #[cfg(not(target_os = "windows"))]
    {
        Command::new(program)
    }
}

fn mediainfo_available() -> bool {
    hidden_command("mediainfo")
        .arg("--Version")
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .map(|status| status.success())
        .unwrap_or(false)
}

fn tool_available(tool: &str, version_arg: &str) -> bool {
    hidden_command(tool)
        .arg(version_arg)
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .map(|status| status.success())
        .unwrap_or(false)
}

fn get_mkvmerge_info(path: &Path) -> Option<serde_json::Value> {
    if !tool_available("mkvmerge", "-V") {
        return None;
    }
    let output = hidden_command("mkvmerge")
        .arg("-J")
        .arg(path)
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    serde_json::from_slice(&output.stdout).ok()
}

fn parse_mkvmerge_duration(mkvmerge: &serde_json::Value) -> Option<String> {
    let duration = mkvmerge
        .get("container")?
        .get("properties")?
        .get("duration")?;
    // mkvmerge ALWAYS returns duration in nanoseconds as a u64 integer
    // Convert to seconds for display
    let nanoseconds = if let Some(value) = duration.as_u64() {
        value as f64
    } else if let Some(value) = duration.as_i64() {
        value as f64
    } else if let Some(value) = duration.as_f64() {
        // If it's a float, check if it's already in seconds or nanoseconds
        // mkvmerge typically uses u64, but handle float case
        if value > 1_000_000_000.0 {
            value // Already in nanoseconds
        } else {
            value * 1_000_000_000.0 // Convert seconds to nanoseconds
        }
    } else if let Some(value) = duration.as_str() {
        // Parse string - mkvmerge always uses nanoseconds
        value.parse::<f64>().ok()?
    } else {
        return None;
    };
    
    // Convert nanoseconds to seconds
    let seconds = nanoseconds / 1_000_000_000.0;
    
    // Ensure seconds is reasonable (not negative, not more than 24 hours for most videos)
    if seconds < 0.0 || !seconds.is_finite() || seconds > 86400.0 * 365.0 {
        return None;
    }
    
    let total_seconds = seconds.round() as u64;
    let hours = total_seconds / 3600;
    let minutes = (total_seconds % 3600) / 60;
    let secs = total_seconds % 60;
    Some(format!("{:02}:{:02}:{:02}", hours, minutes, secs))
}

fn parse_mkvmerge_tracks(mkvmerge: &serde_json::Value) -> Vec<TrackInfo> {
    let mut tracks = Vec::new();
    let Some(track_items) = mkvmerge.get("tracks").and_then(|t| t.as_array()) else {
        return tracks;
    };
    for track in track_items {
        let track_type = track.get("type").and_then(|t| t.as_str()).unwrap_or("unknown");
        let mapped_type = match track_type {
            "video" => "video",
            "audio" => "audio",
            "subtitles" => "subtitle",
            _ => "unknown",
        };
        if mapped_type == "unknown" {
            continue;
        }
        let track_id = track
            .get("id")
            .map(|value| value.to_string())
            .unwrap_or_else(|| "0".to_string());
        let codec = track.get("codec").and_then(|v| v.as_str()).map(|s| s.to_string());
        let properties = track.get("properties");
        let language = properties
            .and_then(|p| p.get("language"))
            .and_then(|v| v.as_str())
            .map(|s| s.to_string());
        let name = properties
            .and_then(|p| p.get("track_name"))
            .and_then(|v| v.as_str())
            .map(|s| s.to_string());
        let is_default = properties
            .and_then(|p| p.get("default_track"))
            .and_then(|v| v.as_bool());
        let is_forced = properties
            .and_then(|p| p.get("forced_track"))
            .and_then(|v| v.as_bool());
        
        // Extract bitrate (in bits per second) - mkvmerge may use different field names
        // Try multiple possible field names: bit_rate, tag_bps, or calculate from properties
        let bitrate = properties.and_then(|p| {
            // First try bit_rate (most common)
            if let Some(v) = p.get("bit_rate") {
                if let Some(value) = v.as_u64() {
                    return Some(value);
                } else if let Some(value) = v.as_f64() {
                    return Some(value as u64);
                } else if let Some(value) = v.as_str() {
                    if let Ok(parsed) = value.parse::<u64>() {
                        return Some(parsed);
                    }
                }
            }
            // Try tag_bps (sometimes used for audio tracks)
            if let Some(v) = p.get("tag_bps") {
                if let Some(value) = v.as_u64() {
                    return Some(value);
                } else if let Some(value) = v.as_f64() {
                    return Some(value as u64);
                } else if let Some(value) = v.as_str() {
                    if let Ok(parsed) = value.parse::<u64>() {
                        return Some(parsed);
                    }
                }
            }
            // For audio tracks, try calculating from audio properties if available
            if mapped_type == "audio" {
                let bits_per_sample = p.get("audio_bits_per_sample")
                    .and_then(|v| v.as_u64())
                    .unwrap_or(16);
                let sample_rate = p.get("audio_sampling_frequency")
                    .and_then(|v| v.as_u64())
                    .or_else(|| p.get("audio_sampling_frequency").and_then(|v| v.as_f64()).map(|f| f as u64));
                let channels = p.get("audio_channels")
                    .and_then(|v| v.as_u64());
                
                if let (Some(sr), Some(ch)) = (sample_rate, channels) {
                    // Calculate raw PCM bitrate (not compressed, but gives an estimate)
                    return Some(bits_per_sample * sr * ch);
                }
            }
            None
        });

        tracks.push(TrackInfo {
            id: track_id,
            track_type: mapped_type.to_string(),
            codec,
            language,
            name,
            is_default,
            is_forced,
            bitrate,
            action: Some("keep".to_string()),
        });
    }
    tracks
}

fn get_mediainfo(path: &Path) -> Option<serde_json::Value> {
    if !mediainfo_available() {
        return None;
    }
    let output = hidden_command("mediainfo")
        .arg("--Output=JSON")
        .arg(path)
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    serde_json::from_slice(&output.stdout).ok()
}

fn parse_duration(mediainfo: &serde_json::Value) -> Option<String> {
    let tracks = mediainfo.get("media")?.get("track")?.as_array()?;
    for track in tracks {
        if track.get("@type")?.as_str()? == "General" {
            if let Some(duration) = track.get("Duration") {
                // mediainfo JSON output returns duration in seconds as a string (e.g., "7749.320")
                let duration_str = duration.as_str()?;
                
                // First try parsing as seconds (most common for mediainfo JSON)
                if let Ok(seconds) = duration_str.trim().parse::<f64>() {
                    let total_seconds = seconds.round() as u64;
                    let hours = total_seconds / 3600;
                    let minutes = (total_seconds % 3600) / 60;
                    let secs = total_seconds % 60;
                    return Some(format!("{:02}:{:02}:{:02}", hours, minutes, secs));
                }
                
                // Try parsing as HH:MM:SS.mmm format
                if duration_str.contains(':') {
                    let parts: Vec<&str> = duration_str.split(':').collect();
                    if parts.len() >= 3 {
                        if let (Ok(h), Ok(m), Ok(s)) = (
                            parts[0].parse::<u64>(),
                            parts[1].parse::<u64>(),
                            parts[2].split('.').next().unwrap_or("0").parse::<u64>(),
                        ) {
                            return Some(format!("{:02}:{:02}:{:02}", h, m, s));
                        }
                    }
                }
            }
        }
    }
    None
}

fn parse_video_fps(mediainfo: &serde_json::Value) -> Option<f64> {
    let tracks = mediainfo.get("media")?.get("track")?.as_array()?;
    for track in tracks {
        if track.get("@type")?.as_str()? == "Video" {
            let value = track
                .get("FrameRate")
                .or_else(|| track.get("FrameRate_Original"))
                .or_else(|| track.get("FrameRate_Nominal"));
            if let Some(v) = value.and_then(|v| v.as_str()) {
                let cleaned: String = v.chars().filter(|c| c.is_ascii_digit() || *c == '.').collect();
                if let Ok(parsed) = cleaned.parse::<f64>() {
                    return Some(parsed);
                }
            } else if let Some(v) = value.and_then(|v| v.as_f64()) {
                return Some(v);
            } else if let Some(v) = value.and_then(|v| v.as_u64()) {
                return Some(v as f64);
            }
        }
    }
    None
}


fn parse_bitrate_value(value: &serde_json::Value) -> Option<u64> {
    if let Some(v) = value.as_u64() {
        return Some(v);
    }
    if let Some(v) = value.as_f64() {
        return Some(v as u64);
    }
    if let Some(v) = value.as_str() {
        // Strip non-digits (e.g., "3 455 kb/s" -> "3455")
        let digits: String = v.chars().filter(|c| c.is_ascii_digit()).collect();
        if !digits.is_empty() {
            if let Ok(parsed) = digits.parse::<u64>() {
                // If mediainfo already returns bits per second, keep as-is.
                // If it returns kbps, it will be a small number; normalize to bps.
                if parsed < 10_000 {
                    return Some(parsed * 1000);
                }
                return Some(parsed);
            }
        }
    }
    None
}

fn parse_tracks(mediainfo: &serde_json::Value) -> Vec<TrackInfo> {
    let mut tracks = Vec::new();
    let Some(track_items) = mediainfo.get("media").and_then(|m| m.get("track")).and_then(|t| t.as_array()) else {
        return tracks;
    };

    for (index, track) in track_items.iter().enumerate() {
        let track_type = track
            .get("@type")
            .and_then(|t| t.as_str())
            .unwrap_or("Unknown");
        let mapped_type = match track_type {
            "Video" => "video",
            "Audio" => "audio",
            "Text" => "subtitle",
            "Menu" => "chapter",
            _ => "unknown",
        };
        if mapped_type == "unknown" {
            continue;
        }
        let codec = track.get("Format").and_then(|v| v.as_str()).map(|s| s.to_string());
        let language = track.get("Language").and_then(|v| v.as_str()).map(|s| s.to_string());
        let name = track.get("Title").and_then(|v| v.as_str()).map(|s| s.to_string());
        let is_default = track
            .get("Default")
            .and_then(|v| v.as_str())
            .map(|v| v.eq_ignore_ascii_case("Yes"));
        let is_forced = track
            .get("Forced")
            .and_then(|v| v.as_str())
            .map(|v| v.eq_ignore_ascii_case("Yes"));
        
        // Extract bitrate from mediainfo (in bits per second)
        // mediainfo can provide bitrate as "BitRate" or "BitRate_Mode" + "BitRate"
        let bitrate = track
            .get("BitRate")
            .and_then(parse_bitrate_value)
            .or_else(|| track.get("BitRate_Maximum").and_then(parse_bitrate_value));

        tracks.push(TrackInfo {
            id: (index + 1).to_string(),
            track_type: mapped_type.to_string(),
            codec,
            language,
            name,
            is_default,
            is_forced,
            bitrate,
            action: Some("keep".to_string()),
        });
    }

    tracks
}

fn parse_external_track_id(mediainfo: &serde_json::Value, track_type: &str) -> Option<u64> {
    let tracks = mediainfo.get("media")?.get("track")?.as_array()?;
    for track in tracks {
        if track.get("@type")?.as_str()? != track_type {
            continue;
        }
        if let Some(id_val) = track.get("ID") {
            if let Some(v) = id_val.as_u64() {
                if v > 0 {
                    return Some(v);
                }
            }
            if let Some(v) = id_val.as_f64() {
                let parsed = v as u64;
                if parsed > 0 {
                    return Some(parsed);
                }
            }
            if let Some(v) = id_val.as_str() {
                let digits: String = v.chars().filter(|c| c.is_ascii_digit()).collect();
                if let Ok(parsed) = digits.parse::<u64>() {
                    if parsed > 0 {
                        return Some(parsed);
                    }
                }
            }
        }
    }
    None
}

fn parse_external_track_id_mkvmerge(mkvmerge: &serde_json::Value, track_type: &str) -> Option<u64> {
    let tracks = mkvmerge.get("tracks")?.as_array()?;
    for track in tracks {
        let mkv_type = track.get("type")?.as_str()?;
        let mapped = match mkv_type {
            "audio" => "Audio",
            "subtitles" => "Text",
            "video" => "Video",
            _ => "Unknown",
        };
        if mapped != track_type {
            continue;
        }
        if let Some(id_val) = track.get("id") {
            if let Some(v) = id_val.as_u64() {
                return Some(v);
            }
            if let Some(v) = id_val.as_i64() {
                return Some(v as u64);
            }
            if let Some(v) = id_val.as_str() {
                let digits: String = v.chars().filter(|c| c.is_ascii_digit()).collect();
                if let Ok(parsed) = digits.parse::<u64>() {
                    return Some(parsed);
                }
            }
        }
    }
    None
}

fn parse_external_track_ids_mkvmerge(mkvmerge: &serde_json::Value, track_type: &str) -> Vec<u64> {
    let mut ids = Vec::new();
    let Some(tracks) = mkvmerge.get("tracks").and_then(|v| v.as_array()) else {
        return ids;
    };
    for track in tracks {
        let mkv_type = match track.get("type").and_then(|v| v.as_str()) {
            Some(value) => value,
            None => continue,
        };
        let mapped = match mkv_type {
            "audio" => "Audio",
            "subtitles" => "Text",
            "video" => "Video",
            _ => "Unknown",
        };
        if mapped != track_type {
            continue;
        }
        let id = track.get("id").and_then(|id_val| {
            if let Some(v) = id_val.as_u64() {
                return Some(v);
            }
            if let Some(v) = id_val.as_i64() {
                return Some(v as u64);
            }
            if let Some(v) = id_val.as_str() {
                let digits: String = v.chars().filter(|c| c.is_ascii_digit()).collect();
                if let Ok(parsed) = digits.parse::<u64>() {
                    return Some(parsed);
                }
            }
            None
        });
        if let Some(id) = id {
            ids.push(id);
        }
    }
    ids
}

fn generate_id(prefix: &str) -> String {
    static COUNTER: AtomicU64 = AtomicU64::new(0);
    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or(Duration::from_secs(0))
        .as_millis();
    let counter = COUNTER.fetch_add(1, Ordering::Relaxed);
    format!("{}-{}-{}", prefix, timestamp, counter)
}

fn scan_files(request: &ScanRequest) -> Result<Vec<PathBuf>, String> {
    let mut results = Vec::new();
    let allowed_extensions = normalize_extension_list(&request.extensions);
    let walker = WalkDir::new(&request.folder)
        .follow_links(true)
        .max_depth(if request.recursive { usize::MAX } else { 1 });

    for entry in walker.into_iter().filter_map(|e| e.ok()) {
        let path = entry.path();
        if path.is_file() && should_include_file(path, &allowed_extensions) {
            results.push(path.to_path_buf());
        }
    }

    Ok(results)
}

fn build_file_info(path: &Path, file_type: &str, include_tracks: bool) -> Result<serde_json::Value, String> {
    // Safely get file metadata - return error if file doesn't exist or can't be read
    let metadata = fs::metadata(path).map_err(|e| format!("Failed to read metadata for {:?}: {e}", path))?;
    let size = metadata.len();
    
    // Safely extract file name - use a fallback if name can't be determined
    let name = path
        .file_name()
        .and_then(|n| n.to_str())
        .map(|s| s.to_string())
        .unwrap_or_else(|| {
            // Fallback: use the full path as name if filename extraction fails
            path.to_string_lossy().to_string()
        });
    
    let full_path = path.to_string_lossy().to_string();
    let id = generate_id(file_type);

    if file_type == "video" {
        let mkvmerge_info = get_mkvmerge_info(path);
        // Always try to get mediainfo for supplementary data (like bitrate)
        let mediainfo = get_mediainfo(path);
        let duration = mkvmerge_info
            .as_ref()
            .and_then(parse_mkvmerge_duration)
            .or_else(|| mediainfo.as_ref().and_then(parse_duration));
        let fps = mediainfo.as_ref().and_then(parse_video_fps);
        let mut tracks = if include_tracks {
            if let Some(info) = mkvmerge_info.as_ref() {
                parse_mkvmerge_tracks(info)
            } else {
                mediainfo.as_ref().map(parse_tracks).unwrap_or_default()
            }
        } else {
            Vec::new()
        };
        
        // If we have mediainfo, supplement missing bitrate data for audio tracks
        if let Some(mi) = mediainfo.as_ref() {
            let mi_tracks = parse_tracks(mi);
            let mi_audio_tracks: Vec<_> = mi_tracks.iter()
                .filter(|t| t.track_type == "audio")
                .collect();
            
            // Build a list of audio track IDs first to avoid borrow conflicts
            let audio_track_ids: Vec<String> = tracks.iter()
                .filter(|t| t.track_type == "audio")
                .map(|t| t.id.clone())
                .collect();
            
            // Prefer mediainfo bitrate for audio tracks (more accurate for VBR)
            for track in tracks.iter_mut() {
                if track.track_type == "audio" {
                    if let Some(idx) = audio_track_ids.iter().position(|id| id == &track.id) {
                        if let Some(mi_track) = mi_audio_tracks.get(idx) {
                            if mi_track.bitrate.is_some() {
                                track.bitrate = mi_track.bitrate;
                            }
                        }
                    }
                }
            }
        }
        
        let video = VideoFileInfo {
            id,
            name,
            path: full_path,
            size,
            duration,
            fps,
            status: "pending".to_string(),
            tracks,
        };
        serde_json::to_value(video).map_err(|e| format!("Serialize error: {e}"))
    } else {
        // For non-video files (chapter, attachment, audio, subtitle)
        // Ensure file_type is valid and matches expected values
        let normalized_file_type = match file_type {
            "chapter" | "attachment" | "audio" | "subtitle" => file_type.to_string(),
            _ => {
                // If file_type is unexpected, default based on file extension or use provided type
                // This prevents crashes from invalid file_type values
                eprintln!("Warning: Unexpected file_type '{}' for file {:?}, using as-is", file_type, path);
                file_type.to_string()
            }
        };
        
        let mkvmerge_info = if normalized_file_type == "audio" || normalized_file_type == "subtitle" {
            get_mkvmerge_info(path)
        } else {
            None
        };
        let mediainfo = if normalized_file_type == "audio" || normalized_file_type == "subtitle" {
            get_mediainfo(path)
        } else {
            None
        };
        let (bitrate, duration, track_id) = if let Some(mi) = mediainfo.as_ref() {
            let tracks = parse_tracks(mi);
            let audio_track = tracks.iter().find(|t| t.track_type == "audio");
            let bitrate = audio_track.and_then(|t| t.bitrate);
            let duration = parse_duration(mi);
            let track_id = if normalized_file_type == "audio" {
                mkvmerge_info
                    .as_ref()
                    .and_then(|mkv| parse_external_track_id_mkvmerge(mkv, "Audio"))
                    .or_else(|| parse_external_track_id(mi, "Audio"))
            } else {
                mkvmerge_info
                    .as_ref()
                    .and_then(|mkv| parse_external_track_id_mkvmerge(mkv, "Text"))
                    .or_else(|| parse_external_track_id(mi, "Text"))
            };
            let track_id = track_id.filter(|id| *id > 0);
            (bitrate, duration, track_id)
        } else {
            let track_id = if normalized_file_type == "audio" {
                mkvmerge_info
                    .as_ref()
                    .and_then(|mkv| parse_external_track_id_mkvmerge(mkv, "Audio"))
            } else {
                mkvmerge_info
                    .as_ref()
                    .and_then(|mkv| parse_external_track_id_mkvmerge(mkv, "Text"))
            };
            let track_id = track_id.filter(|id| *id > 0);
            (None, None, track_id)
        };

        let mut tracks = if include_tracks {
            if let Some(info) = mkvmerge_info.as_ref() {
                parse_mkvmerge_tracks(info)
            } else if let Some(mi) = mediainfo.as_ref() {
                parse_tracks(mi)
            } else {
                Vec::new()
            }
        } else {
            Vec::new()
        };

        if normalized_file_type == "audio" {
            tracks.retain(|t| t.track_type == "audio" || t.track_type == "subtitle");
        } else if normalized_file_type == "subtitle" {
            tracks.retain(|t| t.track_type == "subtitle");
        }

        let external = ExternalFileInfo {
            id,
            name,
            path: full_path,
            file_type: normalized_file_type,
            source: None,
            language: None,
            track_name: None,
            delay: None,
            is_default: None,
            is_forced: None,
            mux_after: None,
            matched_video_id: None,
            size: Some(size),
            bitrate,
            duration,
            track_id,
            tracks,
            included_track_ids: None,
            include_subtitles: None,
            included_subtitle_track_ids: None,
            track_overrides: HashMap::new(),
            apply_language: true,
        };
        serde_json::to_value(external).map_err(|e| format!("Serialize error for {:?}: {e}", path))
    }
}

#[tauri::command]
fn get_app_paths(state: State<AppState>) -> Result<AppPaths, String> {
    Ok(state.paths.clone())
}

#[tauri::command]
fn load_options(state: State<AppState>) -> Result<OptionsData, String> {
    let options = read_options(&state.paths.options_path)?;
    write_options(&state.paths.options_path, &options)?;
    Ok(options)
}

#[tauri::command]
fn save_options(state: State<AppState>, options: OptionsData) -> Result<(), String> {
    write_options(&state.paths.options_path, &options)
}

#[tauri::command]
fn scan_media(request: ScanRequest) -> Result<Vec<serde_json::Value>, String> {
    let files = scan_files(&request)?;
    let mut results = Vec::new();

    for path in files {
        match build_file_info(&path, &request.file_type, request.include_tracks) {
            Ok(file_info) => results.push(file_info),
            Err(e) => {
                // Log error but continue processing other files
                eprintln!("Failed to process file {:?}: {}", path, e);
                // Optionally, you could add a log entry here if logging is set up
            }
        }
    }

    Ok(results)
}

#[tauri::command]
fn inspect_paths(request: InspectRequest) -> Result<Vec<serde_json::Value>, String> {
    let mut results = Vec::new();
    for path_str in request.paths {
        let path = PathBuf::from(path_str);
        if path.is_file() {
            match build_file_info(&path, &request.file_type, request.include_tracks) {
                Ok(file_info) => results.push(file_info),
                Err(e) => {
                    // Log error but continue processing other files
                    eprintln!("Failed to inspect file {:?}: {}", path, e);
                    // Optionally, you could add a log entry here if logging is set up
                }
            }
        }
    }
    Ok(results)
}

fn write_log_line(paths: &AppPaths, line: &str) -> Result<(), String> {
    let mut file = OpenOptions::new()
        .create(true)
        .append(true)
        .open(&paths.log_path)
        .map_err(|e| format!("Failed to open log file: {e}"))?;
    writeln!(file, "{line}").map_err(|e| format!("Failed to write log: {e}"))
}

fn clear_log(paths: &AppPaths) -> Result<(), String> {
    File::create(&paths.log_path).map_err(|e| format!("Failed to create log file: {e}"))?;
    Ok(())
}

fn get_output_paths(job: &MuxJobRequest, settings: &MuxSettings) -> (PathBuf, PathBuf, bool) {
    let video_path = PathBuf::from(&job.video.path);
    let source_dir = video_path.parent().unwrap_or(Path::new(".")).to_path_buf();
    let output_dir = if settings.destination_dir.trim().is_empty() {
        source_dir.clone()
    } else {
        PathBuf::from(&settings.destination_dir)
    };
    let file_stem = video_path.file_stem().and_then(|s| s.to_str()).unwrap_or("output");
    let overwrite_mode = settings.destination_dir.trim().is_empty() || settings.overwrite_source;

    if overwrite_mode {
        let suffix = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or(Duration::from_secs(0))
            .as_secs();
        let temp_name = format!("{}#{}{}.mkv", file_stem, suffix, "");
        let output_path = output_dir.join(temp_name);
        let final_path = output_dir.join(format!("{}.mkv", file_stem));
        (output_path, final_path, true)
    } else {
        let output_path = output_dir.join(format!("{}.mkv", file_stem));
        (output_path.clone(), output_path, false)
    }
}

fn compute_crc(path: &Path) -> Result<String, String> {
    let mut file = File::open(path).map_err(|e| format!("Failed to open file for CRC: {e}"))?;
    let mut hasher = Hasher::new();
    let mut buffer = [0u8; 8192];
    loop {
        let read = file.read(&mut buffer).map_err(|e| format!("Failed to read file: {e}"))?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
    }
    Ok(format!("{:08X}", hasher.finalize()))
}

fn file_name_with_crc(path: &Path, crc: &str) -> PathBuf {
    let file_name = path.file_name().and_then(|n| n.to_str()).unwrap_or("output.mkv");
    let file_stem = file_name.trim_end_matches(".mkv");
    path.with_file_name(format!("{} [{}].mkv", file_stem, crc))
}

fn file_name_without_crc(path: &Path) -> PathBuf {
    let file_name = path.file_name().and_then(|n| n.to_str()).unwrap_or("output.mkv");
    let cleaned = file_name.replace(".mkv", "");
    let sanitized = if let Some(index) = cleaned.rfind('[') {
        cleaned[..index].trim().to_string()
    } else {
        cleaned
    };
    path.with_file_name(format!("{}.mkv", sanitized))
}

fn check_free_space(path: &Path, required_bytes: u64) -> Result<(), String> {
    let available = available_space(path).map_err(|e| format!("Failed to read free space: {e}"))?;
    if available < required_bytes {
        return Err(format!("Not enough free space. Required: {} bytes", required_bytes));
    }
    Ok(())
}

fn collect_track_ids_by_language(tracks: &[TrackInfo], track_type: &str, languages: &[String]) -> Vec<usize> {
    let mut ids = Vec::new();
    for (index, track) in tracks.iter().enumerate() {
        if track.track_type != track_type {
            continue;
        }
        if let Some(language) = &track.language {
            if languages.iter().any(|lang| lang.eq_ignore_ascii_case(language)) {
                if let Ok(parsed) = track.id.parse::<usize>() {
                    ids.push(parsed);
                } else {
                    ids.push(index);
                }
            }
        }
    }
    ids
}

fn parse_track_id(track: &TrackInfo, index: usize) -> usize {
    track.id.parse::<usize>().unwrap_or(index)
}

fn is_track_removed(track: &TrackInfo) -> bool {
    matches!(track.action.as_deref(), Some("remove"))
}

fn collect_track_ids_by_action(tracks: &[TrackInfo], track_type: &str) -> (Vec<usize>, bool) {
    let mut ids = Vec::new();
    let mut has_removed = false;
    for (index, track) in tracks.iter().enumerate() {
        if track.track_type != track_type {
            continue;
        }
        if is_track_removed(track) {
            has_removed = true;
            continue;
        }
        ids.push(parse_track_id(track, index));
    }
    (ids, has_removed)
}

fn intersect_ids(left: Vec<usize>, right: Vec<usize>) -> Vec<usize> {
    left.into_iter().filter(|id| right.contains(id)).collect()
}

fn apply_track_selection(
    args: &mut Vec<String>,
    tracks: &[TrackInfo],
    track_type: &str,
    only_keep_ids: Option<Vec<usize>>,
) {
    let (action_ids, has_removed) = collect_track_ids_by_action(tracks, track_type);
    let type_ids: Vec<usize> = tracks
        .iter()
        .enumerate()
        .filter(|(_, track)| track.track_type == track_type)
        .map(|(index, track)| parse_track_id(track, index))
        .collect();

    if type_ids.is_empty() {
        return;
    }

    let mut selected = if has_removed {
        action_ids
    } else {
        type_ids.clone()
    };

    if let Some(ref keep) = only_keep_ids {
        selected = intersect_ids(selected, keep.clone());
    }

    if selected.len() == type_ids.len() && !has_removed && only_keep_ids.is_none() {
        return;
    }

    if selected.is_empty() {
        match track_type {
            "audio" => args.push("--no-audio".to_string()),
            "subtitle" => args.push("--no-subtitles".to_string()),
            "video" => args.push("--no-video".to_string()),
            _ => {}
        }
        return;
    }

    let flag = match track_type {
        "audio" => "--audio-tracks",
        "subtitle" => "--subtitle-tracks",
        "video" => "--video-tracks",
        _ => return,
    };
    args.push(flag.to_string());
    args.push(selected.iter().map(|id| id.to_string()).collect::<Vec<_>>().join(","));
}

fn build_mkvpropedit_args(job: &MuxJobRequest) -> Vec<String> {
    let mut args = Vec::new();
    
    // Apply track modifications: name, language, default, forced flags
    // For Fast Mux, we apply edits for all tracks that have any properties set
    for (index, track) in job.video.tracks.iter().enumerate() {
        if is_track_removed(track) {
            continue;
        }
        
        // mkvpropedit uses 1-based track IDs, so add 1 to the parsed track ID
        let track_id = parse_track_id(track, index) + 1;
        
        // Track name - apply if set (even if empty, to clear it)
        if let Some(name) = &track.name {
            args.push("--edit".to_string());
            args.push(format!("track:{}", track_id));
            args.push("--set".to_string());
            args.push(format!("name={}", name.trim()));
        }
        
        // Language - apply if set
        if let Some(language) = &track.language {
            args.push("--edit".to_string());
            args.push(format!("track:{}", track_id));
            args.push("--set".to_string());
            args.push(format!("language={}", language));
        }
        
        // Default flag - apply if explicitly set (Some(true) or Some(false))
        if let Some(is_default) = track.is_default {
            args.push("--edit".to_string());
            args.push(format!("track:{}", track_id));
            args.push("--set".to_string());
            args.push(format!("flag-default={}", if is_default { "1" } else { "0" }));
        }
        
        // Forced flag (for subtitles, use flag-forced-display)
        if track.track_type == "subtitle" {
            if let Some(is_forced) = track.is_forced {
                args.push("--edit".to_string());
                args.push(format!("track:{}", track_id));
                args.push("--set".to_string());
                args.push(format!("flag-forced-display={}", if is_forced { "1" } else { "0" }));
            }
        } else if track.track_type == "audio" || track.track_type == "video" {
            if let Some(is_forced) = track.is_forced {
                args.push("--edit".to_string());
                args.push(format!("track:{}", track_id));
                args.push("--set".to_string());
                args.push(format!("flag-forced={}", if is_forced { "1" } else { "0" }));
            }
        }
    }
    
    args
}

fn quote_arg(arg: &str) -> String {
    if arg.contains(' ') || arg.contains('"') || arg.contains('\'') {
        format!("\"{}\"", arg.replace('"', "\\\""))
    } else {
        arg.to_string()
    }
}

fn join_mkvmerge_command(args: &[String]) -> String {
    let mut parts = Vec::with_capacity(args.len() + 1);
    parts.push("mkvmerge".to_string());
    for arg in args {
        parts.push(quote_arg(arg));
    }
    parts.join(" ")
}

fn log_job_plan(state: &AppState, job: &MuxJobRequest, output_path: &Path) {
    let audio_list = if job.audios.is_empty() {
        "[]".to_string()
    } else {
        let items: Vec<String> = job
            .audios
            .iter()
            .map(|audio| {
                format!(
                    "{{path={}, lang={:?}, default={:?}, name={:?}}}",
                    quote_arg(&audio.path),
                    audio.language,
                    audio.is_default,
                    audio.track_name
                )
            })
            .collect();
        format!("[{}]", items.join(", "))
    };
    let subtitle_list = if job.subtitles.is_empty() {
        "[]".to_string()
    } else {
        let items: Vec<String> = job
            .subtitles
            .iter()
            .map(|subtitle| {
                format!(
                    "{{path={}, lang={:?}, default={:?}, forced={:?}, name={:?}}}",
                    quote_arg(&subtitle.path),
                    subtitle.language,
                    subtitle.is_default,
                    subtitle.is_forced,
                    subtitle.track_name
                )
            })
            .collect();
        format!("[{}]", items.join(", "))
    };
    let chapter_list = if job.chapters.is_empty() {
        "[]".to_string()
    } else {
        let items: Vec<String> = job
            .chapters
            .iter()
            .map(|chapter| quote_arg(&chapter.path))
            .collect();
        format!("[{}]", items.join(", "))
    };

    let _ = write_log_line(
        &state.paths,
        &format!(
            "JOB PLAN: video={} output={} audios={} subtitles={} chapters={}",
            quote_arg(&job.video.path),
            quote_arg(&output_path.to_string_lossy()),
            audio_list,
            subtitle_list,
            chapter_list
        ),
    );
}

fn build_mkvmerge_command(
    job: &MuxJobRequest,
    settings: &MuxSettings,
    output_path: &Path,
    _state: &AppState,
) -> Vec<String> {
    let mut args = vec![
        "--gui-mode".to_string(),
        "--output".to_string(),
        output_path.to_string_lossy().to_string(),
    ];

    let mut resolved_external_audios: Vec<(ExternalFileInfo, u64)> = Vec::new();
    for audio in &job.audios {
        let mut resolved_ids: Vec<u64> = Vec::new();
        if let Some(ids) = &audio.included_track_ids {
            if ids.is_empty() {
                continue;
            }
            resolved_ids = ids.clone();
        } else if let Some(mkvmerge) = get_mkvmerge_info(Path::new(&audio.path)) {
            let ids = parse_external_track_ids_mkvmerge(&mkvmerge, "Audio");
            if ids.len() > 1 {
                resolved_ids = ids;
            } else if let Some(id) = audio.track_id {
                resolved_ids.push(id);
            } else {
                resolved_ids = ids;
            }
        } else if let Some(id) = audio.track_id {
            resolved_ids.push(id);
        }

        if resolved_ids.is_empty() {
            resolved_ids.push(0);
        }

        let set_default_on_first = audio.is_default.unwrap_or(false);
        for (index, track_id) in resolved_ids.iter().enumerate() {
            let mut cloned = audio.clone();
            cloned.track_id = Some(*track_id);
            if set_default_on_first {
                cloned.is_default = Some(index == 0);
            }
            cloned.apply_language = index == 0;
            resolved_external_audios.push((cloned, *track_id));
        }
    }

    let mut resolved_external_subtitles: Vec<(ExternalFileInfo, u64)> = Vec::new();
    let mut resolved_external_subtitles_from_audio: Vec<(ExternalFileInfo, u64)> = Vec::new();
    for subtitle in &job.subtitles {
        let mut resolved_ids: Vec<u64> = Vec::new();
        if let Some(ids) = &subtitle.included_track_ids {
            if ids.is_empty() {
                continue;
            }
            resolved_ids = ids.clone();
        } else if let Some(mkvmerge) = get_mkvmerge_info(Path::new(&subtitle.path)) {
            let ids = parse_external_track_ids_mkvmerge(&mkvmerge, "Text");
            if ids.len() > 1 {
                resolved_ids = ids;
            } else if let Some(id) = subtitle.track_id {
                resolved_ids.push(id);
            } else {
                resolved_ids = ids;
            }
        } else if let Some(id) = subtitle.track_id {
            resolved_ids.push(id);
        }

        if resolved_ids.is_empty() {
            resolved_ids.push(0);
        }

        let set_default_on_first = subtitle.is_default.unwrap_or(false);
        for (index, track_id) in resolved_ids.iter().enumerate() {
            let mut cloned = subtitle.clone();
            cloned.track_id = Some(*track_id);
            if set_default_on_first {
                cloned.is_default = Some(index == 0);
            }
            cloned.apply_language = index == 0;
            resolved_external_subtitles.push((cloned, *track_id));
        }
    }

    for audio in &job.audios {
        if audio.include_subtitles != Some(true) {
            continue;
        }
        let mut resolved_ids: Vec<u64> = Vec::new();
        if let Some(ids) = &audio.included_subtitle_track_ids {
            if ids.is_empty() {
                continue;
            }
            resolved_ids = ids.clone();
        } else if let Some(mkvmerge) = get_mkvmerge_info(Path::new(&audio.path)) {
            resolved_ids = parse_external_track_ids_mkvmerge(&mkvmerge, "Text");
        }
        if resolved_ids.is_empty() {
            continue;
        }
        for track_id in resolved_ids.iter() {
            let mut cloned = audio.clone();
            cloned.track_id = Some(*track_id);
            cloned.apply_language = false;
            cloned.is_default = None;
            cloned.is_forced = None;
            resolved_external_subtitles_from_audio.push((cloned, *track_id));
        }
    }

    if settings.discard_old_chapters {
        args.push("--no-chapters".to_string());
    }
    if settings.discard_old_attachments {
        args.push("--no-attachments".to_string());
    }
    if settings.remove_global_tags {
        args.push("--no-global-tags".to_string());
    }

    let external_audio_present = !resolved_external_audios.is_empty();
    let external_subtitle_present =
        !resolved_external_subtitles.is_empty() || !resolved_external_subtitles_from_audio.is_empty();

    let external_audio_default = resolved_external_audios
        .iter()
        .any(|(audio, _)| audio.is_default.unwrap_or(false));
    if external_audio_default {
        for (index, track) in job.video.tracks.iter().enumerate() {
            if track.track_type != "audio" {
                continue;
            }
            let id = parse_track_id(track, index);
            args.push("--default-track-flag".to_string());
            args.push(format!("{id}:no"));
        }
    }

    let external_subtitle_default = resolved_external_subtitles
        .iter()
        .any(|(subtitle, _)| subtitle.is_default.unwrap_or(false));
    if external_subtitle_default {
        for (index, track) in job.video.tracks.iter().enumerate() {
            if track.track_type != "subtitle" {
                continue;
            }
            let id = parse_track_id(track, index);
            args.push("--default-track-flag".to_string());
            args.push(format!("{id}:no"));
        }
    }

    if let Some(language) = &settings.make_audio_default_language {
        let ids = collect_track_ids_by_language(&job.video.tracks, "audio", &[language.clone()]);
        for id in ids {
            args.push("--default-track-flag".to_string());
            args.push(format!("{}:yes", id));
        }
    }
    if let Some(language) = &settings.make_subtitle_default_language {
        let ids = collect_track_ids_by_language(&job.video.tracks, "subtitle", &[language.clone()]);
        for id in ids {
            args.push("--default-track-flag".to_string());
            args.push(format!("{}:yes", id));
        }
    }

    let audio_keep_ids = if settings.only_keep_audios_enabled && !settings.only_keep_audio_languages.is_empty() {
        Some(collect_track_ids_by_language(
            &job.video.tracks,
            "audio",
            &settings.only_keep_audio_languages,
        ))
    } else {
        None
    };
    let subtitle_keep_ids =
        if settings.only_keep_subtitles_enabled && !settings.only_keep_subtitle_languages.is_empty() {
            Some(collect_track_ids_by_language(
                &job.video.tracks,
                "subtitle",
                &settings.only_keep_subtitle_languages,
            ))
        } else {
            None
        };

    apply_track_selection(&mut args, &job.video.tracks, "video", None);
    apply_track_selection(&mut args, &job.video.tracks, "audio", audio_keep_ids);
    apply_track_selection(&mut args, &job.video.tracks, "subtitle", subtitle_keep_ids);

    // Apply individual track modifications (name, language, default, forced) BEFORE adding source file
    // Format: --default-track-flag TID:value (no 0: prefix when flag comes before the file)
    for (index, track) in job.video.tracks.iter().enumerate() {
        if is_track_removed(track) {
            continue;
        }
        let track_id = parse_track_id(track, index);
        
        // Track name (skip if empty)
        if let Some(name) = &track.name {
            if !name.trim().is_empty() {
                args.push("--track-name".to_string());
                args.push(format!("{}:{}", track_id, name));
            }
        }
        
        // Language
        if let Some(language) = &track.language {
            args.push("--language".to_string());
            args.push(format!("{}:{}", track_id, language));
        }
        
        // Default flag - apply individual track defaults from ModifyTracksDialog
        // These override the bulk operations (external defaults, language filters) for specific tracks
        if let Some(is_default) = track.is_default {
            args.push("--default-track-flag".to_string());
            args.push(format!("{}:{}", track_id, if is_default { "yes" } else { "no" }));
        }
        
        // Forced flag for subtitles (use forced-display-flag)
        if track.track_type == "subtitle" {
            if let Some(is_forced) = track.is_forced {
                args.push("--forced-display-flag".to_string());
                args.push(format!("{}:{}", track_id, if is_forced { "yes" } else { "no" }));
            }
        }
    }

    // Enforce audio ordering when external audio exists:
    // bulk audio (from Audio tab) -> per-file external audio -> original audio tracks.
    if external_audio_present || external_subtitle_present {
        let mut order: Vec<String> = Vec::new();
        let source_video_tracks: Vec<usize> = job
            .video
            .tracks
            .iter()
            .enumerate()
            .filter(|(_, track)| track.track_type == "video" && !is_track_removed(track))
            .map(|(index, track)| parse_track_id(track, index))
            .collect();
        let source_audio_tracks: Vec<usize> = job
            .video
            .tracks
            .iter()
            .enumerate()
            .filter(|(_, track)| track.track_type == "audio" && !is_track_removed(track))
            .map(|(index, track)| parse_track_id(track, index))
            .collect();
        let source_subtitle_tracks: Vec<usize> = job
            .video
            .tracks
            .iter()
            .enumerate()
            .filter(|(_, track)| track.track_type == "subtitle" && !is_track_removed(track))
            .map(|(index, track)| parse_track_id(track, index))
            .collect();

        for id in source_video_tracks {
            order.push(format!("0:{}", id));
        }

        let mut file_index = 1usize;
        let mut bulk_audio_entries: Vec<String> = Vec::new();
        let mut per_video_audio_entries: Vec<String> = Vec::new();
        for (audio, track_id) in &resolved_external_audios {
            let entry = format!("{}:{}", file_index, track_id);
            let is_per_video = audio.source.as_deref() == Some("per-file");
            if is_per_video {
                per_video_audio_entries.push(entry);
            } else {
                bulk_audio_entries.push(entry);
            }
            file_index += 1;
        }

        order.extend(bulk_audio_entries);
        order.extend(per_video_audio_entries);
        for id in source_audio_tracks {
            order.push(format!("0:{}", id));
        }

        for id in source_subtitle_tracks {
            order.push(format!("0:{}", id));
        }

        let mut bulk_subtitle_entries: Vec<String> = Vec::new();
        let mut per_video_subtitle_entries: Vec<String> = Vec::new();
        let all_subtitles: Vec<(ExternalFileInfo, u64)> = resolved_external_subtitles
            .iter()
            .cloned()
            .chain(resolved_external_subtitles_from_audio.iter().cloned())
            .collect();
        for (subtitle, track_id) in &all_subtitles {
            let entry = format!("{}:{}", file_index, track_id);
            let is_per_video = subtitle.source.as_deref() == Some("per-file");
            if is_per_video {
                per_video_subtitle_entries.push(entry);
            } else {
                bulk_subtitle_entries.push(entry);
            }
            file_index += 1;
        }
        order.extend(bulk_subtitle_entries);
        order.extend(per_video_subtitle_entries);

        if !order.is_empty() {
            args.push("--track-order".to_string());
            args.push(order.join(","));
        }
    }

    args.push(job.video.path.clone());

    for (audio, track_id) in &resolved_external_audios {
        args.push("--no-video".to_string());
        args.push("--no-subtitles".to_string());
        args.push("--no-chapters".to_string());
        args.push("--no-attachments".to_string());
        args.push("--no-global-tags".to_string());
        args.push("--audio-tracks".to_string());
        args.push(track_id.to_string());
        let override_entry = audio.track_overrides.get(&track_id.to_string());
        let language = override_entry
            .and_then(|entry| entry.language.clone())
            .or_else(|| if audio.apply_language { audio.language.clone() } else { None });
        if let Some(language) = language {
            args.push("--language".to_string());
            args.push(format!("{}:{}", track_id, language));
        }
        let track_name = override_entry
            .and_then(|entry| entry.track_name.clone())
            .or_else(|| audio.track_name.clone());
        if let Some(name) = track_name {
            if !name.trim().is_empty() {
                args.push("--track-name".to_string());
                args.push(format!("{}:{}", track_id, name));
            }
        }
        let delay = override_entry
            .and_then(|entry| entry.delay)
            .or_else(|| audio.delay);
        if let Some(delay) = delay {
            args.push("--sync".to_string());
            args.push(format!("{}:{}", track_id, (delay * 1000.0) as i64));
        }
        if let Some(is_default) = audio.is_default {
            args.push("--default-track-flag".to_string());
            args.push(format!("{}:{}", track_id, if is_default { "yes" } else { "no" }));
        }
        if let Some(_is_forced) = audio.is_forced {
            // mkvmerge versions in the wild often do not support forced flag for audio tracks.
        }
        args.push(audio.path.clone());
    }

    let all_subtitles: Vec<(ExternalFileInfo, u64)> = resolved_external_subtitles
        .iter()
        .cloned()
        .chain(resolved_external_subtitles_from_audio.iter().cloned())
        .collect();
    for (subtitle, track_id) in &all_subtitles {
        args.push("--no-video".to_string());
        args.push("--no-audio".to_string());
        args.push("--no-chapters".to_string());
        args.push("--no-attachments".to_string());
        args.push("--no-global-tags".to_string());
        args.push("--subtitle-tracks".to_string());
        args.push(track_id.to_string());
        let override_entry = subtitle.track_overrides.get(&track_id.to_string());
        let language = override_entry
            .and_then(|entry| entry.language.clone())
            .or_else(|| if subtitle.apply_language { subtitle.language.clone() } else { None });
        if let Some(language) = language {
            args.push("--language".to_string());
            args.push(format!("{}:{}", track_id, language));
        }
        let track_name = override_entry
            .and_then(|entry| entry.track_name.clone())
            .or_else(|| subtitle.track_name.clone());
        if let Some(name) = track_name {
            if !name.trim().is_empty() {
                args.push("--track-name".to_string());
                args.push(format!("{}:{}", track_id, name));
            }
        }
        let delay = override_entry
            .and_then(|entry| entry.delay)
            .or_else(|| subtitle.delay);
        if let Some(delay) = delay {
            args.push("--sync".to_string());
            args.push(format!("{}:{}", track_id, (delay * 1000.0) as i64));
        }
        if let Some(is_default) = subtitle.is_default {
            args.push("--default-track-flag".to_string());
            args.push(format!("{}:{}", track_id, if is_default { "yes" } else { "no" }));
        }
        if let Some(is_forced) = subtitle.is_forced {
            args.push("--forced-display-flag".to_string());
            args.push(format!("{}:{}", track_id, if is_forced { "yes" } else { "no" }));
        }
        args.push(subtitle.path.clone());
    }

    for chapter in &job.chapters {
        args.push("--chapters".to_string());
        args.push(chapter.path.clone());
        // Apply chapter delay if set (mkvmerge uses --sync after --chapters)
        // Note: Chapter delay shifts all chapter timestamps by the specified amount
        if let Some(delay) = chapter.delay {
            if delay != 0.0 {
                args.push("--sync".to_string());
                // For chapter files, use 0:milliseconds format (0 refers to the last added file)
                args.push(format!("0:{}", (delay * 1000.0) as i64));
            }
        }
    }

    for attachment in &job.attachments {
        args.push("--attach-file".to_string());
        args.push(attachment.path.clone());
    }

    args
}

fn spawn_log_reader<R: Read + Send + 'static>(
    reader: R,
    app: AppHandle,
    state: AppState,
    job_id: String,
) {
    thread::spawn(move || {
        let mut reader = BufReader::new(reader);
        let mut line = String::new();
        while let Ok(bytes) = reader.read_line(&mut line) {
            if bytes == 0 {
                break;
            }
            let trimmed = line.trim_end().to_string();
            let _ = write_log_line(&state.paths, &trimmed);
            if let Some(progress) = parse_progress(&trimmed) {
                emit_progress(
                    &app,
                    MuxProgressEvent {
                        job_id: job_id.clone(),
                        status: "processing".to_string(),
                        progress,
                        message: None,
                        size_after: None,
                        error_message: None,
                    },
                );
            }
            let _ = app.emit_all(
                "mux-log",
                serde_json::json!({ "job_id": job_id, "line": trimmed }),
            );
            line.clear();
        }
    });
}

fn run_command_with_logs(
    app: &AppHandle,
    state: &AppState,
    job: &MuxJobRequest,
    command: &mut Command,
) -> Result<Arc<Mutex<Child>>, String> {
    let mut child = command
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("Failed to start process: {e}"))?;

    let stdout = child.stdout.take();
    let stderr = child.stderr.take();

    let handle = Arc::new(Mutex::new(child));
    {
        let mut mux_state = state.mux_state.lock().unwrap();
        mux_state.children.insert(job.id.clone(), handle.clone());
    }

    if let Some(out) = stdout {
        spawn_log_reader(out, app.clone(), state.clone(), job.id.clone());
    }
    if let Some(err) = stderr {
        spawn_log_reader(err, app.clone(), state.clone(), job.id.clone());
    }

    Ok(handle)
}

fn emit_progress(app: &AppHandle, event: MuxProgressEvent) {
    let _ = app.emit_all("mux-progress", event);
}

fn wait_for_child_or_stop(handle: Arc<Mutex<Child>>, state: &AppState) -> Option<i32> {
    loop {
        {
            let mux_state = state.mux_state.lock().unwrap();
            if mux_state.stop {
                drop(mux_state);
                if let Ok(mut child) = handle.lock() {
                    let _ = child.kill();
                }
            }
        }

        let status = {
            let mut child = handle.lock().unwrap();
            match child.try_wait() {
                Ok(Some(status)) => return status.code(),
                Ok(None) => None,
                Err(_) => return None,
            }
        };

        if status.is_some() {
            return status;
        }

        thread::sleep(Duration::from_millis(200));
    }
}

fn parse_progress(line: &str) -> Option<u8> {
    let percent_pos = line.find('%')?;
    let start = line[..percent_pos]
        .rfind(|c: char| !c.is_ascii_digit())
        .map(|index| index + 1)
        .unwrap_or(0);
    line[start..percent_pos].trim().parse::<u8>().ok()
}

fn process_job(app: &AppHandle, state: &AppState, settings: &MuxSettings, job: MuxJobRequest) {
    if state.mux_state.lock().unwrap().stop {
        return;
    }

    emit_progress(
        app,
        MuxProgressEvent {
            job_id: job.id.clone(),
            status: "processing".to_string(),
            progress: 0,
            message: Some("Starting muxing".to_string()),
            size_after: None,
            error_message: None,
        },
    );
    let _ = write_log_line(
        &state.paths,
        &format!("Starting job {} for {}", job.id, job.video.path),
    );

    let output_dir = if settings.destination_dir.trim().is_empty() {
        PathBuf::from(&job.video.path)
            .parent()
            .unwrap_or(Path::new("."))
            .to_path_buf()
    } else {
        PathBuf::from(&settings.destination_dir)
    };
    if let Err(err) = check_free_space(&output_dir, job.video.size) {
        emit_progress(
            app,
            MuxProgressEvent {
                job_id: job.id.clone(),
                status: "error".to_string(),
                progress: 0,
                message: Some("Low disk space".to_string()),
                size_after: None,
                error_message: Some(err),
            },
        );
        if settings.abort_on_errors {
            let mut mux_state = state.mux_state.lock().unwrap();
            mux_state.pause = true;
        }
        return;
    }

    if settings.destination_dir.trim().is_empty() && !settings.overwrite_source {
        emit_progress(
            app,
            MuxProgressEvent {
                job_id: job.id.clone(),
                status: "error".to_string(),
                progress: 0,
                message: Some("Destination folder required".to_string()),
                size_after: None,
                error_message: Some("Set a destination folder or enable overwrite source.".to_string()),
            },
        );
        if settings.abort_on_errors {
            let mut mux_state = state.mux_state.lock().unwrap();
            mux_state.pause = true;
        }
        return;
    }

    let (output_path, final_path, overwrite_mode) = get_output_paths(&job, settings);
    let _ = write_log_line(
        &state.paths,
        &format!("Output path: {}", output_path.to_string_lossy()),
    );
    // mkvpropedit is in-place metadata editing only.
    // Allow it only when the user is explicitly overwriting source files.
    let fast_mux_in_place_allowed =
        settings.destination_dir.trim().is_empty() && settings.overwrite_source;
    let can_use_mkvpropedit = settings.use_mkvpropedit
        && fast_mux_in_place_allowed
        && job.audios.is_empty()
        && job.subtitles.is_empty()
        && job.chapters.is_empty()
        && job.attachments.is_empty()
        && (!settings.only_keep_audios_enabled || settings.only_keep_audio_languages.is_empty())
        && (!settings.only_keep_subtitles_enabled || settings.only_keep_subtitle_languages.is_empty());
    if settings.use_mkvpropedit && !can_use_mkvpropedit {
        let _ = write_log_line(
            &state.paths,
            "Fast muxing requested but this job requires full mkvmerge (fast mux works only for in-place metadata edits).",
        );
    }

    if can_use_mkvpropedit {
        if !tool_available("mkvpropedit", "-V") {
            emit_progress(
                app,
                MuxProgressEvent {
                    job_id: job.id.clone(),
                    status: "error".to_string(),
                    progress: 0,
                    message: Some("mkvpropedit not found".to_string()),
                    size_after: None,
                    error_message: Some("Install mkvpropedit or disable fast muxing.".to_string()),
                },
            );
            return;
        }

        let edit_args = build_mkvpropedit_args(&job);
        if !edit_args.is_empty() {
            let full_command = format!("mkvpropedit {} {}", job.video.path, edit_args.join(" "));
            let _ = write_log_line(&state.paths, &full_command);
            let _ = app.emit_all(
                "mux-log",
                serde_json::json!({ "job_id": job.id, "line": full_command }),
            );

            let mut cmd = hidden_command("mkvpropedit");
            cmd.arg(&job.video.path);
            for arg in edit_args {
                cmd.arg(arg);
            }

            let child = match cmd.spawn() {
                Ok(c) => c,
                Err(e) => {
                    emit_progress(
                        app,
                        MuxProgressEvent {
                            job_id: job.id.clone(),
                            status: "error".to_string(),
                            progress: 0,
                            message: Some("Failed to start mkvpropedit".to_string()),
                            size_after: None,
                            error_message: Some(format!("Failed to start mkvpropedit: {e}")),
                        },
                    );
                    return;
                }
            };

            let handle = Arc::new(Mutex::new(child));
            {
                let mut mux_state = state.mux_state.lock().unwrap();
                mux_state.children.insert(job.id.clone(), handle.clone());
            }

            let status = wait_for_child_or_stop(handle.clone(), state);
            {
                let mut mux_state = state.mux_state.lock().unwrap();
                mux_state.children.remove(&job.id);
            }

            match status {
                Some(code) if code == 0 => {
                        let final_size = fs::metadata(&job.video.path).ok().map(|m| m.len());
                        emit_progress(
                            app,
                            MuxProgressEvent {
                                job_id: job.id.clone(),
                                status: "completed".to_string(),
                                progress: 100,
                                message: Some("Fast mux completed".to_string()),
                                size_after: final_size,
                                error_message: None,
                            },
                        );
                }
                Some(code) => {
                    let error_output = format!("mkvpropedit exited with code: {code}");
                    emit_progress(
                        app,
                        MuxProgressEvent {
                            job_id: job.id.clone(),
                            status: "error".to_string(),
                            progress: 0,
                            message: Some("mkvpropedit failed".to_string()),
                            size_after: None,
                            error_message: Some(error_output),
                        },
                    );
                }
                None => {
                    emit_progress(
                        app,
                        MuxProgressEvent {
                            job_id: job.id.clone(),
                            status: "error".to_string(),
                            progress: 0,
                            message: Some("mkvpropedit error".to_string()),
                            size_after: None,
                            error_message: Some("Failed to wait for mkvpropedit".to_string()),
                        },
                    );
                }
            }
            return;
        } else {
            let _ = write_log_line(
                &state.paths,
                "Fast mux requested but no track modifications detected. Falling back to mkvmerge.",
            );
        }
    }

    if !tool_available("mkvmerge", "-V") {
        emit_progress(
            app,
            MuxProgressEvent {
                job_id: job.id.clone(),
                status: "error".to_string(),
                progress: 0,
                message: Some("mkvmerge not found".to_string()),
                size_after: None,
                error_message: Some("Install mkvmerge (MKVToolNix) and try again.".to_string()),
            },
        );
        if settings.abort_on_errors {
            let mut mux_state = state.mux_state.lock().unwrap();
            mux_state.pause = true;
        }
        return;
    }

    let mut command = hidden_command("mkvmerge");
    let command_args = build_mkvmerge_command(&job, settings, &output_path, state);
    log_job_plan(state, &job, &output_path);
    let command_line = command_args
        .iter()
        .map(|arg| quote_arg(arg))
        .collect::<Vec<_>>()
        .join(" ");
    let _ = write_log_line(&state.paths, &format!("mkvmerge {}", command_line));
    for arg in command_args {
        command.arg(arg);
    }

    let handle = match run_command_with_logs(app, state, &job, &mut command) {
        Ok(child) => child,
        Err(err) => {
            emit_progress(
                app,
                MuxProgressEvent {
                    job_id: job.id.clone(),
                    status: "error".to_string(),
                    progress: 0,
                    message: Some("Failed to start process".to_string()),
                    size_after: None,
                    error_message: Some(err),
                },
            );
            if settings.abort_on_errors {
                let mut mux_state = state.mux_state.lock().unwrap();
                mux_state.pause = true;
            }
            return;
        }
    };

    let exit_code = wait_for_child_or_stop(handle.clone(), state).unwrap_or(-1);
    {
        let mut mux_state = state.mux_state.lock().unwrap();
        mux_state.children.remove(&job.id);
    }

    if exit_code != 0 {
        let treat_as_success = exit_code == 1 && (output_path.exists() || final_path.exists());
        if treat_as_success {
            let _ = write_log_line(
                &state.paths,
                &format!("Job {} completed with warnings (exit code 1)", job.id),
            );
        } else {
        let _ = write_log_line(
            &state.paths,
            &format!("Job {} failed with exit code {}", job.id, exit_code),
        );
        emit_progress(
            app,
            MuxProgressEvent {
                job_id: job.id.clone(),
                status: "error".to_string(),
                progress: 0,
                message: Some("Muxing failed".to_string()),
                size_after: None,
                error_message: Some(format!("Process exited with code {exit_code}")),
            },
        );
        if settings.abort_on_errors {
            let mut mux_state = state.mux_state.lock().unwrap();
            mux_state.pause = true;
        }
            return;
        }
    }

    if overwrite_mode && output_path.exists() {
        let _ = fs::remove_file(&job.video.path);
        let _ = fs::rename(&output_path, &final_path);
    }

    let mut final_output = final_path.clone();
    if settings.add_crc && final_path.exists() {
        if let Ok(crc) = compute_crc(&final_path) {
            let with_crc = file_name_with_crc(&final_path, &crc);
            let _ = fs::rename(&final_path, &with_crc);
            final_output = with_crc;
        }
    } else if settings.remove_old_crc && final_path.exists() {
        let without_crc = file_name_without_crc(&final_path);
        let _ = fs::rename(&final_path, &without_crc);
        final_output = without_crc;
    }

    let size_after = fs::metadata(&final_output).map(|m| m.len()).ok();

    emit_progress(
        app,
        MuxProgressEvent {
            job_id: job.id.clone(),
            status: "completed".to_string(),
            progress: 100,
            message: Some("Muxing completed".to_string()),
            size_after,
            error_message: None,
        },
    );
    let _ = write_log_line(
        &state.paths,
        &format!("Job {} completed successfully", job.id),
    );

    if settings.keep_log_file && !settings.destination_dir.trim().is_empty() {
        let _ = fs::copy(&state.paths.log_path, output_dir.join("muxing_log_file.txt"));
    }
}

fn run_mux_queue(app: AppHandle, state: AppState) {
    let settings = {
        let mux_state = state.mux_state.lock().unwrap();
        mux_state.settings.clone()
    };
    let Some(settings) = settings else { return; };

    let jobs = {
        let mux_state = state.mux_state.lock().unwrap();
        mux_state.queue.clone()
    };

    let max_parallel = settings.max_parallel_jobs.unwrap_or(1).max(1);
    let (tx, rx) = mpsc::channel::<MuxJobRequest>();
    for job in jobs {
        let _ = tx.send(job);
    }
    drop(tx);

    let receiver = Arc::new(Mutex::new(rx));
    let mut workers = Vec::new();

    for _ in 0..max_parallel {
        let app_handle = app.clone();
        let state_clone = state.clone();
        let settings_clone = settings.clone();
        let rx_clone = receiver.clone();
        workers.push(thread::spawn(move || loop {
            {
                let mux_state = state_clone.mux_state.lock().unwrap();
                if mux_state.stop {
                    break;
                }
                if mux_state.pause {
                    drop(mux_state);
                    thread::sleep(Duration::from_millis(200));
                    continue;
                }
            }

            let job = {
                let rx_lock = rx_clone.lock().unwrap();
                rx_lock.recv_timeout(Duration::from_millis(200))
            };

            match job {
                Ok(job) => process_job(&app_handle, &state_clone, &settings_clone, job),
                Err(mpsc::RecvTimeoutError::Timeout) => continue,
                Err(mpsc::RecvTimeoutError::Disconnected) => break,
            }
        }));
    }

    for worker in workers {
        let _ = worker.join();
    }

    let mut mux_state = state.mux_state.lock().unwrap();
    mux_state.running = false;
    mux_state.children.clear();
}

#[tauri::command]
fn start_muxing(app: AppHandle, state: State<AppState>, request: MuxStartRequest) -> Result<(), String> {
    clear_log(&state.paths)?;
    write_log_line(&state.paths, "Starting muxing session")?;

    let mut mux_state = state.mux_state.lock().unwrap();
    mux_state.queue = request.jobs;
    mux_state.settings = Some(request.settings);
    mux_state.stop = false;
    mux_state.pause = false;

    if mux_state.running {
        return Ok(());
    }
    mux_state.running = true;

    let app_handle = app.clone();
    let state_clone = state.inner().clone();
    thread::spawn(move || run_mux_queue(app_handle, state_clone));

    Ok(())
}

#[tauri::command]
fn preview_mux(state: State<AppState>, request: MuxStartRequest) -> Result<Vec<MuxPreviewResult>, String> {
    let settings = request.settings;
    let mut results = Vec::new();

    for job in request.jobs {
        let (output_path, _final_path, _overwrite) = get_output_paths(&job, &settings);
        let command_args = build_mkvmerge_command(&job, &settings, &output_path, &state);
        let command_line = join_mkvmerge_command(&command_args);
        let mut warnings = Vec::new();

        if !Path::new(&job.video.path).exists() {
            warnings.push(format!("Video file missing: {}", job.video.path));
        }
        for audio in &job.audios {
            if !Path::new(&audio.path).exists() {
                warnings.push(format!("Audio file missing: {}", audio.path));
            }
        }
        for subtitle in &job.subtitles {
            if !Path::new(&subtitle.path).exists() {
                warnings.push(format!("Subtitle file missing: {}", subtitle.path));
            }
        }
        for chapter in &job.chapters {
            if !Path::new(&chapter.path).exists() {
                warnings.push(format!("Chapter file missing: {}", chapter.path));
            }
        }
        for attachment in &job.attachments {
            if !Path::new(&attachment.path).exists() {
                warnings.push(format!("Attachment file missing: {}", attachment.path));
            }
        }

        let plan = MuxPreviewPlan {
            video: job.video.path.clone(),
            output: output_path.to_string_lossy().to_string(),
            audios: job.audios.clone(),
            subtitles: job.subtitles.clone(),
            chapters: job.chapters.clone(),
            attachments: job.attachments.clone(),
        };

        results.push(MuxPreviewResult {
            job_id: job.id,
            command: command_line,
            warnings,
            plan,
        });
    }

    Ok(results)
}

#[tauri::command]
fn pause_muxing(state: State<AppState>) -> Result<(), String> {
    let mut mux_state = state.mux_state.lock().unwrap();
    mux_state.pause = true;
    Ok(())
}

#[tauri::command]
fn resume_muxing(state: State<AppState>) -> Result<(), String> {
    let mut mux_state = state.mux_state.lock().unwrap();
    mux_state.pause = false;
    Ok(())
}

#[tauri::command]
fn stop_muxing(state: State<AppState>) -> Result<(), String> {
    let mut mux_state = state.mux_state.lock().unwrap();
    mux_state.stop = true;
    for (_, handle) in mux_state.children.drain() {
        if let Ok(mut child) = handle.lock() {
            let _ = child.kill();
        }
    }
    Ok(())
}

#[tauri::command]
fn open_log_file(app: AppHandle, state: State<AppState>) -> Result<(), String> {
    if !state.paths.log_path.exists() {
        File::create(&state.paths.log_path)
            .map_err(|e| format!("Failed to create log file: {e}"))?;
    }
    let path_string = state.paths.log_path.to_string_lossy().to_string();
    if tauri::api::shell::open(
        &app.shell_scope(),
        path_string.clone(),
        None,
    )
    .is_ok()
    {
        return Ok(());
    }

    #[cfg(target_os = "macos")]
    {
        let status = Command::new("open")
            .arg(&path_string)
            .status()
            .map_err(|e| format!("Failed to open log file: {e}"))?;
        if status.success() {
            return Ok(());
        }
    }

    #[cfg(target_os = "windows")]
    {
        let status = Command::new("cmd")
            .args(["/C", "start", "", &path_string])
            .status()
            .map_err(|e| format!("Failed to open log file: {e}"))?;
        if status.success() {
            return Ok(());
        }
    }

    #[cfg(target_os = "linux")]
    {
        let status = Command::new("xdg-open")
            .arg(&path_string)
            .status()
            .map_err(|e| format!("Failed to open log file: {e}"))?;
        if status.success() {
            return Ok(());
        }
    }

    Err("Failed to open log file".to_string())
}

fn main() {
    tauri::Builder::default()
        .setup(|app| {
            let app_data_dir = tauri::api::path::app_data_dir(&app.config())
                .ok_or("Failed to resolve app data directory")?;
            ensure_dir(&app_data_dir)?;
            let paths = AppPaths {
                app_data_dir: app_data_dir.clone(),
                options_path: app_data_dir.join("setting.json"),
                log_path: app_data_dir.join("muxing_log_file.txt"),
            };
            let state = AppState {
                paths,
                mux_state: Arc::new(Mutex::new(MuxState::default())),
            };
            app.manage(state);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            get_app_paths,
            load_options,
            save_options,
            scan_media,
            inspect_paths,
            start_muxing,
            preview_mux,
            pause_muxing,
            resume_muxing,
            stop_muxing,
            open_log_file,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
