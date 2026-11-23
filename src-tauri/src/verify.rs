//! Verification of a finished mux, before its output replaces the source or
//! counts as done.
//!
//! Two checks. **Structure**: `mkvmerge -J` the output and compare it with
//! what the job asked for, worked out by the same functions that built the
//! mkvmerge command (`resolve_added_tracks`, `source_track_selection`,
//! `track_order`, ...), so the expectation can never drift from the command.
//! **Sync**: when an audio track was added, the analysis engine measures it
//! against the source's first kept audio track inside the output itself; a
//! correct delay leaves nothing to measure. The quick `analyze` reads a few
//! windows; a track it would fail is planned again over the whole timeline
//! (the Dub sync planner) before it fails, because those windows can misread a
//! track with long silences, such as a losslessly conformed dub.
//!
//! A failed check keeps the output beside the source as
//! `<stem>.unverified.mkv` and leaves the source as it was.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::mpsc::Receiver;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::{AppHandle, Manager};

use crate::{
    added_track_settings, attachments_to_add, first_default_track_per_type, hidden_command, is_track_removed,
    only_keep_ids, parse_mkvmerge_duration_seconds, parse_mkvmerge_tracks, parse_track_id, resolve_added_tracks,
    source_default_flags, source_track_default, source_track_selection, track_order, MuxJobRequest, MuxSettings,
    TrackInfo,
};

/// Seconds the output may differ in length from the source.
const DURATION_SLACK_S: f64 = 2.0;
/// How far an added audio track's own length may stray from the video's
/// before it is worth a look: a dub with other credits differs by a little.
const AUDIO_LENGTH_SLACK: f64 = 0.02;
/// Below this the engine's match is noise, not a measurement (the same bar
/// measuring uses before it fills in a delay).
const MIN_CONFIDENCE: f64 = 0.5;

// ------------------------------------------------------------------ report

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub(crate) enum CheckStatus {
    Pass,
    Warn,
    Fail,
    Skip,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Check {
    pub id: String,
    pub label: String,
    pub status: CheckStatus,
    pub detail: String,
}

impl Check {
    fn new(id: &str, label: &str, status: CheckStatus, detail: impl Into<String>) -> Self {
        Self { id: id.to_string(), label: label.to_string(), status, detail: detail.into() }
    }
}

/// What verification found, sent to the frontend with the job's final status.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct VerificationReport {
    /// No check failed. Warnings do not make it false.
    pub ok: bool,
    pub checks: Vec<Check>,
    /// The added audio track furthest from the source's audio, in ms; positive
    /// when it plays late. None when nothing was measured.
    pub residual_ms: Option<f64>,
    pub sync_confidence: Option<f64>,
    /// Where a failed output was kept (`<stem>.unverified.mkv`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub kept_path: Option<String>,
}

impl VerificationReport {
    fn from_checks(checks: Vec<Check>, residual_ms: Option<f64>, sync_confidence: Option<f64>) -> Self {
        let ok = !checks.iter().any(|check| check.status == CheckStatus::Fail);
        Self { ok, checks, residual_ms, sync_confidence, kept_path: None }
    }

    /// The first failed check, as the job's error says it.
    pub fn first_failure(&self) -> Option<&Check> {
        self.checks.iter().find(|check| check.status == CheckStatus::Fail)
    }

    pub fn warnings(&self) -> impl Iterator<Item = &Check> {
        self.checks.iter().filter(|check| check.status == CheckStatus::Warn)
    }
}

// ---------------------------------------------------------------- expected

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Origin {
    /// A track of the source, by its id there.
    Source(u64),
    /// An added track: its input file number in the command and its id there.
    Added { file: usize, track: u64 },
}

#[derive(Debug, Clone)]
pub(crate) struct ExpectedTrack {
    /// "video", "audio" or "subtitle", as TrackInfo has it.
    pub kind: String,
    pub origin: Origin,
    /// How messages name the track.
    pub label: String,
    pub language: Option<String>,
    pub name: Option<String>,
    pub default: Option<bool>,
    pub forced: Option<bool>,
    /// Muxed with a linear stretch (Correct the frame rate). mkvmerge only
    /// rescales its timestamps; a decoder still reads the samples at their
    /// own speed, so the engine would hear the old mismatch and the sync
    /// check cannot judge it.
    pub stretched: bool,
}

/// The file a job should produce, track by track in output order.
#[derive(Debug, Clone, Default)]
pub(crate) struct Expected {
    pub tracks: Vec<ExpectedTrack>,
    /// Chapters were given, so the output must have some.
    pub chapters: bool,
    /// File names of the attachments added.
    pub attachments: Vec<String>,
    /// The source's own tracks could not be read, so how many of them the
    /// output keeps is not known; only the added tracks can be checked.
    pub source_unknown: bool,
    /// The source length compared against may come from a track the job
    /// dropped (its tracks carry no lengths of their own to tell), so an
    /// output shorter than it is only worth a warning.
    pub length_may_be_dropped_track: bool,
}

impl Expected {
    fn added_audio(&self) -> impl Iterator<Item = &ExpectedTrack> {
        self.tracks.iter().filter(|track| track.kind == "audio" && matches!(track.origin, Origin::Added { .. }))
    }
}

fn file_name(path: &str) -> String {
    Path::new(path).file_name().map(|name| name.to_string_lossy().to_string()).unwrap_or_else(|| path.to_string())
}

/// What an mkvmerge run of this job should produce. `source_tracks` stands in
/// for the job's own list when the scan did not read the source's tracks.
pub(crate) fn expected_from_mux(job: &MuxJobRequest, settings: &MuxSettings, source_tracks: Option<&[TrackInfo]>) -> Expected {
    let added = resolve_added_tracks(job);
    let known = !job.video.tracks.is_empty();
    let mut expected = Expected {
        chapters: !job.chapters.is_empty(),
        attachments: attachments_to_add(job, settings).iter().map(|file| file_name(&file.path)).collect(),
        source_unknown: !known && source_tracks.is_none(),
        ..Expected::default()
    };

    // In mkvmerge's own order, which --track-order then rearranges: the
    // source's tracks by id, then each added file's.
    let mut tracks: Vec<ExpectedTrack> = Vec::new();
    if known {
        let early: HashMap<usize, bool> = source_default_flags(job, settings, &added).into_iter().collect();
        let winners = first_default_track_per_type(&job.video.tracks);
        let mut kept: Vec<(usize, &TrackInfo)> = Vec::new();
        for kind in ["video", "audio", "subtitle"] {
            let only_keep = if kind == "video" { None } else { only_keep_ids(job, settings, kind) };
            let selection = source_track_selection(&job.video.tracks, kind, only_keep);
            for (index, track) in job.video.tracks.iter().enumerate() {
                let id = parse_track_id(track, index);
                if track.track_type == kind && selection.as_ref().map_or(true, |ids| ids.contains(&id)) {
                    kept.push((id, track));
                }
            }
        }
        kept.sort_by_key(|(id, _)| *id);
        for (id, track) in kept {
            let external_default = match track.track_type.as_str() {
                "audio" => added.audio_default(),
                "subtitle" => added.subtitle_default(),
                _ => false,
            };
            // The track's own flag is written after the bulk ones, so it wins.
            let default = source_track_default(track, id, &winners, external_default).or_else(|| early.get(&id).copied());
            tracks.push(ExpectedTrack {
                kind: track.track_type.clone(),
                origin: Origin::Source(id as u64),
                label: format!("The source's {} track {}", track.track_type, id),
                language: track.language.clone(),
                name: track.name.clone().filter(|name| !name.trim().is_empty()),
                default,
                forced: (track.track_type == "subtitle").then_some(track.is_forced).flatten(),
                stretched: false,
            });
        }
    } else if let Some(probed) = source_tracks {
        // Nothing was selected or set on tracks the scan never saw: all of
        // them go through as they are.
        for (index, track) in probed.iter().enumerate() {
            let id = parse_track_id(track, index);
            tracks.push(ExpectedTrack {
                kind: track.track_type.clone(),
                origin: Origin::Source(id as u64),
                label: format!("The source's {} track {}", track.track_type, id),
                language: None,
                name: None,
                default: None,
                forced: None,
                stretched: false,
            });
        }
    }

    let label = |file: &crate::ExternalFileInfo, track_id: u64, multi: bool| {
        let name = file_name(&file.path);
        if multi {
            format!("{name}, track {track_id}")
        } else {
            name
        }
    };
    let count_of = |path: &str| added.audios.iter().chain(added.subtitles.iter()).filter(|(file, _)| file.path == path).count();
    let mut file_index = 1usize;
    for (audio, track_id) in &added.audios {
        let settings = added_track_settings(audio, *track_id);
        tracks.push(ExpectedTrack {
            kind: "audio".to_string(),
            origin: Origin::Added { file: file_index, track: *track_id },
            label: label(audio, *track_id, count_of(&audio.path) > 1),
            language: settings.language,
            name: settings.name.filter(|name| !name.trim().is_empty()),
            default: audio.is_default,
            forced: None,
            stretched: settings.stretch.is_some_and(|stretch| stretch.is_usable() && stretch.num != stretch.den),
        });
        file_index += 1;
    }
    for (subtitle, track_id) in &added.subtitles {
        let settings = added_track_settings(subtitle, *track_id);
        tracks.push(ExpectedTrack {
            kind: "subtitle".to_string(),
            origin: Origin::Added { file: file_index, track: *track_id },
            label: label(subtitle, *track_id, count_of(&subtitle.path) > 1),
            language: settings.language,
            name: settings.name.filter(|name| !name.trim().is_empty()),
            default: subtitle.is_default,
            forced: subtitle.is_forced,
            stretched: false,
        });
        file_index += 1;
    }

    // mkvmerge puts the listed tracks first, in that order, and any it was
    // not told about after them; entries for tracks it does not mux are skipped.
    if let Some(order) = track_order(job, &added) {
        let mut rest = tracks;
        let mut ordered = Vec::with_capacity(rest.len());
        for (file, track) in order {
            let wanted = if file == 0 { Origin::Source(track) } else { Origin::Added { file, track } };
            if let Some(at) = rest.iter().position(|candidate| candidate.origin == wanted) {
                ordered.push(rest.remove(at));
            }
        }
        ordered.extend(rest);
        tracks = ordered;
    }
    expected.tracks = tracks;
    expected
}

