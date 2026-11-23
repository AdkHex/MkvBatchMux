//! What the conform and subtitle-sync runs share: one way to talk to the
//! engine, one way to tell the frontend, and the run wrapper every engine run
//! follows (see `audiosync::run_measure`).
//!
//! The link and the sink are traits so a real-tool test can drive the same
//! pipeline the app runs, against an engine it starts itself, and read back
//! the events the frontend would have heard.

use std::io::Read;
use std::process::{Child, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::thread;
use std::time::Duration;

use serde::Serialize;
use serde_json::Value;
use tauri::{AppHandle, Manager};

use crate::audiosync::{drain_ready, locked, Engine, EngineHandle};
use crate::hidden_command;
use crate::remote_status::PAUSED_ERROR;

/// A conversation with the engine: one request line out, its events back.
pub(crate) trait EngineLink {
    fn send(&mut self, payload: &Value) -> Result<(), String>;
    /// The next event, or an error when the engine went away or stayed silent
    /// for `timeout`.
    fn recv(&mut self, timeout: Duration) -> Result<Value, String>;
}

impl EngineLink for Engine {
    fn send(&mut self, payload: &Value) -> Result<(), String> {
        Engine::send(self, payload)
    }

    fn recv(&mut self, timeout: Duration) -> Result<Value, String> {
        self.events()
            .recv_timeout(timeout)
            .map_err(|_| "The analysis engine stopped responding.".to_string())
    }
}

/// Where a run's events go: the app's windows, or a test's recorder.
pub(crate) trait Sink {
    fn emit(&self, event: &str, payload: Value);
}

impl Sink for AppHandle {
    fn emit(&self, event: &str, payload: Value) {
        let _ = self.emit_all(event, payload);
    }
}

/// Serialise an event struct for a sink. The structs are plain data, so this
/// cannot fail in practice; a failure would send `null` rather than panic.
pub(crate) fn to_value<T: Serialize>(event: &T) -> Value {
    serde_json::to_value(event).unwrap_or(Value::Null)
}

/// How a run ended, for its `…-done` event.
#[derive(Debug, Clone, Default, PartialEq)]
pub(crate) struct RunEnd {
    pub cancelled: bool,
    pub error: Option<String>,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DoneEvent {
    pub run_id: String,
    pub cancelled: bool,
    pub error: Option<String>,
}

/// What the frontend reads when the remote lock ended a run part way. These
/// runs are not parked and resumed like measurement: what finished keeps its
/// result, and the rest is started again by hand.
pub(crate) const STOPPED_BY_LOCK: &str =
    "MKVBatchMux paused this run. The files it had not finished are unchanged; start them again when it is back.";

/// Run `body` on its own thread against the app's engine, the way measurement
/// runs: the engine's handshake first, nothing started while the remote lock
/// holds, a cancel aimed at an earlier run cleared, and exactly one `done`
/// event whatever happens. `body` returns `Err` only when the engine itself
/// failed (the engine is then dropped and the next run starts a fresh one);
/// a per-file failure is that file's result, not the run's.
pub(crate) fn spawn_engine_run<F>(app: AppHandle, handle: EngineHandle, run_id: String, done_event: &'static str, body: F)
where
    F: FnOnce(&mut Engine, &AppHandle, &AtomicBool) -> Result<RunEnd, String> + Send + 'static,
{
    handle.cancel_requested.store(false, Ordering::SeqCst);
    handle.runs.fetch_add(1, Ordering::SeqCst);
    tauri::async_runtime::spawn_blocking(move || {
        let cancel = Arc::clone(&handle.cancel_requested);
        let outcome = handle.with(&app, |engine| {
            drain_ready(engine)?;
            if !engine.ffmpeg_ready {
                return Err(
                    "FFmpeg was not found by the analysis engine. Install FFmpeg and make \
                     sure ffmpeg and ffprobe are on your PATH."
                        .to_string(),
                );
            }
            // Locked while this run waited for the engine: start nothing.
            if locked(&app) {
                return Err(PAUSED_ERROR.to_string());
            }
            body(engine, &app, &cancel)
        });
        handle.runs.fetch_sub(1, Ordering::SeqCst);
        let end = match outcome {
            Ok(end) => end,
            Err(err) => {
                let paused = handle.interrupted.swap(false, Ordering::SeqCst) || locked(&app);
                let cancelled = handle.cancel_requested.load(Ordering::SeqCst);
                RunEnd {
                    cancelled,
                    error: if cancelled {
                        None
                    } else if paused {
                        Some(STOPPED_BY_LOCK.to_string())
                    } else {
                        Some(err)
                    },
                }
            }
        };
        handle.cancel_requested.store(false, Ordering::SeqCst);
        Sink::emit(&app, done_event, to_value(&DoneEvent { run_id, cancelled: end.cancelled, error: end.error }));
    });
}

/// Run an external tool to completion, stopping it as soon as `cancel` is
/// set. Both output streams are drained on their own threads, so a tool that
/// writes megabytes (ffprobe listing every packet) cannot block on a full pipe.
pub(crate) fn run_tool(program: &str, args: &[String], cancel: &AtomicBool) -> Result<ToolOutput, String> {
    let mut child = hidden_command(program)
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|err| format!("Could not start {program}: {err}"))?;
    crate::process_job::adopt(&child);
    let stdout = drain(child.stdout.take());
    let stderr = drain(child.stderr.take());
    let status = loop {
        if cancel.load(Ordering::SeqCst) {
            stop(&mut child);
            return Err(CANCELLED.to_string());
        }
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) => thread::sleep(Duration::from_millis(40)),
            Err(err) => return Err(format!("{program} failed: {err}")),
        }
    };
    Ok(ToolOutput {
        code: status.code().unwrap_or(-1),
        stdout: stdout.join().unwrap_or_default(),
        stderr: String::from_utf8_lossy(&stderr.join().unwrap_or_default()).into_owned(),
    })
}

