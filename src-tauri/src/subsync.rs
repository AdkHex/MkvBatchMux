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
//!
//! The engine reads text only, but it lines up when lines are shown, not what
//! they say. So a Blu-ray picture subtitle (PGS) goes in as a stand-in: an SRT
//! with the times its pictures are on screen (`pgs::timing_srt`). A plain
//! offset is then the PGS track's delay like any other; anything more moves
//! the PGS stream's own display sets to where the engine put each stand-in
//! line (`pgs::retime`), into a `.sup` copy. A PGS track inside the video can
//! be the reference the same way.

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::AppHandle;

use crate::audiosync::{ensure_unlocked, ffmpeg_available_for, EngineHandle};
use crate::engine_link::{spawn_engine_run, to_value, EngineLink, RunEnd, Sink};
use crate::pgs;

/// Folder the re-timed copies go to, beside each subtitle, unless the request names one.
pub const DEFAULT_FOLDER: &str = "MKVBatchMux synced";

/// The engine reports progress while it finds speech; this long a silence means it is wedged.
const IDLE_LIMIT: Duration = Duration::from_secs(600);

/// What the app shows for a DVD picture subtitle: only Blu-ray pictures (PGS) are synced.
pub const IMAGE_SUBTITLE: &str =
    "Can't be synced automatically: DVD subtitles (VobSub) are pictures, and only Blu-ray (PGS) pictures can be synced.";

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
    /// The subtitle is Blu-ray pictures (PGS), synced by when they are shown.
    /// A `.sup` file is taken for one without being told.
    #[serde(default)]
    pub subtitle_pictures: bool,
    /// The reference track inside the video is PGS.
    #[serde(default)]
    pub reference_pictures: bool,
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

fn extension_is(path: &str, wanted: &[&str]) -> bool {
    Path::new(path).extension().map(|ext| wanted.contains(&ext.to_string_lossy().to_ascii_lowercase().as_str())).unwrap_or(false)
}

/// Whether a subtitle file is DVD pictures (VobSub), which nothing here syncs.
pub(crate) fn is_image_subtitle(path: &str, track: Option<i64>) -> bool {
    track.is_none() && extension_is(path, &["sub", "idx"])
}

/// Whether a job's subtitle is Blu-ray pictures (PGS).
pub(crate) fn is_pgs(job: &SubsyncJob) -> bool {
    job.subtitle_pictures || (job.subtitle_track.is_none() && extension_is(&job.subtitle_path, &["sup"]))
}

/// What a job sends the engine in place of PGS: the stand-in SRTs, in a
/// folder of their own that goes when the run ends.
pub(crate) struct Prepared {
    work: tempfile::TempDir,
    /// The subtitle's own stream and lines, when it is PGS, and its stand-in.
    pictures: Option<(pgs::Sup, Vec<pgs::Line>, PathBuf)>,
    /// The stand-in of a PGS reference track.
    reference: Option<PathBuf>,
}

impl Prepared {
    /// The folder the engine writes its copy of a stand-in to.
    fn work_dir(&self) -> &Path {
        self.work.path()
    }
}

fn stem_of(path: &str, track: Option<i64>) -> String {
    let stem = Path::new(path).file_stem().map(|stem| stem.to_string_lossy().to_string()).unwrap_or_else(|| "subtitle".to_string());
    match track {
        Some(track) => format!("{stem}.track{}", track + 1),
        None => stem,
    }
}

/// Read a PGS stream (a `.sup`, or a track copied out of a container) and
/// write its stand-in SRT beside it in `work`.
fn read_pictures(path: &str, track: Option<i64>, name: &str, work: &Path, cancel: &AtomicBool, percent: &mut dyn FnMut(u64)) -> Result<(pgs::Sup, Vec<pgs::Line>, PathBuf), String> {
    let source = match track {
        None => PathBuf::from(path),
        Some(track) => {
            let into = work.join(format!("{name}.sup"));
            pgs::extract(Path::new(path), track.max(0) as usize, &into, cancel, |value| percent(value))?;
            into
        }
    };
    let bytes = std::fs::read(&source).map_err(|error| format!("Could not read {}: {error}", source.display()))?;
    let sup = pgs::parse(bytes)?;
    let lines = pgs::lines(&sup.sets);
    let timing = pgs::timing_srt(&lines);
    if timing.is_empty() {
        return Err("The PGS subtitle never shows a line.".to_string());
    }
    let stand_in = work.join(format!("{name}.srt"));
    std::fs::write(&stand_in, timing).map_err(|error| format!("Could not write {}: {error}", stand_in.display()))?;
    Ok((sup, lines, stand_in))
}

