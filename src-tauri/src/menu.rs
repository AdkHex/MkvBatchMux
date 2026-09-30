//! The native menu bar for macOS, where menus belong in the system bar rather
//! than in the window. Windows draws the same menus inside its title bar
//! (src/ui/frame.tsx), so this menu is only attached on macOS: a Tauri 1 menu
//! on Windows would add a second, native menu bar to the window.
//!
//! Predefined items (copy, paste, quit…) act on their own. Ours send their id
//! to the page as an `app-menu` event (src/app/Index.tsx, `menuActions`).

use tauri::{AboutMetadata, CustomMenuItem, Menu, MenuItem, Submenu};

/// Every id the frontend answers to. Kept here so a test can check the menu
/// sends nothing else.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
pub const MENU_IDS: &[&str] = &[
    "prefs",
    "choose-folder",
    "add-files",
    "import-from-video",
    "open-log",
    "remove",
    "clear",
    "move-up",
    "move-down",
    "new-track",
    "duplicate-track",
    "page-videos",
    "page-subtitles",
    "page-audio",
    "page-chapters",
    "page-attachments",
    "page-mux",
    "output",
    "history",
    "measure-delays",
    "modify-tracks",
    "media-info",
    "add-to-queue",
    "validate",
    "start-muxing",
    "tools",
    "shortcuts",
    "updates",
    "release-notes",
];

#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
fn item(id: &str, title: &str, accelerator: Option<&str>) -> CustomMenuItem {
    let item = CustomMenuItem::new(id.to_string(), title);
    match accelerator {
        Some(keys) => item.accelerator(keys),
        None => item,
    }
}

#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
pub fn app_menu() -> Menu {
    let app = Submenu::new(
        "MKVBatchMux",
        Menu::new()
            .add_native_item(MenuItem::About("MKVBatchMux".into(), AboutMetadata::default()))
            .add_native_item(MenuItem::Separator)
            .add_item(item("prefs", "Preferences…", Some("CmdOrCtrl+,")))
            .add_native_item(MenuItem::Separator)
            .add_native_item(MenuItem::Services)
            .add_native_item(MenuItem::Separator)
            .add_native_item(MenuItem::Hide)
            .add_native_item(MenuItem::HideOthers)
            .add_native_item(MenuItem::ShowAll)
            .add_native_item(MenuItem::Separator)
            .add_native_item(MenuItem::Quit),
    );
    let file = Submenu::new(
        "File",
        Menu::new()
            .add_item(item("choose-folder", "Choose Folder…", Some("CmdOrCtrl+O")))
            .add_item(item("add-files", "Add Files…", None))
            .add_item(item("import-from-video", "Import from a Video…", None))
            .add_native_item(MenuItem::Separator)
            .add_item(item("open-log", "Open Log File", None))
            .add_native_item(MenuItem::Separator)
            .add_native_item(MenuItem::CloseWindow),
    );
    // Cut, copy, paste and select all stay native so text boxes keep them.
    let edit = Submenu::new(
        "Edit",
        Menu::new()
            .add_native_item(MenuItem::Undo)
            .add_native_item(MenuItem::Redo)
            .add_native_item(MenuItem::Separator)
            .add_native_item(MenuItem::Cut)
            .add_native_item(MenuItem::Copy)
            .add_native_item(MenuItem::Paste)
            .add_native_item(MenuItem::SelectAll)
            .add_native_item(MenuItem::Separator)
            .add_item(item("remove", "Remove", None))
            .add_item(item("clear", "Clear the List", None))
            .add_native_item(MenuItem::Separator)
            .add_item(item("move-up", "Move Up", Some("Alt+Up")))
            .add_item(item("move-down", "Move Down", Some("Alt+Down")))
            .add_native_item(MenuItem::Separator)
            .add_item(item("new-track", "New Track", Some("CmdOrCtrl+N")))
            .add_item(item("duplicate-track", "Duplicate Track", None)),
    );
    let view = Submenu::new(
        "View",
        Menu::new()
            .add_item(item("page-videos", "Videos", Some("CmdOrCtrl+1")))
            .add_item(item("page-subtitles", "Subtitles", Some("CmdOrCtrl+2")))
            .add_item(item("page-audio", "Audio", Some("CmdOrCtrl+3")))
            .add_item(item("page-chapters", "Chapters", Some("CmdOrCtrl+4")))
            .add_item(item("page-attachments", "Attachments", Some("CmdOrCtrl+5")))
            .add_item(item("page-mux", "Mux", Some("CmdOrCtrl+6")))
            .add_native_item(MenuItem::Separator)
            .add_item(item("output", "Output", None))
            .add_item(item("history", "History", None))
            .add_native_item(MenuItem::Separator)
            .add_native_item(MenuItem::EnterFullScreen),
    );
    // Cmd+M is Minimize on macOS, so Modify Tracks has no key here.
    let tools = Submenu::new(
        "Tools",
        Menu::new()
            .add_item(item("measure-delays", "Measure Delays", None))
            .add_item(item("modify-tracks", "Modify Tracks…", None))
            .add_item(item("media-info", "Media Info", Some("CmdOrCtrl+I")))
            .add_native_item(MenuItem::Separator)
            .add_item(item("add-to-queue", "Add to Queue", None))
            .add_item(item("validate", "Validate", None))
            .add_item(item("start-muxing", "Start Muxing", Some("CmdOrCtrl+Enter")))
            .add_native_item(MenuItem::Separator)
            .add_item(item("tools", "Tools and Dependencies…", None)),
    );
    let window = Submenu::new(
        "Window",
        Menu::new()
            .add_native_item(MenuItem::Minimize)
            .add_native_item(MenuItem::Zoom)
            .add_native_item(MenuItem::Separator)
            .add_native_item(MenuItem::CloseWindow),
    );
    let help = Submenu::new(
        "Help",
        Menu::new()
            .add_item(item("shortcuts", "Keyboard Shortcuts", None))
            .add_item(item("updates", "Check for Updates…", None))
            .add_item(item("release-notes", "Release Notes", None)),
    );
    Menu::new()
        .add_submenu(app)
        .add_submenu(file)
        .add_submenu(edit)
        .add_submenu(view)
        .add_submenu(tools)
        .add_submenu(window)
        .add_submenu(help)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashSet;
    use tauri::MenuEntry;

    fn custom_ids(menu: &Menu, out: &mut Vec<String>) {
        for entry in &menu.items {
            match entry {
                MenuEntry::CustomItem(item) => out.push(item.id_str.clone()),
                MenuEntry::Submenu(submenu) => custom_ids(&submenu.inner, out),
                MenuEntry::NativeItem(_) => {}
            }
        }
    }

    #[test]
    fn every_menu_item_is_one_the_page_answers_to_and_each_appears_once() {
        let mut ids = Vec::new();
        custom_ids(&app_menu(), &mut ids);
        let unique: HashSet<&str> = ids.iter().map(String::as_str).collect();
        assert_eq!(unique.len(), ids.len(), "a menu id appears twice: {ids:?}");
        let known: HashSet<&str> = MENU_IDS.iter().copied().collect();
        assert_eq!(unique, known);
    }
}