/// The error `run_tool` returns when it was stopped on purpose.
pub(crate) const CANCELLED: &str = "Cancelled";

pub(crate) struct ToolOutput {
    pub code: i32,
    pub stdout: Vec<u8>,
    pub stderr: String,
}

impl ToolOutput {
    /// The last non-empty line of stderr (or stdout), for an error message.
    pub fn tail(&self) -> String {
        let text = if self.stderr.trim().is_empty() {
            String::from_utf8_lossy(&self.stdout).into_owned()
        } else {
            self.stderr.clone()
        };
        text.lines().map(str::trim).filter(|line| !line.is_empty()).last().unwrap_or("no output").to_string()
    }
}

fn drain<R: Read + Send + 'static>(stream: Option<R>) -> thread::JoinHandle<Vec<u8>> {
    thread::spawn(move || {
        let mut buffer = Vec::new();
        if let Some(mut stream) = stream {
            let _ = stream.read_to_end(&mut buffer);
        }
        buffer
    })
}

fn stop(child: &mut Child) {
    let _ = child.kill();
    let _ = child.wait();
}

/// An engine a real-tool test starts itself from `AUDIOSYNC_REPO`, the same
/// way the app's development build does, plus a sink that records events.
#[cfg(test)]
pub(crate) mod testing {
    use super::*;
    use std::io::{BufRead, BufReader};
    use std::path::PathBuf;
    use std::process::ChildStdin;
    use std::sync::mpsc::{channel, Receiver};
    use std::sync::Mutex;

    pub struct TestEngine {
        child: Child,
        stdin: ChildStdin,
        events: Receiver<Value>,
    }

