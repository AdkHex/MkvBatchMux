//! Measure how far each subtitle is off its video, with the engine's subtitle
//! sync (`subsBatch` jobs of task `sync`), against the video's speech
//! (`audio`) or a correctly timed subtitle track inside the video (`subtitle`).
//!
//! The engine maps time as `video = ratio * subtitle + offset`, positive offset
//! moving the subtitle later. That offset is already the delay MKVBatchMux adds
//! to a subtitle to line it up, so it is passed on as it is (unlike audio,
//! whose engine delay is negated): a subtitle 2.5 s late measures -2.5 s.
//!
//! The engine also writes a re-timed copy of every subtitle it moves; it is
//! what the app muxes when the fix is more than a delay (a frame-rate change,
//! or different offsets for different scenes).

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::AppHandle;

use crate::audiosync::{ensure_unlocked, ffmpeg_available_for, EngineHandle};
use crate::engine_link::{spawn_engine_run, to_value, EngineLink, RunEnd, Sink};

/// Folder the re-timed copies go to, beside each subtitle, unless the request names one.
pub const DEFAULT_FOLDER: &str = "MKVBatchMux synced";

/// The engine reports progress while it finds speech; this long a silence means it is wedged.
const IDLE_LIMIT: Duration = Duration::from_secs(600);

/// What the app shows for a subtitle made of pictures.
pub const IMAGE_SUBTITLE: &str =
    "Can't be synced automatically: this subtitle is pictures (PGS/VobSub), not text.";

#[derive(Debug, Deserialize, Serialize, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum SubsyncEngine {
    /// Speech in the video's audio track.
    Audio,
    /// A correctly timed subtitle track inside the video.
    Subtitle,
}

#[derive(Debug, Deserialize, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct SubsyncJob {
    pub key: String,
    pub subtitle_path: String,
    /// For a subtitle inside a container (.mks/.mkv): the N of `0:s:N`.
    #[serde(default)]
    pub subtitle_track: Option<i64>,
    pub video_path: String,
    /// The video's audio stream to listen to: the N of `0:a:N`.
    #[serde(default)]
    pub audio_track: i64,
    /// For the `subtitle` engine: the video's subtitle stream to sync against,
    /// the N of `0:s:N`. Null takes the first.
    #[serde(default)]
    pub reference_track: Option<i64>,
}

fn default_max_offset() -> f64 {
    60.0
}

fn yes() -> bool {
    true
}

fn default_workers() -> i64 {
    2
}

#[derive(Debug, Deserialize, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct SubsyncRequest {
    pub run_id: String,
    pub jobs: Vec<SubsyncJob>,
    pub engine: SubsyncEngine,
    #[serde(default = "default_max_offset")]
    pub max_offset_s: f64,
    #[serde(default = "yes")]
    pub detect_framerate: bool,
    #[serde(default = "yes")]
    pub allow_splits: bool,
    /// Null: a `MKVBatchMux synced` folder beside each subtitle.
    #[serde(default)]
    pub output_dir: Option<String>,
    #[serde(default = "default_workers")]
    pub max_workers: i64,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct ProgressEvent {
    run_id: String,
    key: Option<String>,
    percent: u64,
    stage: Option<String>,
    processed: usize,
    total: usize,
}

#[derive(Debug, Serialize, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SplitPoint {
    /// Where on the video the offset changes.
    pub at_s: f64,
    /// The offset from there on, as `offset_s`.
    pub offset_s: f64,
}