/// Ready a job whose subtitle or reference is PGS; None for one that is all text.
fn prepare(job: &SubsyncJob, request: &SubsyncRequest, cancel: &AtomicBool, percent: &mut dyn FnMut(u64)) -> Result<Option<Prepared>, String> {
    let pictures = is_pgs(job);
    let reference = request.engine == SubsyncEngine::Subtitle && job.reference_pictures;
    if !pictures && !reference {
        return Ok(None);
    }
    let work = tempfile::Builder::new().prefix("mkvbatchmux-pgs-").tempdir().map_err(|error| format!("Could not make a work folder: {error}"))?;
    let mut prepared = Prepared { work, pictures: None, reference: None };
    if pictures {
        let name = stem_of(&job.subtitle_path, job.subtitle_track);
        prepared.pictures = Some(read_pictures(&job.subtitle_path, job.subtitle_track, &name, prepared.work.path(), cancel, percent)?);
    }
    if reference {
        let track = Some(job.reference_track.unwrap_or(0).max(0));
        let (_, _, stand_in) = read_pictures(&job.video_path, track, "reference", prepared.work.path(), cancel, percent)
            .map_err(|error| format!("The video's subtitle track: {error}"))?;
        prepared.reference = Some(stand_in);
    }
    Ok(Some(prepared))
}

/// Where a PGS subtitle's re-timed copy goes: beside the text copies, named
/// like them, never over a file of its own folder.
fn pictures_copy_path(job: &SubsyncJob, request: &SubsyncRequest) -> PathBuf {
    let (folder, overwrite) = output_folder(request.output_dir.as_deref(), Path::new(&job.subtitle_path));
    let stem = format!("{}.synced", stem_of(&job.subtitle_path, job.subtitle_track));
    let candidate = folder.join(format!("{stem}.sup"));
    if overwrite || !candidate.exists() {
        return candidate;
    }
    (2..).map(|n| folder.join(format!("{stem} ({n}).sup"))).find(|path| !path.exists()).expect("a free name")
}