/// What an in-place edit (Fast mux, mkvpropedit) should leave: every track of
/// the source where it was, with what `build_mkvpropedit_args` set on it.
pub(crate) fn expected_from_edit(job: &MuxJobRequest) -> Expected {
    let tracks = job
        .video
        .tracks
        .iter()
        .enumerate()
        .map(|(index, track)| {
            let id = parse_track_id(track, index);
            let edited = !is_track_removed(track);
            ExpectedTrack {
                kind: track.track_type.clone(),
                origin: Origin::Source(id as u64),
                label: format!("The source's {} track {}", track.track_type, id),
                language: track.language.clone().filter(|_| edited),
                // An empty name is written to clear it.
                name: track.name.as_ref().filter(|_| edited).map(|name| name.trim().to_string()),
                default: track.is_default.filter(|_| edited),
                forced: track.is_forced.filter(|_| edited),
                stretched: false,
            }
        })
        .collect();
    Expected { tracks, ..Expected::default() }
}

// ------------------------------------------------------------------ output

#[derive(Debug, Clone, Default)]
pub(crate) struct OutputTrack {
    pub kind: String,
    pub language: Option<String>,
    pub language_ietf: Option<String>,
    pub name: Option<String>,
    pub default: Option<bool>,
    pub forced: Option<bool>,
    /// The track's statistics tag: how long it runs.
    pub duration_s: Option<f64>,
}

#[derive(Debug, Clone, Default)]
pub(crate) struct OutputFile {
    pub tracks: Vec<OutputTrack>,
    pub duration_s: Option<f64>,
    pub chapters: u64,
    pub attachments: Vec<String>,
}

/// "01:23:45.678000000", the form mkvmerge's DURATION statistics tag takes.
fn parse_tag_duration(value: &str) -> Option<f64> {
    let mut parts = value.trim().split(':');
    let hours: f64 = parts.next()?.parse().ok()?;
    let minutes: f64 = parts.next()?.parse().ok()?;
    let seconds: f64 = parts.next()?.parse().ok()?;
    parts.next().is_none().then_some(hours * 3600.0 + minutes * 60.0 + seconds)
}

pub(crate) fn read_output(json: &Value) -> OutputFile {
    let tracks = json
        .get("tracks")
        .and_then(Value::as_array)
        .map(|tracks| {
            tracks
                .iter()
                .filter_map(|track| {
                    let kind = match track.get("type").and_then(Value::as_str)? {
                        "video" => "video",
                        "audio" => "audio",
                        "subtitles" => "subtitle",
                        _ => return None,
                    };
                    let properties = track.get("properties");
                    let text = |key: &str| properties.and_then(|p| p.get(key)).and_then(Value::as_str).map(str::to_string);
                    let flag = |key: &str| properties.and_then(|p| p.get(key)).and_then(Value::as_bool);
                    Some(OutputTrack {
                        kind: kind.to_string(),
                        language: text("language"),
                        language_ietf: text("language_ietf"),
                        name: text("track_name"),
                        default: flag("default_track"),
                        forced: flag("forced_track"),
                        duration_s: text("tag_duration").as_deref().and_then(parse_tag_duration),
                    })
                })
                .collect()
        })
        .unwrap_or_default();
    let chapters = json
        .get("chapters")
        .and_then(Value::as_array)
        .map(|entries| entries.iter().filter_map(|entry| entry.get("num_entries").and_then(Value::as_u64)).sum())
        .unwrap_or(0);
    let attachments = json
        .get("attachments")
        .and_then(Value::as_array)
        .map(|entries| {
            entries
                .iter()
                .filter_map(|entry| entry.get("file_name").and_then(Value::as_str).map(str::to_string))
                .collect()
        })
        .unwrap_or_default();
    OutputFile { tracks, duration_s: parse_mkvmerge_duration_seconds(json), chapters, attachments }
}

/// Each track's length from its statistics tag, by track id.
fn track_lengths(json: &Value) -> HashMap<u64, f64> {
    json.get("tracks")
        .and_then(Value::as_array)
        .map(|tracks| {
            tracks
                .iter()
                .filter_map(|track| {
                    let id = track.get("id").and_then(Value::as_u64)?;
                    let tag = track.get("properties")?.get("tag_duration")?.as_str()?;
                    Some((id, parse_tag_duration(tag)?))
                })
                .collect()
        })
        .unwrap_or_default()
}

/// The length the output should have. The source's container length is its
/// longest track, which may be one the job drops (a commentary that runs
/// past the credits): then the output is rightly shorter. So when tracks are
/// dropped the reference is the longest track kept, from the tracks'
/// statistics tags (`lengths`, by id); where those are missing it stays the
/// container length and `expected` is marked so a shorter output only warns.
/// `source_ids` are all the source's track ids, None when not known.
pub(crate) fn reference_length(expected: &mut Expected, source_ids: Option<&[u64]>, lengths: &HashMap<u64, f64>, container: Option<f64>) -> Option<f64> {
    if expected.source_unknown {
        return container;
    }
    let kept: Vec<u64> = expected
        .tracks
        .iter()
        .filter_map(|track| match track.origin {
            Origin::Source(id) => Some(id),
            Origin::Added { .. } => None,
        })
        .collect();
    let dropped = source_ids.map_or(false, |ids| ids.iter().any(|id| !kept.contains(id)));
    if !dropped {
        return container;
    }
    let kept_lengths: Option<Vec<f64>> = kept.iter().map(|id| lengths.get(id).copied()).collect();
    match kept_lengths.filter(|lengths| !lengths.is_empty()) {
        Some(lengths) => {
            let longest = lengths.into_iter().fold(0.0_f64, f64::max);
            Some(container.map_or(longest, |container| longest.min(container)))
        }
        None => {
            expected.length_may_be_dropped_track = true;
            container
        }
    }
}