/// One subtitle's measurement. `offset_s` is the delay to add to the subtitle
/// (positive = later); with `ratio` ≠ 1 it is the offset after scaling, and
/// with splits it holds from the start of the video.
#[derive(Debug, Serialize, Clone, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ResultEvent {
    pub run_id: String,
    pub key: Option<String>,
    /// Null when the engine found no clear match (`applied` false) or failed.
    pub offset_s: Option<f64>,
    /// `video = ratio * subtitle + offset`; 25/23.976 for a PAL-timed subtitle.
    pub ratio: Option<f64>,
    pub splits: usize,
    /// 0-1: how clearly the match stood out, times how much of the subtitle
    /// landed on speech (the engine's own score).
    pub score: Option<f64>,
    pub method: Option<String>,
    pub description: Option<String>,
    /// The engine's re-timed copy; null when nothing was moved.
    pub retimed_path: Option<String>,
    pub error: Option<String>,
    /// False when no match was clear enough to act on: nothing to apply.
    pub applied: bool,
    /// "high" | "medium" | "low".
    pub confidence: Option<String>,
    /// e.g. "25 → 23.976" when a frame-rate conversion was found.
    pub framerate: Option<String>,
    pub split_points: Vec<SplitPoint>,
    pub warnings: Vec<String>,
}

/// Measure each subtitle against its video.
#[tauri::command]
pub fn subsync_start(app: AppHandle, engine: tauri::State<'_, EngineHandle>, request: SubsyncRequest) -> Result<(), String> {
    ensure_unlocked(&app)?;
    if !ffmpeg_available_for(&app) {
        return Err(
            "FFmpeg was not found. Install FFmpeg and make sure ffmpeg and ffprobe are on your PATH."
                .to_string(),
        );
    }
    if request.jobs.is_empty() {
        return Err("There is nothing to sync.".to_string());
    }
    Sink::emit(
        &app,
        "audiosync-log",
        Value::String(format!(
            "Measuring {} subtitle(s) against {}",
            request.jobs.len(),
            match request.engine {
                SubsyncEngine::Audio => "the video's speech",
                SubsyncEngine::Subtitle => "the video's own subtitle track",
            }
        )),
    );
    let run_id = request.run_id.clone();
    spawn_engine_run(app, (*engine).clone(), run_id, "subsync-done", move |engine, app, cancel| {
        run(engine, app, cancel, &request)
    });
    Ok(())
}

/// Whether a subtitle file is pictures, which the engine cannot read as text.
pub(crate) fn is_image_subtitle(path: &str, track: Option<i64>) -> bool {
    track.is_none()
        && Path::new(path)
            .extension()
            .map(|ext| matches!(ext.to_string_lossy().to_ascii_lowercase().as_str(), "sup" | "sub" | "idx"))
            .unwrap_or(false)
}

/// Where a job's re-timed copy goes, and whether an earlier one there may be
/// replaced: always in our own folder, never when that folder is the
/// subtitle's own, where the copy's name could be the subtitle itself.
pub(crate) fn output_folder(output_dir: Option<&str>, subtitle: &Path) -> (PathBuf, bool) {
    let parent = subtitle.parent().map(Path::to_path_buf).unwrap_or_default();
    let folder = output_dir
        .map(str::trim)
        .filter(|dir| !dir.is_empty())
        .map(PathBuf::from)
        .unwrap_or_else(|| parent.join(DEFAULT_FOLDER));
    let overwrite = folder != parent;
    (folder, overwrite)
}

/// The engine's job for one subtitle (`SubJob` in AudioSyncMaster's
/// `src/lib/subsync/types.ts`).
pub(crate) fn engine_job(job: &SubsyncJob, request: &SubsyncRequest) -> Value {
    let (folder, overwrite) = output_folder(request.output_dir.as_deref(), Path::new(&job.subtitle_path));
    let mut subtitle = serde_json::json!({ "path": job.subtitle_path });
    if let Some(track) = job.subtitle_track {
        subtitle["track"] = Value::from(track);
    }
    let mut options = serde_json::json!({
        "engine": match request.engine { SubsyncEngine::Audio => "audio", SubsyncEngine::Subtitle => "subtitle" },
        "maxOffsetS": request.max_offset_s,
        "detectFramerate": request.detect_framerate,
        "allowSplits": request.allow_splits,
    });
    if request.engine == SubsyncEngine::Subtitle {
        options["reference"] = serde_json::json!({ "path": job.video_path, "track": job.reference_track.unwrap_or(0).max(0) });
    }
    serde_json::json!({
        "id": job.key,
        "task": "sync",
        "input": {
            "subtitle": subtitle,
            "video": { "path": job.video_path, "audioTrack": job.audio_track.max(0) },
        },
        "options": options,
        "output": { "dir": folder.to_string_lossy(), "format": "same", "overwrite": overwrite },
    })
}

