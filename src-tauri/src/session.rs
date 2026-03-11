/// Session persistence module.
/// Handles atomic save/load/clear of session state to prevent data loss.
use serde_json::Value;
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::AppHandle;

const SESSION_VERSION: &str = "1.0.0";
const SESSION_FILE_NAME: &str = "session.json";
const SESSION_TEMP_FILE_NAME: &str = "session.tmp.json";

pub fn session_path(app: &AppHandle) -> PathBuf {
    let app_data_dir = tauri::api::path::app_data_dir(&app.config())
        .expect("Failed to resolve app data directory");
    app_data_dir.join(SESSION_FILE_NAME)
}

fn session_temp_path(app: &AppHandle) -> PathBuf {
    let app_data_dir = tauri::api::path::app_data_dir(&app.config())
        .expect("Failed to resolve app data directory");
    app_data_dir.join(SESSION_TEMP_FILE_NAME)
}

/// Save session state atomically: write to temp → verify → rename.
pub fn save_session_data(app: &AppHandle, mut state: Value) -> Result<(), String> {
    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);

    if let Some(obj) = state.as_object_mut() {
        obj.insert("version".to_string(), Value::String(SESSION_VERSION.to_string()));
        obj.insert("timestamp".to_string(), Value::Number(timestamp.into()));
    }

    let json = serde_json::to_string(&state)
        .map_err(|e| format!("Failed to serialize session: {e}"))?;

    let temp_path = session_temp_path(app);
    let final_path = session_path(app);

    // Ensure parent directory exists
    if let Some(parent) = final_path.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("Failed to create session dir: {e}"))?;
    }

    // Write to temp file
    let mut file = fs::File::create(&temp_path)
        .map_err(|e| format!("Failed to create temp session file: {e}"))?;
    file.write_all(json.as_bytes())
        .map_err(|e| format!("Failed to write session data: {e}"))?;
    file.flush()
        .map_err(|e| format!("Failed to flush session file: {e}"))?;
    drop(file);

    // Verify temp file is valid JSON
    verify_session_file(&temp_path)?;

    // Atomic rename
    fs::rename(&temp_path, &final_path)
        .map_err(|e| format!("Failed to finalize session file: {e}"))?;

    Ok(())
}

/// Load session state from disk if it exists and is valid.
pub fn load_session_data(app: &AppHandle) -> Result<Option<Value>, String> {
    let path = session_path(app);
    if !path.exists() {
        return Ok(None);
    }

    let content = fs::read_to_string(&path)
        .map_err(|e| format!("Failed to read session file: {e}"))?;

    match serde_json::from_str::<Value>(&content) {
        Ok(value) => Ok(Some(value)),
        Err(e) => {
            // Corrupt session — delete and return None
            let _ = fs::remove_file(&path);
            Err(format!("Session file was corrupt and has been cleared: {e}"))
        }
    }
}

/// Delete session file.
pub fn clear_session_data(app: &AppHandle) -> Result<(), String> {
    let path = session_path(app);
    if path.exists() {
        fs::remove_file(&path).map_err(|e| format!("Failed to clear session: {e}"))?;
    }
    // Also remove temp if it exists
    let temp_path = session_temp_path(app);
    if temp_path.exists() {
        let _ = fs::remove_file(&temp_path);
    }
    Ok(())
}

/// Verify that a file contains valid JSON with a version field.
fn verify_session_file(path: &Path) -> Result<(), String> {
    let content = fs::read_to_string(path)
        .map_err(|e| format!("Failed to read temp session for verification: {e}"))?;
    let value: Value = serde_json::from_str(&content)
        .map_err(|e| format!("Temp session file is not valid JSON: {e}"))?;
    if value.get("version").is_none() {
        return Err("Session file missing version field".to_string());
    }
    Ok(())
}

// ─── Tauri Commands ────────────────────────────────────────────────────────────

#[tauri::command]
pub fn save_session(state: Value, app: AppHandle) -> Result<(), String> {
    save_session_data(&app, state)
}

#[tauri::command]
pub fn load_session(app: AppHandle) -> Result<Option<Value>, String> {
    load_session_data(&app)
}

#[tauri::command]
pub fn clear_session(app: AppHandle) -> Result<(), String> {
    clear_session_data(&app)
}
