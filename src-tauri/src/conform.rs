//! Conform a dub made for a different cut of the video: lay its stretches back
//! where the video has them, from the engine's Dub sync plan (the same plan the
//! timeline scan shows), and write the result as a new file beside the dub.
//!
//! Two ways, chosen per run:
//!
//! * `render` (default): the engine writes the track, sample-accurate,
//!   re-encoded in the dub's own codec at its bitrate (or FLAC), and checks the
//!   finished track against the video itself.
//! * `lossless`: MKVBatchMux cuts the dub's own frames with mkvmerge and fills
//!   what the dub lacks with silence in its codec (see `lossless`), then has the
//!   engine plan the result against the video again: every stretch must sit
//!   within one codec frame. A dub that cannot be cut that way (another speed,
//!   a lossless or exotic codec) is rendered instead, and the result says why.
//!
//! The source dub is never written to.

mod lossless;

use std::collections::{BTreeMap, HashMap};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::AppHandle;

use crate::audiosync::{ensure_unlocked, ffmpeg_available_for, ffmpeg_tool, EngineHandle, MeasurePair};
use crate::engine_link::{spawn_engine_run, to_value, EngineLink, RunEnd, Sink};
pub(crate) use lossless::Tools;
// The plan reader, for verify's full-timeline sync check.
pub(crate) use lossless::{plan_segments, PlanSegment};
use lossless::{codec_label, probe_stream, CutError};

/// Folder the conformed files go to, beside each dub, unless the request names one.
pub const DEFAULT_FOLDER: &str = "MKVBatchMux conformed";

/// Beyond this the engine is wedged: it reports progress every few seconds
/// while it decodes, renders or checks.
const IDLE_LIMIT: Duration = Duration::from_secs(600);

/// Where lip-sync error becomes visible; the engine's own verification uses it.
const LIP_SYNC_VISIBLE_MS: f64 = 45.0;

#[derive(Debug, Deserialize, Serialize, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum ConformMode {
    Render,
    Lossless,
}

#[derive(Debug, Deserialize, Serialize, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum ConformCodec {
    /// The dub's own codec at its bitrate, or FLAC where there is no encoder for it.
    Same,
    Flac,
}

fn default_workers() -> i64 {
    2
}

#[derive(Debug, Deserialize, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ConformRequest {
    pub run_id: String,
    /// Video as primary, dub as secondary, with the audio-stream indexes
    /// measurement uses (the N of `0:a:N`).
    pub pairs: Vec<MeasurePair>,
    pub mode: ConformMode,
    pub codec: ConformCodec,
    /// Null: a `MKVBatchMux conformed` folder beside each dub.
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

/// One pair's outcome. `mode` is how it was actually written: a lossless
/// request that had to be rendered says `render`, with `fallbackReason`.
#[derive(Debug, Serialize, Clone, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ResultEvent {
    run_id: String,
    key: Option<String>,
    output_path: Option<String>,
    mode: String,
    codec: Option<String>,
    verified: Option<bool>,
    verification_text: Option<String>,
    /// Engine convention (positive = the dub plays late), in ms: the stretch
    /// furthest from the video in the check.
    residual_ms: Option<f64>,
    plan: Option<Value>,
    description: Option<String>,
    error: Option<String>,
    fallback_reason: Option<String>,
}

/// Lay each dub onto its video's cut and write it as a new file.
#[tauri::command]
pub fn conform_dubs_start(
    app: AppHandle,
    engine: tauri::State<'_, EngineHandle>,
    request: ConformRequest,
) -> Result<(), String> {
    ensure_unlocked(&app)?;
    if !ffmpeg_available_for(&app) {
        return Err(
            "FFmpeg was not found. Install FFmpeg and make sure ffmpeg and ffprobe are on your PATH."
                .to_string(),
        );
    }
    if request.pairs.is_empty() {
        return Err("There is nothing to conform.".to_string());
    }
    if request.mode == ConformMode::Lossless && !crate::tool_available("mkvmerge", "-V") {
        return Err("mkvmerge was not found. Install MKVToolNix, or conform by re-encoding.".to_string());
    }
    let tools = Tools {
        mkvmerge: "mkvmerge".to_string(),
        ffmpeg: ffmpeg_tool(&app, "ffmpeg"),
        ffprobe: ffmpeg_tool(&app, "ffprobe"),
    };
    Sink::emit(
        &app,
        "audiosync-log",
        Value::String(format!(
            "Conforming {} dub(s) to their video's cut ({})",
            request.pairs.len(),
            match request.mode {
                ConformMode::Render => "re-encoded, to the sample",
                ConformMode::Lossless => "lossless, to the frame",
            }
        )),
    );
    let run_id = request.run_id.clone();
    spawn_engine_run(app, (*engine).clone(), run_id, "conform-done", move |engine, app, cancel| {
        run(engine, app, &tools, cancel, &request)
    });
    Ok(())
}

/// The whole run, against any engine and any sink (the app's, or a test's).
/// Returns `Err` only when the engine itself failed.
pub(crate) fn run<L: EngineLink, S: Sink>(
    link: &mut L,
    sink: &S,
    tools: &Tools,
    cancel: &AtomicBool,
    request: &ConformRequest,
) -> Result<RunEnd, String> {
    let mut report = Reporter { sink, run_id: request.run_id.clone(), total: request.pairs.len(), processed: 0 };
    let pairs: Vec<(MeasurePair, Option<String>)> = request.pairs.iter().map(|pair| (pair.clone(), None)).collect();
    let mut names = OutputNames::new(&request.pairs);
    let end = match request.mode {
        ConformMode::Render => render(link, &mut report, tools, cancel, request, &mut names, &pairs)?,
        ConformMode::Lossless => lossless_run(link, &mut report, tools, cancel, request, &mut names)?,
    };
    Ok(RunEnd { cancelled: end.cancelled || cancel.load(Ordering::SeqCst), error: end.error })
}

struct Reporter<'a, S: Sink> {
    sink: &'a S,
    run_id: String,
    total: usize,
    processed: usize,
}