/// `mkvmerge -J` a file, uncached: the output is new, and the source may
/// have just been edited in place.
pub(crate) fn probe(path: &Path) -> Result<Value, String> {
    let output = hidden_command("mkvmerge")
        .arg("-J")
        .arg(path)
        .output()
        .map_err(|err| format!("mkvmerge could not be started: {err}"))?;
    // Lossy: without a UTF-8 locale (a macOS app started from the Finder)
    // mkvmerge prints names with bytes that are not UTF-8, which must not make
    // a good file unreadable here.
    let json: Value = serde_json::from_str(&String::from_utf8_lossy(&output.stdout))
        .map_err(|_| format!("mkvmerge could not read {}", path.display()))?;
    // A file mkvmerge cannot make sense of still gets a JSON answer, with
    // its reasons in "errors".
    let recognized = json.get("container").and_then(|c| c.get("recognized")).and_then(Value::as_bool).unwrap_or(false);
    if !output.status.success() || !recognized {
        let reason = json
            .get("errors")
            .and_then(Value::as_array)
            .and_then(|errors| errors.first())
            .and_then(Value::as_str)
            .map(str::to_string)
            .unwrap_or_else(|| "it is not a file mkvmerge recognises".to_string());
        return Err(reason);
    }
    Ok(json)
}

// --------------------------------------------------------------- languages

/// ISO 639-2 has two codes for these; mkvmerge writes the bibliographic one
/// whichever it was given ("fra" comes back "fre").
const BIBLIOGRAPHIC: [(&str, &str); 20] = [
    ("alb", "sqi"), ("arm", "hye"), ("baq", "eus"), ("bur", "mya"), ("chi", "zho"),
    ("cze", "ces"), ("dut", "nld"), ("fre", "fra"), ("geo", "kat"), ("ger", "deu"),
    ("gre", "ell"), ("ice", "isl"), ("mac", "mkd"), ("mao", "mri"), ("may", "msa"),
    ("per", "fas"), ("rum", "ron"), ("slo", "slk"), ("tib", "bod"), ("wel", "cym"),
];

fn terminology(code: &str) -> String {
    let lower = code.trim().to_ascii_lowercase();
    BIBLIOGRAPHIC
        .iter()
        .find(|(bibliographic, _)| *bibliographic == lower)
        .map(|(_, terminology)| terminology.to_string())
        .unwrap_or(lower)
}

/// Whether a track carries the language asked for. mkvmerge stores a legacy
/// ISO 639-2 code and a BCP 47 tag, and the app may have asked in either
/// ("hin", "hi", "pt-BR", or "fra" stored as "fre"/"fr").
pub(crate) fn same_language(asked: &str, track: &OutputTrack) -> bool {
    let asked = asked.trim();
    if asked.is_empty() {
        return true;
    }
    let wanted = terminology(asked);
    let legacy = track.language.as_deref().unwrap_or("eng");
    if terminology(legacy) == wanted {
        return true;
    }
    track.language_ietf.as_deref().is_some_and(|ietf| {
        let primary = ietf.split('-').next().unwrap_or(ietf);
        ietf.eq_ignore_ascii_case(asked) || terminology(primary) == wanted
    })
}

fn language_text(track: &OutputTrack) -> String {
    track.language_ietf.clone().or_else(|| track.language.clone()).unwrap_or_else(|| "und".to_string())
}

// --------------------------------------------------------------- structure

fn plural(count: usize, one: &str) -> String {
    format!("{count} {one}{}", if count == 1 { "" } else { "s" })
}

/// "1:23:45" or "4:49.9": a length as people read it.
fn clock(seconds: f64) -> String {
    let total = seconds.max(0.0);
    let hours = (total / 3600.0).floor();
    let minutes = ((total - hours * 3600.0) / 60.0).floor();
    let rest = total - hours * 3600.0 - minutes * 60.0;
    let secs = if (rest - rest.round()).abs() < 0.05 { format!("{:02}", rest.round() as u64) } else { format!("{:04.1}", rest) };
    if hours > 0.0 {
        format!("{}:{:02}:{secs}", hours as u64, minutes as u64)
    } else {
        format!("{}:{secs}", minutes as u64)
    }
}

const KINDS: [&str; 3] = ["video", "audio", "subtitle"];

fn kind_counts<'a>(kinds: impl Iterator<Item = &'a str>) -> [usize; 3] {
    let mut counts = [0; 3];
    for kind in kinds {
        if let Some(at) = KINDS.iter().position(|known| *known == kind) {
            counts[at] += 1;
        }
    }
    counts
}

fn counts_text(counts: [usize; 3]) -> String {
    let parts: Vec<String> = KINDS
        .iter()
        .zip(counts)
        .filter(|(_, count)| *count > 0)
        .map(|(kind, count)| format!("{count} {kind}"))
        .collect();
    if parts.is_empty() {
        "No tracks".to_string()
    } else {
        format!("{} track{}", parts.join(", "), if counts.iter().sum::<usize>() == 1 { "" } else { "s" })
    }
}

/// Pair each expected track with the output track at the same place among
/// its type. Only types whose counts agree are paired.
fn pair_tracks<'a>(expected: &'a Expected, output: &'a OutputFile) -> Vec<(&'a ExpectedTrack, Option<&'a OutputTrack>)> {
    let mut seen: HashMap<&str, usize> = HashMap::new();
    expected
        .tracks
        .iter()
        .map(|track| {
            let nth = seen.entry(track.kind.as_str()).or_insert(0);
            let found = output.tracks.iter().filter(|candidate| candidate.kind == track.kind).nth(*nth);
            *nth += 1;
            (track, found)
        })
        .collect()
}

