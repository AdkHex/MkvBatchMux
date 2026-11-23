//! MKVBatchMux's own conform: the dub's coded frames, cut by mkvmerge and laid
//! back on the video's timeline as the engine's plan says, with silence
//! encoded in the dub's own codec wherever the dub has nothing. No frame of the
//! dub is decoded or re-encoded.
//!
//! How the frames are laid, and why (each choice was settled by planning the
//! result against the video again, on a dub with a 10 s scene missing):
//!
//! * The output is one unbroken run of whole frames starting at 0. Matroska
//!   cannot store a frame before 0, and a lead-in gap does not survive: the
//!   engine, and any player, reads an audio-only file from its first frame, so a
//!   track whose first frame sits at 18 ms is heard (and measured) 18 ms early.
//!   Whole frames from 0 mean every piece lands on the frame boundary nearest
//!   where the plan puts it: within half a frame (16 ms for AC-3/E-AC-3, 11 ms
//!   for AAC), each piece rounded on its own so the error never accumulates.
//! * Pieces are cut with `--split parts:` on the midpoint between two frames'
//!   timestamps, so mkvmerge's "first frame at or after" rule cannot land a
//!   frame either side of the one meant, and every part starts again at 0.
//! * Pieces and silences are joined with `+` (append): mkvmerge puts each
//!   appended part right after the previous one's last frame, which is exactly
//!   the unbroken run the layout counts on. `--sync` and `--timestamps` were
//!   not needed: shifting timestamps without moving frames leaves gaps and
//!   overlaps that players resolve each their own way.
//! * Silence is encoded by ffmpeg in the dub's codec, rate and layout, a few
//!   frames long, then cut to the exact frame count by mkvmerge the same way,
//!   because encoders add frames of their own (ffmpeg's AC-3 writes one more
//!   than asked for its 256-sample delay).

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::AtomicBool;

use serde_json::Value;

use crate::engine_link::{run_tool, CANCELLED};

/// The tools a lossless conform runs.
#[derive(Debug, Clone)]
pub(crate) struct Tools {
    pub mkvmerge: String,
    pub ffmpeg: String,
    pub ffprobe: String,
}

/// Why a lossless conform did not happen.
#[derive(Debug, Clone, PartialEq)]
pub(crate) enum CutError {
    /// This dub cannot be cut without re-encoding: the engine renders it instead.
    Unsupported(String),
    /// Something went wrong cutting it.
    Failed(String),
    Cancelled,
}

impl From<String> for CutError {
    fn from(message: String) -> Self {
        if message == CANCELLED {
            CutError::Cancelled
        } else {
            CutError::Failed(message)
        }
    }
}

/// A finished lossless conform.
#[derive(Debug, Clone)]
pub(crate) struct Cut {
    pub path: PathBuf,
    /// ffprobe's name for the dub's codec, kept as it was.
    pub codec: String,
    pub frame_ms: f64,
    /// Where each stretch of dub sits from where the plan wants it, in ms,
    /// in the engine's convention (positive = the dub plays late).
    pub residuals_ms: Vec<f64>,
}

/// One stretch of the plan, as the layout needs it.
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct PlanSegment {
    pub dub: bool,
    pub start_s: f64,
    pub end_s: f64,
    /// Dub time minus video time, for a stretch of dub.
    pub offset_s: Option<f64>,
}

/// What the output is made of, in order.
#[derive(Debug, Clone, PartialEq)]
pub(crate) enum Piece {
    /// `count` of the dub's frames from frame `first`.
    Dub { first: usize, count: usize },
    Silence { frames: usize },
}

#[derive(Debug, Clone, PartialEq)]
pub(crate) struct Layout {
    pub pieces: Vec<Piece>,
    pub residuals_ms: Vec<f64>,
    pub total_frames: usize,
}

/// Read the stretches out of an engine plan (`DubSyncPlan.to_dict`).
pub(crate) fn plan_segments(plan: &Value) -> Vec<PlanSegment> {
    let number = |segment: &Value, field: &str| segment.get(field).and_then(Value::as_f64);
    let mut segments: Vec<PlanSegment> = plan
        .get("segments")
        .and_then(Value::as_array)
        .map(|list| {
            list.iter()
                .filter_map(|segment| {
                    Some(PlanSegment {
                        dub: segment.get("kind").and_then(Value::as_str) == Some("dub"),
                        start_s: number(segment, "startS")?,
                        end_s: number(segment, "endS")?,
                        offset_s: number(segment, "offsetS"),
                    })
                })
                .collect()
        })
        .unwrap_or_default();
    segments.sort_by(|a, b| a.start_s.total_cmp(&b.start_s));
    segments
}

