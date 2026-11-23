use super::*;
use crate::{build_mkvmerge_command, build_mkvpropedit_args, get_output_paths, remote_status, AppPaths, AppState, MuxState};
use std::collections::HashSet;
use std::io::{BufRead, BufReader, Write};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::{mpsc, Arc, Mutex};

fn settings(patch: Value) -> MuxSettings {
    let mut value = serde_json::json!({
        "destinationDir": "/out",
        "outputNamingPattern": null,
        "overwriteSource": false,
        "addCrc": false,
        "removeOldCrc": false,
        "keepLogFile": false,
        "abortOnErrors": false,
        "maxParallelJobs": null,
        "onlyKeepAudiosEnabled": false,
        "onlyKeepSubtitlesEnabled": false,
        "onlyKeepAudioLanguages": [],
        "onlyKeepSubtitleLanguages": [],
        "discardOldChapters": false,
        "discardOldAttachments": false,
        "allowDuplicateAttachments": false,
        "attachmentsExpertMode": false,
        "removeGlobalTags": true,
        "makeAudioDefaultLanguage": null,
        "makeSubtitleDefaultLanguage": null,
        "useMkvpropedit": false,
    });
    for (key, patched) in patch.as_object().expect("an object") {
        value[key] = patched.clone();
    }
    serde_json::from_value(value).expect("valid settings")
}

fn job(video_path: &str, tracks: Value, audios: Value, subtitles: Value, chapters: Value) -> MuxJobRequest {
    serde_json::from_value(serde_json::json!({
        "id": "job-1",
        "video": { "id": "v1", "name": file_name(video_path), "path": video_path, "size": 1, "status": "pending", "tracks": tracks },
        "audios": audios,
        "subtitles": subtitles,
        "chapters": chapters,
        "attachments": [],
    }))
    .expect("valid job")
}

/// The test media's episodes: H.264, English FLAC "Stereo", English SRT.
fn episode_tracks() -> Value {
    serde_json::json!([
        { "id": "0", "type": "video", "language": "und", "isDefault": false, "isForced": false },
        { "id": "1", "type": "audio", "language": "eng", "name": "Stereo", "isDefault": false, "isForced": false },
        { "id": "2", "type": "subtitle", "language": "eng", "isDefault": false, "isForced": false },
    ])
}

fn dub(path: &str, language: &str, delay: f64) -> Value {
    serde_json::json!([{
        "id": "a1", "name": file_name(path), "path": path, "type": "audio", "source": "bulk",
        "language": language, "trackName": "Hindi", "delay": delay, "isDefault": true, "includedTrackIds": [0],
    }])
}

fn output_track(kind: &str, language: &str, ietf: &str) -> OutputTrack {
    OutputTrack {
        kind: kind.to_string(),
        language: Some(language.to_string()),
        language_ietf: Some(ietf.to_string()),
        ..OutputTrack::default()
    }
}

fn status_of<'a>(checks: &'a [Check], id: &str) -> &'a Check {
    checks.iter().find(|check| check.id == id).unwrap_or_else(|| panic!("no {id} check in {checks:#?}"))
}

// ------------------------------------------------------------- expectation

#[test]
fn the_expectation_follows_the_track_order_the_command_asks_for() {
    let job = job("/v/Ep.mkv", episode_tracks(), dub("/a/Ep.hin.eac3", "hin", -1.312), serde_json::json!([]), serde_json::json!([]));
    let expected = expected_from_mux(&job, &settings(serde_json::json!({})), None);
    let order: Vec<(String, Origin)> = expected.tracks.iter().map(|t| (t.kind.clone(), t.origin)).collect();
    assert_eq!(
        order,
        vec![
            ("video".to_string(), Origin::Source(0)),
            ("audio".to_string(), Origin::Added { file: 1, track: 0 }),
            ("audio".to_string(), Origin::Source(1)),
            ("subtitle".to_string(), Origin::Source(2)),
        ]
    );
    let added = &expected.tracks[1];
    assert_eq!(added.language.as_deref(), Some("hin"));
    assert_eq!(added.name.as_deref(), Some("Hindi"));
    assert_eq!(added.default, Some(true));
    // An added default audio takes the flag from the source's.
    assert_eq!(expected.tracks[2].default, Some(false));
}

#[test]
fn removed_and_filtered_source_tracks_are_not_expected() {
    let mut tracks = episode_tracks();
    tracks[2]["action"] = serde_json::json!("remove");
    tracks.as_array_mut().unwrap().push(serde_json::json!({ "id": "3", "type": "audio", "language": "jpn" }));
    let job = job("/v/Ep.mkv", tracks, serde_json::json!([]), serde_json::json!([]), serde_json::json!([]));
    let keep_japanese = settings(serde_json::json!({ "onlyKeepAudiosEnabled": true, "onlyKeepAudioLanguages": ["jpn"] }));
    let expected = expected_from_mux(&job, &keep_japanese, None);
    let kept: Vec<Origin> = expected.tracks.iter().map(|t| t.origin).collect();
    assert_eq!(kept, vec![Origin::Source(0), Origin::Source(3)]);
}

#[test]
fn a_source_whose_tracks_were_never_read_is_filled_in_from_a_probe() {
    let job = job("/v/Ep.mkv", serde_json::json!([]), dub("/a/Ep.hin.eac3", "hin", 0.0), serde_json::json!([]), serde_json::json!([]));
    let probed = vec![
        serde_json::from_value::<TrackInfo>(serde_json::json!({ "id": "0", "type": "video" })).unwrap(),
        serde_json::from_value::<TrackInfo>(serde_json::json!({ "id": "1", "type": "audio" })).unwrap(),
    ];
    let expected = expected_from_mux(&job, &settings(serde_json::json!({})), Some(&probed));
    // Listed tracks first (only the added one), then the rest in file order.
    let order: Vec<Origin> = expected.tracks.iter().map(|t| t.origin).collect();
    assert_eq!(order, vec![Origin::Added { file: 1, track: 0 }, Origin::Source(0), Origin::Source(1)]);
    assert!(!expected.source_unknown);
}

// ---------------------------------------------------------------- structure

fn muxed_e01(dub_language: &str) -> OutputFile {
    OutputFile {
        tracks: vec![
            output_track("video", "und", "und"),
            OutputTrack { name: Some("Hindi".into()), default: Some(true), duration_s: Some(300.0), ..output_track("audio", dub_language, "hi") },
            OutputTrack { name: Some("Stereo".into()), default: Some(false), ..output_track("audio", "eng", "en") },
            output_track("subtitle", "eng", "en"),
        ],
        duration_s: Some(300.0),
        chapters: 0,
        attachments: vec![],
    }
}

fn e01_with_dub() -> Expected {
    let job = job("/v/Ep.mkv", episode_tracks(), dub("/a/Ep.hin.eac3", "hin", -1.312), serde_json::json!([]), serde_json::json!([]));
    expected_from_mux(&job, &settings(serde_json::json!({})), None)
}

#[test]
fn an_output_that_matches_passes_every_structure_check() {
    let checks = structure_checks(&e01_with_dub(), &muxed_e01("hin"), Some(300.008));
    let failing: Vec<&Check> = checks.iter().filter(|c| c.status != CheckStatus::Pass && c.status != CheckStatus::Skip).collect();
    assert!(failing.is_empty(), "{failing:#?}");
}

#[test]
fn a_missing_added_track_fails() {
    let mut output = muxed_e01("hin");
    output.tracks.remove(1);
    let checks = structure_checks(&e01_with_dub(), &output, Some(300.0));
    assert_eq!(status_of(&checks, "tracks").status, CheckStatus::Fail);
    assert_eq!(status_of(&checks, "tracks").detail, "1 audio track where the job asked for 2");
    assert_eq!(status_of(&checks, "added").status, CheckStatus::Fail);
}

#[test]
fn an_added_track_in_the_wrong_language_fails() {
    let checks = structure_checks(&e01_with_dub(), &muxed_e01("tam"), Some(300.0));
    let added = status_of(&checks, "added");
    assert_eq!(added.status, CheckStatus::Fail);
    assert!(added.detail.contains("not hin"), "{}", added.detail);
}

