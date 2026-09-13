//! Long-lived connection to the AudioSync analysis engine, a Python process
//! speaking newline-delimited JSON, kept alive so `cancel` reaches a batch in flight.

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

/// How long shutdown waits before killing the engine -- long enough to stop its
/// ffmpeg children, short enough that quitting still feels immediate.
const SHUTDOWN_GRACE: std::time::Duration = std::time::Duration::from_millis(2000);
const SHUTDOWN_POLL: std::time::Duration = std::time::Duration::from_millis(25);

static FFMPEG: OnceLock<Option<FfmpegPair>> = OnceLock::new();

/// The ffmpeg/ffprobe pair measurement runs on.
#[derive(Debug, Clone)]
pub struct FfmpegPair {
    pub ffmpeg: PathBuf,
    pub ffprobe: PathBuf,
    pub bundled: bool,
}

fn exe(name: &str) -> String {
    if cfg!(windows) {
        format!("{name}.exe")
    } else {
        name.to_string()
    }
}

fn pair_in(dir: &std::path::Path, bundled: bool) -> Option<FfmpegPair> {
    let ffmpeg = dir.join(exe("ffmpeg"));
    let ffprobe = dir.join(exe("ffprobe"));
    (ffmpeg.is_file() && ffprobe.is_file()).then_some(FfmpegPair { ffmpeg, ffprobe, bundled })
}

/// Directories an installed FFmpeg may live in, beyond this process's PATH.
/// A process started by the updater's installer can inherit a PATH without the
/// user's entries, so the registry PATH and the common package-manager
/// locations are searched too.
fn extra_search_dirs() -> Vec<PathBuf> {
    let mut dirs = Vec::new();
    #[cfg(target_os = "windows")]
    {
        for (hive, key) in [
            ("HKCU", r"Environment"),
            ("HKLM", r"SYSTEM\CurrentControlSet\Control\Session Manager\Environment"),
        ] {
            if let Some(value) = registry_path(&format!("{hive}\\{key}")) {
                dirs.extend(std::env::split_paths(&expand_env(&value)));
            }
        }
        let var = |name: &str| std::env::var_os(name).map(PathBuf::from);
        if let Some(local) = var("LOCALAPPDATA") {
            dirs.push(local.join("Microsoft").join("WinGet").join("Links"));
        }
        if let Some(program_data) = var("ProgramData") {
            dirs.push(program_data.join("chocolatey").join("bin"));
        }
        if let Some(home) = var("USERPROFILE") {
            dirs.push(home.join("scoop").join("shims"));
        }
    }
    #[cfg(not(target_os = "windows"))]
    {
        for dir in ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin"] {
            dirs.push(PathBuf::from(dir));
        }
    }
    dirs
}

#[cfg(target_os = "windows")]
fn registry_path(key: &str) -> Option<String> {
    let output = hidden_command("reg")
        .args(["query", key, "/v", "Path"])
        .output()
        .ok()?;
    parse_reg_query(&String::from_utf8_lossy(&output.stdout))
}

#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
fn parse_reg_query(text: &str) -> Option<String> {
    // Output line: "    Path    REG_EXPAND_SZ    C:\...;C:\..."
    let line = text.lines().map(str::trim).find(|line| line.starts_with("Path"))?;
    let rest = line.strip_prefix("Path")?.trim_start();
    let (_, value) = rest.split_once(char::is_whitespace)?;
    let value = value.trim();
    (!value.is_empty()).then(|| value.to_string())
}

#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
fn expand_env(value: &str) -> String {
    let mut out = String::new();
    let mut rest = value;
    while let Some(start) = rest.find('%') {
        out.push_str(&rest[..start]);
        match rest[start + 1..].find('%') {
            Some(len) => {
                let name = &rest[start + 1..start + 1 + len];
                match std::env::var(name) {
                    Ok(v) => out.push_str(&v),
                    Err(_) => out.push_str(&rest[start..start + len + 2]),
                }
                rest = &rest[start + len + 2..];
            }
            None => {
                out.push_str(&rest[start..]);
                rest = "";
            }
        }
    }
    out.push_str(rest);
    out
}