pub(crate) fn batch_payload(jobs: &[&SubsyncJob], request: &SubsyncRequest) -> Value {
    serde_json::json!({
        "command": "subsBatch",
        "maxWorkers": request.max_workers.max(1),
        "jobs": jobs.iter().map(|job| engine_job(job, request)).collect::<Vec<_>>(),
    })
}

/// Read a `subsJobDone` outcome into the app's result.
pub(crate) fn parse_outcome(done: &Value) -> ResultEvent {
    let text = |value: Option<&Value>| value.and_then(Value::as_str).map(str::to_string);
    let report = done.get("report").cloned().unwrap_or(Value::Null);
    let summary = text(done.get("summary")).filter(|s| !s.is_empty());
    let warnings: Vec<String> = done
        .get("warnings")
        .and_then(Value::as_array)
        .map(|list| list.iter().filter_map(Value::as_str).map(str::to_string).collect())
        .unwrap_or_default();
    let error = text(done.get("error")).filter(|e| !e.is_empty());
    let split_points: Vec<SplitPoint> = report
        .get("splits")
        .and_then(Value::as_array)
        .map(|list| {
            list.iter()
                .filter_map(|split| {
                    Some(SplitPoint {
                        at_s: split.get("atS")?.as_f64()?,
                        offset_s: split.get("offsetMs")?.as_f64()? / 1000.0,
                    })
                })
                .collect()
        })
        .unwrap_or_default();
    // The engine keeps the timing when nothing stood out; it says so in words
    // only (its report has no flag), and moves nothing.
    let no_match = |line: &str| line.starts_with("No clear match") || line.contains("too few lines");
    let applied = error.is_none()
        && !report.is_null()
        && !summary.as_deref().is_some_and(no_match)
        && !warnings.iter().any(|line| no_match(line));
    let retimed = done
        .get("outputs")
        .and_then(Value::as_array)
        .and_then(|outputs| outputs.iter().find(|output| output.get("kind").and_then(Value::as_str).unwrap_or("subtitle") == "subtitle"))
        .and_then(|output| text(output.get("path")));
    ResultEvent {
        offset_s: applied.then(|| report.get("offsetMs").and_then(Value::as_f64).map(|ms| ms / 1000.0)).flatten(),
        ratio: applied.then(|| report.get("ratio").and_then(Value::as_f64)).flatten(),
        splits: if applied { split_points.len() } else { 0 },
        score: report.get("score").and_then(Value::as_f64),
        method: text(report.get("method")),
        description: summary,
        retimed_path: if applied { retimed } else { None },
        error,
        applied,
        confidence: text(report.get("confidence")),
        framerate: text(report.get("framerate")),
        split_points: if applied { split_points } else { Vec::new() },
        warnings,
        ..Default::default()
    }
}

