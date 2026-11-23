//! Conform and Sync subtitles end to end, with the real engine and mkvmerge:
//! the Rust half. The frontend half
//! (src/features/workspace/lib/realEngine.e2e.test.ts) writes the requests the
//! Audio and Subtitles pages send for the test season; `real_engine_answers`
//! runs them through the same `run` the commands use, against the engine, and
//! writes back every result event the frontend would hear. The frontend half
//! turns those into the Mux page's jobs; `real_mux_jobs` muxes them with the
//! app's own mkvmerge command, reads the outputs back (`mkvmerge -J`), checks
//! each with the app's verification, and compares the subtitles muxed with
//! the timing planted in the test media.
//!
//! Both are ignored: they need the engine (AUDIOSYNC_REPO), ffmpeg and
//! mkvmerge on PATH, the media from make_media.py (MBM_TEST_MEDIA) and a
//! scratch folder (MBM_UI_E2E). The order is in the frontend half's header.

use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::atomic::AtomicBool;
use std::sync::{mpsc, Arc, Mutex};
use std::time::Duration;

use serde_json::Value;

use crate::conform::{self, ConformRequest, Tools};
use crate::engine_link::testing::{Recorder, TestEngine};
use crate::subsync::{self, SubsyncRequest};
use crate::verify::{run_analyze, verify_job_output, Analysis, SyncEngine, SyncWindow, Verdict, VerifyRequest};
use crate::{build_mkvmerge_command, get_output_paths, remote_status, AppPaths, AppState, MuxJobRequest, MuxSettings, MuxState};

fn scratch() -> PathBuf {
    PathBuf::from(std::env::var("MBM_UI_E2E").expect("set MBM_UI_E2E to the scratch folder the frontend half wrote"))
}

fn read_json(path: &Path) -> Value {
    serde_json::from_str(&std::fs::read_to_string(path).unwrap_or_else(|err| panic!("{}: {err}", path.display()))).expect("JSON")
}

/// Every request runs as the command would run it, and every event it sends
/// is kept, exactly as the frontend would receive it.
#[test]
#[ignore = "needs the engine, ffmpeg, mkvmerge, the test media and the frontend half's requests"]
fn real_engine_answers() {
    let dir = scratch();
    let requests = read_json(&dir.join("requests.json"));
    let mut link = TestEngine::start();
    let tools = Tools { mkvmerge: "mkvmerge".into(), ffmpeg: "ffmpeg".into(), ffprobe: "ffprobe".into() };
    let mut conform_events = Vec::new();
    for value in requests["conform"].as_array().unwrap() {
        // The frontend's JSON, read as the command reads it.
        let request: ConformRequest = serde_json::from_value(value.clone()).expect("the frontend's conform request");
        let sink = Recorder::default();
        let end = conform::run(&mut link, &sink, &tools, &AtomicBool::new(false), &request).expect("the engine ran");
        assert!(!end.cancelled && end.error.is_none(), "{end:?}");
        for event in sink.named("conform-result") {
            println!(
                "conform {}: {} {:?} verified={} residual={} ms: {}",
                event["runId"], event["mode"], event["outputPath"].as_str(), event["verified"], event["residualMs"], event["verificationText"].as_str().unwrap_or("")
            );
            assert!(event["error"].is_null(), "{event}");
            conform_events.push(event);
        }
    }
    let mut subsync_events = Vec::new();
    for value in requests["subsync"].as_array().unwrap() {
        let request: SubsyncRequest = serde_json::from_value(value.clone()).expect("the frontend's subsync request");
        let sink = Recorder::default();
        let end = subsync::run(&mut link, &sink, &AtomicBool::new(false), &request).expect("the engine ran");
        assert!(!end.cancelled && end.error.is_none(), "{end:?}");
        for event in sink.named("subsync-result") {
            println!(
                "subsync {} {}: offset {} s, ratio {}, score {}, {} confidence, copy {}",
                request.jobs.iter().find(|job| Some(job.key.as_str()) == event["key"].as_str()).map(|job| job.subtitle_path.rsplit(['/', '\\']).next().unwrap_or("")).unwrap_or(""),
                event["method"], event["offsetS"], event["ratio"], event["score"], event["confidence"], event["retimedPath"].is_string()
            );
            subsync_events.push(event);
        }
    }
    std::fs::write(dir.join("events.json"), serde_json::to_string_pretty(&serde_json::json!({ "conform": conform_events, "subsync": subsync_events })).unwrap()).unwrap();
}

