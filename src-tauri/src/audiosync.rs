//! Long-lived connection to the AudioSync analysis engine.
//!
//! Ported from AudioSyncMaster's `src-tauri/src/bridge.rs`, which is Tauri v2
//! code; the differences here are v1's `emit_all`/`path_resolver` APIs, not a
//! change of design.
//!
//! The engine is a Python process speaking newline-delimited JSON. It is kept
//! alive across runs and spoken to line-by-line so that `cancel` reaches a
//! batch in flight: killing the process instead would orphan every ffmpeg child
//! it had spawned.

use std::io::{BufRead, BufReader, Write};
use std::path::PathBuf;
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::mpsc::{channel, Receiver, Sender};
use std::sync::{Arc, Mutex, OnceLock};
use std::thread;

use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::{AppHandle, Manager};

use crate::hidden_command;

static FFMPEG_AVAILABLE: OnceLock<bool> = OnceLock::new();
static FFMPEG_DIR: OnceLock<Option<PathBuf>> = OnceLock::new();

/// Directory holding the bundled ffmpeg/ffprobe, if this build shipped them.
///
/// The installer bundles them under `resources/ffmpeg` so delay measurement
/// works on a machine that has never installed FFmpeg. A user's own PATH copy
/// is still honoured as a fallback (and in dev builds, where nothing is
/// bundled), but the bundled pair wins: it is the version this app was tested
/// against.
fn bundled_ffmpeg_dir(app: &AppHandle) -> Option<PathBuf> {
    FFMPEG_DIR
        .get_or_init(|| {
            let dir = app.path_resolver().resolve_resource("resources/ffmpeg")?;
            let exe = if cfg!(windows) { "ffmpeg.exe" } else { "ffmpeg" };
            let probe = if cfg!(windows) {
                "ffprobe.exe"
            } else {
                "ffprobe"
            };
            // Only claim the directory when *both* tools are present: the engine
            // needs ffprobe as much as ffmpeg, and a half-populated resource
            // folder would fail later with a much more confusing error.
            (dir.join(exe).is_file() && dir.join(probe).is_file()).then_some(dir)
        })
        .clone()
}

/// Whether this build ships its own ffmpeg pair.
pub fn ffmpeg_is_bundled(app: &AppHandle) -> bool {
    bundled_ffmpeg_dir(app).is_some()
}

/// Absolute path to a bundled tool, else the bare name for PATH lookup.
pub fn ffmpeg_tool(app: &AppHandle, tool: &str) -> String {
    let name = if cfg!(windows) {
        format!("{tool}.exe")
    } else {
        tool.to_string()
    };
    match bundled_ffmpeg_dir(app) {
        Some(dir) => dir.join(&name).to_string_lossy().to_string(),
        None => tool.to_string(),
    }
}

/// Mirrors `mediainfo_available()` / `mkvmerge_available()` in main.rs, but
/// checks the bundled copies first so a fresh install reports available.
pub fn ffmpeg_available_for(app: &AppHandle) -> bool {
    *FFMPEG_AVAILABLE.get_or_init(|| {
        crate::tool_available(&ffmpeg_tool(app, "ffmpeg"), "-version")
            && crate::tool_available(&ffmpeg_tool(app, "ffprobe"), "-version")
    })
}