#[test]
fn flags_that_differ_only_warn() {
    let mut output = muxed_e01("hin");
    output.tracks[1].default = Some(false);
    output.tracks[2].name = Some("Other".into());
    let checks = structure_checks(&e01_with_dub(), &output, Some(300.0));
    let flags = status_of(&checks, "flags");
    assert_eq!(flags.status, CheckStatus::Warn);
    assert!(flags.detail.contains("and 1 more"), "{}", flags.detail);
    assert!(!checks.iter().any(|c| c.status == CheckStatus::Fail));
}

#[test]
fn a_shorter_output_fails_and_a_longer_one_with_added_tracks_warns() {
    let mut output = muxed_e01("hin");
    output.duration_s = Some(250.0);
    assert_eq!(status_of(&structure_checks(&e01_with_dub(), &output, Some(300.0)), "duration").status, CheckStatus::Fail);
    output.duration_s = Some(305.0);
    assert_eq!(status_of(&structure_checks(&e01_with_dub(), &output, Some(300.0)), "duration").status, CheckStatus::Warn);
    output.duration_s = Some(301.5);
    assert_eq!(status_of(&structure_checks(&e01_with_dub(), &output, Some(300.0)), "duration").status, CheckStatus::Pass);
}

#[test]
fn a_source_made_longer_by_a_removed_track_is_measured_by_the_tracks_kept() {
    // E01 with a fourth track, a commentary 5 s longer than the video, removed.
    let mut tracks = episode_tracks();
    tracks.as_array_mut().unwrap().push(serde_json::json!({ "id": "3", "type": "audio", "language": "eng", "isDefault": false, "isForced": false, "action": "remove" }));
    let job = job("/v/Ep.mkv", tracks, serde_json::json!([]), serde_json::json!([]), serde_json::json!([]));
    let ids = [0u64, 1, 2, 3];
    let tagged: HashMap<u64, f64> = [(0, 300.008), (1, 300.0), (2, 292.031), (3, 305.0)].into_iter().collect();
    let mut output = muxed_e01("hin");
    output.tracks.remove(1);
    output.duration_s = Some(300.008);

    let mut expected = expected_from_mux(&job, &settings(serde_json::json!({})), None);
    let reference = reference_length(&mut expected, Some(&ids), &tagged, Some(305.0));
    assert_eq!(reference, Some(300.008), "the longest track kept, not the removed one");
    let check = status_of(&structure_checks(&expected, &output, reference), "duration").clone();
    assert_eq!(check.status, CheckStatus::Pass, "{check:?}");

    // Truncated all the same: still a failure.
    output.duration_s = Some(250.0);
    assert_eq!(status_of(&structure_checks(&expected, &output, reference), "duration").status, CheckStatus::Fail);

    // No per-track lengths to tell: a shorter output only warns.
    output.duration_s = Some(300.008);
    let mut expected = expected_from_mux(&job, &settings(serde_json::json!({})), None);
    let reference = reference_length(&mut expected, Some(&ids), &HashMap::new(), Some(305.0));
    assert_eq!(reference, Some(305.0));
    assert_eq!(status_of(&structure_checks(&expected, &output, reference), "duration").status, CheckStatus::Warn);

    // Nothing dropped: the container length, and shorter fails as before.
    let job = job_with_all_tracks();
    let mut expected = expected_from_mux(&job, &settings(serde_json::json!({})), None);
    let reference = reference_length(&mut expected, Some(&[0, 1, 2]), &HashMap::new(), Some(305.0));
    assert_eq!(reference, Some(305.0));
    assert!(!expected.length_may_be_dropped_track);
}

fn job_with_all_tracks() -> MuxJobRequest {
    job("/v/Ep.mkv", episode_tracks(), serde_json::json!([]), serde_json::json!([]), serde_json::json!([]))
}

#[test]
fn missing_chapters_fail() {
    let job = job("/v/Ep.mkv", episode_tracks(), serde_json::json!([]), serde_json::json!([]), serde_json::json!([{ "id": "c", "name": "c.xml", "path": "/c/c.xml", "type": "chapter" }]));
    let expected = expected_from_mux(&job, &settings(serde_json::json!({})), None);
    let mut output = muxed_e01("hin");
    output.tracks.remove(1);
    let checks = structure_checks(&expected, &output, Some(300.0));
    assert_eq!(status_of(&checks, "chapters").status, CheckStatus::Fail);
    output.chapters = 4;
    assert_eq!(status_of(&structure_checks(&expected, &output, Some(300.0)), "chapters").status, CheckStatus::Pass);
}

#[test]
fn an_added_audio_track_of_another_length_warns() {
    let mut output = muxed_e01("hin");
    output.tracks[1].duration_s = Some(289.92);
    let check = status_of(&structure_checks(&e01_with_dub(), &output, Some(300.0)), "audioLength").clone();
    assert_eq!(check.status, CheckStatus::Warn);
    assert_eq!(check.detail, "Ep.hin.eac3 runs 4:49.9, 3.4 % shorter than the video");
}

#[test]
fn languages_match_across_mkvmerge_spellings() {
    let french = output_track("audio", "fre", "fr");
    assert!(same_language("fra", &french));
    assert!(same_language("fre", &french));
    assert!(same_language("fr", &french));
    assert!(!same_language("deu", &french));
    assert!(same_language("hi", &output_track("audio", "hin", "hi")));
    assert!(same_language("cmn", &output_track("audio", "chi", "cmn")));
    assert!(same_language("pt-BR", &output_track("audio", "por", "pt-BR")));
}

#[test]
fn mkvmerge_statistics_durations_parse() {
    assert_eq!(parse_tag_duration("00:05:01.312000000"), Some(301.312));
    assert_eq!(parse_tag_duration("01:00:00.000000000"), Some(3600.0));
    assert_eq!(parse_tag_duration("nonsense"), None);
    assert_eq!(clock(289.92), "4:49.9");
    assert_eq!(clock(3725.0), "1:02:05");
}

// --------------------------------------------------------------------- sync

fn result(delay: f64, confidence: f64) -> Value {
    serde_json::json!({ "delayMs": delay, "delayAtStartMs": delay, "endDelayMs": delay, "confidence": confidence, "primaryTrack": 1, "secondaryTrack": 0 })
}

#[test]
fn a_confident_offset_within_the_tolerance_passes_and_beyond_it_fails() {
    assert_eq!(sync_verdict("Dub", Some(&result(5.3, 0.99)), 40.0).0, CheckStatus::Pass);
    let (status, detail) = sync_verdict("Dub", Some(&result(1317.3, 0.99)), 40.0);
    assert_eq!(status, CheckStatus::Fail);
    assert_eq!(detail, "Dub plays 1317 ms late, more than the 40 ms allowed (99 % confidence)");
    assert!(sync_verdict("Dub", Some(&result(-80.0, 0.9)), 40.0).1.contains("80 ms early"));
}

#[test]
fn a_weak_match_or_an_error_is_inconclusive_not_a_failure() {
    assert_eq!(sync_verdict("Dub", Some(&result(1317.0, 0.3)), 40.0).0, CheckStatus::Warn);
    let failed = serde_json::json!({ "error": "Could not decode", "confidence": 0.0 });
    assert_eq!(sync_verdict("Dub", Some(&failed), 40.0), (CheckStatus::Warn, "Inconclusive: Could not decode".to_string()));
    assert_eq!(sync_verdict("Dub", None, 40.0).0, CheckStatus::Warn);
}

#[test]
fn a_track_that_drifts_or_jumps_is_judged_by_its_worst_offset() {
    let mut drifting = result(3.0, 0.95);
    drifting["hasSignificantDrift"] = serde_json::json!(true);
    drifting["endDelayMs"] = serde_json::json!(240.0);
    assert_eq!(residual_ms(&drifting), Some(240.0));
    assert_eq!(sync_verdict("Dub", Some(&drifting), 40.0).0, CheckStatus::Fail);

    // A step of about a frame is a slip, not a cut: the start value stands.
    let mut slipped = result(3.0, 0.95);
    slipped["isLikelyCut"] = serde_json::json!(true);
    slipped["isMinorSlip"] = serde_json::json!(true);
    slipped["endDelayMs"] = serde_json::json!(35.0);
    assert_eq!(residual_ms(&slipped), Some(3.0));
    assert_eq!(sync_verdict("Dub", Some(&slipped), 40.0).0, CheckStatus::Pass);
}