impl<S: Sink> Reporter<'_, S> {
    fn progress(&self, key: &str, percent: u64, stage: Option<&str>) {
        self.sink.emit(
            "conform-progress",
            to_value(&ProgressEvent {
                run_id: self.run_id.clone(),
                key: Some(key.to_string()),
                percent: percent.min(100),
                stage: stage.map(str::to_string),
                processed: self.processed,
                total: self.total,
            }),
        );
    }

    fn result(&mut self, key: &str, mut event: ResultEvent) {
        event.run_id = self.run_id.clone();
        event.key = Some(key.to_string());
        self.sink.emit("conform-result", to_value(&event));
        self.processed += 1;
        self.progress(key, 100, None);
    }

    fn log(&self, message: &str) {
        self.sink.emit("audiosync-log", Value::String(message.to_string()));
    }
}

// ---------------------------------------------------------------- the engine

/// What one job of a `dubsyncBatch` came to.
#[derive(Debug, Clone, Default)]
struct JobOutcome {
    plan: Option<Value>,
    description: Option<String>,
    /// The `dubsyncJobDone` event itself: output, verification, error.
    done: Option<Value>,
}

impl JobOutcome {
    fn error(&self) -> Option<String> {
        self.done.as_ref().and_then(|done| done.get("error")).and_then(Value::as_str).map(str::to_string)
    }

    fn plan(&self) -> Option<Value> {
        self.plan.clone().or_else(|| self.done.as_ref().and_then(|done| done.get("plan")).filter(|plan| !plan.is_null()).cloned())
    }
}

struct Batch {
    jobs: Vec<JobOutcome>,
    cancelled: bool,
    fatal: Option<String>,
}

/// Send one `dubsyncBatch` and follow it to `dubsyncBatchDone`. Jobs are
/// numbered in the order they were sent; `on_done` hears each as it finishes.
fn engine_batch<L: EngineLink, S: Sink>(
    link: &mut L,
    report: &Reporter<S>,
    payload: &Value,
    count: usize,
    mut on_progress: impl FnMut(usize, u64, Option<&str>),
    mut on_done: impl FnMut(usize, &JobOutcome),
) -> Result<Batch, String> {
    link.send(payload)?;
    let mut jobs = vec![JobOutcome::default(); count];
    let mut fatal: Option<String> = None;
    loop {
        let value = link.recv(IDLE_LIMIT)?;
        let job = value.get("job").and_then(Value::as_u64).map(|job| job as usize).filter(|&job| job < count);
        match value.get("type").and_then(Value::as_str) {
            Some("dubsyncJobProgress") => {
                if let Some(job) = job {
                    let percent = value.get("percent").and_then(Value::as_u64).unwrap_or(0);
                    on_progress(job, percent, value.get("stage").and_then(Value::as_str));
                }
            }
            Some("dubsyncJobPlan") => {
                if let Some(job) = job {
                    jobs[job].plan = value.get("plan").cloned();
                    jobs[job].description = value.get("description").and_then(Value::as_str).map(str::to_string);
                }
            }
            Some("dubsyncJobDone") => {
                if let Some(job) = job {
                    jobs[job].done = Some(value.clone());
                    on_done(job, &jobs[job]);
                }
            }
            Some("dubsyncJobLog") | Some("log") => {
                if let Some(message) = value.get("message").and_then(Value::as_str) {
                    report.log(message);
                }
            }
            Some("error") => {
                let message = value.get("message").and_then(Value::as_str).unwrap_or("The analysis engine reported an error.");
                report.log(message);
                if value.get("fatal").and_then(Value::as_bool).unwrap_or(false) {
                    fatal = Some(message.to_string());
                }
            }
            Some("dubsyncBatchDone") => {
                let cancelled = value.get("cancelled").and_then(Value::as_bool).unwrap_or(false);
                let error = fatal.or_else(|| value.get("error").and_then(Value::as_str).map(str::to_string));
                return Ok(Batch { jobs, cancelled, fatal: error });
            }
            _ => {}
        }
    }
}

/// The engine's dub sync, told to stop once each pair is planned: the timeline
/// scan's request (`audiosync::timeline_scan_payload`), so a plan here is the
/// one the scan showed.
pub(crate) fn plan_payload(jobs: &[(String, String, i64, i64)], max_workers: i64) -> Value {
    serde_json::json!({
        "command": "dubsyncBatch",
        "jobs": jobs.iter().map(|(video, dub, video_track, dub_track)| serde_json::json!({
            "videoPath": video,
            "dubPath": dub,
            "videoTrack": video_track,
            "dubTrack": dub_track,
        })).collect::<Vec<_>>(),
        "planOnly": true,
        "fixVoices": false,
        "fillUnmatched": false,
        "maxWorkers": max_workers.max(1),
    })
}

/// One pair to render, with where its track goes.
#[derive(Debug, Clone)]
pub(crate) struct RenderJob {
    pub pair: MeasurePair,
    pub output: PathBuf,
}

/// The engine's dub sync, written and checked but never muxed: the voice
/// check is off (it moves voices, which a conform must not), stretches the
/// dub does not match keep the dub, and an earlier conform is replaced.
pub(crate) fn render_payload(jobs: &[RenderJob], codec: &str, bitrate: Option<u64>, max_workers: i64) -> Value {
    let mut payload = serde_json::json!({
        "command": "dubsyncBatch",
        "jobs": jobs.iter().map(|job| serde_json::json!({
            "videoPath": job.pair.primary_path,
            "dubPath": job.pair.secondary_path,
            "videoTrack": job.pair.primary_track,
            "dubTrack": job.pair.secondary_track,
            "outputPath": job.output.to_string_lossy(),
        })).collect::<Vec<_>>(),
        "planOnly": false,
        "fixVoices": false,
        "fillUnmatched": false,
        "verify": true,
        "mux": false,
        "overwrite": true,
        "codec": codec,
        "maxWorkers": max_workers.max(1),
    });
    if let Some(bitrate) = bitrate {
        payload["bitrate"] = Value::String(bitrate.to_string());
    }
    payload
}

// ---------------------------------------------------------------- outputs

