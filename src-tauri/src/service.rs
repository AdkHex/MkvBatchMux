//! Remote status and access password, app side: which URL this build polls,
//! the poll thread, what a lock stops and an unlock resumes, and the commands
//! the lock screen uses. The logic (document, stickiness, password check) lives
//! in src/remote_status.rs. See docs/REMOTE-STATUS.md.
//!
//! `src-tauri/remote-status.json` is read at compile time: `url` (empty = the
//! switch is off in this build) and `requireAccess`. Debug builds also read
//! MKVBATCHMUX_STATUS_URL (http:// allowed for 127.0.0.1 / localhost) and
//! MKVBATCHMUX_STATUS_POLL_SECS (poll interval) for testing; release builds
//! ignore both, so an installed copy cannot be pointed elsewhere.

use std::path::Path;
use std::sync::Arc;
use std::time::Duration;

use tauri::{AppHandle, Manager, State};

use crate::remote_status::{validate_url, Change, Config, KeyringStore, Service, ServiceLock};

const BAKED: &str = include_str!("../remote-status.json");
/// Sent to every window with the new `ServiceLock` whenever it changes.
pub const EVENT: &str = "service-lock-changed";

fn baked() -> serde_json::Value {
    serde_json::from_str(BAKED).unwrap_or_default()
}

/// The status URL this build polls, if the switch is on.
fn status_url() -> Option<String> {
    if cfg!(debug_assertions) {
        if let Some(u) = std::env::var("MKVBATCHMUX_STATUS_URL").ok().filter(|u| !u.trim().is_empty()) {
            return validate_url(&u, true)
                .map_err(|e| eprintln!("MKVBATCHMUX_STATUS_URL ignored: {e}"))
                .ok();
        }
    }
    let baked = baked();
    let u = baked.get("url")?.as_str()?.trim();
    if u.is_empty() {
        return None;
    }
    validate_url(u, false).map_err(|e| eprintln!("remote-status.json: {e}")).ok()
}

fn poll_override() -> Option<Duration> {
    if !cfg!(debug_assertions) {
        return None;
    }
    std::env::var("MKVBATCHMUX_STATUS_POLL_SECS")
        .ok()
        .and_then(|s| s.parse::<u64>().ok())
        .filter(|s| *s > 0)
        .map(Duration::from_secs)
}

/// Restore the saved state and decide the lock, before anything can start.
pub fn create(app: &AppHandle, app_data_dir: &Path) -> Arc<Service> {
    let url = status_url();
    if url.is_none() {
        eprintln!("remote status: no status URL in this build; switch off");
    }
    let identifier = app.config().tauri.bundle.identifier.clone();
    let config = Config {
        url,
        require_access: baked().get("requireAccess").and_then(|v| v.as_bool()).unwrap_or(false),
        app_version: app.package_info().version.to_string(),
        state_file: app_data_dir.join("remote-status.json"),
        poll_every: poll_override(),
    };
    Arc::new(Service::new(config, Box::new(KeyringStore::new(&identifier))))
}

/// Poll in the background: first check right away, never delaying the window.
pub fn start(app: &AppHandle, service: Arc<Service>) {
    if !service.enabled() {
        return;
    }
    let app = app.clone();
    std::thread::spawn(move || loop {
        let change = service.check_now();
        apply(&app, &service, change);
        std::thread::sleep(service.interval());
    });
}

/// Act on a change: stop or resume work, and tell every window. The poll thread
/// and "Check again" can finish in either order, so the effects follow the lock
/// as it is now, not as the change found it.
fn apply(app: &AppHandle, service: &Service, change: Change) {
    match change {
        Change::Unchanged => return,
        Change::Locked if service.is_locked() => {
            // Mux workers see the flag on their own (they check it between
            // jobs and while mkvmerge runs); the analysis engine is stopped here.
            app.state::<crate::audiosync::EngineHandle>().interrupt();
            if let Some(window) = app.get_window("main") {
                let _ = window.unminimize();
                let _ = window.show();
                let _ = window.set_focus();
            }
        }
        Change::Unlocked if !service.is_locked() => crate::audiosync::resume_paused(app),
        _ => {}
    }
    let _ = app.emit_all(EVENT, service.lock_state());
}

#[tauri::command]
pub fn service_lock(service: State<'_, Arc<Service>>) -> ServiceLock {
    service.lock_state()
}

/// "Check again" on the lock screen: fetch now and return the result.
#[tauri::command]
pub async fn check_service_status(app: AppHandle, service: State<'_, Arc<Service>>) -> Result<ServiceLock, String> {
    let service = service.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let change = service.check_now();
        apply(&app, &service, change);
        service.lock_state()
    })
    .await
    .map_err(|e| e.to_string())
}

/// The password screen's Unlock. The password is checked in Rust and never
/// stored or logged; on a match only the hash's id is remembered.
#[tauri::command]
pub async fn unlock_access(
    app: AppHandle,
    service: State<'_, Arc<Service>>,
    password: String,
) -> Result<ServiceLock, String> {
    let service = service.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let change = service.unlock(&password)?;
        apply(&app, &service, change);
        Ok(service.lock_state())
    })
    .await
    .map_err(|e| e.to_string())?
}
