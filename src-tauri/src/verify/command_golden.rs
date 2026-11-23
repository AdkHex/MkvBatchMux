//! Golden test of the mkvmerge and mkvpropedit commands the app builds for a
//! corpus of jobs: removed tracks, language filters, default and forced flags,
//! external audio and subtitles with delays and stretches, multi-track
//! externals, chapters, attachments, overwrite and destination modes, Fast
//! mux. Verification reads its expectations from the same functions that
//! build these commands, so a change to them should be a choice, seen here.
//! Paths are fixed and never read, so the result is the same on every OS.
//!
//! After an intended change, rewrite the golden file and review its diff:
//!   MBM_GOLDEN_OUT=src/verify/command_golden.json cargo test command_golden

use crate::{build_mkvmerge_command, build_mkvpropedit_args, fast_mux_allowed_for_job, get_output_paths, remote_status, AppPaths, AppState, MuxJobRequest, MuxSettings, MuxState};
use serde_json::{json, Value};
use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

fn settings(patch: Value) -> MuxSettings {
    let mut value = json!({
        "destinationDir": "/out",
        "outputNamingPattern": null,
        "overwriteSource": false,
        "addCrc": false,
        "removeOldCrc": false,
        "keepLogFile": false,
        "abortOnErrors": false,
        "maxParallelJobs": null,
        "onlyKeepAudiosEnabled": false,
        "onlyKeepSubtitlesEnabled": false,
        "onlyKeepAudioLanguages": [],
        "onlyKeepSubtitleLanguages": [],
        "discardOldChapters": false,
        "discardOldAttachments": false,
        "allowDuplicateAttachments": false,
        "attachmentsExpertMode": false,
        "removeGlobalTags": true,
        "makeAudioDefaultLanguage": null,
        "makeSubtitleDefaultLanguage": null,
        "useMkvpropedit": false,
    });
    for (key, patched) in patch.as_object().expect("an object") {
        value[key] = patched.clone();
    }
    serde_json::from_value(value).expect("valid settings")
}

fn tracks() -> Value {
    json!([
        { "id": "0", "type": "video", "codec": "AVC", "language": "und", "isDefault": true, "isForced": false },
        { "id": "1", "type": "audio", "codec": "FLAC", "language": "eng", "name": "Stereo", "isDefault": true, "isForced": false },
        { "id": "2", "type": "audio", "codec": "AC-3", "language": "jpn", "name": "5.1", "isDefault": false, "isForced": false },
        { "id": "3", "type": "subtitle", "codec": "SRT", "language": "eng", "name": "Full", "isDefault": true, "isForced": false },
        { "id": "4", "type": "subtitle", "codec": "SRT", "language": "eng", "name": "Signs", "isDefault": false, "isForced": true },
        { "id": "5", "type": "subtitle", "codec": "SRT", "language": "spa", "isDefault": false, "isForced": false },
    ])
}

fn job(patch: Value) -> MuxJobRequest {
    let mut value = json!({
        "id": "job",
        "video": { "id": "v", "name": "Show.S01E01.mkv", "path": "/media/Show/Show.S01E01.mkv", "size": 1, "status": "pending", "tracks": tracks() },
        "audios": [],
        "subtitles": [],
        "chapters": [],
        "attachments": [],
    });
    for (key, patched) in patch.as_object().expect("an object") {
        value[key] = patched.clone();
    }
    serde_json::from_value(value).expect("valid job")
}

fn audio(id: &str, path: &str, extra: Value) -> Value {
    let mut value = json!({ "id": id, "name": Path::new(path).file_name().unwrap().to_string_lossy(), "path": path, "type": "audio", "source": "bulk" });
    for (key, patched) in extra.as_object().expect("an object") {
        value[key] = patched.clone();
    }
    value
}

fn subtitle(id: &str, path: &str, extra: Value) -> Value {
    let mut value = audio(id, path, extra);
    value["type"] = json!("subtitle");
    value
}

fn with_tracks(edit: impl Fn(&mut Vec<Value>)) -> Value {
    let mut list = tracks().as_array().unwrap().clone();
    edit(&mut list);
    json!({ "video": { "id": "v", "name": "Show.S01E01.mkv", "path": "/media/Show/Show.S01E01.mkv", "size": 1, "status": "pending", "tracks": list } })
}

fn merge(a: Value, b: Value) -> Value {
    let mut a = a;
    for (key, value) in b.as_object().unwrap() {
        a[key] = value.clone();
    }
    a
}