/// Lay the plan out in whole frames of `frame_s` from 0 to the video's end.
///
/// `pts` are the dub's frame start times on the clock the plan was made on.
/// Each stretch of dub keeps its frames in order: video frame slot `j` gets dub
/// frame `k0 + (j - j0)`, where `k0` is the dub frame nearest to where the
/// stretch's first slot wants to read. Slots with no dub frame (before its
/// first or past its last) are silence, as are fills and anything the plan
/// leaves uncovered.
pub(crate) fn lay_out(segments: &[PlanSegment], video_duration_s: f64, pts: &[f64], frame_s: f64) -> Result<Layout, String> {
    if pts.is_empty() || !(frame_s > 0.0) {
        return Err("The dub has no frames to cut.".to_string());
    }
    if !(video_duration_s > 0.0) {
        return Err("The plan does not say how long the video is.".to_string());
    }
    let total = (video_duration_s / frame_s).round().max(1.0) as usize;
    let slot = |seconds: f64| ((seconds / frame_s).round().max(0.0) as usize).min(total);
    let count = pts.len() as i64;
    // A frame index's start time, extended past either end at the frame rate.
    let source = |k: i64| -> f64 {
        if k < 0 {
            pts[0] + k as f64 * frame_s
        } else if k >= count {
            pts[pts.len() - 1] + (k - count + 1) as f64 * frame_s
        } else {
            pts[k as usize]
        }
    };
    let nearest = |time: f64| -> i64 {
        if time <= pts[0] {
            return -((pts[0] - time) / frame_s).round() as i64;
        }
        let last = pts[pts.len() - 1];
        if time >= last {
            return count - 1 + ((time - last) / frame_s).round() as i64;
        }
        let after = pts.partition_point(|&t| t < time);
        if after > 0 && time - pts[after - 1] <= pts[after] - time {
            after as i64 - 1
        } else {
            after as i64
        }
    };

    let mut pieces: Vec<Piece> = Vec::new();
    let mut residuals = Vec::new();
    let mut cursor = 0usize;
    for segment in segments {
        let j0 = slot(segment.start_s).max(cursor);
        let j1 = slot(segment.end_s);
        if j1 <= j0 {
            continue;
        }
        if j0 > cursor {
            push(&mut pieces, Piece::Silence { frames: j0 - cursor });
        }
        cursor = j1;
        let offset = match (segment.dub, segment.offset_s) {
            (true, Some(offset)) => offset,
            _ => {
                push(&mut pieces, Piece::Silence { frames: j1 - j0 });
                continue;
            }
        };
        let k0 = nearest(j0 as f64 * frame_s + offset);
        let k1 = k0 + (j1 - j0) as i64;
        let first = k0.clamp(0, count);
        let end = k1.clamp(0, count);
        if first > k0 {
            push(&mut pieces, Piece::Silence { frames: (first.min(k1) - k0) as usize });
        }
        if end > first {
            push(&mut pieces, Piece::Dub { first: first as usize, count: (end - first) as usize });
            // Where this stretch plays against where the plan wants it.
            residuals.push((j0 as f64 * frame_s - (source(k0) - offset)) * 1000.0);
        }
        if k1 > end.max(first) {
            push(&mut pieces, Piece::Silence { frames: (k1 - end.max(first).max(k0)) as usize });
        }
    }
    if cursor < total {
        push(&mut pieces, Piece::Silence { frames: total - cursor });
    }
    if !pieces.iter().any(|piece| matches!(piece, Piece::Dub { .. })) {
        return Err("The plan places none of the dub on the video.".to_string());
    }
    Ok(Layout { pieces, residuals_ms: residuals, total_frames: total })
}

/// Append a piece, joining it to the last one when they continue each other.
fn push(pieces: &mut Vec<Piece>, piece: Piece) {
    match (pieces.last_mut(), &piece) {
        (Some(Piece::Silence { frames }), Piece::Silence { frames: more }) => *frames += more,
        (Some(Piece::Dub { first, count }), Piece::Dub { first: next, count: more }) if *first + *count == *next => {
            *count += more
        }
        _ => {
            if !matches!(piece, Piece::Silence { frames: 0 } | Piece::Dub { count: 0, .. }) {
                pieces.push(piece)
            }
        }
    }
}

/// The time range `--split parts:` keeps to get frames `first..first+count`:
/// from midway between the frame before and the first, to midway between the
/// last and the one after (or past the last frame at the end).
pub(crate) fn frame_range(pts: &[f64], frame_s: f64, first: usize, count: usize) -> (f64, f64) {
    let start = if first == 0 { 0.0 } else { (pts[first - 1] + pts[first]) / 2.0 };
    let last = first + count - 1;
    let end = if last + 1 >= pts.len() { pts[pts.len() - 1] + frame_s } else { (pts[last] + pts[last + 1]) / 2.0 };
    (start, end)
}