/// Everything but sync: tracks, added tracks, length, chapters, attachments,
/// order, names and flags, and the added audio's own length.
pub(crate) fn structure_checks(expected: &Expected, output: &OutputFile, source_duration: Option<f64>) -> Vec<Check> {
    let mut checks = Vec::new();
    let expected_counts = kind_counts(expected.tracks.iter().map(|track| track.kind.as_str()));
    let output_counts = kind_counts(output.tracks.iter().map(|track| track.kind.as_str()));
    let counts_agree = expected_counts == output_counts;

    // Tracks per type.
    checks.push(if expected.source_unknown {
        Check::new("tracks", "Tracks", CheckStatus::Skip, format!("{}; the source's tracks were never read, so there is nothing to compare with", counts_text(output_counts)))
    } else if counts_agree {
        Check::new("tracks", "Tracks", CheckStatus::Pass, counts_text(output_counts))
    } else {
        let at = (0..3).find(|&at| expected_counts[at] != output_counts[at]).unwrap_or(0);
        Check::new(
            "tracks",
            "Tracks",
            CheckStatus::Fail,
            format!("{} where the job asked for {}", plural(output_counts[at], &format!("{} track", KINDS[at])), expected_counts[at]),
        )
    });

    let pairs = pair_tracks(expected, output);
    let type_agrees = |kind: &str| {
        let at = KINDS.iter().position(|known| *known == kind).unwrap_or(0);
        expected.source_unknown || expected_counts[at] == output_counts[at]
    };

    // Added tracks: each there, in its language.
    let added: Vec<&(&ExpectedTrack, Option<&OutputTrack>)> =
        pairs.iter().filter(|(track, _)| matches!(track.origin, Origin::Added { .. })).collect();
    checks.push(if added.is_empty() {
        Check::new("added", "Added tracks", CheckStatus::Skip, "Nothing added")
    } else {
        let mut problem = None;
        for (track, found) in &added {
            let found = found.filter(|_| type_agrees(&track.kind) || expected.source_unknown);
            match found {
                None => {
                    problem = Some(format!("{} ({}) is missing", track.label, track.kind));
                    break;
                }
                Some(found) => {
                    if let Some(language) = track.language.as_deref() {
                        if !same_language(language, found) {
                            problem = Some(format!("{} is {} in the new file, not {}", track.label, language_text(found), language));
                            break;
                        }
                    }
                }
            }
        }
        match problem {
            Some(detail) => Check::new("added", "Added tracks", CheckStatus::Fail, detail),
            None => Check::new("added", "Added tracks", CheckStatus::Pass, format!("{} there, each in its language", plural(added.len(), "added track"))),
        }
    });

    // Length against the source's. Shorter means something was lost; longer
    // is only expected when an added track runs past the end.
    checks.push(match (output.duration_s, source_duration) {
        (None, _) => Check::new("duration", "Duration", CheckStatus::Fail, "The new file has no length"),
        (Some(length), None) => Check::new("duration", "Duration", CheckStatus::Skip, format!("{}; the source's length is not known", clock(length))),
        (Some(length), Some(source)) => {
            let off = length - source;
            if off.abs() <= DURATION_SLACK_S {
                Check::new("duration", "Duration", CheckStatus::Pass, format!("{}, as the source", clock(length)))
            } else if off < 0.0 && expected.length_may_be_dropped_track {
                Check::new(
                    "duration",
                    "Duration",
                    CheckStatus::Warn,
                    format!("{}, {:.1} s shorter than the source, which may be a track the job removed", clock(length), -off),
                )
            } else if off < 0.0 {
                Check::new("duration", "Duration", CheckStatus::Fail, format!("{}, {:.1} s shorter than the source", clock(length), -off))
            } else if expected.tracks.iter().any(|track| matches!(track.origin, Origin::Added { .. })) {
                Check::new("duration", "Duration", CheckStatus::Warn, format!("{}, {:.1} s longer than the source: an added track runs past its end", clock(length), off))
            } else {
                Check::new("duration", "Duration", CheckStatus::Fail, format!("{}, {:.1} s longer than the source", clock(length), off))
            }
        }
    });

    checks.push(if !expected.chapters {
        Check::new("chapters", "Chapters", CheckStatus::Skip, "None added")
    } else if output.chapters > 0 {
        Check::new("chapters", "Chapters", CheckStatus::Pass, plural(output.chapters as usize, "chapter"))
    } else {
        Check::new("chapters", "Chapters", CheckStatus::Fail, "The chapters are missing")
    });

    checks.push(if expected.attachments.is_empty() {
        Check::new("attachments", "Attachments", CheckStatus::Skip, "None added")
    } else {
        let missing: Vec<&String> = expected
            .attachments
            .iter()
            .filter(|name| !output.attachments.iter().any(|found| found.eq_ignore_ascii_case(name)))
            .collect();
        match missing.first() {
            None => Check::new("attachments", "Attachments", CheckStatus::Pass, format!("{} added", plural(expected.attachments.len(), "file"))),
            Some(first) => Check::new(
                "attachments",
                "Attachments",
                CheckStatus::Warn,
                if missing.len() == 1 { format!("{first} is missing") } else { format!("{first} and {} more are missing", missing.len() - 1) },
            ),
        }
    });

    // Order: the sequence of types, the only part of it pairing by order
    // cannot already see.
    let expected_kinds: Vec<&str> = expected.tracks.iter().map(|track| track.kind.as_str()).collect();
    let output_kinds: Vec<&str> = output.tracks.iter().map(|track| track.kind.as_str()).collect();
    checks.push(if expected.source_unknown {
        Check::new("order", "Track order", CheckStatus::Skip, "The source's tracks were never read")
    } else if !counts_agree {
        Check::new("order", "Track order", CheckStatus::Skip, "Not compared: the tracks do not add up")
    } else if expected_kinds == output_kinds {
        Check::new("order", "Track order", CheckStatus::Pass, "As asked")
    } else {
        Check::new("order", "Track order", CheckStatus::Warn, format!("Not the order asked for: {}", output_kinds.join(", ")))
    });

    // Names and flags, on every track that could be paired.
    let mut differences = Vec::new();
    for (track, found) in &pairs {
        let Some(found) = found.filter(|_| type_agrees(&track.kind)) else { continue };
        if matches!(track.origin, Origin::Source(_)) {
            if let Some(language) = track.language.as_deref() {
                if !same_language(language, found) {
                    differences.push(format!("{} is {}, not {}", track.label, language_text(found), language));
                }
            }
        }
        if let Some(name) = track.name.as_deref() {
            let got = found.name.as_deref().unwrap_or("");
            if got.trim() != name.trim() {
                differences.push(if got.trim().is_empty() {
                    format!("{} has no name, not \"{}\"", track.label, name.trim())
                } else {
                    format!("{} is named \"{}\", not \"{}\"", track.label, got, name.trim())
                });
            }
        }
        if let (Some(want), Some(got)) = (track.default, found.default) {
            if want != got {
                differences.push(format!("{} is {}default", track.label, if got { "" } else { "not " }));
            }
        }
        if let (Some(want), Some(got)) = (track.forced, found.forced) {
            if want != got {
                differences.push(format!("{} is {}forced", track.label, if got { "" } else { "not " }));
            }
        }
    }
    checks.push(match differences.len() {
        0 => Check::new("flags", "Names and flags", CheckStatus::Pass, "As asked"),
        1 => Check::new("flags", "Names and flags", CheckStatus::Warn, differences.remove(0)),
        more => Check::new("flags", "Names and flags", CheckStatus::Warn, format!("{} (and {} more)", differences.remove(0), more - 1)),
    });

    // Each added audio track's own length against the video's.
    let added_audio: Vec<(&ExpectedTrack, &OutputTrack)> = pairs
        .iter()
        .filter(|(track, _)| track.kind == "audio" && matches!(track.origin, Origin::Added { .. }) && type_agrees("audio"))
        .filter_map(|(track, found)| found.map(|found| (*track, found)))
        .collect();
    checks.push(match source_duration {
        _ if added_audio.is_empty() => Check::new("audioLength", "Added audio length", CheckStatus::Skip, "No audio added"),
        None => Check::new("audioLength", "Added audio length", CheckStatus::Skip, "The video's length is not known"),
        Some(video) => {
            let off: Vec<String> = added_audio
                .iter()
                .filter_map(|(track, found)| {
                    let length = found.duration_s?;
                    let ratio = (length - video) / video;
                    (ratio.abs() > AUDIO_LENGTH_SLACK).then(|| {
                        format!(
                            "{} runs {}, {:.1} % {} than the video",
                            track.label,
                            clock(length),
                            ratio.abs() * 100.0,
                            if ratio < 0.0 { "shorter" } else { "longer" }
                        )
                    })
                })
                .collect();
            match off.first() {
                None => Check::new("audioLength", "Added audio length", CheckStatus::Pass, "Each runs as long as the video"),
                Some(first) => Check::new(
                    "audioLength",
                    "Added audio length",
                    CheckStatus::Warn,
                    if off.len() == 1 { first.clone() } else { format!("{first} (and {} more)", off.len() - 1) },
                ),
            }
        }
    });

    checks
}

// -------------------------------------------------------------------- sync

/// The measurement windows, from Preferences › Measurement, else the app's
/// defaults (AudioSyncMaster's).
#[derive(Debug, Clone, Copy, PartialEq)]
pub(crate) struct SyncWindow {
    pub window_seconds: f64,
    pub window_count: i64,
    pub max_offset_ms: f64,
}

impl Default for SyncWindow {
    fn default() -> Self {
        Self { window_seconds: 45.0, window_count: 6, max_offset_ms: 60_000.0 }
    }
}