fn runs(binary: &std::path::Path) -> bool {
    crate::tool_available(&binary.to_string_lossy(), "-version")
}

/// Resolve the pair once. An installed FFmpeg wins over the bundled one:
/// AudioSyncMaster measures with the installed one, and different builds
/// decode E-AC-3/TrueHD priming differently, so only the same binary gives
/// the same delay.
pub fn ffmpeg_pair(app: &AppHandle) -> Option<FfmpegPair> {
    FFMPEG
        .get_or_init(|| {
            let process_path = std::env::var_os("PATH").unwrap_or_default();
            let candidates = std::env::split_paths(&process_path)
                .chain(extra_search_dirs())
                .filter(|dir| !dir.as_os_str().is_empty());
            for dir in candidates {
                if let Some(pair) = pair_in(&dir, false) {
                    if runs(&pair.ffmpeg) && runs(&pair.ffprobe) {
                        return Some(pair);
                    }
                }
            }
            let dir = app.path_resolver().resolve_resource("resources/ffmpeg")?;
            pair_in(&dir, true).filter(|pair| runs(&pair.ffmpeg) && runs(&pair.ffprobe))
        })
        .clone()
}

pub fn ffmpeg_is_bundled(app: &AppHandle) -> bool {
    ffmpeg_pair(app).map(|pair| pair.bundled).unwrap_or(false)
}

/// Absolute path of the resolved tool, else the bare name so the failure
/// names the missing tool.
pub fn ffmpeg_tool(app: &AppHandle, tool: &str) -> String {
    match ffmpeg_pair(app) {
        Some(pair) => {
            let path = if tool == "ffprobe" { pair.ffprobe } else { pair.ffmpeg };
            path.to_string_lossy().to_string()
        }
        None => tool.to_string(),
    }
}

