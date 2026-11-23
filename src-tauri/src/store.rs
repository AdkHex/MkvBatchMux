//! Saved workspace data: recipes, the autosaved session and anything else the
//! frontend keeps as JSON in the app's data folder, plus session files the
//! user saves anywhere (`.mbmux`).
//!
//! JSON in, JSON out: the shape is the frontend's business (versioned and
//! migrated in `src/features/workspace/lib/session.ts` and `recipes.ts`). This
//! module only makes sure a write can't leave a half-written file behind (a
//! temporary file in the same folder, flushed, then renamed over the old one,
//! so a crash or power cut leaves either the old file or the new one) and
//! that a damaged or foreign file comes back as an error the UI can show,
//! never a panic.

use serde::Serialize;
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::time::Duration;
use tauri::AppHandle;

/// Larger than any real session (thousands of episodes with every track is a
/// few megabytes); refusing more keeps a wrong file from being read whole.
pub const MAX_FILE_BYTES: u64 = 64 * 1024 * 1024;

/// A key names a file in the app data folder: `recipes` is `recipes.json`.
/// Only letters, digits, `-` and `_`, so a key can't reach outside it.
fn file_for_key(dir: &Path, key: &str) -> Result<PathBuf, String> {
    let valid = !key.is_empty() && key.len() <= 64 && key.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_');
    if !valid {
        return Err(format!("\"{key}\" is not a valid store name."));
    }
    Ok(dir.join(format!("{key}.json")))
}

fn app_data_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = tauri::api::path::app_data_dir(&app.config()).ok_or("Couldn't find the app's data folder.")?;
    fs::create_dir_all(&dir).map_err(|e| format!("Couldn't create {}: {e}", dir.display()))?;
    Ok(dir)
}

/// Write `bytes` to `path` so it is either fully the old content or fully the
/// new: a temporary file beside it, flushed to disk, then renamed over it.
pub fn write_atomic(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let dir = match path.parent() {
        Some(dir) if !dir.as_os_str().is_empty() => dir,
        _ => Path::new("."),
    };
    if !dir.is_dir() {
        return Err(format!("The folder {} doesn't exist.", dir.display()));
    }
    let mut temp = tempfile::Builder::new()
        .prefix(".mbmux-")
        .suffix(".tmp")
        .tempfile_in(dir)
        .map_err(|e| format!("Couldn't write to {}: {e}", dir.display()))?;
    temp.write_all(bytes).map_err(|e| format!("Couldn't write {}: {e}", path.display()))?;
    temp.as_file().sync_all().map_err(|e| format!("Couldn't write {}: {e}", path.display()))?;
    // On Windows the rename fails while another program (a virus scanner, a
    // backup or sync client) has the old file open for a moment; retry briefly.
    let mut temp = temp;
    let mut attempts = 0;
    loop {
        match temp.persist(path) {
            Ok(_) => return Ok(()),
            Err(error) if attempts < 5 => {
                attempts += 1;
                temp = error.file;
                std::thread::sleep(Duration::from_millis(50 * attempts));
            }
            Err(error) => return Err(format!("Couldn't save {}: {}", path.display(), error.error)),
        }
    }
}

/// Read and parse a JSON file. `Ok(None)` when it doesn't exist.
pub fn read_json(path: &Path) -> Result<Option<serde_json::Value>, String> {
    let meta = match fs::metadata(path) {
        Ok(meta) => meta,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(format!("Couldn't open {}: {error}", path.display())),
    };
    if !meta.is_file() {
        return Err(format!("{} is not a file.", path.display()));
    }
    if meta.len() > MAX_FILE_BYTES {
        return Err(format!("{} is too large to be a saved session ({} MB).", path.display(), meta.len() / (1024 * 1024)));
    }
    let bytes = fs::read(path).map_err(|e| format!("Couldn't read {}: {e}", path.display()))?;
    // A BOM from an editor on Windows is not part of the JSON.
    let text = bytes.strip_prefix(b"\xEF\xBB\xBF").unwrap_or(&bytes);
    serde_json::from_slice(text)
        .map(Some)
        .map_err(|e| format!("{} is damaged or not a MKVBatchMux file ({e}).", path.display()))
}

fn to_bytes(value: &serde_json::Value, pretty: bool) -> Result<Vec<u8>, String> {
    let bytes = if pretty { serde_json::to_vec_pretty(value) } else { serde_json::to_vec(value) }.map_err(|e| format!("Couldn't save: {e}"))?;
    if bytes.len() as u64 > MAX_FILE_BYTES {
        return Err("This is too large to save.".into());
    }
    Ok(bytes)
}

/// Read `<key>.json` from the app data folder; null when it doesn't exist.
#[tauri::command]
pub fn store_read(app: AppHandle, key: String) -> Result<Option<serde_json::Value>, String> {
    read_json(&file_for_key(&app_data_dir(&app)?, &key)?)
}

/// Write `<key>.json` in the app data folder, atomically.
#[tauri::command]
pub fn store_write(app: AppHandle, key: String, value: serde_json::Value) -> Result<(), String> {
    let path = file_for_key(&app_data_dir(&app)?, &key)?;
    write_atomic(&path, &to_bytes(&value, false)?)
}

