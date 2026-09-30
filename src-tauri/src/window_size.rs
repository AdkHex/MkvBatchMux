//! The main window's size: 90% of the screen the first time, then whatever
//! size it was left at, remembered in the app's data directory
//! (`window.json`). Sizes are logical pixels, so a saved size means the same
//! on a display with another scale factor.

use serde::{Deserialize, Serialize};
use std::path::Path;

/// The window's minimum, as tauri.conf.json sets it.
pub const MIN_WIDTH: f64 = 900.0;
pub const MIN_HEIGHT: f64 = 600.0;
/// The first launch takes this share of the screen.
const FIRST_SHARE: f64 = 0.9;

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct Saved {
    pub width: f64,
    pub height: f64,
    #[serde(default)]
    pub maximized: bool,
}

/// The size to open at on a screen of `screen` (width, height): the saved
/// size when there is one, never larger than the screen nor smaller than the
/// minimum; otherwise 90% of the screen.
pub fn initial_size(saved: Option<Saved>, screen: (f64, f64)) -> (f64, f64) {
    let (screen_w, screen_h) = screen;
    let (w, h) = match saved {
        Some(s) if s.width > 0.0 && s.height > 0.0 => (s.width, s.height),
        _ => (screen_w * FIRST_SHARE, screen_h * FIRST_SHARE),
    };
    // Clamp to the screen first, then to the minimum: a screen smaller than
    // the minimum still gets a window the app can lay out.
    (w.min(screen_w).max(MIN_WIDTH), h.min(screen_h).max(MIN_HEIGHT))
}

pub fn load(path: &Path) -> Option<Saved> {
    let text = std::fs::read_to_string(path).ok()?;
    serde_json::from_str(&text).ok()
}

pub fn save(path: &Path, saved: Saved) {
    if let Ok(text) = serde_json::to_string(&saved) {
        let _ = std::fs::write(path, text);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn first_launch_takes_most_of_the_screen() {
        let (w, h) = initial_size(None, (1920.0, 1080.0));
        assert_eq!((w.round(), h.round()), (1728.0, 972.0));
    }

    #[test]
    fn a_saved_size_is_reused() {
        let saved = Saved { width: 1400.0, height: 900.0, maximized: false };
        assert_eq!(initial_size(Some(saved), (2560.0, 1440.0)), (1400.0, 900.0));
    }

    #[test]
    fn a_saved_size_never_exceeds_the_screen() {
        let saved = Saved { width: 2400.0, height: 1300.0, maximized: false };
        assert_eq!(initial_size(Some(saved), (1920.0, 1080.0)), (1920.0, 1080.0));
    }

    #[test]
    fn never_smaller_than_the_minimum() {
        let saved = Saved { width: 300.0, height: 200.0, maximized: false };
        assert_eq!(initial_size(Some(saved), (1920.0, 1080.0)), (MIN_WIDTH, MIN_HEIGHT));
        assert_eq!(initial_size(None, (800.0, 500.0)), (MIN_WIDTH, MIN_HEIGHT));
    }

    #[test]
    fn a_broken_saved_size_falls_back_to_the_first_launch_size() {
        let saved = Saved { width: 0.0, height: -5.0, maximized: false };
        assert_eq!(initial_size(Some(saved), (1000.0, 1000.0)), (900.0, 900.0));
    }

    #[test]
    fn round_trips_through_its_file() {
        let dir = std::env::temp_dir().join(format!("mkvbatchmux-window-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("window.json");
        let saved = Saved { width: 1500.0, height: 950.0, maximized: true };
        save(&path, saved);
        assert_eq!(load(&path), Some(saved));
        let _ = std::fs::remove_dir_all(&dir);
    }
}
