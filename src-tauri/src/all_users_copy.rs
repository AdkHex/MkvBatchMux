//! The one-time notice about an old all-users copy (Windows). Earlier releases
//! installed MKVBatchMux per machine, into Program Files, for every account on
//! the PC. The installer is now per user, and a per-user installer has no
//! rights to remove a per-machine copy, so the per-user copy says once where
//! the old one is and that an administrator has to uninstall it.

use std::path::{Path, PathBuf};

use serde::Serialize;
use tauri::AppHandle;

/// Written once the user has seen the notice, so it never shows again.
const SEEN_FILE: &str = "all-users-copy-notice.json";

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AllUsersCopy {
    pub path: String,
}

/// The value of `name` in `reg query` output:
/// `    InstallLocation    REG_SZ    "C:\Program Files\MKVBatchMux"`.
#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
fn reg_value(text: &str, name: &str) -> Option<String> {
    text.lines().map(str::trim).find_map(|line| {
        let rest = line.strip_prefix(name)?;
        if !rest.starts_with(char::is_whitespace) {
            return None;
        }
        let (kind, value) = rest.trim_start().split_once(char::is_whitespace)?;
        if !kind.starts_with("REG_") {
            return None;
        }
        let value = value.trim().trim_matches('"').trim();
        (!value.is_empty()).then(|| value.to_string())
    })
}

/// Whether `exe` lives in `dir`, compared the way Windows compares paths.
#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
fn is_inside(exe: &Path, dir: &Path) -> bool {
    let norm = |p: &Path| p.to_string_lossy().replace('/', "\\").trim_end_matches('\\').to_ascii_lowercase();
    let (exe, dir) = (norm(exe), norm(dir));
    !dir.is_empty() && (exe == dir || exe.starts_with(&format!("{dir}\\")))
}

/// The folder of a per-machine copy other than the one running, if any: the
/// uninstall entry the per-machine installer wrote under HKLM, or failing that
/// the default Program Files folder.
#[cfg(target_os = "windows")]
fn find() -> Option<PathBuf> {
    let has_app = |dir: &PathBuf| dir.join("MKVBatchMux.exe").is_file();
    let from_registry = crate::hidden_command("reg")
        .args([
            "query",
            r"HKLM\Software\Microsoft\Windows\CurrentVersion\Uninstall\MKVBatchMux",
            "/v",
            "InstallLocation",
            "/reg:64",
        ])
        .output()
        .ok()
        .and_then(|out| reg_value(&String::from_utf8_lossy(&out.stdout), "InstallLocation"))
        .map(PathBuf::from)
        .filter(has_app);
    let dir = from_registry.or_else(|| {
        ["ProgramW6432", "ProgramFiles"]
            .iter()
            .filter_map(std::env::var_os)
            .map(|p| PathBuf::from(p).join("MKVBatchMux"))
            .find(has_app)
    })?;
    let exe = std::env::current_exe().ok()?;
    (!is_inside(&exe, &dir)).then_some(dir)
}

#[cfg(not(target_os = "windows"))]
fn find() -> Option<PathBuf> {
    None
}

fn seen_file(app: &AppHandle) -> Option<PathBuf> {
    tauri::api::path::app_data_dir(&app.config()).map(|dir| dir.join(SEEN_FILE))
}

/// The old all-users copy to tell the user about, unless they already saw it.
#[tauri::command]
pub fn all_users_copy_notice(app: AppHandle) -> Option<AllUsersCopy> {
    if seen_file(&app)?.exists() {
        return None;
    }
    find().map(|dir| AllUsersCopy { path: dir.to_string_lossy().to_string() })
}

#[tauri::command]
pub fn dismiss_all_users_copy_notice(app: AppHandle) -> Result<(), String> {
    let path = seen_file(&app).ok_or("Failed to resolve app data directory")?;
    std::fs::write(&path, b"{\"seen\":true}\n").map_err(|e| format!("Failed to save {}: {e}", path.display()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_the_install_location_from_reg_output() {
        let out = "\r\nHKEY_LOCAL_MACHINE\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\MKVBatchMux\r\n    InstallLocation    REG_SZ    \"C:\\Program Files\\MKVBatchMux\"\r\n\r\n";
        assert_eq!(reg_value(out, "InstallLocation").as_deref(), Some("C:\\Program Files\\MKVBatchMux"));
        assert_eq!(reg_value("    InstallLocationX    REG_SZ    C:\\x\r\n", "InstallLocation"), None);
        assert_eq!(reg_value("ERROR: The system was unable to find the specified registry key or value.", "InstallLocation"), None);
        assert_eq!(reg_value("    InstallLocation    REG_SZ    \r\n", "InstallLocation"), None);
    }

    #[test]
    fn the_running_copy_is_not_reported() {
        let dir = Path::new("C:\\Program Files\\MKVBatchMux");
        assert!(is_inside(Path::new("C:\\Program Files\\MKVBatchMux\\MKVBatchMux.exe"), dir));
        assert!(is_inside(Path::new("c:\\program files\\mkvbatchmux\\MKVBatchMux.exe"), Path::new("C:\\Program Files\\MKVBatchMux\\")));
        assert!(!is_inside(Path::new("C:\\Users\\dev\\AppData\\Local\\MKVBatchMux\\MKVBatchMux.exe"), dir));
        assert!(!is_inside(Path::new("C:\\Program Files\\MKVBatchMux2\\MKVBatchMux.exe"), dir));
        assert!(!is_inside(Path::new("C:\\x.exe"), Path::new("")));
    }
}
