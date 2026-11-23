//! Watch folders: new episodes landing in a folder, found by polling.
//!
//! Polling rather than OS change notifications, because the folders people
//! watch are often network shares, where notifications are missing or
//! unreliable (SMB drops them, NFS never had them). One plain thread per
//! watched folder lists it every `interval` (10 s by default) and sleeps in
//! between, parked, so an idle watcher costs nothing.
//!
//! Rules:
//! - Files already there when watching starts are the baseline and never
//!   count; only files that appear later do. If the folder can't be read at
//!   the start (a share not mounted yet), the first listing that succeeds
//!   becomes the baseline, so a share coming online doesn't flood the queue
//!   with episodes that were always there.
//! - A file counts once its size (and modified time) is unchanged for
//!   `stable_polls` consecutive polls (two by default) and it is not empty, so a
//!   copy still in progress is not picked up half-written. On Windows a file
//!   another program still holds open for writing doesn't count either,
//!   because Explorer and robocopy can set the final size before the data is in.
//! - A folder that disappears (share offline, drive unplugged) is reported as
//!   `unavailable` and the watcher keeps polling; what it knew is kept, so
//!   nothing is reported twice when the folder comes back.
//! - Each file is reported once. A file deleted and later added again counts
//!   as new.
//!
//! Events: `watch-files { id, paths }` (the files that became ready in one
//! poll) and `watch-status { id, state, error }`, `state` one of `watching`,
//! `paused`, `unavailable`, `stopped`. While paused the watcher keeps
//! tracking files, holds back the ready ones and reports them on resume.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant, SystemTime};
use tauri::{AppHandle, Manager};

pub const DEFAULT_INTERVAL: Duration = Duration::from_secs(10);
/// The shortest interval a watcher accepts from the UI: anything faster only
/// loads the share without finding files sooner in practice.
const MIN_INTERVAL: Duration = Duration::from_millis(500);
pub const DEFAULT_STABLE_POLLS: u32 = 2;

/// Names that are a download or copy still in progress, never a finished
/// file, whatever the extension filter says.
const PARTIAL_SUFFIXES: &[&str] = &[".part", ".partial", ".tmp", ".temp", ".crdownload", ".download", ".!qb", ".!ut", ".filepart"];

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WatchRequest {
    /// Chosen by the frontend; starting an id that is already watching
    /// replaces that watcher.
    pub id: String,
    pub folder: String,
    /// Without the dot, any case ("mkv", "MP4"). Empty: every file.
    #[serde(default)]
    pub extensions: Vec<String>,
    #[serde(default)]
    pub recursive: bool,
    /// Seconds between polls; 10 when absent, never under 0.5.
    #[serde(default)]
    pub interval_seconds: Option<f64>,
    /// Polls in a row a file's size must stay the same; 2 when absent.
    #[serde(default)]
    pub stable_polls: Option<u32>,
    /// Start paused: files are tracked but held until resumed.
    #[serde(default)]
    pub paused: bool,
}

#[derive(Debug, Clone)]
pub struct WatchConfig {
    pub folder: PathBuf,
    /// Lower case, without the dot.
    pub extensions: Vec<String>,
    pub recursive: bool,
    pub interval: Duration,
    pub stable_polls: u32,
}

impl WatchConfig {
    fn from_request(request: &WatchRequest) -> Result<Self, String> {
        if request.folder.trim().is_empty() {
            return Err("Choose a folder to watch.".into());
        }
        let interval = match request.interval_seconds {
            Some(seconds) if seconds.is_finite() && seconds > 0.0 => Duration::from_secs_f64(seconds).max(MIN_INTERVAL),
            _ => DEFAULT_INTERVAL,
        };
        Ok(Self {
            folder: PathBuf::from(request.folder.trim()),
            extensions: normalize_extensions(&request.extensions),
            recursive: request.recursive,
            interval,
            stable_polls: request.stable_polls.unwrap_or(DEFAULT_STABLE_POLLS).max(1),
        })
    }
}