/// mkvmerge's timestamp form, to the nanosecond.
pub(crate) fn timestamp(seconds: f64) -> String {
    let total_ns = (seconds.max(0.0) * 1e9).round() as u64;
    let (secs, ns) = (total_ns / 1_000_000_000, total_ns % 1_000_000_000);
    format!("{:02}:{:02}:{:02}.{:09}", secs / 3600, secs / 60 % 60, secs % 60, ns)
}

/// Ranges split into runs mkvmerge can take in one `--split parts:` call:
/// each run's ranges ascend without overlapping. A plan that reuses or
/// reorders dub material needs more than one.
pub(crate) fn ascending_runs(ranges: &[(f64, f64)]) -> Vec<Vec<usize>> {
    let mut runs: Vec<Vec<usize>> = Vec::new();
    let mut last_end = f64::NEG_INFINITY;
    for (index, &(start, end)) in ranges.iter().enumerate() {
        if runs.is_empty() || start + 1e-9 < last_end {
            runs.push(Vec::new());
        }
        runs.last_mut().expect("a run").push(index);
        last_end = end;
    }
    runs
}

/// How silence is encoded for a codec that can be cut losslessly: the ffmpeg
/// encoder, and the raw format it is written in (no container priming to
/// second-guess, so mkvmerge reads exactly the frames written).
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct SilenceSpec {
    pub encoder: &'static str,
    pub extension: &'static str,
    pub args: Vec<String>,
}

/// The codecs MKVBatchMux cuts itself. Anything else goes to the engine:
/// lossless formats (FLAC, PCM) because the engine writes them losslessly and
/// to the sample anyway, TrueHD and DTS because there is no encoder here for
/// the silence, Vorbis because its frames vary in length.
pub(crate) fn silence_spec(codec: &str, profile: Option<&str>, frame_ms: f64) -> Result<SilenceSpec, String> {
    let spec = |encoder, extension, args: &[&str]| SilenceSpec {
        encoder,
        extension,
        args: args.iter().map(|arg| arg.to_string()).collect(),
    };
    match codec {
        "ac3" => Ok(spec("ac3", "ac3", &[])),
        "eac3" => Ok(spec("eac3", "eac3", &[])),
        "aac" => match profile.unwrap_or("LC") {
            "LC" => Ok(spec("aac", "aac", &["-profile:a", "aac_low"])),
            other => Err(format!("AAC {other} can't be cut without re-encoding here")),
        },
        "opus" => {
            let frame = [2.5, 5.0, 10.0, 20.0, 40.0, 60.0].into_iter().find(|ms| (ms - frame_ms).abs() < 0.05);
            match frame {
                Some(ms) => Ok(SilenceSpec {
                    encoder: "libopus",
                    extension: "opus",
                    args: vec!["-frame_duration".to_string(), format!("{ms}")],
                }),
                None => Err(format!("Opus in {frame_ms:.1} ms frames can't be cut without re-encoding here")),
            }
        }
        "flac" | "alac" | "wavpack" | "tta" | "mlp" | "truehd" => {
            Err(format!("{} is lossless, so the engine writes it to the sample instead", codec_label(codec)))
        }
        other if other.starts_with("pcm_") => Err("PCM is lossless, so the engine writes it to the sample instead".to_string()),
        other => Err(format!("{} can't be cut without re-encoding here", codec_label(other))),
    }
}

/// A codec as people name it.
pub(crate) fn codec_label(codec: &str) -> String {
    match codec {
        "ac3" => "AC-3".to_string(),
        "eac3" => "E-AC-3".to_string(),
        "aac" => "AAC".to_string(),
        "opus" => "Opus".to_string(),
        "flac" => "FLAC".to_string(),
        "truehd" | "mlp" => "TrueHD".to_string(),
        "dts" => "DTS".to_string(),
        "vorbis" => "Vorbis".to_string(),
        "mp3" => "MP3".to_string(),
        other => other.to_uppercase(),
    }
}

/// What ffprobe says about one audio stream of a file.
#[derive(Debug, Clone, Default, PartialEq)]
pub(crate) struct StreamInfo {
    pub codec: String,
    pub profile: Option<String>,
    pub sample_rate: Option<u32>,
    pub channels: Option<u32>,
    pub layout: Option<String>,
    pub bit_rate: Option<u64>,
    /// The file's clock zero: its earliest stream (see the engine's `audio_lead_s`).
    pub file_start_s: f64,
}

/// Probe audio stream `index` (the N of `0:a:N`).
pub(crate) fn probe_stream(tools: &Tools, path: &Path, index: i64, cancel: &AtomicBool) -> Result<StreamInfo, String> {
    let args = vec![
        "-v".to_string(),
        "error".to_string(),
        "-select_streams".to_string(),
        format!("a:{index}"),
        "-show_entries".to_string(),
        "stream=codec_name,profile,sample_rate,channels,channel_layout,bit_rate:stream_tags=BPS,BPS-eng:format=start_time"
            .to_string(),
        "-of".to_string(),
        "json".to_string(),
        path.to_string_lossy().into_owned(),
    ];
    let output = run_tool(&tools.ffprobe, &args, cancel)?;
    if output.code != 0 {
        return Err(format!("ffprobe could not read {}: {}", file_name(path), output.tail()));
    }
    let json: Value = serde_json::from_slice(&output.stdout).map_err(|err| format!("ffprobe output: {err}"))?;
    parse_stream_info(&json).ok_or_else(|| format!("{} has no audio stream {}", file_name(path), index + 1))
}