impl SyncWindow {
    /// Read from the settings file. The Rust side's own default for a missing
    /// "Measurement" (a five-minute search) is not what the app measures with,
    /// so a missing block means the app's defaults, not that one.
    pub fn from_options(options_path: &Path) -> Self {
        let saved = std::fs::read_to_string(options_path)
            .ok()
            .and_then(|text| serde_json::from_str::<Value>(&text).ok())
            .and_then(|options| options.get("Measurement").cloned());
        let defaults = Self::default();
        let Some(saved) = saved else { return defaults };
        let number = |key: &str| saved.get(key).and_then(Value::as_f64).filter(|value| value.is_finite() && *value > 0.0);
        Self {
            window_seconds: number("windowSeconds").unwrap_or(defaults.window_seconds),
            window_count: number("windowCount").map(|count| count.round() as i64).unwrap_or(defaults.window_count),
            max_offset_ms: number("maxOffsetMs").unwrap_or(defaults.max_offset_ms),
        }
    }
}

/// What the engine answered for a batch: one result per pair it reached, and
/// the fatal error that stopped it, if any.
#[derive(Debug, Default)]
pub(crate) struct Analysis {
    pub results: Vec<Value>,
    pub fatal: Option<String>,
}

/// What the engine planned for each job of a plan-only `dubsyncBatch`, in
/// the order the jobs were sent, and the fatal error that stopped it, if any.
#[derive(Debug, Default)]
pub(crate) struct Plans {
    pub jobs: Vec<PlannedJob>,
    pub fatal: Option<String>,
}

#[derive(Debug, Default, Clone)]
pub(crate) struct PlannedJob {
    pub plan: Option<Value>,
    pub error: Option<String>,
}

/// Something that can run the engine, blocking. `Ok(None)` means it was
/// interrupted (the queue stopped, or the remote lock came on).
pub(crate) trait SyncEngine {
    /// The quick check: `analyze` over a few windows.
    fn analyze(&self, payload: &Value) -> Result<Option<Analysis>, String>;
    /// The full-timeline check: the Dub sync planner, told to stop once each
    /// pair is planned.
    fn plan(&self, _payload: &Value) -> Result<Option<Plans>, String> {
        Err("the full-timeline check is not available".to_string())
    }
}

/// How long the engine may say nothing before it counts as wedged. A check
/// reads six short windows of one file and reports each as it completes, so
/// even a slow share answers well within this.
const ANALYZE_IDLE_LIMIT: Duration = Duration::from_secs(180);
/// How long after a cancel the engine has to say it stopped.
const ANALYZE_STOP_GRACE: Duration = Duration::from_secs(30);
/// How long a `done` may lag a non-fatal error. The engine reports a command
/// that raised as a non-fatal error and then sends nothing more, so waiting
/// for the idle limit would hold every job for minutes.
const ANALYZE_ERROR_GRACE: Duration = if cfg!(test) { Duration::from_millis(400) } else { Duration::from_secs(10) };

/// Send one `analyze` and collect its results until `done`. Shared by the
/// app's engine and the tests' own.
pub(crate) fn run_analyze(
    send: &dyn Fn(&Value) -> Result<(), String>,
    events: &Receiver<Value>,
    payload: &Value,
    interrupted: &dyn Fn() -> bool,
) -> Result<Option<Analysis>, String> {
    let mut results = Vec::new();
    let fatal = run_command(send, events, payload, interrupted, "done", &mut |value| {
        if value.get("type").and_then(Value::as_str) == Some("result") {
            results.push(value);
        }
    })?;
    Ok(fatal.map(|fatal| Analysis { results, fatal }))
}

/// Send one plan-only `dubsyncBatch` and collect each job's plan until
/// `dubsyncBatchDone`. Shared by the app's engine and the tests' own.
pub(crate) fn run_plan(
    send: &dyn Fn(&Value) -> Result<(), String>,
    events: &Receiver<Value>,
    payload: &Value,
    interrupted: &dyn Fn() -> bool,
) -> Result<Option<Plans>, String> {
    let count = payload.get("jobs").and_then(Value::as_array).map_or(0, Vec::len);
    let mut jobs = vec![PlannedJob::default(); count];
    let fatal = run_command(send, events, payload, interrupted, "dubsyncBatchDone", &mut |value| {
        let Some(job) = value.get("job").and_then(Value::as_u64).and_then(|job| jobs.get_mut(job as usize)) else { return };
        let plan = value.get("plan").filter(|plan| !plan.is_null()).cloned();
        match value.get("type").and_then(Value::as_str) {
            Some("dubsyncJobPlan") => job.plan = plan,
            Some("dubsyncJobDone") => {
                job.plan = job.plan.take().or(plan);
                job.error = value.get("error").and_then(Value::as_str).map(str::to_string);
                if value.get("cancelled").and_then(Value::as_bool).unwrap_or(false) && job.error.is_none() {
                    job.error = Some("the check was cancelled".to_string());
                }
            }
            _ => {}
        }
    })?;
    Ok(fatal.map(|fatal| Plans { jobs, fatal }))
}

/// Send one engine command and follow it to its `done_type` event, handing
/// every other event to `on_event`. `Ok(None)`: interrupted; otherwise the
/// fatal error the engine reported, if any. `interrupted` is polled on every
/// turn of the wait, not only when the engine is quiet (it reports progress
/// more often than that): once true, the command is cancelled the way the
/// Stop button cancels a measurement, and the engine is given a moment to say
/// it stopped. A command cancelled by someone else (a stray Stop on a
/// measuring page) is an error, not an interruption: the job was not stopped,
/// so it must neither be put back in the queue nor pass on a check that never
/// ran.
fn run_command(
    send: &dyn Fn(&Value) -> Result<(), String>,
    events: &Receiver<Value>,
    payload: &Value,
    interrupted: &dyn Fn() -> bool,
    done_type: &str,
    on_event: &mut dyn FnMut(Value),
) -> Result<Option<Option<String>>, String> {
    if interrupted() {
        return Ok(None);
    }
    send(payload)?;
    let mut last_event = Instant::now();
    let mut cancelled_at: Option<Instant> = None;
    let mut engine_error: Option<(Instant, String)> = None;
    let mut fatal: Option<String> = None;
    loop {
        if cancelled_at.is_none() && interrupted() {
            send(&serde_json::json!({ "command": "cancel" }))?;
            cancelled_at = Some(Instant::now());
        }
        match events.recv_timeout(Duration::from_millis(200)) {
            Ok(value) => {
                last_event = Instant::now();
                match value.get("type").and_then(Value::as_str) {
                    Some(kind) if kind == done_type => {
                        if cancelled_at.is_some() {
                            return Ok(None);
                        }
                        if value.get("cancelled").and_then(Value::as_bool).unwrap_or(false) {
                            return Err("the sync check was cancelled from outside the queue".to_string());
                        }
                        return Ok(Some(fatal));
                    }
                    Some("error") if value.get("fatal").and_then(Value::as_bool).unwrap_or(false) => {
                        fatal = value.get("message").and_then(Value::as_str).map(str::to_string);
                    }
                    Some("error") => {
                        let message = value.get("message").and_then(Value::as_str).unwrap_or("an unexpected error").to_string();
                        engine_error = Some((Instant::now(), message));
                    }
                    Some("log") => {}
                    _ => {
                        engine_error = None;
                        on_event(value);
                    }
                }
            }
            Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => {
                return Err("The analysis engine stopped.".to_string());
            }
            Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {
                if let Some(at) = cancelled_at {
                    if at.elapsed() > ANALYZE_STOP_GRACE {
                        return Err("The analysis engine did not stop when asked.".to_string());
                    }
                } else if let Some((at, message)) = &engine_error {
                    if at.elapsed() > ANALYZE_ERROR_GRACE {
                        return Err(format!("The analysis engine failed: {message}"));
                    }
                } else if last_event.elapsed() > ANALYZE_IDLE_LIMIT {
                    return Err("The analysis engine stopped responding.".to_string());
                }
            }
        }
    }
}