/// Delete `<key>.json` from the app data folder. Missing is fine.
#[tauri::command]
pub fn store_delete(app: AppHandle, key: String) -> Result<(), String> {
    let path = file_for_key(&app_data_dir(&app)?, &key)?;
    match fs::remove_file(&path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(format!("Couldn't delete {}: {error}", path.display())),
    }
}

/// Save a session file where the user chose, atomically, readable JSON.
#[tauri::command]
pub fn session_save(path: String, value: serde_json::Value) -> Result<(), String> {
    if path.trim().is_empty() {
        return Err("Choose where to save the session.".into());
    }
    write_atomic(Path::new(&path), &to_bytes(&value, true)?)
}

/// Open a session file the user chose.
#[tauri::command]
pub fn session_open(path: String) -> Result<serde_json::Value, String> {
    read_json(Path::new(&path))?.ok_or_else(|| format!("{path} doesn't exist."))
}

/// Whether each path exists, in order. Checked in parallel: on a network
/// share each check can take a round trip.
#[tauri::command]
pub fn paths_exist(paths: Vec<String>) -> Vec<bool> {
    use rayon::prelude::*;
    paths.par_iter().map(|path| !path.trim().is_empty() && Path::new(path).exists()).collect()
}

/// Where the app keeps these files, for the UI to show.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StoreLocation {
    pub dir: String,
}

#[tauri::command]
pub fn store_location(app: AppHandle) -> Result<StoreLocation, String> {
    Ok(StoreLocation { dir: app_data_dir(&app)?.to_string_lossy().into_owned() })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn writes_replace_the_file_whole_and_leave_no_temporary_behind() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("recipes.json");
        write_atomic(&path, br#"{"version":1,"recipes":[]}"#).unwrap();
        write_atomic(&path, br#"{"version":1,"recipes":[{"name":"Hindi"}]}"#).unwrap();
        assert_eq!(read_json(&path).unwrap(), Some(json!({"version":1,"recipes":[{"name":"Hindi"}]})));
        let names: Vec<String> = fs::read_dir(dir.path()).unwrap().map(|e| e.unwrap().file_name().to_string_lossy().into_owned()).collect();
        assert_eq!(names, vec!["recipes.json".to_string()]);
    }

    #[test]
    fn a_failed_write_keeps_the_old_file() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("session.json");
        write_atomic(&path, b"{\"a\":1}").unwrap();
        // A folder where the file should be makes the rename fail.
        let blocked = dir.path().join("blocked");
        fs::create_dir(&blocked).unwrap();
        fs::write(blocked.join("x"), b"x").unwrap();
        assert!(write_atomic(&blocked, b"{}").is_err());
        assert_eq!(read_json(&path).unwrap(), Some(json!({"a":1})));
        assert!(write_atomic(&dir.path().join("missing").join("f.json"), b"{}").is_err());
    }

    #[test]
    fn bad_json_is_an_error_not_a_panic() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("broken.json");
        fs::write(&path, b"{\"version\": 1, \"recipes\": [").unwrap();
        let error = read_json(&path).unwrap_err();
        assert!(error.contains("damaged"), "{error}");
        fs::write(&path, [0xff, 0xfe, 0x00]).unwrap();
        assert!(read_json(&path).is_err());
        assert_eq!(read_json(&dir.path().join("none.json")).unwrap(), None);
        assert!(read_json(dir.path()).is_err(), "a folder is not a file");
    }

    #[test]
    fn a_bom_is_tolerated() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("bom.json");
        fs::write(&path, b"\xEF\xBB\xBF{\"ok\":true}").unwrap();
        assert_eq!(read_json(&path).unwrap(), Some(json!({"ok": true})));
    }

    #[test]
    fn keys_cannot_leave_the_folder() {
        let dir = Path::new("data");
        assert_eq!(file_for_key(dir, "recipes").unwrap(), dir.join("recipes.json"));
        assert_eq!(file_for_key(dir, "last-session_2").unwrap(), dir.join("last-session_2.json"));
        for bad in ["", "../x", "a/b", "a\\b", "a.json", "C:", &"x".repeat(65)] {
            assert!(file_for_key(dir, bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn session_files_round_trip_and_paths_are_checked() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("Show S01.mbmux");
        let value = json!({"format": "mkvbatchmux-session", "version": 1, "videoFiles": [{"path": "C:\\Shows\\a.mkv"}]});
        session_save(path.to_string_lossy().into_owned(), value.clone()).unwrap();
        assert_eq!(session_open(path.to_string_lossy().into_owned()).unwrap(), value);
        assert!(session_open(dir.path().join("nope.mbmux").to_string_lossy().into_owned()).is_err());
        assert!(session_save("  ".into(), value).is_err());
        let exists = paths_exist(vec![path.to_string_lossy().into_owned(), dir.path().join("nope").to_string_lossy().into_owned(), String::new()]);
        assert_eq!(exists, vec![true, false, false]);
    }
}