/// The whole run, against any engine and any sink. `Err` only when the engine failed.
pub(crate) fn run<L: EngineLink, S: Sink>(link: &mut L, sink: &S, cancel: &AtomicBool, request: &SubsyncRequest) -> Result<RunEnd, String> {
    let total = request.jobs.len();
    let mut processed = 0usize;
    let progress = |key: &str, percent: u64, stage: Option<&str>, processed: usize| {
        sink.emit(
            "subsync-progress",
            to_value(&ProgressEvent {
                run_id: request.run_id.clone(),
                key: Some(key.to_string()),
                percent: percent.min(100),
                stage: stage.map(str::to_string),
                processed,
                total,
            }),
        )
    };
    let result = |key: &str, mut event: ResultEvent, processed: &mut usize| {
        event.run_id = request.run_id.clone();
        event.key = Some(key.to_string());
        sink.emit("subsync-result", to_value(&event));
        *processed += 1;
        progress(key, 100, None, *processed);
    };

    // Pictures are refused here, without a round trip to the engine.
    let mut sent: Vec<&SubsyncJob> = Vec::new();
    for job in &request.jobs {
        if is_image_subtitle(&job.subtitle_path, job.subtitle_track) {
            result(&job.key, ResultEvent { error: Some(IMAGE_SUBTITLE.to_string()), ..Default::default() }, &mut processed);
        } else {
            sent.push(job);
        }
    }
    if sent.is_empty() {
        return Ok(RunEnd::default());
    }
    if cancel.load(Ordering::SeqCst) {
        return Ok(RunEnd { cancelled: true, error: None });
    }

    let before = existing_copies(&sent, request);
    link.send(&batch_payload(&sent, request))?;
    let mut fatal: Option<String> = None;
    loop {
        let value = link.recv(IDLE_LIMIT)?;
        let job = value.get("job").and_then(Value::as_u64).and_then(|job| sent.get(job as usize).copied());
        match value.get("type").and_then(Value::as_str) {
            Some("subsJobStart") => {
                if let Some(job) = job {
                    progress(&job.key, 0, Some("Starting"), processed);
                }
            }
            Some("subsJobProgress") => {
                if let Some(job) = job {
                    let percent = value.get("percent").and_then(Value::as_u64).unwrap_or(0);
                    progress(&job.key, percent, value.get("stage").and_then(Value::as_str), processed);
                }
            }
            Some("subsJobDone") => {
                if let Some(job) = job {
                    if value.get("cancelled").and_then(Value::as_bool).unwrap_or(false) {
                        continue;
                    }
                    let mut parsed = parse_outcome(&value);
                    // A plain offset is applied as the original file's delay,
                    // so its re-timed copy would only be clutter beside it.
                    let plain_offset = is_pure_offset(&parsed);
                    if !parsed.applied || plain_offset {
                        discard_unchanged_copy(&value, job, request, &before);
                    }
                    if plain_offset {
                        parsed.retimed_path = None;
                    }
                    result(&job.key, parsed, &mut processed);
                }
            }
            Some("subsJobLog") | Some("log") => {
                if let Some(message) = value.get("message").and_then(Value::as_str) {
                    sink.emit("audiosync-log", Value::String(message.to_string()));
                }
            }
            Some("error") => {
                let message = value.get("message").and_then(Value::as_str).unwrap_or("The analysis engine reported an error.");
                sink.emit("audiosync-log", Value::String(message.to_string()));
                if value.get("fatal").and_then(Value::as_bool).unwrap_or(false) {
                    fatal = Some(message.to_string());
                }
            }
            Some("subsBatchDone") => {
                let cancelled = value.get("cancelled").and_then(Value::as_bool).unwrap_or(false) || cancel.load(Ordering::SeqCst);
                let error = fatal.or_else(|| value.get("error").and_then(Value::as_str).map(str::to_string));
                return Ok(RunEnd { cancelled, error });
            }
            _ => {}
        }
    }
}

/// A ratio this close to 1 is no frame-rate change; the same tolerance as
/// `PURE_OFFSET_RATIO_TOLERANCE` in src/shared/lib/engineFeatures.ts, which
/// decides on the frontend that such a result is applied as a plain delay.
const PURE_OFFSET_RATIO_TOLERANCE: f64 = 1e-4;

/// A result a plain delay fixes: no frame-rate change, no scene-by-scene offsets.
fn is_pure_offset(parsed: &ResultEvent) -> bool {
    parsed.applied && parsed.splits == 0 && parsed.ratio.is_some_and(|ratio| (ratio - 1.0).abs() <= PURE_OFFSET_RATIO_TOLERANCE)
}