/// An analysis that failed once the job was stopped (or the remote lock came
/// on) is that interruption, not an inconclusive check: reading it as
/// inconclusive would pass the output and let it replace the source.
pub(crate) fn interruption_wins<T>(outcome: Result<Option<T>, String>, interrupted: bool) -> Result<Option<T>, String> {
    match outcome {
        Err(_) if interrupted => Ok(None),
        other => other,
    }
}

/// The app's own engine, shared with measuring. Mux and measurement never run
/// at once (the frontend holds the engine for the whole batch), and parallel
/// mux jobs take turns at it.
pub(crate) struct AppEngine<'a> {
    pub app: &'a AppHandle,
    pub interrupted: &'a dyn Fn() -> bool,
}

impl AppEngine<'_> {
    /// Run one command on the shared engine with `run` (`run_analyze` or
    /// `run_plan`).
    fn run<T>(
        &self,
        payload: &Value,
        run: fn(&dyn Fn(&Value) -> Result<(), String>, &Receiver<Value>, &Value, &dyn Fn() -> bool) -> Result<Option<T>, String>,
    ) -> Result<Option<T>, String> {
        if (self.interrupted)() {
            return Ok(None);
        }
        if !crate::audiosync::ffmpeg_available_for(self.app) {
            return Err("FFmpeg was not found".to_string());
        }
        let handle = self.app.state::<crate::audiosync::EngineHandle>().inner().clone();
        // Remembered, because the stop or lock may be gone again by the time
        // the error comes back (the engine killed while cancelling).
        let seen = std::cell::Cell::new(false);
        let interrupted = || {
            let now = (self.interrupted)();
            seen.set(seen.get() || now);
            now
        };
        let outcome = handle.with(self.app, |engine| {
            crate::audiosync::drain_ready(engine)?;
            if !engine.ffmpeg_ready {
                return Err("FFmpeg was not found by the analysis engine".to_string());
            }
            run(&|value| engine.send(value), engine.events(), payload, &interrupted)
        });
        interruption_wins(outcome, seen.get() || (self.interrupted)())
    }
}

impl SyncEngine for AppEngine<'_> {
    fn analyze(&self, payload: &Value) -> Result<Option<Analysis>, String> {
        self.run(payload, run_analyze)
    }

    fn plan(&self, payload: &Value) -> Result<Option<Plans>, String> {
        self.run(payload, run_plan)
    }
}

/// An added audio track to measure, by audio-stream index in the output (the
/// N of ffmpeg's `0:a:N`, which is how the engine picks a track).
#[derive(Debug, Clone)]
struct SyncPair {
    reference: i64,
    track: i64,
    label: String,
}

fn sync_pairs(expected: &Expected) -> Result<Vec<SyncPair>, &'static str> {
    let audio: Vec<&ExpectedTrack> = expected.tracks.iter().filter(|track| track.kind == "audio").collect();
    let reference = audio
        .iter()
        .position(|track| matches!(track.origin, Origin::Source(_)))
        .ok_or("No audio from the source to compare with")?;
    Ok(audio
        .iter()
        .enumerate()
        .filter(|(_, track)| matches!(track.origin, Origin::Added { .. }) && !track.stretched)
        .map(|(index, track)| SyncPair { reference: reference as i64, track: index as i64, label: track.label.clone() })
        .collect())
}

fn analyze_payload(output: &Path, pairs: &[SyncPair], window: &SyncWindow) -> Value {
    let path = output.to_string_lossy().to_string();
    serde_json::json!({
        "command": "analyze",
        "mode": "series",
        "pairs": pairs.iter().enumerate().map(|(index, pair)| serde_json::json!({
            "primaryPath": path,
            "secondaryPath": path,
            "key": format!("verify-{}", index + 1),
            "method": "verify",
            "score": 1.0,
            "primaryTrack": pair.reference,
            "secondaryTrack": pair.track,
        })).collect::<Vec<_>>(),
        "windowSeconds": window.window_seconds,
        "windowCount": window.window_count,
        "maxOffsetMs": window.max_offset_ms,
        "maxWorkers": pairs.len().clamp(1, 4),
        "fast": false,
        // The engine's own default reads both files end to end.
        "timeline": false,
    })
}

/// Which result answers each pair. Both sides are the same file, so the
/// tracks the engine echoes tell them apart; a failure it raised before it
/// knew the tracks echoes 0/0 and goes to every pair still unanswered.
fn results_by_pair(pairs: &[SyncPair], results: &[Value]) -> Vec<Option<Value>> {
    let mut answers: Vec<Option<Value>> = vec![None; pairs.len()];
    for result in results {
        let track = |field: &str| result.get(field).and_then(Value::as_i64);
        let exact = pairs
            .iter()
            .position(|pair| track("primaryTrack") == Some(pair.reference) && track("secondaryTrack") == Some(pair.track));
        match exact {
            Some(at) => answers[at] = Some(result.clone()),
            None => {
                for answer in answers.iter_mut().filter(|answer| answer.is_none()) {
                    *answer = Some(result.clone());
                }
            }
        }
    }
    answers
}

/// The offset a result says the track still has, in ms (positive: it plays
/// late). The value at the start, unless the track drifts or jumps: then the
/// furthest it gets from the reference, so a wrong stretch or a different cut
/// is not passed on its first minutes alone.
pub(crate) fn residual_ms(result: &Value) -> Option<f64> {
    let number = |field: &str| result.get(field).and_then(Value::as_f64).filter(|value| value.is_finite());
    let at_start = number("delayAtStartMs").or_else(|| number("delayMs"))?;
    if drifts_or_jumps(result) {
        if let Some(end) = number("endDelayMs") {
            if end.abs() > at_start.abs() {
                return Some(end);
            }
        }
    }
    Some(at_start)
}

fn drifts_or_jumps(result: &Value) -> bool {
    let flag = |field: &str| result.get(field).and_then(Value::as_bool).unwrap_or(false);
    flag("hasSignificantDrift") || (flag("isLikelyCut") && !flag("isMinorSlip"))
}

fn percent(confidence: f64) -> String {
    format!("{:.0} %", (confidence * 100.0).clamp(0.0, 100.0))
}

/// One added track's verdict. Pass: a confident match within the tolerance.
/// Fail: a confident match outside it. Anything less is inconclusive: a
/// warning, never a failure.
pub(crate) fn sync_verdict(label: &str, result: Option<&Value>, tolerance_ms: f64) -> (CheckStatus, String) {
    let Some(result) = result else {
        return (CheckStatus::Warn, format!("Inconclusive: no answer for {label}"));
    };
    if let Some(error) = result.get("error").and_then(Value::as_str).filter(|error| !error.trim().is_empty()) {
        return (CheckStatus::Warn, format!("Inconclusive: {error}"));
    }
    let confidence = result.get("confidence").and_then(Value::as_f64).unwrap_or(0.0);
    if confidence < MIN_CONFIDENCE {
        return (CheckStatus::Warn, format!("Inconclusive: the match is too weak to judge ({} confidence)", percent(confidence)));
    }
    let Some(residual) = residual_ms(result) else {
        return (CheckStatus::Warn, "Inconclusive: no offset was found".to_string());
    };
    let side = if residual >= 0.0 { "late" } else { "early" };
    if residual.abs() > tolerance_ms {
        return (
            CheckStatus::Fail,
            format!("{label} plays {:.0} ms {side}, more than the {:.0} ms allowed ({} confidence)", residual.abs(), tolerance_ms, percent(confidence)),
        );
    }
    if drifts_or_jumps(result) {
        return (
            CheckStatus::Warn,
            format!("Within {:.0} ms where it was measured, but it does not follow the source's audio all the way", tolerance_ms),
        );
    }
    (CheckStatus::Pass, format!("In sync: {:.0} ms {side}, within {:.0} ms ({} confidence)", residual.abs(), tolerance_ms, percent(confidence)))
}

/// The share of the runtime the full-timeline plan must place the dub in for
/// it to pass. Silence a conform put where the dub has no scene is planned as
/// a fill, so a dub may miss a few scenes; a plan that places little of it
/// proves little.
const MIN_PLAN_COVERAGE: f64 = 0.8;