/// `<folder>/<dub stem>[.trackN].conformed.<extension>`; the folder is the
/// request's, else `MKVBatchMux conformed` beside the dub. A dub's second
/// track and on get their number, so two tracks of one file never collide.
pub(crate) fn conformed_path(output_dir: Option<&str>, dub: &Path, dub_track: i64, extension: &str) -> PathBuf {
    let folder = output_dir
        .map(str::trim)
        .filter(|dir| !dir.is_empty())
        .map(PathBuf::from)
        .unwrap_or_else(|| dub.parent().map(Path::to_path_buf).unwrap_or_default().join(DEFAULT_FOLDER));
    let mut stem = dub.file_stem().map(|stem| stem.to_string_lossy().into_owned()).unwrap_or_else(|| "dub".to_string());
    if dub_track > 0 {
        stem = format!("{stem}.track{}", dub_track + 1);
    }
    folder.join(format!("{stem}.conformed.{extension}"))
}

/// The output names of one run, so no two pairs write the same file and no
/// pair writes over an input. Two pairs share a name when dubs with the same
/// stem from different folders go to one output folder, or when one dub is
/// conformed to two videos; the later pair then gets its video's stem added
/// (`<dub>.<video>.conformed.mka`), then a counter. Names are compared
/// ignoring case, because Windows and macOS do. A pair keeps its name when it
/// falls back from cutting to rendering (only the extension changes).
pub(crate) struct OutputNames {
    /// Every video and dub of the run.
    inputs: Vec<PathBuf>,
    /// `<folder>/<stem>` lower case -> the pair key that owns it.
    taken: HashMap<String, String>,
    /// Pair key -> its chosen path without `.conformed.<ext>`.
    chosen: HashMap<String, PathBuf>,
}

impl OutputNames {
    pub(crate) fn new(pairs: &[MeasurePair]) -> Self {
        let inputs = pairs
            .iter()
            .flat_map(|pair| [&pair.primary_path, &pair.secondary_path])
            .map(PathBuf::from)
            .collect();
        Self { inputs, taken: HashMap::new(), chosen: HashMap::new() }
    }

    fn is_input(&self, path: &Path) -> bool {
        let lower = path.to_string_lossy().to_lowercase();
        self.inputs.iter().any(|input| input.to_string_lossy().to_lowercase() == lower || same_file(input, path))
    }

    /// Where `pair` writes its `.conformed.<extension>` file.
    pub(crate) fn path_for(&mut self, output_dir: Option<&str>, pair: &MeasurePair, extension: &str) -> PathBuf {
        let finish = |base: &Path| {
            let mut name = base.as_os_str().to_os_string();
            name.push(format!(".conformed.{extension}"));
            PathBuf::from(name)
        };
        if let Some(base) = self.chosen.get(&pair.key) {
            let path = finish(base);
            if !self.is_input(&path) {
                return path;
            }
        }
        let plain = conformed_path(output_dir, Path::new(&pair.secondary_path), pair.secondary_track, extension);
        let plain_name = plain.file_name().map(|name| name.to_string_lossy().into_owned()).unwrap_or_default();
        let dub_stem = plain_name.strip_suffix(&format!(".conformed.{extension}")).unwrap_or(&plain_name).to_string();
        let folder = plain.parent().map(Path::to_path_buf).unwrap_or_default();
        let video_stem = Path::new(&pair.primary_path)
            .file_stem()
            .map(|stem| stem.to_string_lossy().into_owned())
            .unwrap_or_else(|| "video".to_string());
        for attempt in 0usize.. {
            let stem = match attempt {
                0 => dub_stem.clone(),
                1 => format!("{dub_stem}.{video_stem}"),
                n => format!("{dub_stem}.{video_stem} ({n})"),
            };
            let base = folder.join(&stem);
            let lower = base.to_string_lossy().to_lowercase();
            let owner = self.taken.get(&lower);
            if owner.is_some_and(|owner| *owner != pair.key) || self.is_input(&finish(&base)) {
                continue;
            }
            if let Some(previous) = self.chosen.insert(pair.key.clone(), base.clone()) {
                self.taken.remove(&previous.to_string_lossy().to_lowercase());
            }
            self.taken.insert(lower, pair.key.clone());
            return finish(&base);
        }
        unreachable!("the counter always finds a free name")
    }
}

/// The engine codec and file extension a render writes. `same` follows the
/// dub where there is an encoder for its codec (the engine's `SAME_AS_DUB`),
/// and FLAC where there is not (TrueHD, DTS): lossless, so nothing is lost twice.
pub(crate) fn render_codec(choice: ConformCodec, dub_codec: &str) -> (&'static str, &'static str) {
    if choice == ConformCodec::Flac {
        return ("flac", "flac");
    }
    match dub_codec {
        "aac" => ("aac", "m4a"),
        "ac3" => ("ac3", "ac3"),
        "eac3" => ("eac3", "eac3"),
        "opus" => ("opus", "opus"),
        "pcm_s16le" | "pcm_s24le" | "pcm_s32le" | "pcm_f32le" => ("wav", "wav"),
        _ => ("flac", "flac"),
    }
}

/// The bitrate a render keeps: the dub's own, when it is re-encoded in its own
/// lossy codec. None lets the engine choose (lossless, or the dub's unknown).
pub(crate) fn render_bitrate(codec: &str, dub_codec: &str, dub_bit_rate: Option<u64>) -> Option<u64> {
    let lossy = matches!(codec, "aac" | "ac3" | "eac3" | "opus");
    (lossy && codec == dub_codec).then_some(dub_bit_rate).flatten()
}

fn path_text(path: &Path) -> String {
    path.to_string_lossy().into_owned()
}

fn same_file(a: &Path, b: &Path) -> bool {
    a == b || matches!((a.canonicalize(), b.canonicalize()), (Ok(x), Ok(y)) if x == y)
}

// ---------------------------------------------------------------- verdicts

/// What a check concluded.
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct Verdict {
    pub verified: Option<bool>,
    pub residual_ms: Option<f64>,
    pub text: String,
}