fn corpus() -> Vec<(&'static str, MuxJobRequest, MuxSettings)> {
    let dub = "/media/Dubs/Show.S01E01.Hindi.eac3";
    let mka = "/media/Dubs/Show.S01E01.multi.mka";
    let srt = "/media/Subs/Show.S01E01.en.srt";
    let none = json!({});
    vec![
        ("plain", job(none.clone()), settings(none.clone())),
        (
            "removed-tracks",
            job(with_tracks(|t| {
                t[2]["action"] = json!("remove");
                t[5]["action"] = json!("remove");
            })),
            settings(none.clone()),
        ),
        (
            "only-keep-languages",
            job(none.clone()),
            settings(json!({ "onlyKeepAudiosEnabled": true, "onlyKeepAudioLanguages": ["jpn"], "onlyKeepSubtitlesEnabled": true, "onlyKeepSubtitleLanguages": ["eng"] })),
        ),
        (
            "only-keep-plus-removed",
            job(with_tracks(|t| t[4]["action"] = json!("remove"))),
            settings(json!({ "onlyKeepSubtitlesEnabled": true, "onlyKeepSubtitleLanguages": ["eng", "spa"] })),
        ),
        (
            "source-flags-names-languages",
            job(with_tracks(|t| {
                t[1]["isDefault"] = json!(false);
                t[2]["isDefault"] = json!(true);
                t[2]["language"] = json!("fra");
                t[2]["name"] = json!("French 5.1");
                t[4]["isForced"] = json!(false);
                t[5]["isForced"] = json!(true);
                t[3]["name"] = json!("");
            })),
            settings(none.clone()),
        ),
        ("default-language-settings", job(none.clone()), settings(json!({ "makeAudioDefaultLanguage": "jpn", "makeSubtitleDefaultLanguage": "spa" }))),
        (
            "external-audio-delay-default",
            job(json!({ "audios": [audio("a1", dub, json!({ "language": "hin", "trackName": "Hindi", "delay": -1.312, "isDefault": true, "includedTrackIds": [0] }))] })),
            settings(json!({ "makeAudioDefaultLanguage": "jpn" })),
        ),
        (
            "external-audio-stretch-and-delay",
            job(json!({ "audios": [audio("a1", dub, json!({ "language": "hin", "delay": 2.0, "isDefault": false, "includedTrackIds": [0], "stretch": { "num": 25.0, "den": 23.976 } }))] })),
            settings(none.clone()),
        ),
        (
            "external-audio-stretch-only",
            job(json!({ "audios": [audio("a1", dub, json!({ "language": "hin", "includedTrackIds": [0], "stretch": { "num": 1001.0, "den": 1000.0 } }))] })),
            settings(none.clone()),
        ),
        (
            "multi-track-external-with-overrides",
            job(json!({ "audios": [audio("a1", mka, json!({
                "language": "hin", "trackName": "Dub", "delay": 0.5, "isDefault": true, "includedTrackIds": [0, 1, 2],
                "trackOverrides": { "1": { "language": "tam", "delay": -0.25, "trackName": "Tamil" }, "2": { "stretch": { "num": 25.0, "den": 24.0 } } },
            }))] })),
            settings(none.clone()),
        ),
        (
            "external-subtitles-delay-flags",
            job(json!({ "subtitles": [
                subtitle("s1", srt, json!({ "language": "eng", "trackName": "Full", "delay": 2.5, "isDefault": true, "isForced": false, "trackId": 0 })),
                subtitle("s2", "/media/Subs/Show.S01E01.signs.ass", json!({ "language": "eng", "trackName": "Signs", "delay": -1.2, "isDefault": false, "isForced": true, "trackId": 0 })),
            ] })),
            settings(none.clone()),
        ),
        (
            "audio-file-with-its-subtitles-first",
            job(json!({ "audios": [audio("a1", mka, json!({
                "language": "hin", "includedTrackIds": [0], "isDefault": true, "includeSubtitles": true, "includedSubtitleTrackIds": [3, 4],
                "includedSubtitlesDefault": true, "includedSubtitlesForced": true, "includedSubtitlesFirst": true,
            }))] })),
            settings(none.clone()),
        ),
        (
            "per-file-and-bulk-order",
            job(json!({
                "audios": [
                    audio("a1", dub, json!({ "language": "hin", "includedTrackIds": [0], "source": "per-file", "muxAfter": "audio-first" })),
                    audio("a2", "/media/Dubs/Show.S01E01.Tamil.eac3", json!({ "language": "tam", "includedTrackIds": [0], "isDefault": true })),
                ],
                "subtitles": [
                    subtitle("s1", srt, json!({ "language": "eng", "trackId": 0, "source": "per-file", "muxAfter": "subtitle-first" })),
                    subtitle("s2", "/media/Subs/Show.S01E01.hi.srt", json!({ "language": "hin", "trackId": 0 })),
                ],
            })),
            settings(none.clone()),
        ),
        (
            "chapters-with-delay",
            job(json!({ "chapters": [{ "id": "c1", "name": "c.xml", "path": "/media/Chapters/Show.S01E01.chapters.xml", "type": "chapter", "delay": 1.5 }] })),
            settings(json!({ "discardOldChapters": true })),
        ),
        (
            "attachments-duplicates-dropped",
            job(json!({ "attachments": [
                { "id": "f1", "name": "Font.ttf", "path": "/fonts/a/Font.ttf", "type": "attachment" },
                { "id": "f2", "name": "font.TTF", "path": "/fonts/b/font.TTF", "type": "attachment" },
                { "id": "f3", "name": "Other.otf", "path": "/fonts/Other.otf", "type": "attachment" },
            ] })),
            settings(json!({ "discardOldAttachments": true })),
        ),
        (
            "attachments-duplicates-allowed-expert",
            job(json!({ "attachments": [
                { "id": "f1", "name": "Font.ttf", "path": "/fonts/a/Font.ttf", "type": "attachment" },
                { "id": "f2", "name": "font.TTF", "path": "/fonts/b/font.TTF", "type": "attachment" },
            ] })),
            settings(json!({ "allowDuplicateAttachments": true, "attachmentsExpertMode": true })),
        ),
        (
            "overwrite-with-crc",
            job(json!({ "audios": [audio("a1", dub, json!({ "language": "hin", "delay": 1.0, "includedTrackIds": [0] }))] })),
            settings(json!({ "destinationDir": "", "overwriteSource": true, "addCrc": true, "removeGlobalTags": false })),
        ),
        (
            "destination-with-pattern-remove-crc",
            job(none.clone()),
            settings(json!({ "outputNamingPattern": "{name} [MUX]", "removeOldCrc": true })),
        ),
        (
            "fast-mux-candidate",
            job(with_tracks(|t| {
                t[2]["isDefault"] = json!(true);
                t[2]["language"] = json!("fra");
                t[5]["action"] = json!("remove");
            })),
            settings(json!({ "destinationDir": "", "overwriteSource": true, "useMkvpropedit": true })),
        ),
        (
            "fast-mux-refused-by-language-filter",
            job(none.clone()),
            settings(json!({ "destinationDir": "", "overwriteSource": true, "useMkvpropedit": true, "onlyKeepAudiosEnabled": true, "onlyKeepAudioLanguages": ["eng"] })),
        ),
        (
            "skipped-and-unprobed-externals",
            job(json!({
                "audios": [
                    audio("a1", dub, json!({ "language": "hin", "includedTrackIds": [] })),
                    audio("a2", "/nonexistent/Show.S01E01.Tamil.mka", json!({ "language": "tam", "trackId": 2, "delay": 0.04 })),
                ],
                "subtitles": [subtitle("s1", "/nonexistent/Show.S01E01.mks", json!({ "language": "eng", "trackId": 1 }))],
            })),
            settings(none.clone()),
        ),
        (
            "unscanned-source",
            job(merge(
                json!({ "video": { "id": "v", "name": "Show.S01E01.mkv", "path": "/media/Show/Show.S01E01.mkv", "size": 1, "status": "pending", "tracks": [] } }),
                json!({ "audios": [audio("a1", dub, json!({ "language": "hin", "isDefault": true, "includedTrackIds": [0] }))] }),
            )),
            settings(json!({ "makeSubtitleDefaultLanguage": "eng" })),
        ),
    ]
}