/// The full-timeline check of one added track inside the output: the Dub sync
/// planner (the plan the timeline scan shows and a conform is checked with),
/// with the output's reference audio as the video side and the added track as
/// the dub. Both sides are the same file; the engine picks each by its
/// audio-stream index.
fn plan_payload(output: &Path, pairs: &[&SyncPair]) -> Value {
    let path = output.to_string_lossy().to_string();
    let jobs: Vec<(String, String, i64, i64)> = pairs.iter().map(|pair| (path.clone(), path.clone(), pair.reference, pair.track)).collect();
    crate::conform::plan_payload(&jobs, pairs.len().clamp(1, 4) as i64)
}

/// A second opinion on a track the quick check failed. The quick check
/// measures a few windows, and on a track with long stretches of silence (a
/// conformed dub whose missing scenes were filled with it) or a different cut
/// those windows can misread by tens of milliseconds or more. The planner
/// follows the whole timeline: the track passes when every stretch of dub it
/// placed is within the tolerance and it placed the dub across most of the
/// runtime. Returns the verdict and the plan's worst stretch, in ms
/// (positive: the track plays late). A plan that could not be made keeps the
/// quick check's failure.
pub(crate) fn second_opinion_verdict(label: &str, quick_ms: f64, answer: Result<&PlannedJob, &str>, tolerance_ms: f64) -> (CheckStatus, String, Option<f64>) {
    let quick = format!("Quick check said {quick_ms:+.0} ms");
    let keep = |why: &str| {
        let side = if quick_ms >= 0.0 { "late" } else { "early" };
        (
            CheckStatus::Fail,
            format!("{label} plays {:.0} ms {side}, more than the {tolerance_ms:.0} ms allowed; the full-timeline check could not confirm it ({why})", quick_ms.abs()),
            None,
        )
    };
    let job = match answer {
        Ok(job) => job,
        Err(why) => return keep(why),
    };
    let Some(plan) = job.plan.as_ref() else {
        return keep(job.error.as_deref().unwrap_or("no plan was made"));
    };
    if let Some(error) = plan.get("error").and_then(Value::as_str).filter(|e| !e.trim().is_empty()).or(job.error.as_deref()) {
        return keep(error);
    }
    if (plan.get("speed").and_then(Value::as_f64).unwrap_or(1.0) - 1.0).abs() > 1e-6 {
        return (CheckStatus::Fail, format!("{quick}; full-timeline check: {label} runs at another speed than the source's audio"), None);
    }
    let stretches: Vec<crate::conform::PlanSegment> =
        crate::conform::plan_segments(plan).into_iter().filter(|segment| segment.dub && segment.offset_s.is_some()).collect();
    let worst = stretches
        .iter()
        .max_by(|a, b| a.offset_s.unwrap_or(0.0).abs().total_cmp(&b.offset_s.unwrap_or(0.0).abs()));
    let Some(worst) = worst else {
        return (CheckStatus::Fail, format!("{quick}; full-timeline check: {label} was not found in step with the source's audio anywhere"), None);
    };
    let worst_ms = worst.offset_s.unwrap_or(0.0) * 1000.0;
    let runtime = plan.get("videoDurationS").and_then(Value::as_f64).filter(|s| *s > 0.0);
    let placed: f64 = stretches.iter().map(|segment| (segment.end_s - segment.start_s).max(0.0)).sum();
    let coverage = runtime.map(|runtime| (placed / runtime).min(1.0));
    let out: Vec<&crate::conform::PlanSegment> =
        stretches.iter().filter(|segment| (segment.offset_s.unwrap_or(0.0) * 1000.0).abs() > tolerance_ms).collect();
    let covered = |share: f64| format!("{:.0} % of the runtime", share * 100.0);
    if out.is_empty() && coverage.map_or(false, |share| share >= MIN_PLAN_COVERAGE) {
        let range = coverage.map(covered).unwrap_or_default();
        return (
            CheckStatus::Pass,
            format!("{quick}; full-timeline check: every stretch within {:.1} ms, across {range}", worst_ms.abs()),
            Some(worst_ms),
        );
    }
    if !out.is_empty() {
        let side = if worst_ms >= 0.0 { "late" } else { "early" };
        return (
            CheckStatus::Fail,
            format!(
                "{quick}; full-timeline check: {label} plays {:.0} ms {side} from {} to {}, more than the {tolerance_ms:.0} ms allowed ({} of {} stretch{} out)",
                worst_ms.abs(),
                clock(worst.start_s),
                clock(worst.end_s),
                out.len(),
                stretches.len(),
                if stretches.len() == 1 { "" } else { "es" }
            ),
            Some(worst_ms),
        );
    }
    let share = coverage.map(covered).unwrap_or_else(|| "an unknown share of the runtime".to_string());
    (
        CheckStatus::Fail,
        format!("{quick}; full-timeline check: every stretch it placed is within {tolerance_ms:.0} ms, but it placed {label} across only {share}"),
        Some(worst_ms),
    )
}

/// The sync checks, one per added audio track, and the worst confident offset.
/// The sync checks of a new file: each added audio track measured against
/// the source's audio inside it, except tracks muxed with a frame-rate
/// stretch, which are listed as not checked rather than reported as a
/// mismatch the stretch has already corrected.
fn sync_checks(
    expected: &Expected,
    output: &Path,
    engine: Option<&dyn SyncEngine>,
    window: &SyncWindow,
    tolerance_ms: f64,
) -> Option<(Vec<Check>, Option<f64>, Option<f64>)> {
    let stretched: Vec<Check> = expected
        .added_audio()
        .filter(|track| track.stretched)
        .enumerate()
        .map(|(index, track)| Check {
            id: format!("sync-stretched-{}", index + 1),
            label: format!("Sync: {}", track.label),
            status: CheckStatus::Skip,
            detail: "Not checked: muxed with a frame-rate correction, which mkvmerge writes into the timestamps; \
                     the analysis engine reads the samples at their own speed, so it cannot judge this track"
                .to_string(),
        })
        .collect();
    if stretched.is_empty() {
        return measured_sync_checks(expected, output, engine, window, tolerance_ms);
    }
    if expected.added_audio().all(|track| track.stretched) {
        return Some((stretched, None, None));
    }
    measured_sync_checks(expected, output, engine, window, tolerance_ms).map(|(mut checks, residual, confidence)| {
        checks.extend(stretched);
        (checks, residual, confidence)
    })
}