/// Read the engine's check of a rendered track (`verify_output`): passed when
/// every spot and every swept window it could measure sits within lip-sync
/// tolerance and no stretch is out. Nothing measured is no verdict.
pub(crate) fn judge_render(verification: Option<&Value>, text: Option<&str>) -> Verdict {
    let text = text.unwrap_or("The engine did not check the finished track.").to_string();
    let Some(verification) = verification.filter(|value| !value.is_null()) else {
        return Verdict { verified: None, residual_ms: None, text };
    };
    let residuals: Vec<f64> = verification
        .get("spots")
        .and_then(Value::as_array)
        .map(|spots| spots.iter().filter_map(|spot| spot.get("residualMs").and_then(Value::as_f64)).collect())
        .unwrap_or_default();
    let worst = residuals.iter().copied().max_by(|a, b| a.abs().total_cmp(&b.abs()));
    let count = |field: &str| verification.get(field).and_then(Value::as_u64).unwrap_or(0);
    let (measured, within) = (count("sweepMeasured"), count("sweepWithinAudible"));
    let stretches_out = verification.get("stretches").and_then(Value::as_array).is_some_and(|list| !list.is_empty());
    let residual_ms = worst.or_else(|| verification.get("sweepWorstMs").and_then(Value::as_f64));
    if worst.is_none() && measured == 0 {
        return Verdict { verified: None, residual_ms: None, text };
    }
    let verified = !stretches_out && within >= measured && residual_ms.map_or(true, |ms| ms.abs() <= LIP_SYNC_VISIBLE_MS);
    Verdict { verified: Some(verified), residual_ms, text }
}

/// Read the plan of a losslessly conformed track against its video. The cut
/// is right when every stretch of dub sits within one codec frame of the
/// video: that is all whole frames can promise. It is not required to be one
/// stretch: two pieces rounded to the frame from opposite sides can sit a
/// frame's fraction apart, and the planner may report them as two (on the test
/// episode: +13.4 ms and -8.0 ms, as laid out). Silence where the dub had
/// nothing is reported as a fill, which is expected.
pub(crate) fn judge_conformed(plan: Option<&Value>, frame_ms: f64) -> Verdict {
    let Some(plan) = plan.filter(|plan| !plan.is_null()) else {
        return Verdict { verified: None, residual_ms: None, text: "The conformed track could not be checked.".to_string() };
    };
    if let Some(error) = plan.get("error").and_then(Value::as_str) {
        return Verdict { verified: Some(false), residual_ms: None, text: format!("The check could not place the conformed track: {error}") };
    }
    if (plan.get("speed").and_then(Value::as_f64).unwrap_or(1.0) - 1.0).abs() > 1e-6 {
        return Verdict {
            verified: Some(false),
            residual_ms: None,
            text: "The check found the conformed track running at another speed than the video.".to_string(),
        };
    }
    let offsets: Vec<f64> = lossless::plan_segments(plan)
        .into_iter()
        .filter(|segment| segment.dub)
        .filter_map(|segment| segment.offset_s.map(|offset| offset * 1000.0))
        .collect();
    let Some(worst) = offsets.iter().copied().max_by(|a, b| a.abs().total_cmp(&b.abs())) else {
        return Verdict { verified: Some(false), residual_ms: None, text: "The check found none of the dub in the conformed track.".to_string() };
    };
    let out = offsets.iter().filter(|ms| ms.abs() >= frame_ms).count();
    let (low, high) = offsets.iter().fold((f64::INFINITY, f64::NEG_INFINITY), |(lo, hi), &ms| (lo.min(ms), hi.max(ms)));
    let range = if (high - low).abs() < 0.05 { format!("{high:+.1} ms") } else { format!("{low:+.1} to {high:+.1} ms") };
    let text = if out == 0 {
        format!("Checked against the video: the dub sits within one {frame_ms:.0} ms frame throughout ({range}).")
    } else {
        format!(
            "Checked against the video: {out} stretch{} of the dub sit{} more than a {frame_ms:.0} ms frame out ({range}).",
            if out == 1 { "" } else { "es" },
            if out == 1 { "s" } else { "" }
        )
    };
    Verdict { verified: Some(out == 0), residual_ms: Some(worst), text }
}

// ---------------------------------------------------------------- render

fn render<L: EngineLink, S: Sink>(
    link: &mut L,
    report: &mut Reporter<S>,
    tools: &Tools,
    cancel: &AtomicBool,
    request: &ConformRequest,
    names: &mut OutputNames,
    pairs: &[(MeasurePair, Option<String>)],
) -> Result<RunEnd, String> {
    // The engine takes one codec and bitrate per batch: dubs that share them
    // go together (a season usually is one batch).
    let mut groups: BTreeMap<(String, Option<u64>), Vec<(RenderJob, Option<String>)>> = BTreeMap::new();
    for (pair, reason) in pairs {
        if cancel.load(Ordering::SeqCst) {
            return Ok(RunEnd { cancelled: true, error: None });
        }
        report.progress(&pair.key, 0, Some("Reading the dub"));
        let dub = PathBuf::from(&pair.secondary_path);
        let info = match probe_stream(tools, &dub, pair.secondary_track, cancel) {
            Ok(info) => info,
            Err(err) if err == crate::engine_link::CANCELLED => return Ok(RunEnd { cancelled: true, error: None }),
            Err(err) => {
                report.result(&pair.key, ResultEvent { mode: "render".into(), error: Some(err), fallback_reason: reason.clone(), ..Default::default() });
                continue;
            }
        };
        let (codec, extension) = render_codec(request.codec, &info.codec);
        let output = names.path_for(request.output_dir.as_deref(), pair, extension);
        if same_file(&output, &dub) || same_file(&output, Path::new(&pair.primary_path)) {
            report.result(&pair.key, ResultEvent {
                mode: "render".into(),
                error: Some("The conformed file would replace a source file; choose another output folder.".into()),
                ..Default::default()
            });
            continue;
        }
        let bitrate = render_bitrate(codec, &info.codec, info.bit_rate);
        groups.entry((codec.to_string(), bitrate)).or_default().push((RenderJob { pair: pair.clone(), output }, reason.clone()));
    }

    for ((codec, bitrate), jobs) in groups {
        if cancel.load(Ordering::SeqCst) {
            return Ok(RunEnd { cancelled: true, error: None });
        }
        let render_jobs: Vec<RenderJob> = jobs.iter().map(|(job, _)| job.clone()).collect();
        let payload = render_payload(&render_jobs, &codec, bitrate, request.max_workers);
        let keys: Vec<String> = render_jobs.iter().map(|job| job.pair.key.clone()).collect();
        let reasons: Vec<Option<String>> = jobs.iter().map(|(_, reason)| reason.clone()).collect();
        let mut finished: Vec<(usize, JobOutcome)> = Vec::new();
        let batch = engine_batch(
            link,
            report,
            &payload,
            keys.len(),
            |job, percent, stage| report.progress(&keys[job], percent, stage),
            |job, outcome| finished.push((job, outcome.clone())),
        )?;
        for (job, outcome) in finished {
            let done = outcome.done.clone().unwrap_or(Value::Null);
            if done.get("cancelled").and_then(Value::as_bool).unwrap_or(false) && outcome.error().is_none() {
                continue;
            }
            let verdict = judge_render(done.get("verification"), done.get("verificationText").and_then(Value::as_str));
            let output = done.pointer("/output/outputPath").and_then(Value::as_str).map(str::to_string);
            let text = match &reasons[job] {
                Some(reason) if output.is_some() => Some(format!("Re-encoded instead of cut: {reason}. {}", verdict.text)),
                _ => output.as_ref().map(|_| verdict.text.clone()),
            };
            report.result(&keys[job], ResultEvent {
                output_path: output.clone(),
                mode: "render".into(),
                codec: output.as_ref().map(|_| codec.clone()),
                verified: output.as_ref().and(verdict.verified),
                verification_text: text,
                residual_ms: output.as_ref().and(verdict.residual_ms),
                plan: outcome.plan(),
                description: outcome.description.clone(),
                error: outcome.error().or_else(|| output.is_none().then(|| "The engine wrote no track.".to_string())),
                fallback_reason: reasons[job].clone(),
                ..Default::default()
            });
        }
        if batch.cancelled {
            return Ok(RunEnd { cancelled: true, error: None });
        }
        if let Some(fatal) = batch.fatal {
            return Ok(RunEnd { cancelled: false, error: Some(fatal) });
        }
    }
    Ok(RunEnd::default())
}