pub(crate) fn parse_stream_info(json: &Value) -> Option<StreamInfo> {
    let stream = json.get("streams")?.as_array()?.first()?;
    let text = |value: Option<&Value>| value.and_then(Value::as_str).map(str::to_string);
    let number = |value: Option<&Value>| -> Option<f64> {
        value.and_then(|v| v.as_f64().or_else(|| v.as_str().and_then(|s| s.trim().parse().ok())))
    };
    let tags = stream.get("tags");
    let bit_rate = number(stream.get("bit_rate"))
        .or_else(|| number(tags.and_then(|t| t.get("BPS"))))
        .or_else(|| number(tags.and_then(|t| t.get("BPS-eng"))))
        .filter(|rate| *rate > 0.0)
        .map(|rate| rate as u64);
    Some(StreamInfo {
        codec: text(stream.get("codec_name"))?.to_ascii_lowercase(),
        profile: text(stream.get("profile")).filter(|p| !p.is_empty() && p != "unknown"),
        sample_rate: number(stream.get("sample_rate")).map(|rate| rate as u32),
        channels: number(stream.get("channels")).map(|count| count as u32),
        layout: text(stream.get("channel_layout")).filter(|l| !l.is_empty()),
        bit_rate,
        file_start_s: number(json.get("format").and_then(|f| f.get("start_time"))).unwrap_or(0.0),
    })
}

/// Every frame's start time of audio stream `index`, in file order.
fn packet_times(tools: &Tools, path: &Path, index: i64, cancel: &AtomicBool) -> Result<Vec<f64>, String> {
    let args = vec![
        "-v".to_string(),
        "error".to_string(),
        "-select_streams".to_string(),
        format!("a:{index}"),
        "-show_entries".to_string(),
        "packet=pts_time".to_string(),
        "-of".to_string(),
        "csv=p=0".to_string(),
        path.to_string_lossy().into_owned(),
    ];
    let output = run_tool(&tools.ffprobe, &args, cancel)?;
    if output.code != 0 {
        return Err(format!("ffprobe could not list the frames of {}: {}", file_name(path), output.tail()));
    }
    parse_packet_times(&String::from_utf8_lossy(&output.stdout))
}

pub(crate) fn parse_packet_times(text: &str) -> Result<Vec<f64>, String> {
    text.lines()
        .map(|line| line.trim().trim_end_matches(','))
        .filter(|line| !line.is_empty())
        .map(|line| line.parse::<f64>().map_err(|_| "Some of the dub's frames carry no timestamp.".to_string()))
        .collect()
}

/// The frame length, and whether every frame has it: the median spacing, with
/// each spacing allowed the millisecond Matroska rounds timestamps to.
pub(crate) fn uniform_frame(pts: &[f64]) -> Result<f64, String> {
    if pts.len() < 3 {
        return Err("The dub is too short to cut.".to_string());
    }
    let mut deltas: Vec<f64> = pts.windows(2).map(|pair| pair[1] - pair[0]).collect();
    let mut sorted = deltas.clone();
    sorted.sort_by(f64::total_cmp);
    let frame = sorted[sorted.len() / 2];
    if !(frame > 0.0) {
        return Err("The dub's frames are out of order.".to_string());
    }
    let slack = 0.0015_f64.max(frame * 0.02);
    deltas.retain(|delta| (delta - frame).abs() > slack);
    if deltas.is_empty() {
        Ok(frame)
    } else {
        Err(format!("The dub's frames are not all {:.1} ms long ({} differ)", frame * 1000.0, deltas.len()))
    }
}

/// mkvmerge's track id for audio stream `index` (the N of `0:a:N`).
fn mkvmerge_audio_id(tools: &Tools, path: &Path, index: i64, cancel: &AtomicBool) -> Result<i64, String> {
    let output = run_tool(&tools.mkvmerge, &["-J".to_string(), path.to_string_lossy().into_owned()], cancel)?;
    let json: Value = serde_json::from_slice(&output.stdout)
        .map_err(|_| format!("mkvmerge could not read {}: {}", file_name(path), output.tail()))?;
    if json.pointer("/container/recognized").and_then(Value::as_bool) == Some(false) {
        return Err(format!("mkvmerge does not recognise {}", file_name(path)));
    }
    json.get("tracks")
        .and_then(Value::as_array)
        .and_then(|tracks| {
            tracks
                .iter()
                .filter(|track| track.get("type").and_then(Value::as_str) == Some("audio"))
                .nth(index.max(0) as usize)
        })
        .and_then(|track| track.get("id").and_then(Value::as_i64))
        .ok_or_else(|| format!("mkvmerge finds no audio track {} in {}", index + 1, file_name(path)))
}