#[test]
fn results_are_matched_to_pairs_by_track_and_early_failures_reach_the_rest() {
    let pairs = vec![
        SyncPair { reference: 2, track: 0, label: "a".into() },
        SyncPair { reference: 2, track: 1, label: "b".into() },
    ];
    let second = serde_json::json!({ "primaryTrack": 2, "secondaryTrack": 1, "confidence": 0.9 });
    let early = serde_json::json!({ "primaryTrack": 0, "secondaryTrack": 0, "error": "boom" });
    let answers = results_by_pair(&pairs, &[second.clone(), early.clone()]);
    assert_eq!(answers[0].as_ref(), Some(&early));
    assert_eq!(answers[1].as_ref(), Some(&second));
}

#[test]
fn the_reference_is_the_first_kept_source_audio_in_the_output() {
    let pairs = sync_pairs(&e01_with_dub()).unwrap();
    assert_eq!((pairs[0].reference, pairs[0].track), (1, 0));
}

struct Answering(Vec<Value>);
impl SyncEngine for Answering {
    fn analyze(&self, payload: &Value) -> Result<Option<Analysis>, String> {
        assert_eq!(payload["timeline"], serde_json::json!(false));
        assert_eq!(payload["pairs"][0]["primaryTrack"], serde_json::json!(1));
        Ok(Some(Analysis { results: self.0.clone(), fatal: None }))
    }
}

#[test]
fn the_report_carries_the_worst_offset() {
    let engine = Answering(vec![result(1317.3, 0.99)]);
    let (checks, residual, confidence) =
        sync_checks(&e01_with_dub(), Path::new("/out/Ep.mkv"), Some(&engine), &SyncWindow::default(), 40.0).unwrap();
    assert_eq!(checks[0].status, CheckStatus::Fail);
    assert_eq!(residual, Some(1317.3));
    assert_eq!(confidence, Some(0.99));
    // No engine: a warning, never a failure.
    let (checks, residual, _) = sync_checks(&e01_with_dub(), Path::new("/out/Ep.mkv"), None, &SyncWindow::default(), 40.0).unwrap();
    assert_eq!(checks[0].status, CheckStatus::Warn);
    assert_eq!(residual, None);
}

#[test]
fn run_analyze_cancels_when_interrupted_and_reports_it() {
    let (events_in, events) = mpsc::channel::<Value>();
    let sent = Mutex::new(Vec::<Value>::new());
    let send = |value: &Value| {
        sent.lock().unwrap().push(value.clone());
        if value["command"] == "cancel" {
            let _ = events_in.send(serde_json::json!({ "type": "done", "cancelled": true }));
        }
        Ok(())
    };
    let outcome = run_analyze(&send, &events, &serde_json::json!({ "command": "analyze" }), &|| true);
    assert!(matches!(outcome, Ok(None)));
    // Interrupted before it began: nothing was sent at all.
    assert!(sent.lock().unwrap().is_empty());

    let interrupted = std::sync::atomic::AtomicBool::new(false);
    let send_and_stop = |value: &Value| {
        if value["command"] == "analyze" {
            interrupted.store(true, std::sync::atomic::Ordering::SeqCst);
        }
        send(value)
    };
    let outcome = run_analyze(&send_and_stop, &events, &serde_json::json!({ "command": "analyze" }), &|| {
        interrupted.load(std::sync::atomic::Ordering::SeqCst)
    });
    assert!(matches!(outcome, Ok(None)));
    let commands: Vec<Value> = sent.lock().unwrap().iter().map(|v| v["command"].clone()).collect();
    assert_eq!(commands, vec![serde_json::json!("analyze"), serde_json::json!("cancel")]);
}

#[test]
fn run_analyze_sees_a_stop_while_the_engine_is_busy_reporting() {
    // The engine reports progress every 50 ms for 3 s: never quiet for 200 ms.
    let (events_in, events) = mpsc::channel::<Value>();
    let cancelled = Arc::new(std::sync::atomic::AtomicBool::new(false));
    let reporter = {
        let (events_in, cancelled) = (events_in.clone(), cancelled.clone());
        std::thread::spawn(move || {
            for _ in 0..60 {
                if cancelled.load(std::sync::atomic::Ordering::SeqCst) {
                    let _ = events_in.send(serde_json::json!({ "type": "done", "cancelled": true }));
                    return;
                }
                let _ = events_in.send(serde_json::json!({ "type": "fileProgress", "percent": 10 }));
                std::thread::sleep(Duration::from_millis(50));
            }
        })
    };
    let send = |value: &Value| {
        if value["command"] == "cancel" {
            cancelled.store(true, std::sync::atomic::Ordering::SeqCst);
        }
        Ok(())
    };
    let started = Instant::now();
    let stop_at = started + Duration::from_millis(300);
    let outcome = run_analyze(&send, &events, &serde_json::json!({ "command": "analyze" }), &|| Instant::now() >= stop_at);
    assert!(matches!(outcome, Ok(None)), "{outcome:?}");
    assert!(started.elapsed() < Duration::from_secs(1), "the stop waited {:?} for a quiet moment", started.elapsed());
    reporter.join().unwrap();
}

#[test]
fn a_cancel_nobody_in_the_queue_asked_for_is_not_an_interruption() {
    let (events_in, events) = mpsc::channel::<Value>();
    events_in.send(serde_json::json!({ "type": "fileProgress", "percent": 40 })).unwrap();
    events_in.send(serde_json::json!({ "type": "done", "cancelled": true })).unwrap();
    let outcome = run_analyze(&|_| Ok(()), &events, &serde_json::json!({ "command": "analyze" }), &|| false);
    // An error, so the job is checked as inconclusive rather than put back in
    // the queue and muxed again.
    assert!(matches!(&outcome, Err(message) if message.contains("cancelled")), "{outcome:?}");
}

#[test]
fn an_engine_that_raised_gives_up_quickly_instead_of_at_the_idle_limit() {
    let (events_in, events) = mpsc::channel::<Value>();
    events_in.send(serde_json::json!({ "type": "error", "message": "KeyError: 'x'", "fatal": false })).unwrap();
    let started = Instant::now();
    let outcome = run_analyze(&|_| Ok(()), &events, &serde_json::json!({ "command": "analyze" }), &|| false);
    assert!(matches!(&outcome, Err(message) if message.contains("KeyError")), "{outcome:?}");
    assert!(started.elapsed() < Duration::from_secs(5));
    drop(events_in);
}

#[test]
fn an_error_after_a_stop_is_the_stop() {
    assert!(matches!(interruption_wins::<Analysis>(Err("The analysis engine stopped.".into()), true), Ok(None)));
    assert!(matches!(interruption_wins::<Analysis>(Err("The analysis engine stopped.".into()), false), Err(_)));
    assert!(matches!(interruption_wins(Ok(Some(Analysis::default())), true), Ok(Some(_))));
}

/// An engine that fails exactly when the queue is stopped: the verdict must
/// be the interruption, never a pass that goes on to replace the source.
struct StoppedEngine;
impl SyncEngine for StoppedEngine {
    fn analyze(&self, _payload: &Value) -> Result<Option<Analysis>, String> {
        interruption_wins(Err("The analysis engine stopped.".into()), true)
    }
}

#[test]
fn a_sync_check_broken_off_by_a_stop_does_not_pass() {
    let checks = sync_checks(&e01_with_dub(), Path::new("/out/Ep.mkv"), Some(&StoppedEngine), &SyncWindow::default(), 40.0);
    assert!(checks.is_none(), "{checks:?}");
}

// ------------------------------------------------- full-timeline second opinion