fn measured_sync_checks(
    expected: &Expected,
    output: &Path,
    engine: Option<&dyn SyncEngine>,
    window: &SyncWindow,
    tolerance_ms: f64,
) -> Option<(Vec<Check>, Option<f64>, Option<f64>)> {
    let skip = |detail: &str| Some((vec![Check::new("sync", "Sync", CheckStatus::Skip, detail)], None, None));
    if expected.added_audio().next().is_none() {
        return skip("No audio added");
    }
    let pairs = match sync_pairs(expected) {
        Ok(pairs) => pairs,
        Err(reason) => return skip(reason),
    };
    let id = |index: usize| if index == 0 { "sync".to_string() } else { format!("sync-{}", index + 1) };
    let label = |pair: &SyncPair| format!("Sync: {}", pair.label);
    let inconclusive = |reason: String| {
        Some((
            pairs
                .iter()
                .enumerate()
                .map(|(index, pair)| Check { id: id(index), label: label(pair), status: CheckStatus::Warn, detail: reason.clone() })
                .collect(),
            None,
            None,
        ))
    };
    let Some(engine) = engine else {
        return inconclusive("Inconclusive: the analysis engine is missing".to_string());
    };
    let analysis = match engine.analyze(&analyze_payload(output, &pairs, window)) {
        Ok(Some(analysis)) => analysis,
        Ok(None) => return None,
        Err(err) => return inconclusive(format!("Inconclusive: {err}")),
    };
    if analysis.results.is_empty() {
        let reason = analysis.fatal.unwrap_or_else(|| "the analysis engine gave no answer".to_string());
        return inconclusive(format!("Inconclusive: {reason}"));
    }

    let answers = results_by_pair(&pairs, &analysis.results);
    // Each track's verdict and its confident offset (residual, confidence).
    let mut verdicts: Vec<(CheckStatus, String, Option<(f64, f64)>)> = pairs
        .iter()
        .zip(answers.iter())
        .map(|(pair, answer)| {
            let (status, detail) = sync_verdict(&pair.label, answer.as_ref(), tolerance_ms);
            let measured = answer.as_ref().and_then(|answer| {
                let confidence = answer.get("confidence").and_then(Value::as_f64).unwrap_or(0.0);
                let failed = answer.get("error").and_then(Value::as_str).is_some_and(|e| !e.is_empty());
                (confidence >= MIN_CONFIDENCE && !failed).then(|| residual_ms(answer).map(|residual| (residual, confidence))).flatten()
            });
            (status, detail, measured)
        })
        .collect();

    // A failure is only final once the full timeline agrees. Tracks that
    // passed or were inconclusive keep the quick check's word.
    let failed: Vec<usize> = (0..pairs.len()).filter(|&index| verdicts[index].0 == CheckStatus::Fail).collect();
    if !failed.is_empty() {
        let asked: Vec<&SyncPair> = failed.iter().map(|&index| &pairs[index]).collect();
        let plans = match engine.plan(&plan_payload(output, &asked)) {
            Ok(Some(plans)) => Ok(plans),
            Ok(None) => return None,
            Err(err) => Err(err),
        };
        for (job, &index) in failed.iter().enumerate() {
            let Some((quick_ms, confidence)) = verdicts[index].2 else { continue };
            let answer = match &plans {
                Ok(plans) => plans.jobs.get(job).ok_or_else(|| plans.fatal.clone().unwrap_or_else(|| "the engine gave no answer".to_string())),
                Err(err) => Err(err.clone()),
            };
            let (status, detail, planned) = second_opinion_verdict(&pairs[index].label, quick_ms, answer.as_ref().copied().map_err(String::as_str), tolerance_ms);
            verdicts[index] = (status, detail, Some((planned.unwrap_or(quick_ms), confidence)));
        }
    }

    let mut checks = Vec::new();
    let mut worst: Option<(f64, f64)> = None;
    for (index, (pair, (status, detail, measured))) in pairs.iter().zip(verdicts).enumerate() {
        checks.push(Check { id: id(index), label: label(pair), status, detail });
        if let Some((residual, confidence)) = measured {
            if worst.map_or(true, |(current, _)| residual.abs() > current.abs()) {
                worst = Some((residual, confidence));
            }
        }
    }
    Some((checks, worst.map(|(residual, _)| residual), worst.map(|(_, confidence)| confidence)))
}

// ------------------------------------------------------------------- a job

/// Where a failed output is kept: beside the final name, as
/// `<stem>.unverified.mkv`.
pub(crate) fn unverified_path(final_path: &Path) -> PathBuf {
    let stem = final_path.file_stem().map(|stem| stem.to_string_lossy().to_string()).unwrap_or_else(|| "output".to_string());
    final_path.with_file_name(format!("{stem}.unverified.mkv"))
}

pub(crate) fn keep_unverified(output: &Path, final_path: &Path) -> Result<PathBuf, String> {
    let target = unverified_path(final_path);
    if target.exists() {
        std::fs::remove_file(&target).map_err(|err| format!("Could not replace {}: {err}", target.display()))?;
    }
    std::fs::rename(output, &target).map_err(|err| format!("Could not rename {} to {}: {err}", output.display(), target.display()))?;
    Ok(target)
}

pub(crate) struct VerifyRequest<'a> {
    pub job: &'a MuxJobRequest,
    pub settings: &'a MuxSettings,
    /// The file mkvmerge wrote (a temporary name when overwriting).
    pub output: &'a Path,
    /// The name it is to have.
    pub final_path: &'a Path,
    /// An in-place edit (Fast mux): the output is the source itself, so it is
    /// never moved aside, and nothing was added to measure.
    pub in_place: bool,
    pub engine: Option<&'a dyn SyncEngine>,
    pub window: SyncWindow,
}

pub(crate) enum Verdict {
    /// Every check passed, or only warned.
    Passed(VerificationReport),
    /// A check failed. The output was moved to `kept` (an error if it could
    /// not be); an in-place edit stays where it is.
    Failed { report: VerificationReport, kept: Option<Result<PathBuf, String>> },
    /// The queue was stopped, or the remote lock came on, while it ran.
    Interrupted,
}

/// Verify a job's output and, if it fails, move it aside.
pub(crate) fn verify_job_output(request: &VerifyRequest) -> Verdict {
    let VerifyRequest { job, settings, output, final_path, in_place, engine, window } = request;
    let report = match probe(output) {
        Err(reason) => VerificationReport::from_checks(
            vec![Check::new("readable", "Readable", CheckStatus::Fail, format!("mkvmerge cannot read the new file: {reason}"))],
            None,
            None,
        ),
        Ok(json) => {
            let output_file = read_output(&json);
            let source = Path::new(&job.video.path);
            let (expected, source_duration) = if *in_place {
                (expected_from_edit(job), job.video.duration_seconds)
            } else {
                let probed = probe(source).ok();
                let probed_tracks = job.video.tracks.is_empty().then(|| probed.as_ref().map(parse_mkvmerge_tracks)).flatten();
                let duration = probed.as_ref().and_then(parse_mkvmerge_duration_seconds).or(job.video.duration_seconds);
                let mut expected = expected_from_mux(job, settings, probed_tracks.as_deref());
                // The source's track ids: from the probe, else from the scan.
                let source_ids: Option<Vec<u64>> = match &probed {
                    Some(json) => json.get("tracks").and_then(Value::as_array).map(|tracks| tracks.iter().filter_map(|t| t.get("id").and_then(Value::as_u64)).collect()),
                    None => (!job.video.tracks.is_empty())
                        .then(|| job.video.tracks.iter().enumerate().map(|(index, track)| parse_track_id(track, index) as u64).collect()),
                };
                let lengths = probed.as_ref().map(track_lengths).unwrap_or_default();
                let reference = reference_length(&mut expected, source_ids.as_deref(), &lengths, duration);
                (expected, reference)
            };
            let mut checks = structure_checks(&expected, &output_file, source_duration);
            let audio_agrees = kind_counts(expected.tracks.iter().map(|t| t.kind.as_str()))[1]
                == kind_counts(output_file.tracks.iter().map(|t| t.kind.as_str()))[1];
            let (mut residual, mut confidence) = (None, None);
            if *in_place {
                checks.push(Check::new("sync", "Sync", CheckStatus::Skip, "Nothing added"));
            } else if !settings.verify_sync {
                checks.push(Check::new("sync", "Sync", CheckStatus::Skip, "Turned off"));
            } else if !audio_agrees && !expected.source_unknown {
                checks.push(Check::new("sync", "Sync", CheckStatus::Skip, "Not measured: the audio tracks do not add up"));
            } else {
                match sync_checks(&expected, output, *engine, window, settings.verify_sync_tolerance_ms) {
                    None => return Verdict::Interrupted,
                    Some((sync, worst, sure)) => {
                        checks.extend(sync);
                        residual = worst;
                        confidence = sure;
                    }
                }
            }
            VerificationReport::from_checks(checks, residual, confidence)
        }
    };
    if report.ok {
        return Verdict::Passed(report);
    }
    let kept = (!*in_place).then(|| keep_unverified(output, final_path));
    let mut report = report;
    report.kept_path = kept.as_ref().and_then(|kept| kept.as_ref().ok()).map(|path| path.to_string_lossy().to_string());
    Verdict::Failed { report, kept }
}

#[cfg(test)]
mod tests;
#[cfg(test)]
mod command_golden;