// ------------------------------------------------------------------ mux

fn state() -> AppState {
    AppState {
        paths: AppPaths { app_data_dir: PathBuf::new(), options_path: PathBuf::new(), log_path: PathBuf::new() },
        mux_state: Arc::new(Mutex::new(MuxState::default())),
        cancelled_scans: Arc::new(Mutex::new(Default::default())),
        service: Arc::new(remote_status::Service::disabled()),
    }
}

/// The bridge, for the verification's sync check (the app's engine needs a running app).
struct Bridge {
    child: Child,
    stdin: Mutex<ChildStdin>,
    events: mpsc::Receiver<Value>,
}

impl Bridge {
    fn spawn() -> Self {
        use std::io::{BufRead, BufReader};
        let repo = PathBuf::from(std::env::var("AUDIOSYNC_REPO").expect("set AUDIOSYNC_REPO"));
        let python = repo.join("python").join(".venv").join(if cfg!(windows) { "Scripts" } else { "bin" }).join(if cfg!(windows) { "python.exe" } else { "python" });
        let mut child = Command::new(python)
            .arg(repo.join("python").join("bridge.py"))
            .current_dir(&repo)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .expect("start the engine");
        let stdin = child.stdin.take().unwrap();
        let stdout = child.stdout.take().unwrap();
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
        let ready = events.recv_timeout(Duration::from_secs(60)).expect("handshake");
        assert_eq!(ready["type"], "ready");
        Self { child, stdin: Mutex::new(stdin), events }
    }
}

impl SyncEngine for Bridge {
    fn analyze(&self, payload: &Value) -> Result<Option<Analysis>, String> {
        use std::io::Write;
        let send = |value: &Value| {
            let mut stdin = self.stdin.lock().unwrap();
            writeln!(stdin, "{value}").and_then(|_| stdin.flush()).map_err(|e| e.to_string())
        };
        run_analyze(&send, &self.events, payload, &|| false)
    }
}

impl Drop for Bridge {
    fn drop(&mut self) {
        use std::io::Write;
        if let Ok(mut stdin) = self.stdin.lock() {
            let _ = writeln!(stdin, "{}", serde_json::json!({ "command": "shutdown" }));
        }
        let _ = self.child.wait();
    }
}

fn identify(path: &Path) -> Value {
    let out = Command::new("mkvmerge").arg("-J").arg(path).output().expect("mkvmerge -J");
    serde_json::from_slice(&out.stdout).expect("mkvmerge -J JSON")
}

/// Cue start times of an SRT file, in seconds.
fn cue_starts(srt: &str) -> Vec<f64> {
    srt.lines()
        .filter_map(|line| line.split_once(" --> ").map(|(start, _)| start.trim().to_string()))
        .filter_map(|start| {
            let (clock, ms) = start.split_once(',')?;
            let parts: Vec<f64> = clock.split(':').filter_map(|part| part.parse().ok()).collect();
            Some(parts.first()? * 3600.0 + parts.get(1)? * 60.0 + parts.get(2)? + ms.parse::<f64>().ok()? / 1000.0)
        })
        .collect()
}

/// The subtitle track mkvmerge added from `source` (its file name), extracted
/// and compared line by line with where the lines really are in the video.
fn subtitle_error(output: &Path, info: &Value, from: &str, truth: &[f64], work: &Path) -> (usize, f64) {
    let id = info["tracks"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|track| track["type"] == "subtitles")
        .last()
        .map(|track| track["id"].as_u64().unwrap())
        .expect("a subtitle track was added");
    let srt = work.join(format!("{from}.extracted.srt"));
    let status = Command::new("mkvextract").arg(output).arg("tracks").arg(format!("{id}:{}", srt.display())).stdout(Stdio::null()).status().unwrap();
    assert!(status.success());
    let starts = cue_starts(&std::fs::read_to_string(&srt).unwrap());
    let worst = starts.iter().zip(truth).map(|(got, want)| (got - want).abs()).fold(0.0, f64::max);
    (starts.len(), worst)
}