/// A plan as the engine reports it: (kind, start, end, offset in s).
fn plan_of(segments: &[(&str, f64, f64, Option<f64>)]) -> Value {
    serde_json::json!({
        "speed": 1.0,
        "videoDurationS": 300.0,
        "error": null,
        "segments": segments.iter().map(|(kind, start, end, offset)| serde_json::json!({
            "kind": kind, "startS": start, "endS": end, "sourceStartS": start, "offsetS": offset,
        })).collect::<Vec<_>>(),
    })
}

fn planned(plan: Value) -> PlannedJob {
    PlannedJob { plan: Some(plan), error: None }
}

/// The plan the engine makes of the losslessly conformed E02 inside its mux.
fn conformed_e02_plan() -> Value {
    plan_of(&[
        ("dub", 0.0, 28.03, Some(0.0134)),
        ("dub", 28.03, 100.014, Some(-0.008)),
        ("fill", 100.014, 110.088, None),
        ("dub", 110.088, 300.0, Some(-0.008)),
    ])
}

#[test]
fn a_misread_quick_check_passes_when_every_stretch_of_the_plan_is_in_sync() {
    let (status, detail, worst) = second_opinion_verdict("Hindi", 69.0, Ok(&planned(conformed_e02_plan())), 40.0);
    assert_eq!(status, CheckStatus::Pass, "{detail}");
    assert_eq!(detail, "Quick check said +69 ms; full-timeline check: every stretch within 13.4 ms, across 97 % of the runtime");
    assert!((worst.unwrap() - 13.4).abs() < 1e-9);
}

#[test]
fn a_plan_with_a_stretch_out_of_sync_fails_on_that_stretch() {
    let cut = plan_of(&[("dub", 0.0, 100.0, Some(0.0)), ("dub", 100.0, 300.0, Some(-10.0))]);
    let (status, detail, worst) = second_opinion_verdict("Hindi", 840.0, Ok(&planned(cut)), 40.0);
    assert_eq!(status, CheckStatus::Fail);
    assert_eq!(worst, Some(-10_000.0));
    assert!(detail.contains("plays 10000 ms early from 1:40 to 5:00") && detail.contains("1 of 2 stretches out"), "{detail}");
    let late = plan_of(&[("dub", 0.0, 300.0, Some(1.312))]);
    let (status, detail, worst) = second_opinion_verdict("Hindi", 1317.0, Ok(&planned(late)), 40.0);
    assert_eq!((status, worst), (CheckStatus::Fail, Some(1312.0)));
    assert!(detail.starts_with("Quick check said +1317 ms; full-timeline check: Hindi plays 1312 ms late"), "{detail}");
}

#[test]
fn a_plan_that_places_little_of_the_track_proves_nothing() {
    let sparse = plan_of(&[("dub", 0.0, 120.0, Some(0.002)), ("fill", 120.0, 300.0, None)]);
    let (status, detail, _) = second_opinion_verdict("Hindi", 69.0, Ok(&planned(sparse)), 40.0);
    assert_eq!(status, CheckStatus::Fail);
    assert!(detail.contains("only 40 % of the runtime"), "{detail}");
    let nothing = plan_of(&[("fill", 0.0, 300.0, None)]);
    assert_eq!(second_opinion_verdict("Hindi", 69.0, Ok(&planned(nothing)), 40.0).0, CheckStatus::Fail);
}

#[test]
fn a_plan_that_could_not_be_made_keeps_the_quick_failure() {
    let mut failed = plan_of(&[]);
    failed["error"] = serde_json::json!("The dub and the video share no audio");
    for answer in [
        Ok(planned(failed)),
        Ok(PlannedJob { plan: None, error: Some("Could not decode".into()) }),
        Err("The analysis engine stopped.".to_string()),
    ] {
        let (status, detail, worst) = second_opinion_verdict("Hindi", 69.0, answer.as_ref().map_err(String::as_str), 40.0);
        assert_eq!((status, worst), (CheckStatus::Fail, None));
        assert!(detail.starts_with("Hindi plays 69 ms late, more than the 40 ms allowed; the full-timeline check could not confirm it"), "{detail}");
    }
    let mut faster = conformed_e02_plan();
    faster["speed"] = serde_json::json!(1.04271);
    assert!(second_opinion_verdict("Hindi", 69.0, Ok(&planned(faster)), 40.0).1.contains("another speed"));
}

/// Answers the quick check with `quick` and the full-timeline check with
/// `plan` (None: interrupted), counting the plans asked for.
struct TwoOpinions {
    quick: Value,
    plan: Option<Value>,
    plans: std::cell::RefCell<Vec<Value>>,
}

impl SyncEngine for TwoOpinions {
    fn analyze(&self, _payload: &Value) -> Result<Option<Analysis>, String> {
        Ok(Some(Analysis { results: vec![self.quick.clone()], fatal: None }))
    }

    fn plan(&self, payload: &Value) -> Result<Option<Plans>, String> {
        self.plans.borrow_mut().push(payload.clone());
        Ok(self.plan.clone().map(|plan| Plans { jobs: vec![planned(plan)], fatal: None }))
    }
}

#[test]
fn only_a_failed_quick_check_asks_the_full_timeline_and_its_answer_stands() {
    let output = Path::new("/out/Ep.mkv");
    let engine = TwoOpinions { quick: result(69.0, 0.98), plan: Some(conformed_e02_plan()), plans: Default::default() };
    let (checks, residual, confidence) = sync_checks(&e01_with_dub(), output, Some(&engine), &SyncWindow::default(), 40.0).unwrap();
    assert_eq!(checks[0].status, CheckStatus::Pass, "{checks:?}");
    assert!((residual.unwrap() - 13.4).abs() < 1e-9);
    assert_eq!(confidence, Some(0.98));
    // The planner was asked with the output on both sides: the reference
    // audio as the video, the added track as the dub.
    let plans = engine.plans.borrow();
    assert_eq!(plans.len(), 1);
    let job = &plans[0]["jobs"][0];
    assert_eq!((plans[0]["command"].as_str(), plans[0]["planOnly"].as_bool(), plans[0]["fixVoices"].as_bool()), (Some("dubsyncBatch"), Some(true), Some(false)));
    assert_eq!((job["videoPath"].as_str(), job["dubPath"].as_str()), (Some("/out/Ep.mkv"), Some("/out/Ep.mkv")));
    assert_eq!((job["videoTrack"].as_i64(), job["dubTrack"].as_i64()), (Some(1), Some(0)));
    drop(plans);

    let in_sync = TwoOpinions { quick: result(5.0, 0.99), plan: Some(conformed_e02_plan()), plans: Default::default() };
    let (checks, residual, _) = sync_checks(&e01_with_dub(), output, Some(&in_sync), &SyncWindow::default(), 40.0).unwrap();
    assert_eq!((checks[0].status, residual), (CheckStatus::Pass, Some(5.0)));
    assert!(in_sync.plans.borrow().is_empty(), "a passing quick check needs no second opinion");

    let weak = TwoOpinions { quick: result(900.0, 0.3), plan: Some(conformed_e02_plan()), plans: Default::default() };
    let (checks, _, _) = sync_checks(&e01_with_dub(), output, Some(&weak), &SyncWindow::default(), 40.0).unwrap();
    assert_eq!(checks[0].status, CheckStatus::Warn);
    assert!(weak.plans.borrow().is_empty(), "an inconclusive quick check stays inconclusive");
}

#[test]
fn a_second_opinion_broken_off_by_a_stop_does_not_pass() {
    let engine = TwoOpinions { quick: result(69.0, 0.98), plan: None, plans: Default::default() };
    let checks = sync_checks(&e01_with_dub(), Path::new("/out/Ep.mkv"), Some(&engine), &SyncWindow::default(), 40.0);
    assert!(checks.is_none(), "{checks:?}");
}