fn file_name(path: &Path) -> String {
    path.file_name().map(|name| name.to_string_lossy().into_owned()).unwrap_or_else(|| path.to_string_lossy().into_owned())
}

/// Run mkvmerge; exit 1 is "finished with warnings", which still wrote the file.
fn mkvmerge(tools: &Tools, args: Vec<String>, cancel: &AtomicBool) -> Result<(), CutError> {
    let output = run_tool(&tools.mkvmerge, &args, cancel)?;
    match output.code {
        0 | 1 => Ok(()),
        _ => Err(CutError::Failed(format!("mkvmerge: {}", output.tail()))),
    }
}

/// Run `mkvmerge --split parts:` over `ranges` of `source`, and return the
/// files it wrote in range order. With one range mkvmerge writes the name it
/// was given; with more it numbers them.
fn split(tools: &Tools, source: &Path, ranges: &[(f64, f64)], dir: &Path, stem: &str, cancel: &AtomicBool) -> Result<Vec<PathBuf>, CutError> {
    let parts = ranges.iter().map(|(start, end)| format!("{}-{}", timestamp(*start), timestamp(*end))).collect::<Vec<_>>().join(",");
    let base = dir.join(format!("{stem}.mka"));
    mkvmerge(
        tools,
        vec!["-q".into(), "-o".into(), base.to_string_lossy().into_owned(), "--split".into(), format!("parts:{parts}"), source.to_string_lossy().into_owned()],
        cancel,
    )?;
    let files: Vec<PathBuf> = if ranges.len() == 1 {
        vec![base]
    } else {
        (1..=ranges.len()).map(|n| dir.join(format!("{stem}-{n:03}.mka"))).collect()
    };
    match files.iter().find(|file| !file.is_file()) {
        Some(missing) => Err(CutError::Failed(format!("mkvmerge did not write {}", file_name(missing)))),
        None => Ok(files),
    }
}