/// Move the PGS stream's display sets to where the engine put each stand-in
/// line (its copy at `engine_copy`), into a `.sup` copy; its path.
fn write_pictures_copy(job: &SubsyncJob, request: &SubsyncRequest, pictures: &(pgs::Sup, Vec<pgs::Line>, PathBuf), engine_copy: Option<&str>) -> Result<String, String> {
    let (sup, lines, _) = pictures;
    let engine_copy = engine_copy.ok_or("The engine wrote no re-timed copy.")?;
    let text = std::fs::read_to_string(engine_copy).map_err(|error| format!("Could not read the engine's re-timed copy: {error}"))?;
    let placed = pgs::read_timing_srt(&text);
    let bytes = pgs::retime(sup, lines, &placed)?;
    let path = pictures_copy_path(job, request);
    if let Some(folder) = path.parent() {
        std::fs::create_dir_all(folder).map_err(|error| format!("Could not make {}: {error}", folder.display()))?;
    }
    std::fs::write(&path, bytes).map_err(|error| format!("Could not write {}: {error}", path.display()))?;
    Ok(path.to_string_lossy().to_string())
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
#[cfg(test)]
pub(crate) fn engine_job(job: &SubsyncJob, request: &SubsyncRequest) -> Value {
    engine_job_with(job, request, None)
}

/// The engine's job, with the stand-ins of anything PGS in it.
fn engine_job_with(job: &SubsyncJob, request: &SubsyncRequest, prepared: Option<&Prepared>) -> Value {
    let (mut folder, mut overwrite) = output_folder(request.output_dir.as_deref(), Path::new(&job.subtitle_path));
    let mut subtitle = serde_json::json!({ "path": job.subtitle_path });
    if let Some(track) = job.subtitle_track {
        subtitle["track"] = Value::from(track);
    }
    let stand_in = prepared.and_then(|prepared| prepared.pictures.as_ref().map(|(_, _, srt)| (prepared.work_dir(), srt)));
    if let Some((work, srt)) = stand_in {
        // The engine's copy of a stand-in is read back here, never muxed.
        subtitle = serde_json::json!({ "path": srt.to_string_lossy() });
        folder = work.to_path_buf();
        overwrite = true;
    }
    let mut options = serde_json::json!({
        "engine": match request.engine { SubsyncEngine::Audio => "audio", SubsyncEngine::Subtitle => "subtitle" },
        "maxOffsetS": request.max_offset_s,
        "detectFramerate": request.detect_framerate,
        "allowSplits": request.allow_splits,
    });
    if request.engine == SubsyncEngine::Subtitle {
        options["reference"] = match prepared.and_then(|prepared| prepared.reference.as_ref()) {
            Some(srt) => serde_json::json!({ "path": srt.to_string_lossy() }),
            None => serde_json::json!({ "path": job.video_path, "track": job.reference_track.unwrap_or(0).max(0) }),
        };
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

pub(crate) fn batch_payload(jobs: &[(&SubsyncJob, Option<&Prepared>)], request: &SubsyncRequest) -> Value {
    serde_json::json!({
        "command": "subsBatch",
        "maxWorkers": request.max_workers.max(1),
        "jobs": jobs.iter().map(|(job, prepared)| engine_job_with(job, request, *prepared)).collect::<Vec<_>>(),
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

    // DVD pictures are refused here, without a round trip to the engine; PGS
    // is read for its timing first.
    let mut sent: Vec<&SubsyncJob> = Vec::new();
    let mut prepared: Vec<Option<Prepared>> = Vec::new();
    for job in &request.jobs {
        if cancel.load(Ordering::SeqCst) {
            return Ok(RunEnd { cancelled: true, error: None });
        }
        if is_image_subtitle(&job.subtitle_path, job.subtitle_track) {
            result(&job.key, ResultEvent { error: Some(IMAGE_SUBTITLE.to_string()), ..Default::default() }, &mut processed);
            continue;
        }
        if is_pgs(job) || (request.engine == SubsyncEngine::Subtitle && job.reference_pictures) {
            progress(&job.key, 0, Some("Reading the pictures' timing"), processed);
        }
        let mut percent = |value: u64| progress(&job.key, value.min(99), Some("Reading the pictures' timing"), processed);
        match prepare(job, request, cancel, &mut percent) {
            Ok(ready) => {
                sent.push(job);
                prepared.push(ready);
            }
            Err(_) if cancel.load(Ordering::SeqCst) => return Ok(RunEnd { cancelled: true, error: None }),
            Err(error) => result(&job.key, ResultEvent { error: Some(error), ..Default::default() }, &mut processed),
        }
    }
    if sent.is_empty() {
        return Ok(RunEnd::default());
    }
    if cancel.load(Ordering::SeqCst) {
        return Ok(RunEnd { cancelled: true, error: None });
    }

    let before = existing_copies(&sent, request);
    let jobs: Vec<(&SubsyncJob, Option<&Prepared>)> = sent.iter().copied().zip(prepared.iter().map(Option::as_ref)).collect();
    link.send(&batch_payload(&jobs, request))?;
    let mut fatal: Option<String> = None;
    loop {
        let value = link.recv(IDLE_LIMIT)?;
        let index = value.get("job").and_then(Value::as_u64).map(|job| job as usize);
        let job = index.and_then(|index| sent.get(index).copied());
        let pictures = index.and_then(|index| prepared.get(index)).and_then(Option::as_ref).and_then(|ready| ready.pictures.as_ref());
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
                    if let Some(pictures) = pictures {
                        // The engine's copy is of the stand-in: the pictures
                        // themselves move only when a delay is not enough.
                        let engine_copy = parsed.retimed_path.take();
                        if parsed.applied && !plain_offset {
                            match write_pictures_copy(job, request, pictures, engine_copy.as_deref()) {
                                Ok(path) => parsed.retimed_path = Some(path),
                                Err(error) => {
                                    parsed.error = Some(format!("Could not re-time the pictures: {error}"));
                                    parsed.applied = false;
                                }
                            }
                        }
                    } else {
                        if !parsed.applied || plain_offset {
                            discard_unchanged_copy(&value, job, request, &before);
                        }
                        if plain_offset {
                            parsed.retimed_path = None;
                        }
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
            subtitle_pictures: false,
            reference_pictures: false,
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
    fn dvd_pictures_are_refused_and_blu_ray_pictures_are_synced() {
        assert!(is_image_subtitle("/s/movie.IDX", None));
        assert!(is_image_subtitle("/s/movie.sub", None));
        assert!(!is_image_subtitle("/s/movie.sup", None));
        assert!(!is_image_subtitle("/s/movie.srt", None));
        assert!(is_pgs(&job("k", "/s/movie.SUP")));
        assert!(!is_pgs(&job("k", "/s/movie.srt")));
        let inside = SubsyncJob { subtitle_track: Some(2), subtitle_pictures: true, ..job("k", "/s/remux.mkv") };
        assert!(is_pgs(&inside));
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

    // ------------------------------------------------------------- pictures

    use crate::engine_link::testing::Recorder;
    use std::collections::VecDeque;

    /// An engine that moves every stand-in line by `video = ratio * t + offset`
    /// (dropping the lines `drop` names) and reports that, as the real one does.
    struct FakeEngine {
        ratio: f64,
        offset_ms: f64,
        drop: Vec<usize>,
        sent: Vec<Value>,
        queue: VecDeque<Value>,
    }

    impl FakeEngine {
        fn new(ratio: f64, offset_ms: f64) -> Self {
            Self { ratio, offset_ms, drop: vec![], sent: vec![], queue: VecDeque::new() }
        }
    }

    impl EngineLink for FakeEngine {
        fn send(&mut self, payload: &Value) -> Result<(), String> {
            self.sent.push(payload.clone());
            for (index, job) in payload["jobs"].as_array().unwrap().iter().enumerate() {
                let path = job["input"]["subtitle"]["path"].as_str().unwrap();
                let text = std::fs::read_to_string(path).unwrap();
                let mut out = String::new();
                for (n, (line, (start, end))) in {
                    let mut placed: Vec<_> = pgs::read_timing_srt(&text).into_iter().collect();
                    placed.sort();
                    placed
                }
                .into_iter()
                .enumerate()
                {
                    if self.drop.contains(&line) {
                        continue;
                    }
                    let at = |ms: i64| {
                        let ms = (ms as f64 * self.ratio + self.offset_ms).round() as i64;
                        format!("{:02}:{:02}:{:02},{:03}", ms / 3_600_000, ms / 60_000 % 60, ms / 1000 % 60, ms % 1000)
                    };
                    out.push_str(&format!("{}\n{} --> {}\nline {line}\n\n", n + 1, at(start), at(end)));
                }
                let dir = Path::new(job["output"]["dir"].as_str().unwrap());
                std::fs::create_dir_all(dir).unwrap();
                let copy = dir.join(format!("{}.synced.srt", Path::new(path).file_stem().unwrap().to_string_lossy()));
                std::fs::write(&copy, out).unwrap();
                self.queue.push_back(serde_json::json!({
                    "type": "subsJobDone", "job": index, "id": job["id"],
                    "outputs": [{ "path": copy.to_string_lossy(), "kind": "subtitle" }],
                    "report": { "offsetMs": self.offset_ms, "ratio": self.ratio, "splits": [], "score": 1.0, "confidence": "high", "method": "audio" },
                    "summary": "Matched", "warnings": [],
                }));
            }
            self.queue.push_back(serde_json::json!({ "type": "subsBatchDone" }));
            Ok(())
        }

        fn recv(&mut self, _timeout: Duration) -> Result<Value, String> {
            self.queue.pop_front().ok_or_else(|| "nothing more".to_string())
        }
    }

    fn picture_request(jobs: Vec<SubsyncJob>) -> SubsyncRequest {
        SubsyncRequest { jobs, ..request(SubsyncEngine::Audio, None) }
    }

    fn results(sink: &Recorder) -> HashMap<String, Value> {
        sink.named("subsync-result").into_iter().map(|value| (value["key"].as_str().unwrap().to_string(), value)).collect()
    }

    #[test]
    fn a_pgs_file_goes_to_the_engine_as_its_timing_and_a_plain_offset_is_its_delay() {
        let dir = tempfile::tempdir().unwrap();
        let sup = dir.path().join("Show.S01E01.sup");
        std::fs::write(&sup, pgs::testing::sup(&[(1000, 2000), (3000, 4500), (6000, 7000)], &[])).unwrap();
        let mut engine = FakeEngine::new(1.0, -2500.0);
        let sink = Recorder::default();
        let request = picture_request(vec![job("e01", &sup.to_string_lossy())]);
        assert_eq!(run(&mut engine, &sink, &AtomicBool::new(false), &request).unwrap(), RunEnd::default());

        let sent = &engine.sent[0]["jobs"][0];
        let stand_in = PathBuf::from(sent["input"]["subtitle"]["path"].as_str().unwrap());
        assert_eq!(stand_in.file_name().unwrap(), "Show.S01E01.srt");
        assert!(!stand_in.starts_with(dir.path()), "the stand-in is not left beside the subtitle");
        assert!(!stand_in.exists(), "the work folder goes when the run ends");
        let result = &results(&sink)["e01"];
        assert_eq!(result["offsetS"], -2.5);
        assert_eq!(result["applied"], true);
        assert!(result["retimedPath"].is_null(), "{result}");
        assert!(!dir.path().join(DEFAULT_FOLDER).exists(), "no copy for a plain delay");
    }

    #[test]
    fn a_frame_rate_change_writes_a_re_timed_sup_beside_the_text_copies() {
        let dir = tempfile::tempdir().unwrap();
        let sup = dir.path().join("Show.S01E03.sup");
        std::fs::write(&sup, pgs::testing::sup(&[(10_000, 12_000), (20_000, 21_000), (30_000, 31_000)], &[0])).unwrap();
        let ratio = 25.0 / 23.976;
        let mut engine = FakeEngine::new(ratio, 100.0);
        engine.drop = vec![1];
        let sink = Recorder::default();
        run(&mut engine, &sink, &AtomicBool::new(false), &picture_request(vec![job("e03", &sup.to_string_lossy())])).unwrap();

        let result = &results(&sink)["e03"];
        let copy = PathBuf::from(result["retimedPath"].as_str().unwrap_or_else(|| panic!("{result}")));
        assert_eq!(copy, dir.path().join(DEFAULT_FOLDER).join("Show.S01E03.synced.sup"));
        let sets: Vec<i64> = pgs::parse(std::fs::read(&copy).unwrap()).unwrap().sets.iter().map(|set| (set.pts / 90) as i64).collect();
        let at = |ms: f64| (ms * ratio + 100.0).round() as i64;
        // Line 0 (with its fade), line 1 dropped by the engine (moves with line 0), line 2.
        let shift0 = at(10_000.0) - 10_000;
        assert_eq!(sets, vec![at(10_000.0), (11_000.0 * ratio + 100.0).round() as i64, at(12_000.0), 20_000 + shift0, 21_000 + shift0, at(30_000.0), at(31_000.0)]);
    }

    #[test]
    fn what_cannot_be_read_fails_alone_and_dvd_pictures_are_refused() {
        let dir = tempfile::tempdir().unwrap();
        let broken = dir.path().join("broken.sup");
        std::fs::write(&broken, b"not pgs at all").unwrap();
        let good = dir.path().join("good.sup");
        std::fs::write(&good, pgs::testing::sup(&[(1000, 2000), (3000, 4000)], &[])).unwrap();
        let idx = dir.path().join("dvd.idx");
        let mut engine = FakeEngine::new(1.0, 500.0);
        let sink = Recorder::default();
        let jobs = vec![job("broken", &broken.to_string_lossy()), job("good", &good.to_string_lossy()), job("dvd", &idx.to_string_lossy())];
        run(&mut engine, &sink, &AtomicBool::new(false), &picture_request(jobs)).unwrap();
        let results = results(&sink);
        assert!(results["broken"]["error"].as_str().unwrap().contains("not a Blu-ray"), "{}", results["broken"]);
        assert_eq!(results["dvd"]["error"], IMAGE_SUBTITLE);
        assert_eq!(results["good"]["offsetS"], 0.5);
        assert_eq!(engine.sent[0]["jobs"].as_array().unwrap().len(), 1);
    }

    #[test]
    fn a_pgs_reference_goes_to_the_engine_as_its_timing_too() {
        let dir = tempfile::tempdir().unwrap();
        let work = tempfile::tempdir().unwrap();
        let reference = work.path().join("reference.srt");
        std::fs::write(&reference, "1\n00:00:01,000 --> 00:00:02,000\nline 0\n\n").unwrap();
        let prepared = Prepared { work, pictures: None, reference: Some(reference.clone()) };
        let mut text = job("k", &dir.path().join("a.srt").to_string_lossy());
        text.reference_track = Some(1);
        text.reference_pictures = true;
        let value = engine_job_with(&text, &request(SubsyncEngine::Subtitle, None), Some(&prepared));
        assert_eq!(value["options"]["reference"], serde_json::json!({ "path": reference.to_string_lossy() }));
        // The text subtitle itself goes as it is, its copy beside it as always.
        assert_eq!(value["input"]["subtitle"]["path"], text.subtitle_path.as_str());
        assert_eq!(value["output"]["dir"], dir.path().join(DEFAULT_FOLDER).to_string_lossy().as_ref());
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
                subtitle_pictures: false,
                reference_pictures: false,
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

        /// E0n's subtitle as Blu-ray pictures, with the same timing, in `dir`.
        fn pictures_of(n: u32, dir: &Path) -> PathBuf {
            let srt = std::fs::read_to_string(external(n).subtitle_path).unwrap();
            let sup = dir.join(format!("Show.S01E0{n}.en.sup"));
            std::fs::write(&sup, pgs::testing::sup(&pgs::testing::srt_times(&srt), &[])).unwrap();
            sup
        }

        fn tool(program: &str, args: &[std::ffi::OsString]) {
            let status = crate::hidden_command(program).args(args).stdout(std::process::Stdio::null()).status().unwrap();
            assert!(status.code().is_some_and(|code| code <= 1), "{program} failed: {status}");
        }

        /// The test season's subtitles as PGS, a `.sup` and inside an `.mks`,
        /// measured the same as the text they came from; E03's frame-rate fix
        /// moves the pictures where the video's own track has its lines; and a
        /// PGS track inside the video is a reference like a text one.
        #[test]
        #[ignore = "needs the engine, ffmpeg, mkvmerge, mkvextract and the test media"]
        fn pictures_sync_by_their_timing() {
            let truth = truth();
            let planted = |n: u32| -truth[format!("S01E0{n}")]["subShiftS"].as_f64().unwrap();
            let dir = tempfile::tempdir().unwrap();
            let out = dir.path().join("out");
            let os = |path: &Path| path.as_os_str().to_owned();
            let arg = |text: &str| std::ffi::OsString::from(text);

            let as_pictures = |n: u32| SubsyncJob { key: format!("p0{n}"), subtitle_path: pictures_of(n, dir.path()).to_string_lossy().into_owned(), ..external(n) };
            let mks = dir.path().join("Show.S01E01.subs.mks");
            tool("mkvmerge", &[arg("-q"), arg("-o"), os(&mks), os(&pictures_of(1, dir.path()))]);
            let inside_mks = SubsyncJob { key: "m01".into(), subtitle_path: mks.to_string_lossy().into_owned(), subtitle_track: Some(0), subtitle_pictures: true, ..external(1) };

            // Against the video's own (text) track: as exact as the text.
            let reference = measure(SubsyncEngine::Subtitle, vec![external(1), as_pictures(1), inside_mks.clone(), as_pictures(2)], &out);
            let by = |results: &[ResultEvent], key: &str| results.iter().find(|r| r.key.as_deref() == Some(key)).unwrap_or_else(|| panic!("no {key}")).clone();
            for result in &reference {
                println!("subtitle engine {:?}: offset {:?}, ratio {:?}, score {:?}, copy {:?}, error {:?}", result.key, result.offset_s, result.ratio, result.score, result.retimed_path, result.error);
            }
            let text = by(&reference, "e01").offset_s.unwrap();
            for key in ["p01", "m01"] {
                let result = by(&reference, key);
                assert!(result.error.is_none() && result.applied, "{result:?}");
                assert!((result.offset_s.unwrap() - text).abs() < 0.002, "{key}: {:?} against the text's {text}", result.offset_s);
                assert!((result.offset_s.unwrap() - planted(1)).abs() < 0.05);
                assert!(result.retimed_path.is_none(), "a plain delay needs no copy");
            }
            assert!((by(&reference, "p02").offset_s.unwrap() - planted(2)).abs() < 0.05);

            // E03, timed for 25 fps (its video has no subtitle track: by speech):
            // the pictures land where the engine's re-timed text puts its lines.
            let speech = measure(SubsyncEngine::Audio, vec![external(3), as_pictures(3)], &out);
            for result in &speech {
                println!("audio engine {:?}: offset {:?}, ratio {:?}, score {:?}, copy {:?}, error {:?}", result.key, result.offset_s, result.ratio, result.score, result.retimed_path, result.error);
            }
            let (e03_text, e03) = (by(&speech, "e03"), by(&speech, "p03"));
            assert!((e03.ratio.unwrap() - 25.0 / 23.976).abs() < 1e-4, "{e03:?}");
            assert!((e03.offset_s.unwrap() - e03_text.offset_s.unwrap()).abs() < 0.002, "{e03:?} against {e03_text:?}");
            let copy = PathBuf::from(e03.retimed_path.clone().unwrap());
            assert_eq!(copy.extension().unwrap(), "sup");
            let video = PathBuf::from(external(3).video_path);
            let wanted: Vec<(u32, u32)> = pgs::testing::srt_times(&std::fs::read_to_string(e03_text.retimed_path.unwrap()).unwrap());
            let moved = pgs::parse(std::fs::read(&copy).unwrap()).unwrap();
            let got: Vec<(u32, u32)> = pgs::lines(&moved.sets).iter().map(|line| (line.start / 90, line.end / 90)).collect();
            assert_eq!(got.len(), wanted.len());
            let worst = got.iter().zip(&wanted).map(|(a, b)| (a.0 as i64 - b.0 as i64).abs().max((a.1 as i64 - b.1 as i64).abs())).max().unwrap();
            println!("E03 copy: {} lines, ratio {:.6}, worst {worst} ms from the engine's re-timed text", got.len(), e03.ratio.unwrap());
            assert!(worst <= 1, "{got:?} against {wanted:?}");
            // mkvmerge muxes the copy.
            let muxed = dir.path().join("E03.muxed.mkv");
            tool("mkvmerge", &[arg("-q"), arg("-o"), os(&muxed), os(&video), os(&copy)]);
            let info = crate::hidden_command("mkvmerge").arg("-J").arg(&muxed).output().unwrap();
            let json: Value = serde_json::from_slice(&info.stdout).unwrap();
            assert!(json["tracks"].as_array().unwrap().iter().any(|track| track["codec"].as_str().is_some_and(|codec| codec.contains("PGS"))));

            // A video whose own subtitle is PGS: the reference by its timing.
            let pgs_video = dir.path().join("Show.S01E01.pgs.mkv");
            let inside_e01 = dir.path().join("inside01.srt");
            tool("mkvextract", &[arg(&external(1).video_path), arg("tracks"), format!("2:{}", inside_e01.display()).into()]);
            let reference_sup = dir.path().join("inside01.sup");
            std::fs::write(&reference_sup, pgs::testing::sup(&pgs::testing::srt_times(&std::fs::read_to_string(&inside_e01).unwrap()), &[])).unwrap();
            tool("mkvmerge", &[arg("-q"), arg("-o"), os(&pgs_video), arg("-S"), arg(&external(1).video_path), os(&reference_sup)]);
            let against_pictures = |job: SubsyncJob| SubsyncJob { video_path: pgs_video.to_string_lossy().into_owned(), reference_track: Some(0), reference_pictures: true, ..job };
            let pictures = measure(SubsyncEngine::Subtitle, vec![against_pictures(external(1)), against_pictures(as_pictures(1))], &out);
            for result in &pictures {
                println!("PGS reference {:?}: offset {:?}, score {:?}, error {:?}", result.key, result.offset_s, result.score, result.error);
                assert!((result.offset_s.unwrap() - planted(1)).abs() < 0.05, "{result:?}");
            }
        }
    }
}