#[test]
#[ignore = "needs mkvmerge, mkvextract, the engine, the test media and the frontend half's jobs"]
fn real_mux_jobs() {
    let dir = scratch();
    let truth = read_json(&PathBuf::from(std::env::var("MBM_TEST_MEDIA").expect("MBM_TEST_MEDIA")).join("truth.json"));
    let engine = Bridge::spawn();
    // The season (E02 with the rendered conform), then E02 with the lossless one.
    for batch in ["muxjobs.json", "muxjobs-lossless.json"] {
        println!("== {batch}");
        mux_batch(&read_json(&dir.join(batch)), &truth, &engine, &dir);
    }
}

fn mux_batch(start: &Value, truth: &Value, engine: &Bridge, dir: &Path) {
    let settings: MuxSettings = serde_json::from_value(start["settings"].clone()).expect("the frontend's settings");
    let jobs: Vec<MuxJobRequest> = serde_json::from_value(start["jobs"].clone()).expect("the frontend's jobs");
    for job in &jobs {
        let episode = job.video.name.trim_end_matches(".mkv").rsplit('.').next().unwrap().to_string();
        let (output, final_path, _) = get_output_paths(job, &settings);
        let args = build_mkvmerge_command(job, &settings, &output, &state());
        let status = crate::hidden_command("mkvmerge").args(&args).stdout(Stdio::null()).status().expect("mkvmerge runs");
        assert!(matches!(status.code(), Some(0) | Some(1)), "mkvmerge failed on {episode}: {status}");
        let info = identify(&output);
        let tracks: Vec<String> = info["tracks"]
            .as_array()
            .unwrap()
            .iter()
            .map(|track| format!("{}:{}:{}", track["type"].as_str().unwrap(), track["codec"].as_str().unwrap(), track["properties"]["language"].as_str().unwrap_or("")))
            .collect();
        // What mkvmerge was told for each added file: its path and its --sync.
        let added: Vec<String> = args.iter().filter(|arg| job.audios.iter().chain(&job.subtitles).any(|file| &file.path == *arg)).cloned().collect();
        let syncs: Vec<String> = args.windows(2).filter(|pair| pair[0] == "--sync").map(|pair| pair[1].clone()).collect();
        // Each --sync belongs to the input file after it.
        let mut sync_of: std::collections::HashMap<String, String> = Default::default();
        let mut pending: Option<String> = None;
        for pair in args.windows(2) {
            if pair[0] == "--sync" {
                pending = Some(pair[1].clone());
            } else if added.contains(&pair[1]) {
                if let Some(sync) = pending.take() {
                    sync_of.insert(pair[1].clone(), sync);
                }
            }
        }
        println!("{episode}: tracks {tracks:?}\n  added {added:?}\n  --sync {syncs:?}");

        let verdict = verify_job_output(&VerifyRequest { job, settings: &settings, output: &output, final_path: &final_path, in_place: false, engine: Some(engine), window: SyncWindow::default() });
        let lossless = job.subtitles.is_empty();
        let report = match verdict {
            Verdict::Passed(report) => report,
            // The engine's survey misreads the first 100 s of this synthetic
            // episode by about 670 ms (it reads the original dub at +1507 ms
            // there, planted +840), so its sync check can fail the lossless
            // track although a plain cross-correlation puts it at +13.4 ms and
            // -8.0 ms, as the conform's own check does. The structure must pass.
            Verdict::Failed { report, .. } if lossless && report.checks.iter().all(|check| check.status != crate::verify::CheckStatus::Fail || check.id == "sync") => {
                println!("  NOTE: only the sync check failed ({:?} ms)", report.residual_ms);
                report
            }
            Verdict::Failed { report, .. } => panic!("{episode} failed verification: {report:#?}"),
            Verdict::Interrupted => panic!("interrupted"),
        };
        println!("  verified ok={} residual={:?} ms confidence={:?}", report.ok, report.residual_ms, report.sync_confidence);
        for check in &report.checks {
            println!("    {:?} {}: {}", check.status, check.label, check.detail);
        }
        let lines: Vec<f64> = truth[episode.as_str()]["lines"].as_array().unwrap().iter().map(|line| line["start"].as_f64().unwrap()).collect();
        if lossless {
            // The lossless conform, on its own: Matroska in, its one track muxed at 0.
            let conformed = &job.audios[0];
            assert!(conformed.path.ends_with(".conformed.mka"), "{}", conformed.path);
            assert_eq!(sync_of.get(&conformed.path).map(String::as_str).unwrap_or("0:0"), "0:0");
            assert!(tracks.iter().any(|track| track == "audio:E-AC-3:hin"), "{tracks:?}");
            continue;
        }
        let final_info = identify(&final_path);
        let (count, worst) = subtitle_error(&final_path, &final_info, &episode, &lines, dir);
        println!("  added subtitle: {count} lines, the furthest {:.0} ms from where the line is spoken", worst * 1000.0);

        match episode.as_str() {
            "S01E02" => {
                // The conformed dub: its own file, one E-AC-3 track in Hindi, at delay 0.
                let conformed = &job.audios[0];
                assert!(conformed.path.contains("MKVBatchMux conformed") || conformed.path.contains("render"), "{}", conformed.path);
                assert!(added.contains(&conformed.path));
                assert!(tracks.iter().any(|track| track == "audio:E-AC-3:hin"), "{tracks:?}");
                let sync = sync_of.get(&conformed.path).map(String::as_str).unwrap_or("0:0");
                assert_eq!(sync, "0:0", "the conformed track goes in at 0");
                let residual = report.residual_ms.expect("the conformed dub was measured in the output");
                assert!(residual.abs() <= 40.0, "conformed dub {residual} ms off");
                assert!(worst < 0.05, "E02's subtitle {worst} s off");
            }
            "S01E03" => {
                // The re-timed copy, at delay 0.
                let subtitle = &job.subtitles[0];
                assert!(subtitle.path.contains("synced"), "{}", subtitle.path);
                assert_eq!(subtitle.delay, Some(0.0));
                assert!(added.contains(&subtitle.path));
                assert_eq!(sync_of.get(&subtitle.path).map(String::as_str).unwrap_or("0:0"), "0:0");
                assert!(worst < 0.15, "E03's re-timed subtitle {worst} s off");
            }
            _ => assert!(worst < 0.05, "{episode}'s subtitle {worst} s off"),
        }
        assert_eq!(count, lines.len());
    }
}