/// Conform one dub losslessly from its plan, writing `output` (a `.mka`).
/// `progress` hears a percentage of this step and what is being done.
pub(crate) fn conform(
    tools: &Tools,
    plan: &Value,
    output: &Path,
    cancel: &AtomicBool,
    progress: &mut dyn FnMut(u64, &str),
) -> Result<Cut, CutError> {
    let speed = plan.get("speed").and_then(Value::as_f64).unwrap_or(1.0);
    if (speed - 1.0).abs() > 1e-6 {
        return Err(CutError::Unsupported(
            "The dub runs at another speed (a frame-rate conversion), which only re-encoding can undo".to_string(),
        ));
    }
    if plan.get("timeline").and_then(Value::as_str).unwrap_or("stream") != "container" {
        return Err(CutError::Unsupported("This engine's plan is not on the files' own clocks".to_string()));
    }
    let dub_path = PathBuf::from(plan.get("dubPath").and_then(Value::as_str).ok_or_else(|| CutError::Failed("The plan names no dub.".into()))?);
    let dub_track = plan.get("dubTrack").and_then(Value::as_i64).unwrap_or(0);
    let video_duration = plan.get("videoDurationS").and_then(Value::as_f64).unwrap_or(0.0);

    progress(0, "Reading the dub's frames");
    let info = probe_stream(tools, &dub_path, dub_track, cancel)?;
    let engine_pts: Vec<f64> = packet_times(tools, &dub_path, dub_track, cancel)?
        .into_iter()
        .map(|t| t - info.file_start_s)
        .collect();
    let frame = uniform_frame(&engine_pts).map_err(CutError::Unsupported)?;
    let spec = silence_spec(&info.codec, info.profile.as_deref(), frame * 1000.0).map_err(CutError::Unsupported)?;
    let layout = lay_out(&plan_segments(plan), video_duration, &engine_pts, frame).map_err(CutError::Failed)?;

    let parent = output.parent().ok_or_else(|| CutError::Failed("No folder to write to.".into()))?;
    fs::create_dir_all(parent).map_err(|err| CutError::Failed(format!("Could not create {}: {err}", parent.display())))?;
    // Beside the output, not in the system temp folder: the pieces are as big
    // as the dub, and the final rename stays on one drive.
    let work = tempfile::Builder::new()
        .prefix(".mkvbatchmux-conform-")
        .tempdir_in(parent)
        .map_err(|err| CutError::Failed(format!("Could not make a working folder: {err}")))?;

    // The dub's own track alone, as mkvmerge sees it: its timestamps are the
    // ones `--split` cuts on. Whatever ffprobe and mkvmerge each make of the
    // container's clock, they must agree on the frames.
    progress(10, "Reading the dub's frames");
    let track_id = mkvmerge_audio_id(tools, &dub_path, dub_track, cancel)?;
    let source = work.path().join("source.mka");
    mkvmerge(
        tools,
        vec![
            "-q".into(),
            "-o".into(),
            source.to_string_lossy().into_owned(),
            "-a".into(),
            track_id.to_string(),
            "-D".into(),
            "-S".into(),
            "-B".into(),
            "-M".into(),
            "--no-chapters".into(),
            "--no-global-tags".into(),
            dub_path.to_string_lossy().into_owned(),
        ],
        cancel,
    )?;
    let mkv_pts = packet_times(tools, &source, 0, cancel)?;
    if mkv_pts.len() != engine_pts.len() {
        return Err(CutError::Unsupported(format!(
            "mkvmerge reads {} frames in the dub where ffmpeg reads {}",
            mkv_pts.len(),
            engine_pts.len()
        )));
    }

    // Silence, all of it in one encode, cut into the lengths the layout needs.
    let silences: Vec<usize> = layout.pieces.iter().filter_map(|piece| match piece {
        Piece::Silence { frames } => Some(*frames),
        _ => None,
    }).collect();
    let mut silence_files: Vec<PathBuf> = Vec::new();
    if !silences.is_empty() {
        progress(30, "Encoding silence for the gaps");
        let needed: usize = silences.iter().sum();
        let raw = work.path().join(format!("silence-source.{}", spec.extension));
        let rate = info.sample_rate.unwrap_or(48000);
        let layout_name = info.layout.clone().unwrap_or_else(|| format!("{}c", info.channels.unwrap_or(2)));
        let mut args: Vec<String> = vec![
            "-nostdin".into(),
            "-v".into(),
            "error".into(),
            "-y".into(),
            "-f".into(),
            "lavfi".into(),
            "-i".into(),
            format!("anullsrc=r={rate}:cl={layout_name}"),
            "-frames:a".into(),
            (needed + 4).to_string(),
            "-c:a".into(),
            spec.encoder.to_string(),
        ];
        // The encoder's own bitrate: silence costs nothing at any rate, and the
        // dub's (an average, for some) need not be one the encoder accepts.
        args.extend(spec.args.iter().cloned());
        args.push(raw.to_string_lossy().into_owned());
        let encoded = run_tool(&tools.ffmpeg, &args, cancel)?;
        if encoded.code != 0 {
            return Err(CutError::Unsupported(format!("ffmpeg could not encode silence to match: {}", encoded.tail())));
        }
        let silence = work.path().join("silence.mka");
        mkvmerge(tools, vec!["-q".into(), "-o".into(), silence.to_string_lossy().into_owned(), raw.to_string_lossy().into_owned()], cancel)?;
        let silence_pts = packet_times(tools, &silence, 0, cancel)?;
        let silence_frame = uniform_frame(&silence_pts).map_err(CutError::Failed)?;
        if (silence_frame - frame).abs() > 0.0001 || silence_pts.len() < needed {
            return Err(CutError::Unsupported(format!(
                "The silence ffmpeg encodes comes in {:.1} ms frames, the dub's in {:.1} ms",
                silence_frame * 1000.0,
                frame * 1000.0
            )));
        }
        let mut at = 0usize;
        let ranges: Vec<(f64, f64)> = silences
            .iter()
            .map(|&frames| {
                let range = frame_range(&silence_pts, silence_frame, at, frames);
                at += frames;
                range
            })
            .collect();
        silence_files = split(tools, &silence, &ranges, work.path(), "silence-part", cancel)?;
    }

    // The dub's pieces, in as few passes over the file as their order allows.
    progress(45, "Cutting the dub's frames");
    let dub_pieces: Vec<(usize, usize)> = layout.pieces.iter().filter_map(|piece| match piece {
        Piece::Dub { first, count } => Some((*first, *count)),
        _ => None,
    }).collect();
    let ranges: Vec<(f64, f64)> = dub_pieces.iter().map(|&(first, count)| frame_range(&mkv_pts, frame, first, count)).collect();
    let mut dub_files: Vec<PathBuf> = vec![PathBuf::new(); ranges.len()];
    for (run_index, run) in ascending_runs(&ranges).into_iter().enumerate() {
        let run_ranges: Vec<(f64, f64)> = run.iter().map(|&i| ranges[i]).collect();
        let files = split(tools, &source, &run_ranges, work.path(), &format!("dub-run{run_index}"), cancel)?;
        for (index, file) in run.into_iter().zip(files) {
            dub_files[index] = file;
        }
    }

    // Join them in the layout's order. Each file is renamed first so none ends
    // in a number: mkvmerge would otherwise look for "-002" beside a "-001"
    // and join files it was not given.
    progress(70, "Joining the pieces");
    let (mut dubs, mut silences) = (dub_files.into_iter(), silence_files.into_iter());
    let mut ordered: Vec<PathBuf> = Vec::new();
    for (index, piece) in layout.pieces.iter().enumerate() {
        let file = match piece {
            Piece::Dub { .. } => dubs.next(),
            Piece::Silence { .. } => silences.next(),
        }
        .ok_or_else(|| CutError::Failed("A piece went missing while cutting.".into()))?;
        let renamed = work.path().join(format!("piece-{index}-cut.mka"));
        fs::rename(&file, &renamed).map_err(|err| CutError::Failed(format!("Could not arrange the pieces: {err}")))?;
        ordered.push(renamed);
    }
    let staging = work.path().join("conformed.mka");
    let mut args: Vec<String> = vec!["-q".into(), "-o".into(), staging.to_string_lossy().into_owned()];
    for (index, file) in ordered.iter().enumerate() {
        if index > 0 {
            args.push("+".into());
        }
        args.push(file.to_string_lossy().into_owned());
    }
    match mkvmerge(tools, args, cancel) {
        Ok(()) => {}
        // Appending fails when the silence's codec setup differs from the
        // dub's (an AAC or Opus header ffmpeg cannot reproduce): not this
        // dub's fault, and the engine can still write it.
        Err(CutError::Failed(message)) => {
            return Err(CutError::Unsupported(format!("The silence could not be joined to the dub ({message})")))
        }
        Err(other) => return Err(other),
    }

    // Exactly the frames counted, or something moved.
    let written = packet_times(tools, &staging, 0, cancel)?.len();
    if written != layout.total_frames {
        return Err(CutError::Failed(format!(
            "The conformed track has {written} frames where {} were laid out",
            layout.total_frames
        )));
    }
    if output == dub_path.as_path() {
        return Err(CutError::Failed("Refusing to overwrite the dub itself.".into()));
    }
    if output.exists() {
        fs::remove_file(output).map_err(|err| CutError::Failed(format!("Could not replace {}: {err}", file_name(output))))?;
    }
    fs::rename(&staging, output).map_err(|err| CutError::Failed(format!("Could not write {}: {err}", file_name(output))))?;
    progress(100, "Cut");
    Ok(Cut { path: output.to_path_buf(), codec: info.codec, frame_ms: frame * 1000.0, residuals_ms: layout.residuals_ms })
}