fn normalize_extensions(extensions: &[String]) -> Vec<String> {
    extensions
        .iter()
        .map(|ext| ext.trim().trim_start_matches('.').to_lowercase())
        .filter(|ext| !ext.is_empty() && ext != "all" && ext != "*")
        .collect()
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum WatchState {
    Watching,
    Paused,
    Unavailable,
    Stopped,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum WatchEvent {
    Files(Vec<PathBuf>),
    Status(WatchState, Option<String>),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct Signature {
    size: u64,
    modified: Option<SystemTime>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Entry {
    /// There when watching started.
    Baseline,
    /// New, waiting for its size to settle: the last signature seen and how
    /// many polls in a row it has held.
    Settling { last: Signature, unchanged: u32 },
    Reported,
}

/// One listing of the folder.
struct Listing {
    files: Vec<(PathBuf, Signature)>,
    /// Every directory was read. When not (a subfolder unreadable for a
    /// moment), files missing from the listing are not taken as deleted.
    complete: bool,
}

/// The polling logic without the thread, so it can be stepped in tests.
pub struct Poller {
    config: WatchConfig,
    entries: HashMap<PathBuf, Entry>,
    has_baseline: bool,
}

/// What one poll found.
#[derive(Debug, Default, PartialEq, Eq)]
pub struct PollOutcome {
    /// Files that became ready on this poll, sorted.
    pub ready: Vec<PathBuf>,
    /// The folder could not be listed; why.
    pub unavailable: Option<String>,
}

impl Poller {
    pub fn new(config: WatchConfig) -> Self {
        Self { config, entries: HashMap::new(), has_baseline: false }
    }

    /// Take the baseline now. Returns false when the folder can't be read; the
    /// first successful `poll` then takes it instead.
    pub fn take_baseline(&mut self) -> bool {
        match self.list() {
            Ok(listing) => {
                for (path, _) in listing.files {
                    self.entries.insert(path, Entry::Baseline);
                }
                self.has_baseline = true;
                true
            }
            Err(_) => false,
        }
    }

    pub fn poll(&mut self) -> PollOutcome {
        let listing = match self.list() {
            Ok(listing) => listing,
            Err(error) => return PollOutcome { ready: Vec::new(), unavailable: Some(error) },
        };
        if !self.has_baseline {
            for (path, _) in listing.files {
                self.entries.insert(path, Entry::Baseline);
            }
            self.has_baseline = true;
            return PollOutcome::default();
        }

        let mut seen = std::collections::HashSet::with_capacity(listing.files.len());
        let mut ready = Vec::new();
        for (path, signature) in listing.files {
            seen.insert(path.clone());
            let next = match self.entries.get(&path) {
                None => Entry::Settling { last: signature, unchanged: 0 },
                Some(Entry::Settling { last, unchanged }) => {
                    if *last == signature && signature.size > 0 && !is_held_open(&path) {
                        let unchanged = unchanged + 1;
                        if unchanged >= self.config.stable_polls {
                            ready.push(path.clone());
                            Entry::Reported
                        } else {
                            Entry::Settling { last: signature, unchanged }
                        }
                    } else {
                        Entry::Settling { last: signature, unchanged: 0 }
                    }
                }
                Some(other) => *other,
            };
            self.entries.insert(path, next);
        }
        if listing.complete {
            self.entries.retain(|path, _| seen.contains(path));
        }
        ready.sort();
        PollOutcome { ready, unavailable: None }
    }

    /// How many new files are still settling.
    pub fn settling(&self) -> usize {
        self.entries.values().filter(|entry| matches!(entry, Entry::Settling { .. })).count()
    }

    fn list(&self) -> Result<Listing, String> {
        let root = &self.config.folder;
        // Checked first: walkdir on a missing root yields one error, which
        // would read as an empty but "incomplete" folder.
        match std::fs::metadata(root) {
            Ok(meta) if meta.is_dir() => {}
            Ok(_) => return Err(format!("{} is not a folder", root.display())),
            Err(error) => return Err(format!("Can't open {}: {error}", root.display())),
        }
        let walker = walkdir::WalkDir::new(root).follow_links(false).max_depth(if self.config.recursive { usize::MAX } else { 1 });
        let mut files = Vec::new();
        let mut complete = true;
        for entry in walker {
            let entry = match entry {
                Ok(entry) => entry,
                Err(_) => {
                    complete = false;
                    continue;
                }
            };
            if !entry.file_type().is_file() || !self.wanted(entry.path()) {
                continue;
            }
            match entry.metadata() {
                Ok(meta) => files.push((entry.into_path(), Signature { size: meta.len(), modified: meta.modified().ok() })),
                Err(_) => complete = false,
            }
        }
        Ok(Listing { files, complete })
    }

    fn wanted(&self, path: &Path) -> bool {
        let Some(name) = path.file_name().and_then(|name| name.to_str()) else { return false };
        let lower = name.to_lowercase();
        // Hidden files, Office/Explorer lock files, and partial downloads.
        if lower.starts_with('.') || lower.starts_with("~$") || PARTIAL_SUFFIXES.iter().any(|suffix| lower.ends_with(suffix)) {
            return false;
        }
        // The app's own leftovers: a watcher pointed at the folder it muxes
        // into would otherwise queue its own temp files and failed outputs.
        if is_own_working_file(&lower) {
            return false;
        }
        if self.config.extensions.is_empty() {
            return true;
        }
        let ext = path.extension().and_then(|ext| ext.to_str()).map(str::to_lowercase).unwrap_or_default();
        self.config.extensions.iter().any(|wanted| *wanted == ext)
    }
}

/// Files MKVBatchMux itself writes beside the episodes, never episodes:
/// a failed output kept as `<stem>.unverified.mkv`, the in-place temp output
/// `<stem>#<nanos>-<seq>.mkv` (`build_output_paths` in main.rs), and the
/// source moved aside as `<name>.mkvbatchmux-backup-<nanos>` while it is
/// replaced (`unique_backup_path`). `lower` is the file name in lower case.
fn is_own_working_file(lower: &str) -> bool {
    if lower.ends_with(".unverified.mkv") || lower.contains(".mkvbatchmux-backup-") {
        return true;
    }
    // `#\d+-\d+\.mkv$`
    let Some(rest) = lower.strip_suffix(".mkv") else { return false };
    let Some((_, tail)) = rest.rsplit_once('#') else { return false };
    let Some((nanos, sequence)) = tail.split_once('-') else { return false };
    let digits = |s: &str| !s.is_empty() && s.bytes().all(|b| b.is_ascii_digit());
    digits(nanos) && digits(sequence)
}

/// Whether another program still has the file open for writing. Only Windows
/// can tell cheaply: opening it while allowing others to read but not write
/// fails with a sharing violation while a writer holds it.
#[cfg(windows)]
fn is_held_open(path: &Path) -> bool {
    use std::os::windows::fs::OpenOptionsExt;
    const FILE_SHARE_READ: u32 = 0x1;
    std::fs::OpenOptions::new().read(true).share_mode(FILE_SHARE_READ).open(path).is_err()
}

#[cfg(not(windows))]
fn is_held_open(_path: &Path) -> bool {
    false
}

/// A running watcher thread.
pub struct WatchHandle {
    stop: Arc<AtomicBool>,
    /// Set when another watcher took over this id: from then on this one
    /// sends nothing, so its final `stopped` can't land on the new watcher's
    /// id after the new one reported `watching`. A mutex rather than a flag
    /// so that once `mute` returns, no event of this watcher is mid-send.
    muted: Arc<Mutex<bool>>,
    paused: Arc<AtomicBool>,
    thread: Option<JoinHandle<()>>,
    shared: Arc<Mutex<Shared>>,
    config: WatchConfig,
}

#[derive(Debug, Clone)]
struct Shared {
    state: WatchState,
    error: Option<String>,
    settling: usize,
    reported: usize,
    held: usize,
}

impl WatchHandle {
    /// Start watching. `sink` receives every event, from the watcher's thread.
    pub fn spawn(config: WatchConfig, paused: bool, sink: impl Fn(WatchEvent) + Send + 'static) -> Self {
        let stop = Arc::new(AtomicBool::new(false));
        let muted = Arc::new(Mutex::new(false));
        let paused_flag = Arc::new(AtomicBool::new(paused));
        let shared = Arc::new(Mutex::new(Shared { state: WatchState::Watching, error: None, settling: 0, reported: 0, held: 0 }));
        let thread = {
            let (stop, paused_flag, shared, config) = (stop.clone(), paused_flag.clone(), shared.clone(), config.clone());
            let muted = muted.clone();
            let sink = move |event: WatchEvent| {
                let muted = muted.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
                if !*muted {
                    sink(event);
                }
            };
            thread::Builder::new()
                .name("watch-folder".into())
                .spawn(move || run(config, stop, paused_flag, shared, sink))
                .ok()
        };
        Self { stop, muted, paused: paused_flag, thread, shared, config }
    }

    /// Stop without sending anything more, not even `stopped`: for a watcher
    /// replaced by a new one under the same id.
    fn mute_and_stop(&self) {
        *self.muted.lock().unwrap_or_else(|poisoned| poisoned.into_inner()) = true;
        self.signal_stop();
    }

    pub fn set_paused(&self, paused: bool) {
        self.paused.store(paused, Ordering::SeqCst);
        // Wake it so the change shows (and held files go out) now, not a poll later.
        if let Some(thread) = &self.thread {
            thread.thread().unpark();
        }
    }

    /// Ask the thread to stop without waiting for it: a poll stuck on a dead
    /// network share can take minutes to time out, and the UI must not hang on it.
    pub fn signal_stop(&self) {
        self.stop.store(true, Ordering::SeqCst);
        if let Some(thread) = &self.thread {
            thread.thread().unpark();
        }
    }

    /// Stop and wait for the thread to finish.
    #[cfg(test)]
    pub fn stop_and_join(mut self) {
        self.signal_stop();
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
    }

    fn info(&self, id: &str) -> WatchInfo {
        let shared = self.shared.lock().map(|s| s.clone()).unwrap_or_else(|p| p.into_inner().clone());
        WatchInfo {
            id: id.to_string(),
            folder: self.config.folder.to_string_lossy().into_owned(),
            extensions: self.config.extensions.clone(),
            recursive: self.config.recursive,
            interval_seconds: self.config.interval.as_secs_f64(),
            stable_polls: self.config.stable_polls,
            state: shared.state,
            error: shared.error,
            paused: self.paused.load(Ordering::SeqCst),
            settling: shared.settling,
            reported: shared.reported,
            held: shared.held,
        }
    }
}

fn run(config: WatchConfig, stop: Arc<AtomicBool>, paused: Arc<AtomicBool>, shared: Arc<Mutex<Shared>>, sink: impl Fn(WatchEvent)) {
    let interval = config.interval;
    let mut poller = Poller::new(config);
    let mut last_status: Option<(WatchState, Option<String>)> = None;
    let mut held: Vec<PathBuf> = Vec::new();
    let mut reported = 0usize;

    let mut publish = |state: WatchState, error: Option<String>, settling: usize, reported: usize, held: usize| {
        if let Ok(mut shared) = shared.lock() {
            *shared = Shared { state, error: error.clone(), settling, reported, held };
        }
        let status = (state, error);
        if last_status.as_ref() != Some(&status) {
            sink(WatchEvent::Status(status.0, status.1.clone()));
            last_status = Some(status);
        }
    };

    let mut first = true;
    let mut unavailable: Option<String> = None;
    while !stop.load(Ordering::SeqCst) {
        if first {
            first = false;
            if !poller.take_baseline() {
                // Poll once to learn why; the baseline is then taken by the first poll that succeeds.
                unavailable = poller.poll().unavailable;
            }
        } else {
            let outcome = poller.poll();
            unavailable = outcome.unavailable;
            held.extend(outcome.ready);
        }
        if stop.load(Ordering::SeqCst) {
            break;
        }
        let is_paused = paused.load(Ordering::SeqCst);
        if !is_paused && !held.is_empty() {
            held.sort();
            held.dedup();
            reported += held.len();
            sink(WatchEvent::Files(std::mem::take(&mut held)));
        }
        let state = match (&unavailable, is_paused) {
            (Some(_), _) => WatchState::Unavailable,
            (None, true) => WatchState::Paused,
            (None, false) => WatchState::Watching,
        };
        publish(state, unavailable.clone(), poller.settling(), reported, held.len());

        // Sleep until the next poll. A stop ends the wait; a pause change is
        // acted on at once (resuming sends what was held) and the wait goes on,
        // so the poll schedule stays the same.
        let deadline = Instant::now() + interval;
        let mut was_paused = is_paused;
        while !stop.load(Ordering::SeqCst) {
            let now_paused = paused.load(Ordering::SeqCst);
            if now_paused != was_paused {
                was_paused = now_paused;
                if !now_paused && !held.is_empty() {
                    held.sort();
                    held.dedup();
                    reported += held.len();
                    sink(WatchEvent::Files(std::mem::take(&mut held)));
                }
                let state = if unavailable.is_some() {
                    WatchState::Unavailable
                } else if now_paused {
                    WatchState::Paused
                } else {
                    WatchState::Watching
                };
                publish(state, unavailable.clone(), poller.settling(), reported, held.len());
            }
            let now = Instant::now();
            if now >= deadline {
                break;
            }
            thread::park_timeout(deadline - now);
        }
    }
    publish(WatchState::Stopped, None, 0, reported, 0);
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WatchInfo {
    pub id: String,
    pub folder: String,
    pub extensions: Vec<String>,
    pub recursive: bool,
    pub interval_seconds: f64,
    pub stable_polls: u32,
    pub state: WatchState,
    pub error: Option<String>,
    pub paused: bool,
    /// New files whose size is still changing.
    pub settling: usize,
    /// Files reported since watching started.
    pub reported: usize,
    /// Ready files held back while paused.
    pub held: usize,
}

#[derive(Debug, Clone, Serialize)]
struct FilesPayload {
    id: String,
    paths: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
struct StatusPayload {
    id: String,
    state: WatchState,
    error: Option<String>,
}

fn registry() -> &'static Mutex<HashMap<String, WatchHandle>> {
    static REGISTRY: OnceLock<Mutex<HashMap<String, WatchHandle>>> = OnceLock::new();
    REGISTRY.get_or_init(|| Mutex::new(HashMap::new()))
}

fn registry_lock() -> std::sync::MutexGuard<'static, HashMap<String, WatchHandle>> {
    registry().lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// Start watching a folder. Replaces a watcher with the same id.
#[tauri::command]
pub fn watch_start(app: AppHandle, request: WatchRequest) -> Result<WatchInfo, String> {
    let config = WatchConfig::from_request(&request)?;
    let id = request.id.clone();
    let sink = {
        let (app, id) = (app.clone(), id.clone());
        move |event: WatchEvent| match event {
            WatchEvent::Files(paths) => {
                let paths = paths.into_iter().map(|p| p.to_string_lossy().into_owned()).collect();
                let _ = app.emit_all("watch-files", FilesPayload { id: id.clone(), paths });
            }
            WatchEvent::Status(state, error) => {
                let _ = app.emit_all("watch-status", StatusPayload { id: id.clone(), state, error });
            }
        }
    };
    let mut registry = registry_lock();
    let handle = start_in(&mut registry, id.clone(), || WatchHandle::spawn(config, request.paused, sink));
    Ok(handle.info(&id))
}

/// Put a new watcher under `id`, silencing and stopping the one it replaces
/// first, so every event under `id` from here on is the new watcher's.
fn start_in(registry: &mut HashMap<String, WatchHandle>, id: String, spawn: impl FnOnce() -> WatchHandle) -> &WatchHandle {
    if let Some(previous) = registry.remove(&id) {
        previous.mute_and_stop();
    }
    registry.entry(id).or_insert_with(spawn)
}

/// Stop a watcher. False when there was none with this id.
#[tauri::command]
pub fn watch_stop(id: String) -> bool {
    match registry_lock().remove(&id) {
        Some(handle) => {
            handle.signal_stop();
            true
        }
        None => false,
    }
}

/// Pause or resume a watcher. False when there was none with this id.
#[tauri::command]
pub fn watch_set_paused(id: String, paused: bool) -> bool {
    match registry_lock().get(&id) {
        Some(handle) => {
            handle.set_paused(paused);
            true
        }
        None => false,
    }
}

/// Every running watcher, by id.
#[tauri::command]
pub fn watch_list() -> Vec<WatchInfo> {
    let registry = registry_lock();
    let mut list: Vec<WatchInfo> = registry.iter().map(|(id, handle)| handle.info(id)).collect();
    list.sort_by(|a, b| a.id.cmp(&b.id));
    list
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::io::Write;
    use std::sync::mpsc;

    fn config(dir: &Path, extensions: &[&str], recursive: bool) -> WatchConfig {
        WatchConfig {
            folder: dir.to_path_buf(),
            extensions: normalize_extensions(&extensions.iter().map(|s| s.to_string()).collect::<Vec<_>>()),
            recursive,
            interval: Duration::from_millis(40),
            stable_polls: 2,
        }
    }

    fn write(path: &Path, bytes: usize) {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).unwrap();
        }
        fs::write(path, vec![7u8; bytes]).unwrap();
    }

    fn append(path: &Path, bytes: usize) {
        let mut file = fs::OpenOptions::new().append(true).open(path).unwrap();
        file.write_all(&vec![1u8; bytes]).unwrap();
    }

    #[test]
    fn a_new_file_is_reported_once_after_two_unchanged_polls() {
        let dir = tempfile::tempdir().unwrap();
        let mut poller = Poller::new(config(dir.path(), &["mkv"], false));
        assert!(poller.take_baseline());
        let episode = dir.path().join("Show.S01E04.mkv");
        write(&episode, 1000);
        assert_eq!(poller.poll().ready, Vec::<PathBuf>::new(), "first sight");
        assert_eq!(poller.poll().ready, Vec::<PathBuf>::new(), "unchanged once");
        assert_eq!(poller.poll().ready, vec![episode.clone()], "unchanged twice");
        assert!(poller.poll().ready.is_empty(), "never twice");
        assert!(poller.poll().ready.is_empty());
    }

    #[test]
    fn a_growing_file_waits_until_it_stops_growing() {
        let dir = tempfile::tempdir().unwrap();
        let mut poller = Poller::new(config(dir.path(), &[], false));
        assert!(poller.take_baseline());
        let episode = dir.path().join("Show.S01E05.mkv");
        write(&episode, 10);
        assert!(poller.poll().ready.is_empty());
        for _ in 0..5 {
            append(&episode, 10);
            assert!(poller.poll().ready.is_empty(), "still growing");
        }
        assert!(poller.poll().ready.is_empty());
        assert_eq!(poller.poll().ready, vec![episode]);
    }

    #[test]
    fn files_there_at_the_start_are_ignored() {
        let dir = tempfile::tempdir().unwrap();
        write(&dir.path().join("Show.S01E01.mkv"), 100);
        write(&dir.path().join("Season 1").join("Show.S01E02.mkv"), 100);
        let mut poller = Poller::new(config(dir.path(), &["mkv"], true));
        assert!(poller.take_baseline());
        for _ in 0..4 {
            assert!(poller.poll().ready.is_empty());
        }
        // Touching an old file doesn't make it new.
        append(&dir.path().join("Show.S01E01.mkv"), 5);
        for _ in 0..4 {
            assert!(poller.poll().ready.is_empty());
        }
    }

    #[test]
    fn filters_by_extension_skips_partials_and_empty_files_and_honours_recursion() {
        let dir = tempfile::tempdir().unwrap();
        let mut flat = Poller::new(config(dir.path(), &[".MKV", "mp4"], false));
        let mut deep = Poller::new(config(dir.path(), &["mkv"], true));
        assert!(flat.take_baseline() && deep.take_baseline());
        write(&dir.path().join("a.MKV"), 10);
        write(&dir.path().join("b.mp4"), 10);
        write(&dir.path().join("c.srt"), 10);
        write(&dir.path().join("d.mkv.part"), 10);
        write(&dir.path().join("e.mkv"), 0);
        write(&dir.path().join("sub").join("f.mkv"), 10);
        let mut flat_ready = Vec::new();
        let mut deep_ready = Vec::new();
        for _ in 0..4 {
            flat_ready.extend(flat.poll().ready);
            deep_ready.extend(deep.poll().ready);
        }
        assert_eq!(flat_ready, vec![dir.path().join("a.MKV"), dir.path().join("b.mp4")]);
        assert_eq!(deep_ready, vec![dir.path().join("a.MKV"), dir.path().join("sub").join("f.mkv")]);
    }

    #[test]
    fn survives_the_folder_disappearing_and_coming_back() {
        let parent = tempfile::tempdir().unwrap();
        let dir = parent.path().join("share");
        write(&dir.join("old.mkv"), 10);
        let mut poller = Poller::new(config(&dir, &["mkv"], false));
        assert!(poller.take_baseline());
        let moved = parent.path().join("offline");
        fs::rename(&dir, &moved).unwrap();
        let outcome = poller.poll();
        assert!(outcome.unavailable.is_some());
        assert!(outcome.ready.is_empty());
        fs::rename(&moved, &dir).unwrap();
        write(&dir.join("new.mkv"), 10);
        let mut ready = Vec::new();
        for _ in 0..3 {
            let outcome = poller.poll();
            assert!(outcome.unavailable.is_none());
            ready.extend(outcome.ready);
        }
        assert_eq!(ready, vec![dir.join("new.mkv")], "the old file is still known");
    }

    #[test]
    fn a_folder_missing_at_the_start_takes_its_baseline_when_it_appears() {
        let parent = tempfile::tempdir().unwrap();
        let dir = parent.path().join("later");
        let mut poller = Poller::new(config(&dir, &[], false));
        assert!(!poller.take_baseline());
        assert!(poller.poll().unavailable.is_some());
        write(&dir.join("was-there.mkv"), 10);
        assert!(poller.poll().ready.is_empty(), "first good listing is the baseline");
        write(&dir.join("new.mkv"), 10);
        let mut ready = Vec::new();
        for _ in 0..3 {
            ready.extend(poller.poll().ready);
        }
        assert_eq!(ready, vec![dir.join("new.mkv")]);
    }

    #[test]
    fn a_file_deleted_and_added_again_counts_again() {
        let dir = tempfile::tempdir().unwrap();
        let mut poller = Poller::new(config(dir.path(), &[], false));
        assert!(poller.take_baseline());
        let file = dir.path().join("x.mkv");
        write(&file, 10);
        let mut count = 0;
        for _ in 0..3 {
            count += poller.poll().ready.len();
        }
        fs::remove_file(&file).unwrap();
        poller.poll();
        write(&file, 20);
        for _ in 0..3 {
            count += poller.poll().ready.len();
        }
        assert_eq!(count, 2);
    }

    fn collect_until(rx: &mpsc::Receiver<WatchEvent>, timeout: Duration, mut done: impl FnMut(&[WatchEvent]) -> bool) -> Vec<WatchEvent> {
        let deadline = Instant::now() + timeout;
        let mut events = Vec::new();
        while Instant::now() < deadline {
            if let Ok(event) = rx.recv_timeout(Duration::from_millis(20)) {
                events.push(event);
                if done(&events) {
                    break;
                }
            }
        }
        events
    }

    fn files_in(events: &[WatchEvent]) -> Vec<PathBuf> {
        events.iter().filter_map(|e| if let WatchEvent::Files(f) = e { Some(f.clone()) } else { None }).flatten().collect()
    }

    #[test]
    fn the_thread_reports_new_files_once_and_stops_cleanly() {
        let dir = tempfile::tempdir().unwrap();
        write(&dir.path().join("old.mkv"), 10);
        let (tx, rx) = mpsc::channel();
        let tx = Mutex::new(tx);
        let handle = WatchHandle::spawn(config(dir.path(), &["mkv"], false), false, move |event| {
            let _ = tx.lock().unwrap().send(event);
        });
        let started = collect_until(&rx, Duration::from_secs(2), |e| e.contains(&WatchEvent::Status(WatchState::Watching, None)));
        assert!(started.contains(&WatchEvent::Status(WatchState::Watching, None)));

        // Grows for a while, then settles.
        let episode = dir.path().join("Show.S01E06.mkv");
        write(&episode, 10);
        for _ in 0..4 {
            thread::sleep(Duration::from_millis(30));
            append(&episode, 10);
        }
        let events = collect_until(&rx, Duration::from_secs(3), |e| !files_in(e).is_empty());
        assert_eq!(files_in(&events), vec![episode.clone()]);
        // Nothing more for the same file.
        let later = collect_until(&rx, Duration::from_millis(300), |_| false);
        assert!(files_in(&later).is_empty());

        let started_stop = Instant::now();
        handle.stop_and_join();
        assert!(started_stop.elapsed() < Duration::from_secs(1), "stop wakes the sleeping thread");
        let tail: Vec<WatchEvent> = rx.try_iter().collect();
        assert_eq!(tail.last(), Some(&WatchEvent::Status(WatchState::Stopped, None)));
    }

    #[test]
    fn paused_watchers_hold_files_until_resumed() {
        let dir = tempfile::tempdir().unwrap();
        let (tx, rx) = mpsc::channel();
        let tx = Mutex::new(tx);
        let handle = WatchHandle::spawn(config(dir.path(), &[], false), true, move |event| {
            let _ = tx.lock().unwrap().send(event);
        });
        collect_until(&rx, Duration::from_secs(2), |e| e.contains(&WatchEvent::Status(WatchState::Paused, None)));
        write(&dir.path().join("held.mkv"), 10);
        let while_paused = collect_until(&rx, Duration::from_millis(400), |_| false);
        assert!(files_in(&while_paused).is_empty());
        handle.set_paused(false);
        let resumed = collect_until(&rx, Duration::from_secs(2), |e| !files_in(e).is_empty());
        assert_eq!(files_in(&resumed), vec![dir.path().join("held.mkv")]);
        handle.stop_and_join();
    }

    #[test]
    fn the_apps_own_temp_backup_and_unverified_files_are_never_picked_up() {
        let dir = tempfile::tempdir().unwrap();
        let mut poller = Poller::new(config(dir.path(), &["mkv"], false));
        assert!(poller.take_baseline());
        for name in [
            "Show.S01E01#1732361234567890123-0.mkv",
            "Show.S01E01#1-12.MKV",
            "Show.S01E01.unverified.mkv",
            "Show.S01E01.UNVERIFIED.MKV",
            "Show.S01E01.mkv.mkvbatchmux-backup-1732361234567890123",
            "Show.S01E02.mkvbatchmux-backup-17.mkv",
            "Episode.mkv",
            "Episode #3.mkv",
            "Episode #3-x.mkv",
        ] {
            write(&dir.path().join(name), 10);
        }
        let mut ready = Vec::new();
        for _ in 0..4 {
            ready.extend(poller.poll().ready);
        }
        ready.sort();
        assert_eq!(ready, vec![dir.path().join("Episode #3-x.mkv"), dir.path().join("Episode #3.mkv"), dir.path().join("Episode.mkv")]);
    }

    #[test]
    fn a_replaced_watcher_sends_nothing_more_under_its_id() {
        let first = tempfile::tempdir().unwrap();
        let second = tempfile::tempdir().unwrap();
        let (tx, rx) = mpsc::channel::<(u32, WatchEvent)>();
        let spawn = |dir: &Path, generation: u32| {
            let tx = Mutex::new(tx.clone());
            let dir = dir.to_path_buf();
            move || {
                WatchHandle::spawn(config(&dir, &[], false), false, move |event| {
                    let _ = tx.lock().unwrap().send((generation, event));
                })
            }
        };
        let mut registry = HashMap::new();
        start_in(&mut registry, "show".into(), spawn(first.path(), 1));
        let deadline = Instant::now() + Duration::from_secs(2);
        while Instant::now() < deadline {
            if let Ok((1, WatchEvent::Status(WatchState::Watching, _))) = rx.recv_timeout(Duration::from_millis(20)) {
                break;
            }
        }
        start_in(&mut registry, "show".into(), spawn(second.path(), 2));
        // Give the first watcher's thread time to wind down and (before the
        // fix) send its `stopped`.
        thread::sleep(Duration::from_millis(300));
        let events: Vec<(u32, WatchEvent)> = rx.try_iter().collect();
        assert!(events.iter().all(|(generation, _)| *generation == 2), "the replaced watcher stayed silent: {events:?}");
        assert!(events.contains(&(2, WatchEvent::Status(WatchState::Watching, None))));
        registry.remove("show").unwrap().stop_and_join();
    }

    #[test]
    fn requests_are_checked_and_defaulted() {
        let request = WatchRequest { id: "a".into(), folder: "  ".into(), extensions: vec![], recursive: false, interval_seconds: None, stable_polls: None, paused: false };
        assert!(WatchConfig::from_request(&request).is_err());
        let request = WatchRequest { folder: "X".into(), interval_seconds: Some(0.01), extensions: vec![".Mkv".into(), "all".into()], ..request };
        let config = WatchConfig::from_request(&request).unwrap();
        assert_eq!(config.interval, MIN_INTERVAL);
        assert_eq!(config.stable_polls, 2);
        assert_eq!(config.extensions, vec!["mkv".to_string()]);
        let request = WatchRequest { interval_seconds: None, ..request };
        assert_eq!(WatchConfig::from_request(&request).unwrap().interval, DEFAULT_INTERVAL);
    }
}