// ---------------------------------------------------------------- lossless

/// A pair cut losslessly, waiting for its check.
struct Pending {
    pair: MeasurePair,
    cut: lossless::Cut,
    plan: Value,
    description: Option<String>,
}

fn lossless_run<L: EngineLink, S: Sink>(
    link: &mut L,
    report: &mut Reporter<S>,
    tools: &Tools,
    cancel: &AtomicBool,
    request: &ConformRequest,
    names: &mut OutputNames,
) -> Result<RunEnd, String> {
    let pairs = &request.pairs;
    // 1. The plan of every pair: the first half of each one's progress.
    let jobs: Vec<(String, String, i64, i64)> = pairs
        .iter()
        .map(|pair| (pair.primary_path.clone(), pair.secondary_path.clone(), pair.primary_track, pair.secondary_track))
        .collect();
    let planned = engine_batch(
        link,
        report,
        &plan_payload(&jobs, request.max_workers),
        pairs.len(),
        |job, percent, stage| report.progress(&pairs[job].key, percent / 2, stage.or(Some("Planning"))),
        |_, _| {},
    )?;
    if planned.cancelled || cancel.load(Ordering::SeqCst) {
        return Ok(RunEnd { cancelled: true, error: None });
    }
    if let Some(fatal) = planned.fatal.filter(|_| planned.jobs.iter().all(|job| job.plan().is_none())) {
        return Ok(RunEnd { cancelled: false, error: Some(fatal) });
    }

    // 2. Cut each one on its frames.
    let mut pending: Vec<Pending> = Vec::new();
    let mut fallback: Vec<(MeasurePair, Option<String>)> = Vec::new();
    for (pair, outcome) in pairs.iter().zip(planned.jobs) {
        if cancel.load(Ordering::SeqCst) {
            return Ok(RunEnd { cancelled: true, error: None });
        }
        let plan = outcome.plan();
        let failed = |message: String| ResultEvent {
            mode: "lossless".into(),
            plan: plan.clone(),
            description: outcome.description.clone(),
            error: Some(message),
            ..Default::default()
        };
        let Some(plan_value) = plan.clone().filter(|plan| plan.get("error").map_or(true, Value::is_null)) else {
            let message = outcome
                .error()
                .or_else(|| plan.as_ref().and_then(|plan| plan.get("error")).and_then(Value::as_str).map(str::to_string))
                .unwrap_or_else(|| "The engine could not plan this pair.".to_string());
            report.result(&pair.key, failed(message));
            continue;
        };
        let dub = PathBuf::from(&pair.secondary_path);
        let output = names.path_for(request.output_dir.as_deref(), pair, "mka");
        if same_file(&output, &dub) || same_file(&output, Path::new(&pair.primary_path)) {
            report.result(&pair.key, failed("The conformed file would replace a source file; choose another output folder.".into()));
            continue;
        }
        let key = pair.key.clone();
        let mut progress = |percent: u64, stage: &str| report.progress(&key, 50 + percent / 5, Some(stage));
        match lossless::conform(tools, &plan_value, &output, cancel, &mut progress) {
            Ok(cut) => {
                report.log(&format!(
                    "Cut {} losslessly: {} frame(s) of {:.1} ms, stretches within {} ms of the plan",
                    dub.file_name().map(|name| name.to_string_lossy().into_owned()).unwrap_or_default(),
                    codec_label(&cut.codec),
                    cut.frame_ms,
                    cut.residuals_ms.iter().map(|ms| format!("{ms:+.1}")).collect::<Vec<_>>().join(" / "),
                ));
                pending.push(Pending { pair: pair.clone(), cut, plan: plan_value, description: outcome.description.clone() });
            }
            Err(CutError::Unsupported(reason)) => {
                report.log(&format!("{}: {reason}; the engine re-encodes it instead", pair.secondary_path));
                fallback.push((pair.clone(), Some(reason)));
            }
            Err(CutError::Failed(message)) => report.result(&pair.key, failed(message)),
            Err(CutError::Cancelled) => return Ok(RunEnd { cancelled: true, error: None }),
        }
    }

    // 3. Plan each conformed track against its video again.
    if !pending.is_empty() {
        let jobs: Vec<(String, String, i64, i64)> = pending
            .iter()
            .map(|done| (done.pair.primary_path.clone(), path_text(&done.cut.path), done.pair.primary_track, 0))
            .collect();
        let checked = engine_batch(
            link,
            report,
            &plan_payload(&jobs, request.max_workers),
            pending.len(),
            |job, percent, _| report.progress(&pending[job].pair.key, 70 + percent * 3 / 10, Some("Checking the conformed track")),
            |_, _| {},
        )?;
        for (done, check) in pending.iter().zip(&checked.jobs) {
            let plan = check.plan();
            let verdict = if checked.cancelled && plan.is_none() {
                Verdict { verified: None, residual_ms: None, text: "Not checked: the run was stopped.".to_string() }
            } else if plan.is_none() {
                Verdict {
                    verified: None,
                    residual_ms: None,
                    text: format!("The conformed track could not be checked: {}", check.error().unwrap_or_else(|| "no plan".into())),
                }
            } else {
                judge_conformed(plan.as_ref(), done.cut.frame_ms)
            };
            report.result(&done.pair.key, ResultEvent {
                output_path: Some(path_text(&done.cut.path)),
                mode: "lossless".into(),
                codec: Some(done.cut.codec.clone()),
                verified: verdict.verified,
                verification_text: Some(verdict.text),
                residual_ms: verdict.residual_ms,
                plan: Some(done.plan.clone()),
                description: done.description.clone(),
                ..Default::default()
            });
        }
        if checked.cancelled {
            return Ok(RunEnd { cancelled: true, error: None });
        }
    }

    // 4. What could not be cut, the engine writes.
    if fallback.is_empty() {
        return Ok(RunEnd::default());
    }
    render(link, report, tools, cancel, request, names, &fallback)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn pair(key: &str, video: &str, dub: &str, dub_track: i64) -> MeasurePair {
        MeasurePair {
            primary_path: video.to_string(),
            secondary_path: dub.to_string(),
            key: key.to_string(),
            method: "mkvbatchmux".to_string(),
            score: 1.0,
            primary_track: 0,
            secondary_track: dub_track,
        }
    }

    #[test]
    fn the_request_reads_the_frontend_payload() {
        let json = r#"{"runId":"c1","pairs":[{"primaryPath":"/v/E02.mkv","secondaryPath":"/d/E02.eac3","key":"a1",
            "method":"mkvbatchmux","score":1,"primaryTrack":0,"secondaryTrack":0}],"mode":"lossless","codec":"same",
            "outputDir":null,"maxWorkers":3}"#;
        let request: ConformRequest = serde_json::from_str(json).unwrap();
        assert_eq!(request.mode, ConformMode::Lossless);
        assert_eq!(request.codec, ConformCodec::Same);
        assert_eq!(request.output_dir, None);
        let minimal: ConformRequest =
            serde_json::from_str(r#"{"runId":"c2","pairs":[],"mode":"render","codec":"flac"}"#).unwrap();
        assert_eq!(minimal.max_workers, 2);
    }

    /// A render must write and check, never mux into the video, never move
    /// voices, and replace only its own earlier output.
    #[test]
    fn a_render_writes_and_checks_but_never_muxes() {
        let job = RenderJob { pair: pair("a", "/v/E02.mkv", "/d/E02.eac3", 1), output: PathBuf::from("/d/out/E02.conformed.eac3") };
        let payload = render_payload(&[job], "eac3", Some(256000), 3);
        assert_eq!(payload["command"], "dubsyncBatch");
        assert_eq!(payload["planOnly"], false);
        assert_eq!(payload["mux"], false);
        assert_eq!(payload["fixVoices"], false);
        assert_eq!(payload["verify"], true);
        assert_eq!(payload["overwrite"], true);
        assert_eq!(payload["codec"], "eac3");
        assert_eq!(payload["bitrate"], "256000");
        assert_eq!(payload["jobs"][0]["dubTrack"], 1);
        assert_eq!(payload["jobs"][0]["outputPath"], "/d/out/E02.conformed.eac3");
        let flac = render_payload(&[], "flac", None, 0);
        assert!(flac.get("bitrate").is_none());
        assert_eq!(flac["maxWorkers"], 1);
        let plan = plan_payload(&[("/v".into(), "/d".into(), 0, 0)], 2);
        assert_eq!(plan["planOnly"], true);
        assert_eq!(plan["fixVoices"], false);
    }

    #[test]
    fn conformed_files_go_beside_the_dub_unless_told_otherwise() {
        let dub = Path::new("/media/Dubs/Show.S01E02.Hindi.eac3");
        assert_eq!(
            conformed_path(None, dub, 0, "mka"),
            Path::new("/media/Dubs").join(DEFAULT_FOLDER).join("Show.S01E02.Hindi.conformed.mka")
        );
        assert_eq!(conformed_path(Some("  "), dub, 0, "eac3"), Path::new("/media/Dubs").join(DEFAULT_FOLDER).join("Show.S01E02.Hindi.conformed.eac3"));
        assert_eq!(conformed_path(Some("/out"), dub, 2, "flac"), Path::new("/out").join("Show.S01E02.Hindi.track3.conformed.flac"));
    }

    #[test]
    fn no_two_pairs_of_a_run_write_the_same_file_or_over_an_input() {
        let pairs = vec![
            pair("a", "/v1/Show.S01E01.mkv", "/d1/Show.S01E01.Hindi.eac3", 0),
            // Same dub stem from another folder, into the shared output folder.
            pair("b", "/v2/Show.S01E01.mkv", "/d2/show.s01e01.HINDI.eac3", 0),
            // One dub conformed to two videos.
            pair("c", "/v1/Show.S01E01.mkv", "/d3/Movie.Hindi.eac3", 0),
            pair("d", "/v1/Movie.Directors.Cut.mkv", "/d3/Movie.Hindi.eac3", 0),
            // A dub that is itself the plain name another pair would write.
            pair("e", "/v1/Ep.mkv", "/out/Ep.Hindi.eac3", 0),
            pair("f", "/v1/Ep2.mkv", "/out/Ep.Hindi.conformed.mka", 0),
        ];
        let mut names = OutputNames::new(&pairs);
        let out = Some("/out");
        let paths: Vec<PathBuf> = pairs.iter().map(|pair| names.path_for(out, pair, "mka")).collect();
        let lower: std::collections::HashSet<String> = paths.iter().map(|path| path.to_string_lossy().to_lowercase()).collect();
        assert_eq!(lower.len(), paths.len(), "every output distinct, ignoring case: {paths:?}");
        assert_eq!(paths[0], Path::new("/out").join("Show.S01E01.Hindi.conformed.mka"), "the first keeps the plain name");
        assert_eq!(paths[1], Path::new("/out").join("show.s01e01.HINDI.Show.S01E01.conformed.mka"));
        assert_eq!(paths[2], Path::new("/out").join("Movie.Hindi.conformed.mka"));
        assert_eq!(paths[3], Path::new("/out").join("Movie.Hindi.Movie.Directors.Cut.conformed.mka"));
        for path in &paths {
            assert!(!pairs.iter().any(|pair| Path::new(&pair.secondary_path) == path || Path::new(&pair.primary_path) == path), "{path:?} is an input");
        }
        assert_eq!(paths[4], Path::new("/out").join("Ep.Hindi.Ep.conformed.mka"));
        // Asked again (a fallback render), a pair keeps its name with the new extension.
        assert_eq!(names.path_for(out, &pairs[1], "eac3"), Path::new("/out").join("show.s01e01.HINDI.Show.S01E01.conformed.eac3"));
        assert_eq!(names.path_for(out, &pairs[0], "eac3"), Path::new("/out").join("Show.S01E01.Hindi.conformed.eac3"));
        // Same dub and same video stem twice: a counter.
        let twins = vec![pair("x", "/a/E1.mkv", "/a/E1.eac3", 0), pair("y", "/b/E1.mkv", "/b/E1.eac3", 0), pair("z", "/c/E1.mkv", "/c/E1.eac3", 0)];
        let mut names = OutputNames::new(&twins);
        let paths: Vec<PathBuf> = twins.iter().map(|pair| names.path_for(out, pair, "mka")).collect();
        assert_eq!(
            paths,
            vec![
                Path::new("/out").join("E1.conformed.mka"),
                Path::new("/out").join("E1.E1.conformed.mka"),
                Path::new("/out").join("E1.E1 (2).conformed.mka"),
            ]
        );
    }

    #[test]
    fn same_means_the_dubs_own_codec_where_it_can_be_written() {
        assert_eq!(render_codec(ConformCodec::Same, "eac3"), ("eac3", "eac3"));
        assert_eq!(render_codec(ConformCodec::Same, "aac"), ("aac", "m4a"));
        assert_eq!(render_codec(ConformCodec::Same, "truehd"), ("flac", "flac"));
        assert_eq!(render_codec(ConformCodec::Same, "dts"), ("flac", "flac"));
        assert_eq!(render_codec(ConformCodec::Same, "pcm_s24le"), ("wav", "wav"));
        assert_eq!(render_codec(ConformCodec::Flac, "eac3"), ("flac", "flac"));
        assert_eq!(render_bitrate("eac3", "eac3", Some(640000)), Some(640000));
        assert_eq!(render_bitrate("flac", "truehd", Some(4_000_000)), None);
        assert_eq!(render_bitrate("flac", "flac", Some(900_000)), None);
    }

    #[test]
    fn a_render_passes_when_everything_measured_is_within_lip_sync() {
        let good = serde_json::json!({
            "spots": [{"residualMs": -0.11}, {"residualMs": null}, {"residualMs": 0.03}],
            "sweepMeasured": 26, "sweepWithinAudible": 26, "sweepWorstMs": 0.2, "stretches": []
        });
        let verdict = judge_render(Some(&good), Some("sits 0.0ms from the original"));
        assert_eq!(verdict.verified, Some(true));
        assert_eq!(verdict.residual_ms, Some(-0.11));
        let stretch_out = serde_json::json!({"spots": [{"residualMs": 3.0}], "sweepMeasured": 20, "sweepWithinAudible": 18,
            "stretches": [{"startS": 10.0, "endS": 20.0, "residualMs": 80.0}]});
        assert_eq!(judge_render(Some(&stretch_out), None).verified, Some(false));
        let silent = serde_json::json!({"spots": [{"residualMs": null}], "sweepMeasured": 0, "sweepWithinAudible": 0, "stretches": []});
        assert_eq!(judge_render(Some(&silent), None).verified, None);
        assert_eq!(judge_render(None, None).verified, None);
    }

    fn replan(segments: Value) -> Value {
        serde_json::json!({"speed": 1.0, "error": null, "segments": segments})
    }

    #[test]
    fn a_conformed_track_passes_when_every_stretch_is_within_a_frame() {
        // What planning the real E02 cut again reported.
        let plan = replan(serde_json::json!([
            {"kind": "dub", "startS": 0.0, "endS": 28.03, "offsetS": 0.0134},
            {"kind": "dub", "startS": 28.03, "endS": 100.014, "offsetS": -0.008},
            {"kind": "fill", "startS": 100.014, "endS": 110.088, "offsetS": null},
            {"kind": "dub", "startS": 110.088, "endS": 300.0, "offsetS": -0.008},
        ]));
        let verdict = judge_conformed(Some(&plan), 32.0);
        assert_eq!(verdict.verified, Some(true));
        assert!((verdict.residual_ms.unwrap() - 13.4).abs() < 1e-9);
        assert!(verdict.text.contains("-8.0 to +13.4 ms"), "{}", verdict.text);

        let cut_left = replan(serde_json::json!([
            {"kind": "dub", "startS": 0.0, "endS": 100.0, "offsetS": 0.001},
            {"kind": "dub", "startS": 100.0, "endS": 300.0, "offsetS": -10.069},
        ]));
        let verdict = judge_conformed(Some(&cut_left), 32.0);
        assert_eq!(verdict.verified, Some(false));
        assert_eq!(verdict.residual_ms, Some(-10069.0));
        let failed = serde_json::json!({"error": "no match", "segments": []});
        assert_eq!(judge_conformed(Some(&failed), 32.0).verified, Some(false));
        assert_eq!(judge_conformed(None, 32.0).verified, None);
    }

    /// Real tools, real engine: `cargo test -- --ignored --nocapture` with
    /// AUDIOSYNC_REPO (the pinned engine with python/.venv), MBM_TEST_MEDIA
    /// (make_media.py's folder) and ffmpeg, ffprobe and mkvmerge on PATH.
    mod real {
        use super::*;
        use crate::engine_link::testing::{media, Recorder, TestEngine};

        fn tools() -> Tools {
            Tools { mkvmerge: "mkvmerge".into(), ffmpeg: "ffmpeg".into(), ffprobe: "ffprobe".into() }
        }

        fn episode(n: u32) -> MeasurePair {
            let root = media();
            let video = root.join("Show").join("Season 1").join(format!("Show.S01E0{n}.mkv"));
            let dub = root.join("Dubs").join(format!("Show.S01E0{n}.Hindi.eac3"));
            pair(&format!("e0{n}"), &video.to_string_lossy(), &dub.to_string_lossy(), 0)
        }

        fn conform_one(pair: MeasurePair, mode: ConformMode, out: &Path) -> (ResultEvent, Recorder) {
            let mut engine = TestEngine::start();
            let sink = Recorder::default();
            let request = ConformRequest {
                run_id: "real".into(),
                pairs: vec![pair],
                mode,
                codec: ConformCodec::Same,
                output_dir: Some(out.to_string_lossy().into_owned()),
                max_workers: 2,
            };
            let end = run(&mut engine, &sink, &tools(), &AtomicBool::new(false), &request).expect("engine ran");
            assert_eq!(end, RunEnd::default());
            let results = sink.named("conform-result");
            assert_eq!(results.len(), 1, "{results:?}");
            let result: Value = results[0].clone();
            let event = ResultEvent {
                run_id: result["runId"].as_str().unwrap_or_default().into(),
                key: result["key"].as_str().map(str::to_string),
                output_path: result["outputPath"].as_str().map(str::to_string),
                mode: result["mode"].as_str().unwrap_or_default().into(),
                codec: result["codec"].as_str().map(str::to_string),
                verified: result["verified"].as_bool(),
                verification_text: result["verificationText"].as_str().map(str::to_string),
                residual_ms: result["residualMs"].as_f64(),
                plan: Some(result["plan"].clone()),
                description: result["description"].as_str().map(str::to_string),
                error: result["error"].as_str().map(str::to_string),
                fallback_reason: result["fallbackReason"].as_str().map(str::to_string),
            };
            (event, sink)
        }

        /// Plan a written track against the video again: the offsets of its stretches of dub, in ms.
        fn replan_offsets(video: &str, track: &str) -> Vec<f64> {
            let mut engine = TestEngine::start();
            let sink = Recorder::default();
            let report = Reporter { sink: &sink, run_id: "check".into(), total: 1, processed: 0 };
            let batch = engine_batch(&mut engine, &report, &plan_payload(&[(video.into(), track.into(), 0, 0)], 1), 1, |_, _, _| {}, |_, _| {})
                .expect("plan again");
            let plan = batch.jobs[0].plan().expect("a plan");
            lossless::plan_segments(&plan).into_iter().filter(|s| s.dub).filter_map(|s| s.offset_s.map(|o| o * 1000.0)).collect()
        }

        #[test]
        #[ignore = "needs the engine, ffmpeg, mkvmerge and the test media"]
        fn lossless_conform_of_a_different_cut_verifies() {
            let out = tempfile::tempdir().unwrap();
            let pair = episode(2);
            let (result, _) = conform_one(pair.clone(), ConformMode::Lossless, out.path());
            println!(
                "E02 lossless: verified {:?}, residual {:?} ms, codec {:?}\n  {}",
                result.verified,
                result.residual_ms,
                result.codec,
                result.verification_text.clone().unwrap_or_default()
            );
            assert_eq!(result.error, None);
            assert_eq!(result.mode, "lossless");
            assert_eq!(result.codec.as_deref(), Some("eac3"));
            assert_eq!(result.verified, Some(true), "{:?}", result.verification_text);
            assert!(result.residual_ms.unwrap().abs() < 32.0);
            let path = result.output_path.unwrap();
            assert!(path.ends_with("Show.S01E02.Hindi.conformed.mka"));
            // The plan it was cut from: the 10 s scene missing at 100 s.
            let plan = result.plan.unwrap();
            let fill = lossless::plan_segments(&plan).into_iter().find(|s| !s.dub).expect("a fill");
            println!("planned gap {:.3}-{:.3} s (truth 100.000 + 10.000 s)", fill.start_s, fill.end_s);
            assert!((fill.start_s - 100.0).abs() < 0.2 && (fill.end_s - fill.start_s - 10.0).abs() < 0.2);
        }

        #[test]
        #[ignore = "needs the engine, ffmpeg, mkvmerge and the test media"]
        fn render_conform_of_a_different_cut_verifies() {
            let out = tempfile::tempdir().unwrap();
            let pair = episode(2);
            let (result, _) = conform_one(pair.clone(), ConformMode::Render, out.path());
            println!("E02 render: verified {:?}, residual {:?} ms\n{}", result.verified, result.residual_ms, result.verification_text.clone().unwrap_or_default());
            assert_eq!(result.error, None);
            assert_eq!(result.mode, "render");
            assert_eq!(result.codec.as_deref(), Some("eac3"));
            assert_eq!(result.verified, Some(true));
            assert!(result.residual_ms.unwrap().abs() < 5.0);
            let offsets = replan_offsets(&pair.primary_path, result.output_path.as_deref().unwrap());
            println!("E02 render planned again: {offsets:?} ms");
            assert!(offsets.iter().all(|ms| ms.abs() < 5.0), "{offsets:?}");
        }

        #[test]
        #[ignore = "needs the engine, ffmpeg, mkvmerge and the test media"]
        fn a_dub_at_another_speed_is_rendered_instead_of_cut() {
            let out = tempfile::tempdir().unwrap();
            let (result, _) = conform_one(episode(3), ConformMode::Lossless, out.path());
            println!("E03 lossless request: {:?} / {:?} / verified {:?} residual {:?}", result.mode, result.fallback_reason, result.verified, result.residual_ms);
            assert_eq!(result.mode, "render");
            assert!(result.fallback_reason.unwrap_or_default().contains("speed"));
            assert_eq!(result.verified, Some(true));
            assert!(result.output_path.unwrap().ends_with(".conformed.eac3"));
        }
    }
}