#[cfg(test)]
mod tests {
    use super::*;

    const F: f64 = 0.032;

    fn grid(count: usize) -> Vec<f64> {
        (0..count).map(|k| k as f64 * F).collect()
    }

    fn dub(start_s: f64, end_s: f64, offset_s: f64) -> PlanSegment {
        PlanSegment { dub: true, start_s, end_s, offset_s: Some(offset_s) }
    }

    fn fill(start_s: f64, end_s: f64) -> PlanSegment {
        PlanSegment { dub: false, start_s, end_s, offset_s: None }
    }

    /// The E02 test episode: 10 s of the video missing from the dub at 100 s,
    /// the dub 0.8455 s late before it. These are the numbers the real cut
    /// produced, and that planning it again confirmed.
    #[test]
    fn a_missing_scene_becomes_silence_between_two_runs_of_frames() {
        let segments = [dub(0.0, 100.014, 0.8455), fill(100.014, 110.0835), dub(110.0835, 300.0, -9.224)];
        let layout = lay_out(&segments, 300.0, &grid(9087), F).unwrap();
        assert_eq!(
            layout.pieces,
            vec![
                Piece::Dub { first: 26, count: 3125 },
                Piece::Silence { frames: 315 },
                Piece::Dub { first: 3152, count: 5935 },
            ]
        );
        assert_eq!(layout.total_frames, 9375);
        assert!((layout.residuals_ms[0] - 13.5).abs() < 0.01, "{:?}", layout.residuals_ms);
        assert!((layout.residuals_ms[1] + 8.0).abs() < 0.01, "{:?}", layout.residuals_ms);
    }

    /// Every stretch lands within half a frame, however its offset falls
    /// between frames, and the frames always add up to the video's length.
    #[test]
    fn every_stretch_lands_within_half_a_frame() {
        for step in 0..64 {
            let offset = -1.0 + step as f64 * 0.0371;
            let segments = [dub(0.0, 40.0, offset), fill(40.0, 45.0), dub(45.0, 120.0, offset - 3.3)];
            let layout = lay_out(&segments, 120.0, &grid(4000), F).unwrap();
            let frames: usize = layout
                .pieces
                .iter()
                .map(|piece| match piece {
                    Piece::Dub { count, .. } => *count,
                    Piece::Silence { frames } => *frames,
                })
                .sum();
            assert_eq!(frames, layout.total_frames);
            for residual in &layout.residuals_ms {
                assert!(residual.abs() <= F * 500.0 + 1e-6, "offset {offset}: {residual} ms");
            }
        }
    }