#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct EngineStatus {
    pub engine_available: bool,
    pub ffmpeg_available: bool,
    pub engine_path: Option<String>,
    pub message: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct MeasurePair {
    pub primary_path: String,
    pub secondary_path: String,
    pub key: String,
    pub method: String,
    pub score: f64,
    pub primary_track: i64,
    pub secondary_track: i64,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct MeasureStartRequest {
    pub run_id: String,
    pub pairs: Vec<MeasurePair>,
    pub window_seconds: f64,
    pub window_count: i64,
    pub max_offset_ms: f64,
    pub max_workers: i64,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct MeasureProgressEvent {
    run_id: String,
    processed: usize,
    total: usize,
    current: Option<String>,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct MeasureResultEvent {
    run_id: String,
    key: Option<String>,
    result: Value,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct MeasureDoneEvent {
    run_id: String,
    cancelled: bool,
    error: Option<String>,
}

/// A running engine process plus the channel its stdout reader publishes to.
pub struct Engine {
    child: Child,
    stdin: ChildStdin,
    events: Receiver<Value>,
    path: String,
    /// Whether the one-time `ready` event has been consumed. See `drain_ready`.
    handshake_done: bool,
    /// What that handshake reported about ffmpeg -- a second confirmation
    /// alongside this app's own PATH probe.
    ffmpeg_ready: bool,
}

impl Engine {
    pub fn spawn(app: &AppHandle) -> Result<Self, String> {
        let (mut command, described) = build_command(app)?;
        command
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());

        let mut child = command
            .spawn()
            .map_err(|err| format!("Could not start the analysis engine: {err}"))?;

        let stdin = child
            .stdin
            .take()
            .ok_or_else(|| "Could not open the engine's input stream".to_string())?;
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| "Could not open the engine's output stream".to_string())?;
        let stderr = child
            .stderr
            .take()
            .ok_or_else(|| "Could not open the engine's error stream".to_string())?;

        let (sender, receiver): (Sender<Value>, Receiver<Value>) = channel();

        // stdout is drained on its own thread from the moment the process
        // starts, so writing a large request can never deadlock against a full
        // output pipe.
        thread::spawn(move || {
            let reader = BufReader::new(stdout);
            for line in reader.lines() {
                let Ok(line) = line else { break };
                let trimmed = line.trim();
                if trimmed.is_empty() {
                    continue;
                }
                match serde_json::from_str::<Value>(trimmed) {
                    Ok(value) => {
                        if sender.send(value).is_err() {
                            break; // Receiver dropped; the run is over.
                        }
                    }
                    Err(_) => {
                        let _ = sender.send(serde_json::json!({
                            "type": "log",
                            "message": format!("Unparsed engine output: {trimmed}"),
                        }));
                    }
                }
            }
        });

        let app_for_stderr = app.clone();
        thread::spawn(move || {
            let reader = BufReader::new(stderr);
            for line in reader.lines().map_while(Result::ok) {
                if !line.trim().is_empty() {
                    let _ = app_for_stderr.emit_all("audiosync-log", line);
                }
            }
        });

        Ok(Self {
            child,
            stdin,
            events: receiver,
            path: described,
            handshake_done: false,
            ffmpeg_ready: false,
        })
    }

    pub fn send(&mut self, payload: &Value) -> Result<(), String> {
        let line = format!(
            "{}\n",
            serde_json::to_string(payload).map_err(|e| e.to_string())?
        );
        self.stdin
            .write_all(line.as_bytes())
            .map_err(|err| format!("Lost connection to the analysis engine: {err}"))?;
        self.stdin
            .flush()
            .map_err(|err| format!("Lost connection to the analysis engine: {err}"))
    }

    pub fn events(&self) -> &Receiver<Value> {
        &self.events
    }

    pub fn shutdown(&mut self) {
        let _ = self.send(&serde_json::json!({ "command": "shutdown" }));
        let _ = self.stdin.flush();
        match self.child.try_wait() {
            Ok(Some(_)) => {}
            _ => {
                let _ = self.child.kill();
                let _ = self.child.wait();
            }
        }
    }
}

impl Drop for Engine {
    fn drop(&mut self) {
        self.shutdown();
    }
}

/// Shared handle so commands from different invocations reach the same process.
#[derive(Clone, Default)]
pub struct EngineHandle(Arc<Mutex<Option<Engine>>>);

impl EngineHandle {
    /// Run `action` against a live engine, starting one if necessary.
    pub fn with<T>(
        &self,
        app: &AppHandle,
        action: impl FnOnce(&mut Engine) -> Result<T, String>,
    ) -> Result<T, String> {
        let mut guard = self
            .0
            .lock()
            .map_err(|_| "Engine lock poisoned".to_string())?;
        if guard.is_none() {
            *guard = Some(Engine::spawn(app)?);
        }
        let engine = guard.as_mut().expect("engine present");
        match action(engine) {
            Ok(value) => Ok(value),
            Err(err) => {
                // A failed exchange usually means the process died; drop it so
                // the next call starts a healthy one rather than reusing a
                // half-broken pipe.
                *guard = None;
                Err(err)
            }
        }
    }

    /// Send without waiting for a reply. Used for cancellation, which must not
    /// queue behind the run it is trying to stop.
    pub fn send_now(&self, payload: &Value) -> Result<(), String> {
        let mut guard = self
            .0
            .lock()
            .map_err(|_| "Engine lock poisoned".to_string())?;
        match guard.as_mut() {
            Some(engine) => engine.send(payload),
            None => Err("The analysis engine is not running".to_string()),
        }
    }

    pub fn path(&self) -> Option<String> {
        self.0
            .lock()
            .ok()
            .and_then(|guard| guard.as_ref().map(|engine| engine.path.clone()))
    }

    pub fn shutdown(&self) {
        if let Ok(mut guard) = self.0.lock() {
            if let Some(mut engine) = guard.take() {
                engine.shutdown();
            }
        }
    }
}

/// Locate the packaged engine.
///
/// The engine ships as a PyInstaller *directory* build under
/// `resources/engine/`, not a single-file executable: a onefile build
/// re-extracts its whole payload to a temp directory on every launch.
fn find_sidecar(app: &AppHandle) -> Option<PathBuf> {
    let exe_name = if cfg!(windows) {
        "audiosync-cli.exe"
    } else {
        "audiosync-cli"
    };

    let mut candidates: Vec<PathBuf> = Vec::new();

    if let Some(dir) = app
        .path_resolver()
        .resolve_resource("resources/engine")
    {
        candidates.push(dir.join(exe_name));
        // PyInstaller >= 6 nests the payload under a subdirectory on some
        // platforms.
        candidates.push(dir.join("audiosync-cli").join(exe_name));
    }

    // Development layout: built into src-tauri/resources/engine.
    if let Ok(exe) = std::env::current_exe() {
        let mut cursor = exe.parent().map(PathBuf::from);
        while let Some(dir) = cursor {
            candidates.push(
                dir.join("src-tauri")
                    .join("resources")
                    .join("engine")
                    .join(exe_name),
            );
            cursor = dir.parent().map(PathBuf::from);
        }
    }

    candidates.into_iter().find(|path| path.is_file())
}

/// The AudioSyncMaster source checkout, used as a development fallback so the
/// feature is workable without a PyInstaller build.
fn dev_bridge_script() -> Option<PathBuf> {
    let mut roots: Vec<PathBuf> = Vec::new();
    if let Ok(dir) = std::env::var("AUDIOSYNC_REPO") {
        roots.push(PathBuf::from(dir));
    }
    // The sibling checkout, which is how both repos are laid out in practice.
    if let Ok(exe) = std::env::current_exe() {
        let mut cursor = exe.parent().map(PathBuf::from);
        while let Some(dir) = cursor {
            roots.push(dir.join("AudioSyncMaster"));
            if let Some(parent) = dir.parent() {
                roots.push(parent.join("AudioSyncMaster"));
            }
            cursor = dir.parent().map(PathBuf::from);
        }
    }
    if let Ok(cwd) = std::env::current_dir() {
        roots.push(cwd.join("..").join("AudioSyncMaster"));
        roots.push(cwd.join("..").join("..").join("AudioSyncMaster"));
    }

    roots
        .into_iter()
        .map(|root| root.join("python").join("bridge.py"))
        .find(|script| script.is_file())
}

fn find_python(repo_root: &std::path::Path) -> PathBuf {
    let venv = if cfg!(windows) {
        repo_root
            .join("python")
            .join(".venv")
            .join("Scripts")
            .join("python.exe")
    } else {
        repo_root.join("python").join(".venv").join("bin").join("python")
    };
    if venv.is_file() {
        return venv;
    }
    PathBuf::from(if cfg!(windows) { "python" } else { "python3" })
}

/// Build the command that starts the engine, preferring the bundled sidecar.
/// Returns the command and a human-readable description for the log.
/// Prepend the bundled ffmpeg directory to the child's PATH.
///
/// The engine shells out to ffmpeg/ffprobe by bare name, so bundling the
/// binaries is not enough on its own -- the child has to be able to find them.
/// Prepending (rather than replacing) means a user's own FFmpeg still works if
/// nothing is bundled, and the tested pair wins when it is.
fn apply_ffmpeg_path(app: &AppHandle, command: &mut Command) {
    let Some(dir) = bundled_ffmpeg_dir(app) else {
        return;
    };
    let existing = std::env::var_os("PATH").unwrap_or_default();
    let mut entries = vec![dir];
    entries.extend(std::env::split_paths(&existing));
    if let Ok(joined) = std::env::join_paths(entries) {
        command.env("PATH", joined);
    }
}

fn build_command(app: &AppHandle) -> Result<(Command, String), String> {
    if let Some(sidecar) = find_sidecar(app) {
        let described = sidecar.to_string_lossy().to_string();
        // hidden_command applies CREATE_NO_WINDOW on Windows; without it a
        // console window flashes on every run.
        let mut command = hidden_command(&described);
        apply_ffmpeg_path(app, &mut command);
        return Ok((command, described));
    }

    if let Some(script) = dev_bridge_script() {
        let repo_root = script
            .parent()
            .and_then(|p| p.parent())
            .map(PathBuf::from)
            .unwrap_or_else(|| PathBuf::from("."));
        let interpreter = find_python(&repo_root);
        let described = format!(
            "{} {} (development)",
            interpreter.to_string_lossy(),
            script.to_string_lossy()
        );
        let mut command = hidden_command(&interpreter.to_string_lossy());
        command.arg(&script);
        // Run from the repo root so the engine resolves its own package.
        command.current_dir(&repo_root);
        apply_ffmpeg_path(app, &mut command);
        return Ok((command, described));
    }

    Err(
        "The audio analysis engine is missing. Build it with `npm run fetch-engine`, \
         or set AUDIOSYNC_REPO to an AudioSyncMaster checkout."
            .to_string(),
    )
}

#[tauri::command]
pub fn audiosync_engine_status(
    app: AppHandle,
    engine: tauri::State<'_, EngineHandle>,
) -> EngineStatus {
    let ffmpeg = ffmpeg_available_for(&app);
    let located = find_sidecar(&app)
        .map(|p| p.to_string_lossy().to_string())
        .or_else(|| {
            dev_bridge_script().map(|p| format!("{} (development)", p.to_string_lossy()))
        });

    // Release builds bundle both, so these only surface if something went
    // wrong with the install -- or in a dev checkout, where the build command
    // is the useful answer. Debug builds get the developer wording; installed
    // users get something they can act on.
    let message = if located.is_none() {
        Some(if cfg!(debug_assertions) {
            "The audio analysis engine is not built. Run `npm run fetch-engine`.".to_string()
        } else {
            "The audio analysis engine is missing from this install. Reinstalling the app \
             restores it."
                .to_string()
        })
    } else if !ffmpeg {
        Some(if cfg!(debug_assertions) {
            "FFmpeg was not found. Run `npm run fetch-ffmpeg`, or put ffmpeg and ffprobe on \
             your PATH."
                .to_string()
        } else {
            "FFmpeg is missing from this install. Open Settings to install it, or reinstall \
             the app."
                .to_string()
        })
    } else {
        None
    };

    EngineStatus {
        engine_available: located.is_some(),
        ffmpeg_available: ffmpeg,
        engine_path: engine.path().or(located),
        message,
    }
}

/// Enumerate a file's audio streams, for the reference-track picker.
#[tauri::command]
pub fn list_reference_tracks(
    app: AppHandle,
    engine: tauri::State<'_, EngineHandle>,
    paths: Vec<String>,
) -> Result<Value, String> {
    if paths.is_empty() {
        return Ok(serde_json::json!({ "files": [] }));
    }

    engine.with(&app, |engine| {
        // A freshly spawned engine still owes us its handshake; consuming it
        // here keeps it out of the response stream below.
        drain_ready(engine)?;
        engine.send(&serde_json::json!({
            "command": "listTracks",
            "paths": paths,
        }))?;

        use std::time::Duration;
        let deadline = Duration::from_secs(120);
        loop {
            match engine.events().recv_timeout(deadline) {
                Ok(value) => match value.get("type").and_then(Value::as_str) {
                    Some("tracks") => return Ok(value),
                    Some("error") => {
                        return Err(value
                            .get("message")
                            .and_then(Value::as_str)
                            .unwrap_or("The engine could not read those files.")
                            .to_string())
                    }
                    _ => continue,
                },
                Err(_) => return Err("The engine did not answer in time.".to_string()),
            }
        }
    })
}

/// Consume the engine's startup handshake, if it is still pending.
///
/// The engine emits `ready` once, when it starts. A command issued against a
/// freshly spawned engine must swallow it, or it arrives interleaved with that
/// command's own response; a command issued against an established engine has
/// nothing to swallow and must not block looking for one.
///
/// `handshake_done` distinguishes the two cases explicitly. Peeking at the
/// channel instead would race: an empty queue means "already handshaken" and
/// "process still starting" equally, and guessing wrong either eats a real
/// event or hangs.
fn drain_ready(engine: &mut Engine) -> Result<(), String> {
    use std::time::Duration;

    if engine.handshake_done {
        return Ok(());
    }

    // A cold PyInstaller directory build starts in well under a second; this
    // bound exists so a broken engine reports rather than hanging forever.
    let deadline = Duration::from_secs(30);
    loop {
        match engine.events().recv_timeout(deadline) {
            Ok(value) => match value.get("type").and_then(Value::as_str) {
                Some("ready") => {
                    engine.handshake_done = true;
                    engine.ffmpeg_ready =
                        value.get("ffmpeg").and_then(Value::as_bool).unwrap_or(false);
                    return Ok(());
                }
                // Anything before `ready` is startup chatter on the log path.
                _ => continue,
            },
            Err(_) => {
                return Err("The analysis engine did not start in time.".to_string());
            }
        }
    }
}

#[tauri::command]
pub fn measure_delays_start(
    app: AppHandle,
    engine: tauri::State<'_, EngineHandle>,
    request: MeasureStartRequest,
) -> Result<(), String> {
    if !ffmpeg_available_for(&app) {
        return Err(
            "FFmpeg was not found. Install FFmpeg and make sure ffmpeg and ffprobe are on your PATH."
                .to_string(),
        );
    }
    if request.pairs.is_empty() {
        return Err("There is nothing to measure.".to_string());
    }

    let run_id = request.run_id.clone();
    let total = request.pairs.len();

    // Map the engine's per-result paths back to the key the frontend sent, so
    // write-back never has to re-derive the pairing.
    let mut keys_by_pair: std::collections::HashMap<(String, String), String> =
        std::collections::HashMap::new();
    for pair in &request.pairs {
        keys_by_pair.insert(
            (pair.primary_path.clone(), pair.secondary_path.clone()),
            pair.key.clone(),
        );
    }

    let payload = serde_json::json!({
        "command": "analyze",
        "mode": "series",
        "pairs": request.pairs.iter().map(|pair| serde_json::json!({
            "primaryPath": pair.primary_path,
            "secondaryPath": pair.secondary_path,
            "key": pair.key,
            "method": pair.method,
            "score": pair.score,
            "primaryTrack": pair.primary_track,
            "secondaryTrack": pair.secondary_track,
        })).collect::<Vec<_>>(),
        "windowSeconds": request.window_seconds,
        "windowCount": request.window_count,
        "maxOffsetMs": request.max_offset_ms,
        "maxWorkers": request.max_workers,
    });

    let handle = (*engine).clone();
    let app_for_run = app.clone();

    // The run is driven on its own thread so the command returns immediately
    // and the rest of the app stays usable while a batch is in flight.
    tauri::async_runtime::spawn_blocking(move || {
        let outcome = handle.with(&app_for_run, |engine| {
            drain_ready(engine)?;
            // The engine's own view of ffmpeg is the authority once it is
            // running; this app's PATH probe can disagree if the two resolve
            // PATH differently.
            if !engine.ffmpeg_ready {
                return Err(
                    "FFmpeg was not found by the analysis engine. Install FFmpeg and make \
                     sure ffmpeg and ffprobe are on your PATH."
                        .to_string(),
                );
            }
            engine.send(&payload)?;

            use std::time::Duration;
            // No single measurement runs anywhere near this long; the bound
            // exists so a wedged engine surfaces rather than hanging forever.
            let idle_limit = Duration::from_secs(600);
            let mut processed = 0usize;
            let mut fatal: Option<String> = None;

            loop {
                let value = match engine.events().recv_timeout(idle_limit) {
                    Ok(value) => value,
                    Err(_) => {
                        return Err("The analysis engine stopped responding.".to_string());
                    }
                };

                match value.get("type").and_then(Value::as_str) {
                    Some("progress") => {
                        processed = value
                            .get("processed")
                            .and_then(Value::as_u64)
                            .unwrap_or(processed as u64) as usize;
                        let _ = app_for_run.emit_all(
                            "measure-delays-progress",
                            MeasureProgressEvent {
                                run_id: run_id.clone(),
                                processed,
                                total,
                                current: value
                                    .get("current")
                                    .and_then(Value::as_str)
                                    .map(str::to_string),
                            },
                        );
                    }
                    Some("result") => {
                        // bridge.py flattens the result onto the event itself.
                        let primary = value
                            .get("primaryPath")
                            .and_then(Value::as_str)
                            .unwrap_or_default()
                            .to_string();
                        let secondary = value
                            .get("secondaryPath")
                            .and_then(Value::as_str)
                            .unwrap_or_default()
                            .to_string();
                        let key = keys_by_pair.get(&(primary, secondary)).cloned();
                        let _ = app_for_run.emit_all(
                            "measure-delays-result",
                            MeasureResultEvent {
                                run_id: run_id.clone(),
                                key,
                                result: value.clone(),
                            },
                        );
                    }
                    Some("log") => {
                        if let Some(message) = value.get("message").and_then(Value::as_str) {
                            let _ = app_for_run.emit_all("audiosync-log", message.to_string());
                        }
                    }
                    Some("error") => {
                        let message = value
                            .get("message")
                            .and_then(Value::as_str)
                            .unwrap_or("The analysis engine reported an error.")
                            .to_string();
                        let _ = app_for_run.emit_all("audiosync-log", message.clone());
                        if value.get("fatal").and_then(Value::as_bool).unwrap_or(false) {
                            fatal = Some(message);
                        }
                    }
                    Some("done") => {
                        let cancelled = value
                            .get("cancelled")
                            .and_then(Value::as_bool)
                            .unwrap_or(false);
                        let _ = app_for_run.emit_all(
                            "measure-delays-done",
                            MeasureDoneEvent {
                                run_id: run_id.clone(),
                                cancelled,
                                error: fatal.clone(),
                            },
                        );
                        return Ok(());
                    }
                    _ => {}
                }
            }
        });

        // A failed run still has to close out the frontend's progress state,
        // otherwise the UI waits on a batch that will never report done.
        if let Err(err) = outcome {
            let _ = app_for_run.emit_all(
                "measure-delays-done",
                MeasureDoneEvent {
                    run_id: request.run_id.clone(),
                    cancelled: false,
                    error: Some(err),
                },
            );
        }
    });

    Ok(())
}

/// Ask the engine to stop the batch in flight.
///
/// Cancellation is a message, not a kill: killing the process would orphan the
/// ffmpeg children it spawned.
///
/// KNOWN LIMITATION (upstream, verified 2026-08-28): `bridge.py`'s command loop
/// is single-threaded -- `for line in sys.stdin` does not run again until the
/// current command returns -- so a `cancel` sent mid-`analyze` is not read
/// until that batch has already finished. Measured directly: a `ping` sent 3s
/// into a 17.6s batch went unanswered until the batch completed. The engine's
/// own comments describe cancel as handled "ahead of the queue", which is true
/// of the queue but not of a command already executing.
///
/// The message is still sent, so this starts working the moment the engine
/// reads stdin on its own thread. Until then the UI reports cancellation as
/// requested rather than as done, so the button never claims more than it can
/// deliver. Fixing it belongs in AudioSyncMaster, which owns that file.
#[tauri::command]
pub fn measure_delays_cancel(engine: tauri::State<'_, EngineHandle>) -> Result<(), String> {
    engine.send_now(&serde_json::json!({ "command": "cancel" }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn measure_request_deserializes_from_the_frontend_payload() {
        let json = r#"{
            "runId": "run-1",
            "pairs": [{
                "primaryPath": "/v/Episode 01.mkv",
                "secondaryPath": "/a/Episode 01.aac",
                "key": "audio-1",
                "method": "mkvbatchmux",
                "score": 1.0,
                "primaryTrack": 0,
                "secondaryTrack": 0
            }],
            "windowSeconds": 45,
            "windowCount": 6,
            "maxOffsetMs": 60000,
            "maxWorkers": 3
        }"#;
        let parsed: MeasureStartRequest =
            serde_json::from_str(json).expect("frontend payload should deserialize");
        assert_eq!(parsed.pairs.len(), 1);
        assert_eq!(parsed.pairs[0].key, "audio-1");
        assert_eq!(parsed.max_workers, 3);
    }
}