/// The files already in each folder the run writes re-timed copies to, by
/// folder, names in lower case (Windows and macOS ignore case). Taken before
/// the engine starts, so only copies this run made are ever removed.
fn existing_copies(jobs: &[&SubsyncJob], request: &SubsyncRequest) -> HashMap<PathBuf, HashSet<String>> {
    let mut existing: HashMap<PathBuf, HashSet<String>> = HashMap::new();
    for job in jobs {
        let (folder, overwrite) = output_folder(request.output_dir.as_deref(), Path::new(&job.subtitle_path));
        if !overwrite || existing.contains_key(&folder) {
            continue;
        }
        // Missing (the first run into it) means empty: everything in it later is new.
        let names = std::fs::read_dir(&folder)
            .map(|entries| entries.filter_map(Result::ok).map(|entry| entry.file_name().to_string_lossy().to_lowercase()).collect())
            .unwrap_or_default();
        existing.insert(folder, names);
    }
    existing
}

/// When nothing stood out the engine still writes its "re-timed" copy, the
/// subtitle unchanged. Only a copy in our own folder that this run created is
/// removed: never a file beside the subtitle, and never one an earlier run
/// wrote (`before`), which a mux may already use.
fn discard_unchanged_copy(done: &Value, job: &SubsyncJob, request: &SubsyncRequest, before: &HashMap<PathBuf, HashSet<String>>) {
    let (folder, overwrite) = output_folder(request.output_dir.as_deref(), Path::new(&job.subtitle_path));
    if !overwrite {
        return;
    }
    // A folder not looked at beforehand: nothing in it is known to be new.
    let Some(existing) = before.get(&folder) else { return };
    let outputs = done.get("outputs").and_then(Value::as_array).cloned().unwrap_or_default();
    for path in outputs.iter().filter_map(|output| output.get("path").and_then(Value::as_str)) {
        let path = Path::new(path);
        let Some(name) = path.file_name().map(|name| name.to_string_lossy().to_lowercase()) else { continue };
        if path.parent() == Some(folder.as_path()) && path != Path::new(&job.subtitle_path) && !existing.contains(&name) {
            let _ = std::fs::remove_file(path);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_an_applied_result_without_rate_change_or_splits_is_a_plain_offset() {
        let base = parse_outcome(&serde_json::json!({
            "type": "subsJobDone", "job": 0, "id": "a",
            "outputs": [{ "path": "/s/MKVBatchMux synced/a.synced.en.srt" }],
            "report": { "offsetMs": -2500.0, "ratio": 1.0, "splits": [], "score": 1.0, "confidence": "high", "method": "subtitle" },
        }));
        assert!(base.applied, "{base:?}");
        assert!(is_pure_offset(&base));
        let mut drift = base.clone();
        drift.ratio = Some(1.0427083);
        assert!(!is_pure_offset(&drift));
        let mut split = base.clone();
        split.splits = 1;
        assert!(!is_pure_offset(&split));
        let mut missed = base.clone();
        missed.applied = false;
        assert!(!is_pure_offset(&missed));
    }

    fn job(key: &str, subtitle: &str) -> SubsyncJob {
        SubsyncJob {
            key: key.to_string(),
            subtitle_path: subtitle.to_string(),
            subtitle_track: None,
            video_path: "/v/Show.S01E02.mkv".to_string(),
            audio_track: 1,
            reference_track: None,
        }
    }

    fn request(engine: SubsyncEngine, output_dir: Option<&str>) -> SubsyncRequest {
        SubsyncRequest {
            run_id: "s1".to_string(),
            jobs: vec![],
            engine,
            max_offset_s: 60.0,
            detect_framerate: true,
            allow_splits: true,
            output_dir: output_dir.map(str::to_string),
            max_workers: 0,
        }
    }

    #[test]
    fn the_request_reads_the_frontend_payload_with_defaults() {
        let parsed: SubsyncRequest = serde_json::from_str(
            r#"{"runId":"r","engine":"subtitle","jobs":[{"key":"s1","subtitlePath":"/s/a.srt","videoPath":"/v/a.mkv",
                "audioTrack":0,"referenceTrack":2}],"outputDir":null}"#,
        )
        .unwrap();
        assert_eq!(parsed.engine, SubsyncEngine::Subtitle);
        assert_eq!(parsed.max_offset_s, 60.0);
        assert!(parsed.detect_framerate && parsed.allow_splits);
        assert_eq!(parsed.jobs[0].reference_track, Some(2));
        assert_eq!(parsed.jobs[0].subtitle_track, None);
    }

    #[test]
    fn an_audio_job_listens_to_the_chosen_audio_track() {
        let request = request(SubsyncEngine::Audio, None);
        let value = engine_job(&job("k", "/s/Show.S01E02.en.srt"), &request);
        assert_eq!(value["task"], "sync");
        assert_eq!(value["id"], "k");
        assert_eq!(value["input"]["subtitle"]["path"], "/s/Show.S01E02.en.srt");
        assert!(value["input"]["subtitle"].get("track").is_none());
        assert_eq!(value["input"]["video"]["audioTrack"], 1);
        assert_eq!(value["options"]["engine"], "audio");
        assert_eq!(value["options"]["maxOffsetS"], 60.0);
        assert!(value["options"].get("reference").is_none());
        assert_eq!(value["output"]["dir"], Path::new("/s").join(DEFAULT_FOLDER).to_string_lossy().as_ref());
        assert_eq!(value["output"]["overwrite"], true);
        assert_eq!(batch_payload(&[], &request)["maxWorkers"], 1);
    }

    #[test]
    fn a_subtitle_job_syncs_against_the_videos_own_track() {
        let request = request(SubsyncEngine::Subtitle, Some("/s"));
        let mut inside = job("k", "/s/Show.S01E02.en.srt");
        inside.reference_track = Some(1);
        let value = engine_job(&inside, &request);
        assert_eq!(value["options"]["engine"], "subtitle");
        assert_eq!(value["options"]["reference"]["path"], "/v/Show.S01E02.mkv");
        assert_eq!(value["options"]["reference"]["track"], 1);
        // Writing into the subtitle's own folder: never over an existing file.
        assert_eq!(value["output"]["overwrite"], false);
        let first = engine_job(&job("k", "/s/a.srt"), &request);
        assert_eq!(first["options"]["reference"]["track"], 0);
    }

    #[test]
    fn picture_subtitles_are_refused() {
        assert!(is_image_subtitle("/s/movie.sup", None));
        assert!(is_image_subtitle("/s/movie.IDX", None));
        assert!(!is_image_subtitle("/s/movie.srt", None));
        assert!(!is_image_subtitle("/s/movie.sup", Some(0)));
    }

    fn done(report: Value, summary: &str, warnings: &[&str]) -> Value {
        serde_json::json!({
            "type": "subsJobDone", "job": 0, "id": "k", "task": "sync",
            "outputs": [{"path": "/s/MKVBatchMux synced/a.synced.en.srt", "kind": "subtitle"}],
            "report": report, "summary": summary, "warnings": warnings,
        })
    }

    /// What the engine reported for the test season's E01 subtitle, 2.5 s late.
    #[test]
    fn a_late_subtitle_measures_a_negative_delay() {
        let outcome = done(
            serde_json::json!({"offsetMs": -2578.1, "ratio": 1.0, "framerate": null, "splits": [], "score": 1.0,
                               "confidence": "high", "method": "audio"}),
            "Matched against the video's speech (high confidence, score 1.00): shifted by -2.578 s.",
            &[],
        );
        let parsed = parse_outcome(&outcome);
        assert!(parsed.applied);
        assert_eq!(parsed.offset_s, Some(-2.5781));
        assert_eq!(parsed.ratio, Some(1.0));
        assert_eq!(parsed.splits, 0);
        assert_eq!(parsed.method.as_deref(), Some("audio"));
        assert_eq!(parsed.retimed_path.as_deref(), Some("/s/MKVBatchMux synced/a.synced.en.srt"));
    }

    #[test]
    fn a_frame_rate_change_and_scene_splits_are_reported() {
        let outcome = done(
            serde_json::json!({"offsetMs": -72.3, "ratio": 1.0427083333333333, "framerate": "25 → 23.976",
                               "splits": [{"atS": 600.0, "offsetMs": 4100.0}], "score": 0.93, "confidence": "high", "method": "audio"}),
            "Matched …",
            &[],
        );
        let parsed = parse_outcome(&outcome);
        assert_eq!(parsed.ratio, Some(1.0427083333333333));
        assert_eq!(parsed.framerate.as_deref(), Some("25 → 23.976"));
        assert_eq!(parsed.splits, 1);
        assert_eq!(parsed.split_points, vec![SplitPoint { at_s: 600.0, offset_s: 4.1 }]);
    }

    #[test]
    fn only_an_unchanged_copy_this_run_made_is_removed() {
        let dir = tempfile::tempdir().unwrap();
        let subs = dir.path().join("Subs");
        let synced = subs.join(DEFAULT_FOLDER);
        std::fs::create_dir_all(&synced).unwrap();
        // E01's copy is from an earlier run (and may be muxed from); E02 has none yet.
        let earlier = synced.join("Show.S01E01.en.srt");
        std::fs::write(&earlier, "earlier run").unwrap();
        let e01 = job("a", &subs.join("Show.S01E01.en.srt").to_string_lossy());
        let e02 = job("b", &subs.join("Show.S01E02.en.srt").to_string_lossy());
        let request = request(SubsyncEngine::Audio, None);
        let before = existing_copies(&[&e01, &e02], &request);

        // The engine now writes both copies, and neither moved anything.
        let fresh = synced.join("Show.S01E02.en.srt");
        std::fs::write(&earlier, "unchanged").unwrap();
        std::fs::write(&fresh, "unchanged").unwrap();
        let outcome = |path: &Path| serde_json::json!({ "outputs": [{ "kind": "subtitle", "path": path.to_string_lossy() }] });
        discard_unchanged_copy(&outcome(&earlier), &e01, &request, &before);
        discard_unchanged_copy(&outcome(&fresh), &e02, &request, &before);
        assert!(earlier.exists(), "a copy an earlier run wrote is kept");
        assert!(!fresh.exists(), "the copy this run made is removed");
    }

    #[test]
    fn no_clear_match_applies_nothing() {
        let outcome = done(
            serde_json::json!({"offsetMs": 0.0, "ratio": 1.0, "splits": [], "score": 0.04, "confidence": "low", "method": "audio"}),
            "No clear match between the subtitle and the video's speech was found, so the timing was left as it was (score 0.04).",
            &["No clear match was found: this subtitle may belong to a different cut or episode, or the video has little clear speech."],
        );
        let parsed = parse_outcome(&outcome);
        assert!(!parsed.applied);
        assert_eq!(parsed.offset_s, None);
        assert_eq!(parsed.ratio, None);
        assert_eq!(parsed.retimed_path, None);
        assert_eq!(parsed.score, Some(0.04));
        let failed = parse_outcome(&serde_json::json!({"job": 0, "outputs": [], "report": {}, "summary": "", "error": "Subtitle not found: /x"}));
        assert!(!failed.applied);
        assert_eq!(failed.error.as_deref(), Some("Subtitle not found: /x"));
    }

    /// Real engine on the test season: `cargo test -- --ignored --nocapture`
    /// with AUDIOSYNC_REPO and MBM_TEST_MEDIA set and ffmpeg on PATH.
    mod real {
        use super::*;
        use crate::engine_link::testing::{media, truth, Recorder, TestEngine};

        fn measure(engine: SubsyncEngine, jobs: Vec<SubsyncJob>, out: &Path) -> Vec<ResultEvent> {
            let mut link = TestEngine::start();
            let sink = Recorder::default();
            let request = SubsyncRequest {
                run_id: "real".into(),
                jobs,
                engine,
                max_offset_s: 60.0,
                detect_framerate: true,
                allow_splits: true,
                output_dir: Some(out.to_string_lossy().into_owned()),
                max_workers: 2,
            };
            assert_eq!(run(&mut link, &sink, &AtomicBool::new(false), &request).unwrap(), RunEnd::default());
            let mut results: Vec<ResultEvent> = sink
                .named("subsync-result")
                .into_iter()
                .map(|value| ResultEvent {
                    key: value["key"].as_str().map(str::to_string),
                    offset_s: value["offsetS"].as_f64(),
                    ratio: value["ratio"].as_f64(),
                    splits: value["splits"].as_u64().unwrap_or(0) as usize,
                    score: value["score"].as_f64(),
                    retimed_path: value["retimedPath"].as_str().map(str::to_string),
                    error: value["error"].as_str().map(str::to_string),
                    applied: value["applied"].as_bool().unwrap_or(false),
                    description: value["description"].as_str().map(str::to_string),
                    ..Default::default()
                })
                .collect();
            results.sort_by(|a, b| a.key.cmp(&b.key));
            results
        }

        fn external(n: u32) -> SubsyncJob {
            let root = media();
            SubsyncJob {
                key: format!("e0{n}"),
                subtitle_path: root.join("Subs").join(format!("Show.S01E0{n}.en.srt")).to_string_lossy().into_owned(),
                subtitle_track: None,
                video_path: root.join("Show").join("Season 1").join(format!("Show.S01E0{n}.mkv")).to_string_lossy().into_owned(),
                audio_track: 0,
                reference_track: Some(0),
            }
        }

        /// The correctly timed track inside the video, measured the same way:
        /// what the speech detector makes of a subtitle that is right.
        fn inside(n: u32) -> SubsyncJob {
            let video = external(n).video_path;
            SubsyncJob { key: format!("in0{n}"), subtitle_path: video.clone(), subtitle_track: Some(0), ..external(n) }
        }

        #[test]
        #[ignore = "needs the engine, ffmpeg and the test media"]
        fn subtitle_delays_match_what_was_planted() {
            let truth = truth();
            let planted = |n: u32| -truth[format!("S01E0{n}")]["subShiftS"].as_f64().unwrap();
            let out = tempfile::tempdir().unwrap();

            let audio = measure(SubsyncEngine::Audio, vec![external(1), external(2), external(3), inside(1), inside(2)], out.path());
            for result in &audio {
                println!("audio    {:?}: offset {:?} s, ratio {:?}, score {:?}, retimed {:?}, {:?}", result.key, result.offset_s, result.ratio, result.score, result.retimed_path.is_some(), result.error);
            }
            let by = |key: &str| audio.iter().find(|r| r.key.as_deref() == Some(key)).unwrap().clone();
            for n in [1, 2] {
                let (measured, baseline) = (by(&format!("e0{n}")), by(&format!("in0{n}")));
                let (offset, bias) = (measured.offset_s.unwrap(), baseline.offset_s.unwrap());
                println!("E0{n} audio: {offset:+.3} s, speech-detector bias on the right timing {bias:+.3} s, corrected {:+.3} s, truth {:+.3} s", offset - bias, planted(n));
                assert!(((offset - bias) - planted(n)).abs() < 0.05);
                assert!((measured.ratio.unwrap() - 1.0).abs() < 1e-4 && measured.splits == 0);
            }
            assert!((by("e01").offset_s.unwrap() - planted(1)).abs() < 0.15);
            let e03 = by("e03");
            println!("E03 audio: ratio {:.6} (25/23.976 = {:.6}), offset {:+.3} s", e03.ratio.unwrap(), 25.0 / 23.976, e03.offset_s.unwrap());
            assert!((e03.ratio.unwrap() - 25.0 / 23.976).abs() < 1e-4);
            assert!(Path::new(e03.retimed_path.as_deref().unwrap()).is_file());

            let reference = measure(SubsyncEngine::Subtitle, vec![external(1), external(2)], out.path());
            for result in &reference {
                let n: u32 = result.key.as_deref().unwrap()[2..].parse().unwrap();
                println!("subtitle {:?}: offset {:+.4} s, truth {:+.3} s, score {:?}", result.key, result.offset_s.unwrap(), planted(n), result.score);
                assert!((result.offset_s.unwrap() - planted(n)).abs() < 0.05);
            }
        }
    }
}