    impl TestEngine {
        /// Start `python/bridge.py` of the checkout in `AUDIOSYNC_REPO`, with
        /// ffmpeg/ffprobe from PATH, and consume its `ready` handshake.
        pub fn start() -> Self {
            let repo = PathBuf::from(std::env::var("AUDIOSYNC_REPO").expect(
                "set AUDIOSYNC_REPO to an AudioSyncMaster checkout with python/.venv to run this test",
            ));
            let venv = if cfg!(windows) {
                repo.join("python").join(".venv").join("Scripts").join("python.exe")
            } else {
                repo.join("python").join(".venv").join("bin").join("python")
            };
            let python = if venv.is_file() { venv } else { PathBuf::from("python3") };
            let mut command = hidden_command(&python.to_string_lossy());
            command.arg(repo.join("python").join("bridge.py")).current_dir(&repo);
            for (var, tool) in [("AUDIOSYNC_FFMPEG", "ffmpeg"), ("AUDIOSYNC_FFPROBE", "ffprobe")] {
                if std::env::var_os(var).is_none() {
                    if let Some(path) = which(tool) {
                        command.env(var, path);
                    }
                }
            }
            let mut child = command
                .stdin(Stdio::piped())
                .stdout(Stdio::piped())
                .stderr(Stdio::null())
                .spawn()
                .expect("start the engine");
            let stdin = child.stdin.take().expect("engine stdin");
            let stdout = child.stdout.take().expect("engine stdout");
            let (sender, events) = channel();
            thread::spawn(move || {
                for line in BufReader::new(stdout).lines().map_while(Result::ok) {
                    if let Ok(value) = serde_json::from_str::<Value>(line.trim()) {
                        if sender.send(value).is_err() {
                            break;
                        }
                    }
                }
            });
            let mut engine = Self { child, stdin, events };
            loop {
                let event = engine.recv(Duration::from_secs(60)).expect("engine handshake");
                if event.get("type").and_then(Value::as_str) == Some("ready") {
                    break;
                }
            }
            engine
        }
    }

    impl EngineLink for TestEngine {
        fn send(&mut self, payload: &Value) -> Result<(), String> {
            use std::io::Write;
            writeln!(self.stdin, "{}", payload).map_err(|err| err.to_string())?;
            self.stdin.flush().map_err(|err| err.to_string())
        }

        fn recv(&mut self, timeout: Duration) -> Result<Value, String> {
            self.events.recv_timeout(timeout).map_err(|_| "The analysis engine stopped responding.".to_string())
        }
    }

    impl Drop for TestEngine {
        fn drop(&mut self) {
            let _ = self.send(&serde_json::json!({ "command": "shutdown" }));
            let _ = self.child.kill();
            let _ = self.child.wait();
        }
    }

    /// Every event a run emitted, in order.
    #[derive(Default)]
    pub struct Recorder(pub Mutex<Vec<(String, Value)>>);

    impl Sink for Recorder {
        fn emit(&self, event: &str, payload: Value) {
            self.0.lock().unwrap().push((event.to_string(), payload));
        }
    }

    impl Recorder {
        pub fn named(&self, event: &str) -> Vec<Value> {
            self.0.lock().unwrap().iter().filter(|(name, _)| name == event).map(|(_, value)| value.clone()).collect()
        }
    }

    pub fn which(tool: &str) -> Option<PathBuf> {
        let name = if cfg!(windows) { format!("{tool}.exe") } else { tool.to_string() };
        std::env::split_paths(&std::env::var_os("PATH")?).map(|dir| dir.join(&name)).find(|path| path.is_file())
    }

    /// The test season from `make_media.py`: `MBM_TEST_MEDIA` names its folder.
    pub fn media() -> PathBuf {
        PathBuf::from(std::env::var("MBM_TEST_MEDIA").expect(
            "set MBM_TEST_MEDIA to the folder make_media.py wrote (with truth.json) to run this test",
        ))
    }

    pub fn truth() -> Value {
        let text = std::fs::read_to_string(media().join("truth.json")).expect("truth.json");
        serde_json::from_str(&text).expect("truth.json parses")
    }
}