fn state() -> AppState {
    AppState {
        paths: AppPaths { app_data_dir: PathBuf::new(), options_path: PathBuf::new(), log_path: PathBuf::new() },
        mux_state: Arc::new(Mutex::new(MuxState::default())),
        cancelled_scans: Arc::new(Mutex::new(HashSet::new())),
        service: Arc::new(remote_status::Service::disabled()),
    }
}

/// `\` as `/`, and the temporary output's clock-and-counter suffix masked.
fn portable(path: &Path) -> String {
    let text = path.to_string_lossy().replace('\\', "/");
    match text.rfind('#') {
        Some(at) if text.ends_with(".mkv") => format!("{}#<temp>.mkv", &text[..at]),
        _ => text,
    }
}

pub(crate) fn render() -> Value {
    let state = state();
    let entries: Vec<Value> = corpus()
        .into_iter()
        .map(|(name, job, settings)| {
            let (output, final_path, overwrite) = get_output_paths(&job, &settings);
            let args = build_mkvmerge_command(&job, &settings, Path::new("/out/OUT.mkv"), &state);
            json!({
                "name": name,
                "output": portable(&output),
                "final": portable(&final_path),
                "overwrite": overwrite,
                "fastMux": fast_mux_allowed_for_job(&job, &settings),
                "mkvpropedit": build_mkvpropedit_args(&job),
                "mkvmerge": args,
            })
        })
        .collect();
    Value::Array(entries)
}

#[test]
fn the_commands_built_for_the_corpus_are_unchanged() {
    let rendered = render();
    assert!(rendered.as_array().unwrap().len() >= 15);
    if let Some(out) = std::env::var_os("MBM_GOLDEN_OUT") {
        std::fs::write(out, serde_json::to_string_pretty(&rendered).unwrap()).unwrap();
        return;
    }
    let golden: Value = serde_json::from_str(include_str!("command_golden.json")).expect("valid golden file");
    let golden = golden.as_array().expect("a list");
    let rendered = rendered.as_array().unwrap();
    assert_eq!(rendered.len(), golden.len(), "the corpus and the golden file differ in length");
    for (now, before) in rendered.iter().zip(golden) {
        assert_eq!(now, before, "the commands for {} changed", before["name"]);
    }
}