    /// A dub that starts after the video does gets silence in front, not a
    /// frame from before its start.
    #[test]
    fn a_late_dub_is_led_in_with_silence() {
        let layout = lay_out(&[dub(0.0, 10.0, -0.5)], 10.0, &grid(400), F).unwrap();
        assert_eq!(layout.pieces[0], Piece::Silence { frames: 16 });
        assert_eq!(layout.pieces[1], Piece::Dub { first: 0, count: 297 });
        // Past the dub's last frame: silence to the end.
        let short = lay_out(&[dub(0.0, 10.0, 0.0)], 10.0, &grid(100), F).unwrap();
        assert_eq!(short.pieces, vec![Piece::Dub { first: 0, count: 100 }, Piece::Silence { frames: 213 }]);
    }

    /// Two stretches the planner split at nearly the same offset read on from
    /// one another, so they stay one cut.
    #[test]
    fn stretches_that_continue_each_other_are_one_piece() {
        let layout = lay_out(&[dub(0.0, 20.0, 1.0), dub(20.0, 40.0, 1.0004)], 40.0, &grid(2000), F).unwrap();
        assert_eq!(layout.pieces, vec![Piece::Dub { first: 31, count: 1250 }]);
    }

    #[test]
    fn a_plan_with_no_dub_is_refused() {
        assert!(lay_out(&[fill(0.0, 10.0)], 10.0, &grid(100), F).is_err());
        assert!(lay_out(&[dub(0.0, 10.0, 0.0)], 0.0, &grid(100), F).is_err());
    }

    #[test]
    fn split_points_fall_midway_between_frames() {
        let pts = grid(10);
        assert_eq!(frame_range(&pts, F, 0, 3), (0.0, 0.08));
        let (start, end) = frame_range(&pts, F, 3, 7);
        assert!((start - 0.08).abs() < 1e-12 && (end - (0.288 + F)).abs() < 1e-12);
        assert_eq!(timestamp(100.848), "00:01:40.848000000");
        assert_eq!(timestamp(3725.5), "01:02:05.500000000");
    }

    #[test]
    fn reordered_ranges_take_more_than_one_pass() {
        assert_eq!(ascending_runs(&[(0.0, 1.0), (1.0, 2.0), (5.0, 6.0)]), vec![vec![0, 1, 2]]);
        assert_eq!(ascending_runs(&[(0.0, 4.0), (3.0, 6.0), (7.0, 8.0)]), vec![vec![0], vec![1, 2]]);
    }

    #[test]
    fn only_codecs_with_a_matching_silence_are_cut() {
        assert_eq!(silence_spec("eac3", None, 32.0).unwrap().encoder, "eac3");
        assert_eq!(silence_spec("aac", Some("LC"), 21.333).unwrap().extension, "aac");
        assert!(silence_spec("aac", Some("HE-AAC"), 42.667).is_err());
        assert!(silence_spec("opus", None, 20.0).is_ok());
        assert!(silence_spec("opus", None, 13.0).is_err());
        assert!(silence_spec("truehd", None, 0.833).unwrap_err().contains("lossless"));
        assert!(silence_spec("pcm_s24le", None, 1.0).unwrap_err().contains("lossless"));
        assert!(silence_spec("dts", None, 10.667).unwrap_err().contains("DTS"));
    }

    #[test]
    fn frames_must_all_be_one_length() {
        assert!((uniform_frame(&grid(50)).unwrap() - F).abs() < 1e-12);
        // Matroska's millisecond timestamps for AAC: 21 and 22 ms apart.
        let aac: Vec<f64> = (0..50).map(|k| ((k as f64 * 0.021333) * 1000.0).round() / 1000.0).collect();
        assert!(uniform_frame(&aac).is_ok());
        let mut vorbis = grid(50);
        vorbis[20] += 0.010;
        assert!(uniform_frame(&vorbis).is_err());
    }

    #[test]
    fn stream_info_reads_matroska_statistics_tags() {
        let json = serde_json::json!({
            "streams": [{ "codec_name": "eac3", "sample_rate": "48000", "channels": 6,
                          "channel_layout": "5.1(side)", "tags": { "BPS": "640000" } }],
            "format": { "start_time": "0.000000" }
        });
        let info = parse_stream_info(&json).unwrap();
        assert_eq!(info.codec, "eac3");
        assert_eq!(info.bit_rate, Some(640000));
        assert_eq!(info.sample_rate, Some(48000));
        assert_eq!(info.layout.as_deref(), Some("5.1(side)"));
        assert_eq!(parse_packet_times("0.000000\n0.032000,\n\n").unwrap(), vec![0.0, 0.032]);
        assert!(parse_packet_times("0.0\nN/A\n").is_err());
    }
}