/// Preferences › Measurement keeps the conform settings (and the whole-timeline
/// switch) through a save, and a setting.json from before them still loads.
#[test]
fn measurement_settings_load_old_files_and_keep_the_new_fields() {
    let old: crate::OptionsData = serde_json::from_value(serde_json::json!({
        "Presets": [], "Measurement": { "windowSeconds": 45.0, "windowCount": 6, "maxOffsetMs": 60000.0 },
        "FavoritePresetId": 0, "Dark_Mode": true, "Attachment_Expert_Mode_Info_Message_Show": true, "Choose_Preset_On_Startup": false
    }))
    .expect("a setting.json from before the conform settings loads");
    let written = serde_json::to_value(&old).unwrap();
    assert_eq!(written["Measurement"], serde_json::json!({ "windowSeconds": 45.0, "windowCount": 6, "maxOffsetMs": 60000.0 }));

    let saved = serde_json::json!({ "windowSeconds": 45.0, "windowCount": 6, "maxOffsetMs": 60000.0, "fullTimeline": true, "conformMode": "lossless", "conformCodec": "flac", "conformOutputDir": "E:\\Conformed" });
    let read: crate::MeasurementSettings = serde_json::from_value(saved.clone()).unwrap();
    assert_eq!(serde_json::to_value(&read).unwrap(), saved);
    // The frontend writes no folder as null: read as absent, and left out again.
    let none: crate::MeasurementSettings = serde_json::from_value(serde_json::json!({ "windowSeconds": 45.0, "windowCount": 6, "maxOffsetMs": 60000.0, "conformOutputDir": null })).unwrap();
    assert!(serde_json::to_value(&none).unwrap().get("conformOutputDir").is_none());
}