#[test]
fn run_plan_collects_each_jobs_plan_and_cancels_when_interrupted() {
    let (events_in, events) = mpsc::channel::<Value>();
    let plan = conformed_e02_plan();
    for event in [
        serde_json::json!({ "type": "dubsyncJobStart", "job": 0 }),
        serde_json::json!({ "type": "dubsyncJobProgress", "job": 0, "percent": 50 }),
        serde_json::json!({ "type": "dubsyncJobPlan", "job": 0, "plan": plan }),
        serde_json::json!({ "type": "dubsyncJobDone", "job": 0, "plan": plan }),
        serde_json::json!({ "type": "dubsyncJobDone", "job": 1, "error": "Could not decode" }),
        serde_json::json!({ "type": "dubsyncBatchDone", "cancelled": false }),
    ] {
        events_in.send(event).unwrap();
    }
    let payload = serde_json::json!({ "command": "dubsyncBatch", "jobs": [{}, {}] });
    let plans = run_plan(&|_| Ok(()), &events, &payload, &|| false).unwrap().unwrap();
    assert_eq!(plans.jobs.len(), 2);
    assert_eq!(plans.jobs[0].plan.as_ref(), Some(&plan));
    assert_eq!(plans.jobs[1].error.as_deref(), Some("Could not decode"));

    let send = |value: &Value| {
        if value["command"] == "cancel" {
            let _ = events_in.send(serde_json::json!({ "type": "dubsyncBatchDone", "cancelled": true }));
        }
        Ok(())
    };
    let stopped = std::sync::atomic::AtomicBool::new(false);
    let send_and_stop = |value: &Value| {
        stopped.store(true, std::sync::atomic::Ordering::SeqCst);
        send(value)
    };
    let outcome = run_plan(&send_and_stop, &events, &payload, &|| stopped.load(std::sync::atomic::Ordering::SeqCst));
    assert!(matches!(outcome, Ok(None)), "{outcome:?}");
    // A cancel nobody in the queue asked for is an error, not an interruption.
    events_in.send(serde_json::json!({ "type": "dubsyncBatchDone", "cancelled": true })).unwrap();
    assert!(run_plan(&|_| Ok(()), &events, &payload, &|| false).is_err());
}

// ------------------------------------------------------------------- report

#[test]
fn settings_from_older_frontends_verify_by_default() {
    let parsed = settings(serde_json::json!({}));
    assert!(parsed.verify_output);
    assert!(parsed.verify_sync);
    assert_eq!(parsed.verify_sync_tolerance_ms, 40.0);
}

#[test]
fn the_report_serializes_as_the_frontend_reads_it() {
    let report = VerificationReport::from_checks(
        vec![Check::new("sync", "Sync: Dub", CheckStatus::Pass, "In sync")],
        Some(5.3),
        Some(0.99),
    );
    assert_eq!(
        serde_json::to_value(&report).unwrap(),
        serde_json::json!({
            "ok": true,
            "checks": [{ "id": "sync", "label": "Sync: Dub", "status": "pass", "detail": "In sync" }],
            "residualMs": 5.3,
            "syncConfidence": 0.99,
        })
    );
}

#[test]
fn a_failed_output_is_kept_as_unverified_beside_the_final_name() {
    assert_eq!(unverified_path(Path::new("/v/Show.S01E01.mkv")), PathBuf::from("/v/Show.S01E01.unverified.mkv"));
}