pub fn ffmpeg_available_for(app: &AppHandle) -> bool {
    ffmpeg_pair(app).is_some()
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct EngineStatus {
    pub engine_available: bool,
    pub ffmpeg_available: bool,
    pub engine_path: Option<String>,
    /// Version stamp for the engine build, e.g. "AudioSyncMaster v2.8.0 (8e53e8b)".
    pub engine_version: Option<String>,
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

/// Engine stdin, held separately from the engine lock so a cancel isn't queued
/// behind a batch that holds that lock for its whole duration.
type SharedStdin = Arc<Mutex<ChildStdin>>;

/// A running engine process plus the channel its stdout reader publishes to.
pub struct Engine {
    child: Child,
    stdin: SharedStdin,
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

        let stdin: SharedStdin = Arc::new(Mutex::new(
            child
                .stdin
                .take()
                .ok_or_else(|| "Could not open the engine's input stream".to_string())?,
        ));
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| "Could not open the engine's output stream".to_string())?;
        let stderr = child
            .stderr
            .take()
            .ok_or_else(|| "Could not open the engine's error stream".to_string())?;

        let (sender, receiver): (Sender<Value>, Receiver<Value>) = channel();

        // Drained on its own thread from the start, so a large request write
        // can never deadlock against a full output pipe.
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

    pub fn send(&self, payload: &Value) -> Result<(), String> {
        write_line(&self.stdin, payload)
    }

    /// A clone of the stdin handle, for writing outside the engine lock.
    fn stdin_handle(&self) -> SharedStdin {
        Arc::clone(&self.stdin)
    }

    pub fn events(&self) -> &Receiver<Value> {
        &self.events
    }

    pub fn shutdown(&mut self) {
        let _ = self.send(&serde_json::json!({ "command": "shutdown" }));

        // Give the engine a moment to read the shutdown line and stop its
        // ffmpeg children before killing it.
        let deadline = std::time::Instant::now() + SHUTDOWN_GRACE;
        loop {
            match self.child.try_wait() {
                Ok(Some(_)) => return,
                Ok(None) => {
                    if std::time::Instant::now() >= deadline {
                        break;
                    }
                    thread::sleep(SHUTDOWN_POLL);
                }
                Err(_) => break,
            }
        }

        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

/// Serialise a payload and write it as one line. The lock is held only for the
/// write itself, so this never blocks on anything but another in-flight write.
fn write_line(stdin: &SharedStdin, payload: &Value) -> Result<(), String> {
    let line = format!(
        "{}\n",
        serde_json::to_string(payload).map_err(|e| e.to_string())?
    );
    let mut stdin = stdin
        .lock()
        .map_err(|_| "Engine input lock poisoned".to_string())?;
    stdin
        .write_all(line.as_bytes())
        .map_err(|err| format!("Lost connection to the analysis engine: {err}"))?;
    stdin
        .flush()
        .map_err(|err| format!("Lost connection to the analysis engine: {err}"))
}

impl Drop for Engine {
    fn drop(&mut self) {
        self.shutdown();
    }
}

/// Shared handle to the engine process; stdin is guarded separately from the
/// engine lock so cancellation is never queued behind a running batch.
#[derive(Clone, Default)]
pub struct EngineHandle {
    engine: Arc<Mutex<Option<Engine>>>,
    stdin: Arc<Mutex<Option<SharedStdin>>>,
}

impl EngineHandle {
    /// Run `action` against a live engine, starting one if necessary.
    pub fn with<T>(
        &self,
        app: &AppHandle,
        action: impl FnOnce(&mut Engine) -> Result<T, String>,
    ) -> Result<T, String> {
        let mut guard = self
            .engine
            .lock()
            .map_err(|_| "Engine lock poisoned".to_string())?;
        if guard.is_none() {
            let engine = Engine::spawn(app)?;
            self.publish_stdin(Some(engine.stdin_handle()));
            *guard = Some(engine);
        }
        let engine = guard.as_mut().expect("engine present");
        match action(engine) {
            Ok(value) => Ok(value),
            Err(err) => {
                // Drop a dead engine so the next call starts fresh instead of
                // reusing a broken pipe.
                *guard = None;
                self.publish_stdin(None);
                Err(err)
            }
        }
    }

    /// Record (or clear) the stdin of the live engine.
    fn publish_stdin(&self, value: Option<SharedStdin>) {
        if let Ok(mut slot) = self.stdin.lock() {
            *slot = value;
        }
    }

    /// Send without waiting for a reply. Used for cancellation, which must not
    /// queue behind the run it is trying to stop.
    pub fn send_now(&self, payload: &Value) -> Result<(), String> {
        // Cloned out under a lock held for no longer than the clone, so a batch
        // holding the engine lock cannot delay this write.
        let stdin = {
            let guard = self
                .stdin
                .lock()
                .map_err(|_| "Engine input lock poisoned".to_string())?;
            guard.clone()
        };
        match stdin {
            Some(stdin) => write_line(&stdin, payload),
            None => Err("The analysis engine is not running".to_string()),
        }
    }

    pub fn path(&self) -> Option<String> {
        self.engine
            .lock()
            .ok()
            .and_then(|guard| guard.as_ref().map(|engine| engine.path.clone()))
    }

    pub fn shutdown(&self) {
        if let Ok(mut guard) = self.engine.lock() {
            if let Some(mut engine) = guard.take() {
                engine.shutdown();
            }
        }
        self.publish_stdin(None);
    }
}

/// Locate the packaged engine, shipped as a PyInstaller directory build under
/// `resources/engine/` (not onefile, which re-extracts on every launch).
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

/// Written by `scripts/fetch-engine.mjs` beside the bundled engine. The name
/// is shared with that script; change both or neither.
const ENGINE_VERSION_FILE: &str = "ENGINE_VERSION";

/// The AudioSyncMaster release this build expects to measure with, from
/// package.json via build.rs. Empty when the pin is missing there.
const PINNED_ENGINE_REF: &str = env!("AUDIOSYNC_ENGINE_REF");

/// Whether a version stamp names the pinned release exactly. Must be followed
/// by a space, not just prefix-matched, since a stamp past the tag also starts with it.
fn is_pinned_release(version: &str) -> bool {
    if PINNED_ENGINE_REF.is_empty() {
        return true; // Nothing to compare against; do not cry wolf.
    }
    version
        .strip_prefix("AudioSyncMaster ")
        .and_then(|rest| rest.strip_prefix(PINNED_ENGINE_REF))
        .is_some_and(|rest| rest.starts_with(' '))
}

/// The stamp fetch-engine left beside a bundled sidecar.
fn sidecar_version(sidecar: &std::path::Path) -> Option<String> {
    // Check the sidecar's own directory, then its parent, since PyInstaller
    // may nest the binary one level down.
    let own = sidecar.parent()?;
    [Some(own), own.parent()]
        .into_iter()
        .flatten()
        .find_map(|dir| std::fs::read_to_string(dir.join(ENGINE_VERSION_FILE)).ok())
        .and_then(|text| {
            let line = text.lines().next().unwrap_or("").trim();
            (!line.is_empty()).then(|| line.to_string())
        })
}

/// `git describe` of a development checkout, so a dev build reports which
/// commit it is measuring with.
fn checkout_version(repo_root: &std::path::Path) -> Option<String> {
    let output = hidden_command("git")
        .arg("-C")
        .arg(repo_root)
        .args(["describe", "--tags", "--always", "--dirty"])
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let described = String::from_utf8_lossy(&output.stdout).trim().to_string();
    (!described.is_empty()).then(|| format!("AudioSyncMaster {described} (development checkout)"))
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

/// Point the engine at the ffmpeg pair this app resolved via env vars, rather
/// than letting it repeat PATH/bundled-copy resolution itself.
fn apply_ffmpeg_path(app: &AppHandle, command: &mut Command) {
    let Some(pair) = ffmpeg_pair(app) else {
        return;
    };
    command.env("AUDIOSYNC_FFMPEG", &pair.ffmpeg);
    command.env("AUDIOSYNC_FFPROBE", &pair.ffprobe);
    if let Some(dir) = pair.ffmpeg.parent() {
        let existing = std::env::var_os("PATH").unwrap_or_default();
        let mut entries = vec![dir.to_path_buf()];
        entries.extend(std::env::split_paths(&existing));
        if let Ok(joined) = std::env::join_paths(entries) {
            command.env("PATH", joined);
        }
    }
}

/// Build the command that starts the engine, preferring the bundled sidecar.
/// Returns the command and a human-readable description for the log.
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
    let (located, version) = match find_sidecar(&app) {
        Some(sidecar) => (
            Some(sidecar.to_string_lossy().to_string()),
            sidecar_version(&sidecar),
        ),
        None => match dev_bridge_script() {
            Some(script) => {
                let repo_root = script.parent().and_then(|p| p.parent()).map(PathBuf::from);
                (
                    Some(format!("{} (development)", script.to_string_lossy())),
                    repo_root.as_deref().and_then(checkout_version),
                )
            }
            None => (None, None),
        },
    };

    // These only surface when the install is broken or the dev build is missing.
    // Debug builds get developer wording; installed users get something actionable.
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
        // Measuring still works with an unpinned engine, but results may not
        // match AudioSyncMaster's.
        version
            .as_deref()
            .filter(|found| !is_pinned_release(found))
            .map(|found| {
                format!(
                    "The analysis engine is {found}, not the pinned AudioSyncMaster \
                     {PINNED_ENGINE_REF}. Its delays may differ from AudioSyncMaster's.{}",
                    if cfg!(debug_assertions) {
                        " Run `npm run fetch-engine` against a checkout at that tag."
                    } else {
                        ""
                    }
                )
            })
    };

    EngineStatus {
        engine_available: located.is_some(),
        ffmpeg_available: ffmpeg,
        engine_path: engine.path().or(located),
        engine_version: version,
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

/// Consume the engine's startup `ready` event before it interleaves with a
/// command's response. `handshake_done` tracks this since an empty channel can't tell "done" from "starting".
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

    if let Some(pair) = ffmpeg_pair(&app) {
        let _ = app.emit_all(
            "audiosync-log",
            format!(
                "Decoding with {}{} · {} windows × {} s, max offset {} s",
                pair.ffmpeg.display(),
                if pair.bundled { " (bundled)" } else { "" },
                request.window_count,
                request.window_seconds,
                request.max_offset_ms / 1000.0
            ),
        );
    }

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
            // The engine's own ffmpeg check is authoritative once running;
            // PATH resolution can differ from this app's probe.
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
                        // The engine flattens the result onto the event itself.
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

/// Ask the engine to stop the batch in flight. Sent as a message rather than a
/// kill, so ffmpeg children aren't orphaned; the upstream engine only reads it
/// once the current batch finishes, so the UI reports cancellation as requested rather than done.
#[tauri::command]
pub fn measure_delays_cancel(engine: tauri::State<'_, EngineHandle>) -> Result<(), String> {
    engine.send_now(&serde_json::json!({ "command": "cancel" }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reg_query_output_yields_the_path_value() {
        let out = "\r\nHKEY_CURRENT_USER\\Environment\r\n    Path    REG_EXPAND_SZ    C:\\Tools\\ffmpeg\\bin;%USERPROFILE%\\bin\r\n\r\n";
        assert_eq!(
            parse_reg_query(out).as_deref(),
            Some("C:\\Tools\\ffmpeg\\bin;%USERPROFILE%\\bin")
        );
        assert_eq!(parse_reg_query("ERROR: The system was unable to find the specified registry key or value."), None);
    }

    #[test]
    fn env_references_are_expanded_and_unknown_ones_kept() {
        std::env::set_var("MBM_TEST_DIR", "C:\\X");
        assert_eq!(expand_env("%MBM_TEST_DIR%\\bin;%MBM_NOPE%\\y;plain"), "C:\\X\\bin;%MBM_NOPE%\\y;plain");
    }

    /// The stamp is read from beside the binary in both layouts PyInstaller
    /// produces, and its absence is reported as such rather than invented.
    #[test]
    fn the_stamp_is_found_in_both_sidecar_layouts() {
        let dir = tempfile::tempdir().expect("tempdir");
        let engine = dir.path().join("engine");
        std::fs::create_dir_all(engine.join("audiosync-cli")).unwrap();
        let flat = engine.join("audiosync-cli.exe");
        let nested = engine.join("audiosync-cli").join("audiosync-cli.exe");
        std::fs::write(&flat, b"").unwrap();
        std::fs::write(&nested, b"").unwrap();

        assert_eq!(sidecar_version(&flat), None);
        std::fs::write(
            engine.join(ENGINE_VERSION_FILE),
            "AudioSyncMaster v2.8.0 (8e53e8b)\nsecond line ignored\n",
        )
        .unwrap();
        assert_eq!(
            sidecar_version(&flat).as_deref(),
            Some("AudioSyncMaster v2.8.0 (8e53e8b)")
        );
        assert_eq!(
            sidecar_version(&nested).as_deref(),
            Some("AudioSyncMaster v2.8.0 (8e53e8b)")
        );
    }

    #[test]
    fn a_stamp_at_the_pinned_tag_is_the_release() {
        if PINNED_ENGINE_REF.is_empty() {
            return; // package.json without a pin: nothing to check.
        }
        assert!(is_pinned_release(&format!("AudioSyncMaster {PINNED_ENGINE_REF} (8e53e8b)")));
        assert!(is_pinned_release(&format!(
            "AudioSyncMaster {PINNED_ENGINE_REF} (development checkout)"
        )));
    }

    #[test]
    fn a_stamp_past_the_tag_is_not_the_release() {
        if PINNED_ENGINE_REF.is_empty() {
            return;
        }
        // `git describe` of two commits past the tag: the tag is a prefix but
        // the engine is not the release.
        assert!(!is_pinned_release(&format!(
            "AudioSyncMaster {PINNED_ENGINE_REF}-2-gf38ace9 (development checkout)"
        )));
        assert!(!is_pinned_release(&format!(
            "AudioSyncMaster {PINNED_ENGINE_REF}-dirty (development checkout)"
        )));
        assert!(!is_pinned_release("AudioSyncMaster v0.0.1 (0000000)"));
        assert!(!is_pinned_release("unknown (prebuilt copy from /x; pin is v2.8.0)"));
    }

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