#[test]
fn measurement_windows_come_from_the_settings_file() {
    let dir = std::env::temp_dir().join(format!("mkvbatchmux-verify-window-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let path = dir.join("setting.json");
    assert_eq!(SyncWindow::from_options(&path), SyncWindow::default());
    std::fs::write(&path, r#"{"Measurement":{"windowSeconds":30,"windowCount":4,"maxOffsetMs":120000,"fullTimeline":true}}"#).unwrap();
    assert_eq!(SyncWindow::from_options(&path), SyncWindow { window_seconds: 30.0, window_count: 4, max_offset_ms: 120000.0 });
    let _ = std::fs::remove_dir_all(&dir);
}

// --------------------------------------------------------- real-tool tests
//
// These mux the test media with mkvmerge through the app's own command
// builder and verify the result, the sync check with the real engine:
//
//   FFMPEG=ffmpeg python3 make_media.py <media>      (the media generator)
//   MKVBATCHMUX_TEST_MEDIA=<media> AUDIOSYNC_REPO=<AudioSyncMaster checkout> \
//     cargo test verify::tests::real_ -- --ignored --nocapture
//
// with mkvmerge, mkvpropedit, ffmpeg and ffprobe on PATH. Without the media
// or mkvmerge they say so and skip.

/// The bridge run directly: the app's engine needs a running app.
struct DirectEngine {
    child: Child,
    stdin: Mutex<ChildStdin>,
    events: mpsc::Receiver<Value>,
    /// How many full-timeline checks it was asked for.
    plans: std::sync::atomic::AtomicUsize,
}

impl DirectEngine {
    fn spawn() -> Option<Self> {
        let repo = PathBuf::from(std::env::var_os("AUDIOSYNC_REPO")?);
        let python = if cfg!(windows) {
            repo.join("python").join(".venv").join("Scripts").join("python.exe")
        } else {
            repo.join("python").join(".venv").join("bin").join("python")
        };
        let mut child = Command::new(python)
            .arg(repo.join("python").join("bridge.py"))
            .current_dir(&repo)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .ok()?;
        let stdin = child.stdin.take()?;
        let stdout = child.stdout.take()?;
        let (sender, events) = mpsc::channel();
        std::thread::spawn(move || {
            for line in BufReader::new(stdout).lines().map_while(Result::ok) {
                if let Ok(value) = serde_json::from_str::<Value>(&line) {
                    if sender.send(value).is_err() {
                        break;
                    }
                }
            }
        });
        let ready = events.recv_timeout(Duration::from_secs(60)).ok()?;
        assert_eq!(ready["type"], "ready", "the engine did not start: {ready}");
        Some(Self { child, stdin: Mutex::new(stdin), events, plans: Default::default() })
    }
}

impl DirectEngine {
    fn send(&self, value: &Value) -> Result<(), String> {
        let mut stdin = self.stdin.lock().unwrap();
        writeln!(stdin, "{value}").and_then(|_| stdin.flush()).map_err(|e| e.to_string())
    }

    fn second_opinions(&self) -> usize {
        self.plans.load(std::sync::atomic::Ordering::SeqCst)
    }
}

impl SyncEngine for DirectEngine {
    fn analyze(&self, payload: &Value) -> Result<Option<Analysis>, String> {
        run_analyze(&|value| self.send(value), &self.events, payload, &|| false)
    }

    fn plan(&self, payload: &Value) -> Result<Option<Plans>, String> {
        self.plans.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        run_plan(&|value| self.send(value), &self.events, payload, &|| false)
    }
}

impl Drop for DirectEngine {
    fn drop(&mut self) {
        if let Ok(mut stdin) = self.stdin.lock() {
            let _ = writeln!(stdin, "{}", serde_json::json!({ "command": "shutdown" }));
        }
        let _ = self.child.wait();
    }
}

fn media() -> Option<PathBuf> {
    let Some(dir) = std::env::var_os("MKVBATCHMUX_TEST_MEDIA").map(PathBuf::from) else {
        eprintln!("SKIPPED: set MKVBATCHMUX_TEST_MEDIA to the folder make_media.py wrote");
        return None;
    };
    if !crate::tool_available("mkvmerge", "-V") {
        eprintln!("SKIPPED: mkvmerge is not on PATH");
        return None;
    }
    Some(dir)
}

fn episode(media: &Path, n: u32) -> String {
    media.join("Show").join("Season 1").join(format!("Show.S01E0{n}.mkv")).to_string_lossy().to_string()
}

fn dub_of(media: &Path, n: u32) -> String {
    media.join("Dubs").join(format!("Show.S01E0{n}.Hindi.eac3")).to_string_lossy().to_string()
}

fn scratch(name: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("mkvbatchmux-verify-{name}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

fn state() -> AppState {
    AppState {
        paths: AppPaths { app_data_dir: PathBuf::new(), options_path: PathBuf::new(), log_path: PathBuf::new() },
        mux_state: Arc::new(Mutex::new(MuxState::default())),
        cancelled_scans: Arc::new(Mutex::new(HashSet::new())),
        service: Arc::new(remote_status::Service::disabled()),
    }
}

/// Mux a job the way process_job does: the app's own command, to the output
/// path it would choose.
fn mux(job: &MuxJobRequest, settings: &MuxSettings) -> (PathBuf, PathBuf) {
    let (output, final_path, _) = get_output_paths(job, settings);
    let args = build_mkvmerge_command(job, settings, &output, &state());
    let status = crate::hidden_command("mkvmerge").args(&args).stdout(Stdio::null()).status().expect("mkvmerge runs");
    assert!(matches!(status.code(), Some(0) | Some(1)), "mkvmerge failed: {status}");
    (output, final_path)
}

fn verify(job: &MuxJobRequest, settings: &MuxSettings, output: &Path, final_path: &Path, engine: Option<&dyn SyncEngine>) -> Verdict {
    verify_job_output(&VerifyRequest { job, settings, output, final_path, in_place: false, engine, window: SyncWindow::default() })
}

fn print_report(name: &str, report: &VerificationReport) {
    eprintln!("{name}: ok={} residual={:?} confidence={:?}", report.ok, report.residual_ms, report.sync_confidence);
    for check in &report.checks {
        eprintln!("  {:?} {}: {}", check.status, check.label, check.detail);
    }
}

#[test]
#[ignore = "needs mkvmerge, the test media and the engine: see the note above"]
fn real_e01_with_its_measured_delay_verifies_in_sync() {
    let Some(media) = media() else { return };
    let Some(engine) = DirectEngine::spawn() else { panic!("set AUDIOSYNC_REPO to run the engine") };
    let out = scratch("e01-good");
    // The engine measures this dub +1311.99 ms late, which the app stores as -1.312 s.
    let job = job(&episode(&media, 1), episode_tracks(), dub(&dub_of(&media, 1), "hin", -1.312), serde_json::json!([]), serde_json::json!([]));
    let settings = settings(serde_json::json!({ "destinationDir": out.to_string_lossy() }));
    let (output, final_path) = mux(&job, &settings);
    let Verdict::Passed(report) = verify(&job, &settings, &output, &final_path, Some(&engine)) else { panic!("did not pass") };
    print_report("E01 + dub at -1.312 s", &report);
    assert!(report.checks.iter().all(|c| c.status == CheckStatus::Pass || c.status == CheckStatus::Skip), "{report:#?}");
    let residual = report.residual_ms.expect("measured");
    assert!(residual.abs() <= 40.0, "residual {residual} ms");
    assert_eq!(engine.second_opinions(), 0, "a passing quick check needs no second opinion");
    assert!(final_path.exists());
    let _ = std::fs::remove_dir_all(&out);
}

#[test]
#[ignore = "needs mkvmerge, the test media and the engine: see the note above"]
fn real_e01_without_its_delay_fails_and_leaves_the_source_alone() {
    let Some(media) = media() else { return };
    let Some(engine) = DirectEngine::spawn() else { panic!("set AUDIOSYNC_REPO to run the engine") };
    let out = scratch("e01-zero");
    // Overwrite mode, on a copy of the video.
    let video = out.join("Show.S01E01.mkv");
    std::fs::copy(episode(&media, 1), &video).unwrap();
    let before = std::fs::read(&video).unwrap();
    let job = job(&video.to_string_lossy(), episode_tracks(), dub(&dub_of(&media, 1), "hin", 0.0), serde_json::json!([]), serde_json::json!([]));
    let settings = settings(serde_json::json!({ "destinationDir": "", "overwriteSource": true }));
    let (output, final_path) = mux(&job, &settings);
    assert_ne!(output, final_path, "overwrite mode writes to a temporary name");
    let Verdict::Failed { report, kept } = verify(&job, &settings, &output, &final_path, Some(&engine)) else { panic!("did not fail") };
    print_report("E01 + dub at 0", &report);
    assert_eq!(report.first_failure().map(|c| c.id.as_str()), Some("sync"));
    assert_eq!(engine.second_opinions(), 1);
    assert!(status_of(&report.checks, "sync").detail.contains("ms late from 0:00 to 5:00"), "{report:#?}");
    let residual = report.residual_ms.expect("measured");
    assert!((1250.0..1400.0).contains(&residual), "residual {residual} ms");
    let kept = kept.expect("moved aside").expect("renamed");
    assert_eq!(kept, out.join("Show.S01E01.unverified.mkv"));
    assert_eq!(report.kept_path.as_deref(), Some(kept.to_string_lossy().as_ref()));
    assert!(kept.exists() && !output.exists());
    assert_eq!(std::fs::read(&video).unwrap(), before, "the source must be untouched");
    let _ = std::fs::remove_dir_all(&out);
}

#[test]
#[ignore = "needs mkvmerge, the test media and the engine: see the note above"]
fn real_e02_different_cut_is_not_passed() {
    let Some(media) = media() else { return };
    let Some(engine) = DirectEngine::spawn() else { panic!("set AUDIOSYNC_REPO to run the engine") };
    let out = scratch("e02-cut");
    let job = job(&episode(&media, 2), episode_tracks(), dub(&dub_of(&media, 2), "hin", -0.840), serde_json::json!([]), serde_json::json!([]));
    let settings = settings(serde_json::json!({ "destinationDir": out.to_string_lossy() }));
    let (output, final_path) = mux(&job, &settings);
    let report = match verify(&job, &settings, &output, &final_path, Some(&engine)) {
        Verdict::Passed(report) | Verdict::Failed { report, .. } => report,
        Verdict::Interrupted => panic!("interrupted"),
    };
    print_report("E02 (different cut) + dub at -0.840 s", &report);
    let sync = status_of(&report.checks, "sync");
    // In step for the first 100 s, then 10 s off where the scene is missing:
    // the full timeline confirms the failure.
    assert_eq!(sync.status, CheckStatus::Fail, "a different cut must not verify as in sync: {sync:?}");
    assert!(sync.detail.contains("full-timeline check"), "{sync:?}");
    let _ = std::fs::remove_dir_all(&out);
}

#[test]
#[ignore = "needs mkvmerge, ffmpeg, ffprobe, the test media and the engine: see the note above"]
fn real_e02_conformed_losslessly_passes_on_the_full_timeline() {
    use crate::conform::{ConformCodec, ConformMode, ConformRequest, Tools};
    use crate::engine_link::testing::{Recorder, TestEngine};
    let Some(media) = media() else { return };
    let Some(engine) = DirectEngine::spawn() else { panic!("set AUDIOSYNC_REPO to run the engine") };
    let out = scratch("e02-lossless");
    // The dub cut to the video's timeline from its own frames, the missing
    // scene filled with silence.
    let pair = crate::audiosync::MeasurePair {
        primary_path: episode(&media, 2),
        secondary_path: dub_of(&media, 2),
        key: "e02".into(),
        method: "mkvbatchmux".into(),
        score: 1.0,
        primary_track: 0,
        secondary_track: 0,
    };
    let request = ConformRequest {
        run_id: "verify".into(),
        pairs: vec![pair],
        mode: ConformMode::Lossless,
        codec: ConformCodec::Same,
        output_dir: Some(out.join("conformed").to_string_lossy().into_owned()),
        max_workers: 1,
    };
    let tools = Tools { mkvmerge: "mkvmerge".into(), ffmpeg: "ffmpeg".into(), ffprobe: "ffprobe".into() };
    let sink = Recorder::default();
    crate::conform::run(&mut TestEngine::start(), &sink, &tools, &std::sync::atomic::AtomicBool::new(false), &request).expect("conform ran");
    let conformed = sink.named("conform-result")[0].clone();
    assert_eq!((conformed["mode"].as_str(), conformed["verified"].as_bool()), (Some("lossless"), Some(true)), "{conformed}");
    let track = conformed["outputPath"].as_str().expect("a conformed track").to_string();

    let job = job(&episode(&media, 2), episode_tracks(), dub(&track, "hin", 0.0), serde_json::json!([]), serde_json::json!([]));
    let settings = settings(serde_json::json!({ "destinationDir": out.join("muxed").to_string_lossy() }));
    std::fs::create_dir_all(out.join("muxed")).unwrap();
    let (output, final_path) = mux(&job, &settings);
    let report = match verify(&job, &settings, &output, &final_path, Some(&engine)) {
        Verdict::Passed(report) | Verdict::Failed { report, .. } => report,
        Verdict::Interrupted => panic!("interrupted"),
    };
    print_report("E02 conformed losslessly + delay 0", &report);
    let sync = status_of(&report.checks, "sync");
    assert_eq!(sync.status, CheckStatus::Pass, "{sync:?}");
    // Up to AudioSyncMaster v2.22 the quick check read this pair 69 ms out over
    // its repeating music, and only the full-timeline second opinion passed it
    // (second_opinion_verdict's own tests keep that route covered). From v2.23
    // the quick check searches the waveforms and measures it itself.
    if engine.second_opinions() > 0 {
        assert_eq!(engine.second_opinions(), 1);
        assert!(sync.detail.starts_with("Quick check said") && sync.detail.contains("full-timeline check: every stretch within"), "{sync:?}");
    } else {
        assert!(sync.detail.starts_with("In sync"), "{sync:?}");
    }
    let residual = report.residual_ms.expect("measured");
    assert!(residual.abs() < 32.0, "the plan's worst stretch {residual} ms");
    assert!(report.ok && final_path.exists());
    let _ = std::fs::remove_dir_all(&out);
}

#[test]
#[ignore = "needs mkvmerge and the test media: see the note above"]
fn real_removed_track_added_subtitle_and_chapters_pass_structure() {
    let Some(media) = media() else { return };
    let out = scratch("structure");
    let mut tracks = episode_tracks();
    tracks[2]["action"] = serde_json::json!("remove");
    let subtitle = media.join("Subs").join("Show.S01E01.en.srt").to_string_lossy().to_string();
    let chapters = media.join("Chapters").join("Show.S01E01.chapters.xml").to_string_lossy().to_string();
    let job = job(
        &episode(&media, 1),
        tracks,
        serde_json::json!([]),
        serde_json::json!([{ "id": "s1", "name": "Show.S01E01.en.srt", "path": subtitle, "type": "subtitle", "language": "eng", "trackName": "Full", "isDefault": true, "isForced": false, "trackId": 0 }]),
        serde_json::json!([{ "id": "c1", "name": "Show.S01E01.chapters.xml", "path": chapters, "type": "chapter" }]),
    );
    let settings = settings(serde_json::json!({ "destinationDir": out.to_string_lossy() }));
    let (output, final_path) = mux(&job, &settings);
    let Verdict::Passed(report) = verify(&job, &settings, &output, &final_path, None) else { panic!("did not pass") };
    print_report("E01, source subtitle removed, SRT and chapters added", &report);
    for id in ["tracks", "added", "duration", "chapters", "order", "flags"] {
        assert_eq!(status_of(&report.checks, id).status, CheckStatus::Pass, "{id}: {report:#?}");
    }
    assert_eq!(status_of(&report.checks, "sync").status, CheckStatus::Skip);
    let _ = std::fs::remove_dir_all(&out);
}

#[test]
#[ignore = "needs mkvmerge and the test media: see the note above"]
fn real_a_tampered_expectation_fails_structure() {
    let Some(media) = media() else { return };
    let out = scratch("tampered");
    let muxed = job(&episode(&media, 1), episode_tracks(), dub(&dub_of(&media, 1), "hin", -1.312), serde_json::json!([]), serde_json::json!([]));
    let settings = settings(serde_json::json!({ "destinationDir": out.to_string_lossy(), "verifySync": false }));
    let (output, final_path) = mux(&muxed, &settings);
    // The job now claims the dub is Tamil: the file says Hindi.
    let mut claimed = muxed.clone();
    claimed.audios[0].language = Some("tam".to_string());
    let Verdict::Failed { report, kept } = verify(&claimed, &settings, &output, &final_path, None) else { panic!("did not fail") };
    print_report("E01 + dub, expectation says Tamil", &report);
    let failure = report.first_failure().expect("a failure");
    assert_eq!(failure.id, "added");
    assert_eq!(failure.detail, "Show.S01E01.Hindi.eac3 is hi in the new file, not tam");
    // Not overwriting: the output itself is renamed.
    assert_eq!(kept.unwrap().unwrap(), out.join("Show.S01E01.unverified.mkv"));
    assert!(!final_path.exists());
    let _ = std::fs::remove_dir_all(&out);
}

#[test]
#[ignore = "needs mkvpropedit and the test media: see the note above"]
fn real_an_in_place_edit_is_verified() {
    let Some(media) = media() else { return };
    let out = scratch("in-place");
    let video = out.join("Show.S01E01.mkv");
    std::fs::copy(episode(&media, 1), &video).unwrap();
    let mut tracks = episode_tracks();
    tracks[1]["language"] = serde_json::json!("fra");
    // ASCII: mkvtoolnix without a UTF-8 locale cuts a name at its first other byte.
    tracks[1]["name"] = serde_json::json!("French");
    tracks[1]["isDefault"] = serde_json::json!(true);
    tracks[2]["isForced"] = serde_json::json!(true);
    let job = job(&video.to_string_lossy(), tracks, serde_json::json!([]), serde_json::json!([]), serde_json::json!([]));
    let status = crate::hidden_command("mkvpropedit").arg(&video).args(build_mkvpropedit_args(&job)).stdout(Stdio::null()).status().unwrap();
    assert!(status.success(), "mkvpropedit refused the edit: {status}");
    let settings = settings(serde_json::json!({ "destinationDir": "", "overwriteSource": true, "useMkvpropedit": true }));
    let report = match verify_job_output(&VerifyRequest { job: &job, settings: &settings, output: &video, final_path: &video, in_place: true, engine: None, window: SyncWindow::default() }) {
        Verdict::Passed(report) => report,
        Verdict::Failed { report, .. } => panic!("failed: {report:#?}"),
        Verdict::Interrupted => panic!("interrupted"),
    };
    print_report("Fast mux of E01", &report);
    assert!(report.checks.iter().all(|c| c.status == CheckStatus::Pass || c.status == CheckStatus::Skip), "{report:#?}");
    let _ = std::fs::remove_dir_all(&out);
}

#[test]
#[ignore = "needs mkvmerge, ffmpeg and the test media: see the note above"]
fn real_a_removed_track_longer_than_the_video_does_not_fail_the_length() {
    let Some(media) = media() else { return };
    if !crate::tool_available("ffmpeg", "-version") {
        eprintln!("SKIPPED: ffmpeg is not on PATH");
        return;
    }
    let out = scratch("longer-commentary");
    // E01 plus a commentary that runs 5 s past the video's end.
    let source = out.join("Show.S01E01.mkv");
    let status = crate::hidden_command("ffmpeg")
        .args(["-v", "error", "-y", "-i"])
        .arg(episode(&media, 1))
        .args(["-f", "lavfi", "-i", "sine=frequency=330:sample_rate=48000:duration=305.008"])
        .args(["-map", "0", "-map", "1", "-c", "copy", "-c:a:1", "flac", "-metadata:s:a:1", "language=eng"])
        .arg(&source)
        .status()
        .expect("ffmpeg runs");
    assert!(status.success());
    let probed = probe(&source).unwrap();
    let source_length = parse_mkvmerge_duration_seconds(&probed).unwrap();
    eprintln!("source container length {source_length:.3} s, track lengths {:?}", track_lengths(&probed));
    assert!(source_length > 304.0);

    let mut tracks = episode_tracks();
    tracks.as_array_mut().unwrap().push(serde_json::json!({ "id": "3", "type": "audio", "language": "eng", "isDefault": false, "isForced": false, "action": "remove" }));
    let job = job(&source.to_string_lossy(), tracks, serde_json::json!([]), serde_json::json!([]), serde_json::json!([]));
    let dest = out.join("out");
    std::fs::create_dir_all(&dest).unwrap();
    let settings = settings(serde_json::json!({ "destinationDir": dest.to_string_lossy() }));
    let (output, final_path) = mux(&job, &settings);
    let report = match verify(&job, &settings, &output, &final_path, None) {
        Verdict::Passed(report) => report,
        Verdict::Failed { report, .. } => panic!("failed: {report:#?}"),
        Verdict::Interrupted => panic!("interrupted"),
    };
    print_report("E01 + 305 s commentary, commentary removed", &report);
    assert_eq!(status_of(&report.checks, "duration").status, CheckStatus::Pass);

    // The same tracks cut short at 4:00: a real truncation still fails.
    let truncated = dest.join("cut.mkv");
    let status = crate::hidden_command("ffmpeg")
        .args(["-v", "error", "-y", "-i"])
        .arg(&source)
        .args(["-t", "240", "-map", "0:0", "-map", "0:1", "-map", "0:2", "-c", "copy"])
        .arg(&truncated)
        .status()
        .expect("ffmpeg runs");
    assert!(status.success());
    let Verdict::Failed { report, .. } = verify(&job, &settings, &truncated, &dest.join("cut-final.mkv"), None) else { panic!("a truncated output must fail") };
    print_report("the same, truncated to 4:00", &report);
    assert_eq!(report.first_failure().map(|c| c.id.as_str()), Some("duration"));
    let _ = std::fs::remove_dir_all(&out);
}

#[test]
fn a_dub_muxed_with_a_frame_rate_correction_is_not_checked_rather_than_flagged() {
    // E03's case: the dub was played 25/23.976 fast, and Correct the frame
    // rate muxes it with a 1001/960 stretch. A decoder reads its samples at
    // their own speed, so the engine would only hear the old mismatch.
    let mut audio = dub("/a/Ep.hin.eac3", "hin", -1.999);
    audio[0]["stretch"] = serde_json::json!({ "num": 1001.0, "den": 960.0 });
    let job = job("/v/Ep.mkv", episode_tracks(), audio, serde_json::json!([]), serde_json::json!([]));
    let expected = expected_from_mux(&job, &settings(serde_json::json!({})), None);
    assert!(expected.added_audio().all(|track| track.stretched));
    // No engine at all: the answer must not depend on one.
    let (checks, residual, confidence) = sync_checks(&expected, Path::new("/out/Ep.mkv"), None, &SyncWindow::default(), 40.0).unwrap();
    assert_eq!(checks.len(), 1);
    assert_eq!(checks[0].status, CheckStatus::Skip);
    assert!(checks[0].detail.starts_with("Not checked: muxed with a frame-rate correction"), "{}", checks[0].detail);
    assert_eq!((residual, confidence), (None, None));
    // Without the stretch the same dub is measured (here: engine missing, so inconclusive).
    let plain = expected_from_mux(
        &job_without_stretch(),
        &settings(serde_json::json!({})),
        None,
    );
    let (checks, _, _) = sync_checks(&plain, Path::new("/out/Ep.mkv"), None, &SyncWindow::default(), 40.0).unwrap();
    assert_eq!(checks[0].status, CheckStatus::Warn);
}

fn job_without_stretch() -> MuxJobRequest {
    job("/v/Ep.mkv", episode_tracks(), dub("/a/Ep.hin.eac3", "hin", -1.999), serde_json::json!([]), serde_json::json!([]))
}

// ------------------------------------------------- mkvmerge's own track order

/// A source whose subtitle comes before its audio, nothing added, its subtitle
/// made the default: what a batch that only changes flags muxes.
fn subtitle_first_job() -> MuxJobRequest {
    let tracks = serde_json::json!([
        { "id": "0", "type": "video", "language": "und", "isDefault": false, "isForced": false },
        { "id": "1", "type": "subtitle", "language": "eng", "isDefault": true, "isForced": false },
        { "id": "2", "type": "audio", "language": "jpn", "isDefault": true, "isForced": false },
    ]);
    job("/v/Ep.mkv", tracks, serde_json::json!([]), serde_json::json!([]), serde_json::json!([]))
}

fn output_of(kinds: &[&str]) -> OutputFile {
    OutputFile {
        tracks: kinds
            .iter()
            .map(|kind| match *kind {
                "video" => output_track("video", "und", "und"),
                "audio" => OutputTrack { default: Some(true), ..output_track("audio", "jpn", "ja") },
                _ => OutputTrack { default: Some(true), forced: Some(false), ..output_track("subtitle", "eng", "en") },
            })
            .collect(),
        ..OutputFile::default()
    }
}

#[test]
fn without_a_track_order_mkvmerge_may_sort_the_tracks_by_type() {
    let expected = expected_from_mux(&subtitle_first_job(), &settings(serde_json::json!({})), None);
    assert!(expected.order_by_type_ok);
    // Current mkvmerge: video, audio, subtitles. Older ones: the source's order.
    for kinds in [["video", "audio", "subtitle"], ["video", "subtitle", "audio"]] {
        let checks = structure_checks(&expected, &output_of(&kinds), None);
        assert_eq!(status_of(&checks, "order").status, CheckStatus::Pass, "{kinds:?}");
        assert_eq!(status_of(&checks, "flags").status, CheckStatus::Pass, "{kinds:?}: {checks:#?}");
    }
    // Any other order is still a real difference.
    let checks = structure_checks(&expected, &output_of(&["audio", "video", "subtitle"]), None);
    assert_eq!(status_of(&checks, "order").status, CheckStatus::Warn);
}

#[test]
fn with_a_track_order_only_that_order_passes() {
    let mut job = subtitle_first_job();
    job.audios = serde_json::from_value(dub("/a/Ep.hin.eac3", "hin", 0.0)).unwrap();
    let expected = expected_from_mux(&job, &settings(serde_json::json!({})), None);
    assert!(!expected.order_by_type_ok);
    let kinds: Vec<&str> = expected.tracks.iter().map(|t| t.kind.as_str()).collect();
    assert_eq!(kinds, vec!["video", "audio", "audio", "subtitle"]);
}

#[test]
#[ignore = "needs mkvmerge, ffmpeg and the test media: see the note above"]
fn real_a_subtitle_first_source_muxed_without_changes_keeps_a_clean_order_check() {
    let Some(media) = media() else { return };
    if !crate::tool_available("ffmpeg", "-version") {
        eprintln!("SKIPPED: ffmpeg is not on PATH");
        return;
    }
    let out = scratch("subtitle-first");
    // E01 rewritten with its subtitle ahead of its audio.
    let source = out.join("Show.S01E01.mkv");
    let status = crate::hidden_command("ffmpeg")
        .args(["-v", "error", "-y", "-i"])
        .arg(episode(&media, 1))
        .args(["-map", "0:v", "-map", "0:s", "-map", "0:a", "-c", "copy"])
        .arg(&source)
        .status()
        .expect("ffmpeg runs");
    assert!(status.success());
    let source_kinds: Vec<String> = parse_mkvmerge_tracks(&probe(&source).unwrap()).into_iter().map(|t| t.track_type).collect();
    assert_eq!(source_kinds, ["video", "subtitle", "audio"]);

    let tracks = serde_json::json!([
        { "id": "0", "type": "video", "language": "und", "isDefault": false, "isForced": false },
        { "id": "1", "type": "subtitle", "language": "eng", "isDefault": true, "isForced": false },
        { "id": "2", "type": "audio", "language": "eng", "name": "Stereo", "isDefault": false, "isForced": false },
    ]);
    let job = job(&source.to_string_lossy(), tracks, serde_json::json!([]), serde_json::json!([]), serde_json::json!([]));
    let dest = out.join("out");
    std::fs::create_dir_all(&dest).unwrap();
    let settings = settings(serde_json::json!({ "destinationDir": dest.to_string_lossy() }));
    let (output, final_path) = mux(&job, &settings);
    let output_kinds: Vec<String> = read_output(&probe(&output).unwrap()).tracks.into_iter().map(|t| t.kind).collect();
    eprintln!("mkvmerge wrote {output_kinds:?} from a {source_kinds:?} source");
    let report = match verify(&job, &settings, &output, &final_path, None) {
        Verdict::Passed(report) => report,
        Verdict::Failed { report, .. } => panic!("failed: {report:#?}"),
        Verdict::Interrupted => panic!("interrupted"),
    };
    print_report("E01 with its subtitle first, subtitle made default", &report);
    for id in ["tracks", "duration", "order", "flags"] {
        assert_eq!(status_of(&report.checks, id).status, CheckStatus::Pass, "{id}: {report:#?}");
    }
    let _ = std::fs::remove_dir_all(&out);
}
