//! Blu-ray picture subtitles (HDMV PGS, `.sup`): when each picture is on
//! screen, and the same pictures at other times.
//!
//! A PGS stream is a run of display sets, each a presentation composition
//! (PCS) and the window, palette and picture data it needs, closed by an END
//! segment. A composition with pictures puts them on screen at its time; one
//! without pictures clears the screen; one that only updates the palette
//! (fades) keeps the same pictures up. So the stream's lines, and when each is
//! shown, can be read without decoding a single picture, which is all the
//! sync engine needs: it lines up when lines are shown, not what they say.
//!
//! Re-timing moves whole display sets, so the pictures, palettes and windows
//! stay exactly as they were.

use std::collections::HashMap;
use std::io::{BufRead, BufReader};
use std::path::Path;
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

/// PGS timestamps count a 90 kHz clock.
pub(crate) const TICKS_PER_MS: f64 = 90.0;

const HEADER_LEN: usize = 13;
const PALETTE: u8 = 0x14;
const PICTURE: u8 = 0x15;
const COMPOSITION: u8 = 0x16;
const WINDOW: u8 = 0x17;
const END: u8 = 0x80;

/// A line still on screen when the stream ends is given this long.
const LAST_LINE_TICKS: u32 = 3 * 90_000;

#[derive(Debug, Clone, PartialEq)]
struct Segment {
    /// Where its header starts in the stream.
    at: usize,
    pts: u32,
    dts: u32,
    /// The display set it belongs to.
    set: usize,
}

/// One composition and what it needs.
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct DisplaySet {
    pub pts: u32,
    /// Pictures it puts on screen; 0 clears the screen.
    pub pictures: u8,
    /// Only the palette changes (a fade): the same pictures stay up.
    pub palette_only: bool,
}

/// A parsed `.sup` stream.
#[derive(Debug, Clone)]
pub(crate) struct Sup {
    bytes: Vec<u8>,
    segments: Vec<Segment>,
    pub sets: Vec<DisplaySet>,
}

/// One line: from the display set that shows it to the one that replaces or
/// clears it.
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct Line {
    pub start_set: usize,
    /// The set that takes it off screen: a clear, or the next line's own.
    pub end_set: Option<usize>,
    pub start: u32,
    pub end: u32,
}

fn be16(bytes: &[u8], at: usize) -> usize {
    u16::from_be_bytes([bytes[at], bytes[at + 1]]) as usize
}

fn be32(bytes: &[u8], at: usize) -> u32 {
    u32::from_be_bytes([bytes[at], bytes[at + 1], bytes[at + 2], bytes[at + 3]])
}

/// Read a `.sup` stream's segments and display sets.
pub(crate) fn parse(bytes: Vec<u8>) -> Result<Sup, String> {
    let mut segments = Vec::new();
    let mut sets: Vec<DisplaySet> = Vec::new();
    let mut at = 0usize;
    while at + HEADER_LEN <= bytes.len() {
        if &bytes[at..at + 2] != b"PG" {
            if at == 0 {
                return Err("This is not a Blu-ray (PGS) subtitle stream.".to_string());
            }
            // Junk between segments (a damaged rip): carry on at the next
            // segment, the junk left as it is.
            match bytes[at + 1..].windows(2).position(|pair| pair == b"PG") {
                Some(skip) => {
                    at += 1 + skip;
                    continue;
                }
                None => break,
            }
        }
        let pts = be32(&bytes, at + 2);
        let dts = be32(&bytes, at + 6);
        let kind = bytes[at + 10];
        let size = be16(&bytes, at + 11);
        let payload = at + HEADER_LEN;
        if payload + size > bytes.len() {
            // A stream cut off mid-segment: what came before it still counts.
            break;
        }
        if kind == COMPOSITION {
            if size < 11 {
                return Err(format!("The PGS stream has a composition too short to read at byte {at}."));
            }
            sets.push(DisplaySet {
                pts,
                pictures: bytes[payload + 10],
                palette_only: bytes[payload + 8] & 0x80 != 0,
            });
        } else if !matches!(kind, PALETTE | PICTURE | WINDOW | END) {
            return Err(format!("The PGS stream has a segment of unknown type 0x{kind:02x} at byte {at}."));
        }
        // Anything before the first composition travels with it.
        segments.push(Segment { at, pts, dts, set: sets.len().saturating_sub(1) });
        at = payload + size;
    }
    if sets.is_empty() {
        return Err("The PGS stream has no subtitles in it.".to_string());
    }
    Ok(Sup { bytes, segments, sets })
}

/// The lines of a stream, in order.
pub(crate) fn lines(sets: &[DisplaySet]) -> Vec<Line> {
    let mut lines: Vec<Line> = Vec::new();
    let mut open: Option<usize> = None;
    for (index, set) in sets.iter().enumerate() {
        if set.pictures == 0 {
            if let Some(line) = open.take() {
                lines[line].end_set = Some(index);
                lines[line].end = set.pts;
            }
            continue;
        }
        if set.palette_only && open.is_some() {
            continue;
        }
        if let Some(line) = open.take() {
            lines[line].end_set = Some(index);
            lines[line].end = set.pts;
        }
        lines.push(Line { start_set: index, end_set: None, start: set.pts, end: set.pts });
        open = Some(lines.len() - 1);
    }
    if let Some(line) = open {
        lines[line].end = lines[line].start.saturating_add(LAST_LINE_TICKS);
    }
    lines
}

fn ms(ticks: u32) -> i64 {
    (ticks as f64 / TICKS_PER_MS).round() as i64
}

fn srt_clock(ms: i64) -> String {
    let ms = ms.max(0);
    format!("{:02}:{:02}:{:02},{:03}", ms / 3_600_000, ms / 60_000 % 60, ms / 1000 % 60, ms % 1000)
}

/// The words standing in for line `n`'s picture. Not empty and not a sound
/// cue, so the engine takes the line for dialogue; its number brings the line
/// back from the engine's re-timed copy.
fn stand_in(n: usize) -> String {
    format!("line {n}")
}

/// An SRT with the stream's timing and a stand-in for each picture.
pub(crate) fn timing_srt(lines: &[Line]) -> String {
    let mut out = String::new();
    let mut number = 0;
    for (n, line) in lines.iter().enumerate() {
        if line.end <= line.start {
            continue;
        }
        number += 1;
        out.push_str(&format!("{number}\n{} --> {}\n{}\n\n", srt_clock(ms(line.start)), srt_clock(ms(line.end)), stand_in(n)));
    }
    out
}

fn parse_srt_clock(text: &str) -> Option<i64> {
    let text = text.trim();
    let (clock, fraction) = text.split_once([',', '.']).unwrap_or((text, "0"));
    let mut parts = clock.split(':').map(|part| part.trim().parse::<i64>());
    let (h, m, s) = (parts.next()?.ok()?, parts.next()?.ok()?, parts.next()?.ok()?);
    if parts.next().is_some() {
        return None;
    }
    let digits: String = fraction.trim().chars().take_while(char::is_ascii_digit).collect();
    let frac_ms = match digits.len() {
        0 => 0,
        1 => digits.parse::<i64>().ok()? * 100,
        2 => digits.parse::<i64>().ok()? * 10,
        _ => digits[..3].parse::<i64>().ok()?,
    };
    Some(((h * 60 + m) * 60 + s) * 1000 + frac_ms)
}

/// Where the engine's re-timed copy of `timing_srt` put each line: line
/// number to (start, end) in ms. Lines it dropped are missing.
pub(crate) fn read_timing_srt(text: &str) -> HashMap<usize, (i64, i64)> {
    let mut placed = HashMap::new();
    let text = text.trim_start_matches('\u{feff}').replace("\r\n", "\n").replace('\r', "\n");
    for block in text.split("\n\n") {
        let mut rows = block.lines().map(str::trim).filter(|row| !row.is_empty());
        let Some(timing) = rows.by_ref().find(|row| row.contains("-->")) else { continue };
        let Some((from, to)) = timing.split_once("-->") else { continue };
        let to = to.split_whitespace().next().unwrap_or("");
        let (Some(start), Some(end)) = (parse_srt_clock(from), parse_srt_clock(to)) else { continue };
        let words: String = rows.collect::<Vec<_>>().join(" ");
        let Some(number) = words.split_whitespace().skip_while(|word| *word != "line").nth(1).and_then(|n| n.parse::<usize>().ok()) else {
            continue;
        };
        placed.insert(number, (start, end));
    }
    placed
}

/// The stream with every line where `placed` (from `read_timing_srt`) put it.
///
/// Each display set moves by its line's shift: the one that shows a line by
/// the shift of its start, the clear after it by the shift of its end, and
/// fades in between in proportion. A line the engine dropped moves with the
/// line before it. Sets never change order, and none goes before 0.
pub(crate) fn retime(sup: &Sup, lines: &[Line], placed: &HashMap<usize, (i64, i64)>) -> Result<Vec<u8>, String> {
    let original = |n: usize| (ms(lines[n].start), ms(lines[n].end));
    // Shifts in ticks, (start, end), per line.
    let mut shifts: Vec<Option<(f64, f64)>> = (0..lines.len())
        .map(|n| {
            placed.get(&n).map(|&(start, end)| {
                let (was_start, was_end) = original(n);
                ((start - was_start) as f64 * TICKS_PER_MS, (end - was_end) as f64 * TICKS_PER_MS)
            })
        })
        .collect();
    let Some(first) = shifts.iter().flatten().next().copied() else {
        return Err("The engine placed none of the subtitle's lines.".to_string());
    };
    let mut last = first;
    for shift in shifts.iter_mut() {
        match shift {
            Some(known) => last = *known,
            None => *shift = Some((last.0, last.0)),
        }
    }

    let sets = &sup.sets;
    let mut at: Vec<Option<f64>> = vec![None; sets.len()];
    // Ends and fades first; a set that both ends one line and shows the next
    // is then the next line's start.
    for (n, line) in lines.iter().enumerate() {
        let (start_shift, end_shift) = shifts[n].unwrap_or(first);
        let stop = line.end_set.unwrap_or(sets.len());
        for index in line.start_set + 1..stop {
            let pts = sets[index].pts as f64;
            let span = line.end.saturating_sub(line.start) as f64;
            let part = if span > 0.0 { ((pts - line.start as f64) / span).clamp(0.0, 1.0) } else { 0.0 };
            at[index] = Some(pts + start_shift + part * (end_shift - start_shift));
        }
        if let Some(end) = line.end_set {
            at[end] = Some(sets[end].pts as f64 + end_shift);
        }
    }
    for (n, line) in lines.iter().enumerate() {
        let (start_shift, _) = shifts[n].unwrap_or(first);
        at[line.start_set] = Some(sets[line.start_set].pts as f64 + start_shift);
    }
    // Sets outside every line (a clear with nothing up) move with the set before.
    let mut shift = first.0;
    let mut floor = 0.0f64;
    let mut moved: Vec<i64> = Vec::with_capacity(sets.len());
    for (index, set) in sets.iter().enumerate() {
        let time = match at[index] {
            Some(time) => {
                shift = time - set.pts as f64;
                time
            }
            None => set.pts as f64 + shift,
        };
        let time = time.max(floor).max(0.0);
        floor = time;
        moved.push(time.round() as i64 - set.pts as i64);
    }

    let mut bytes = sup.bytes.clone();
    let clamp = |value: i64| value.clamp(0, u32::MAX as i64) as u32;
    for segment in &sup.segments {
        let delta = moved[segment.set];
        let pts = clamp(segment.pts as i64 + delta);
        // A decode time of 0 means "not given", in most .sup files.
        let dts = if segment.dts == 0 { 0 } else { clamp(segment.dts as i64 + delta) };
        bytes[segment.at + 2..segment.at + 6].copy_from_slice(&pts.to_be_bytes());
        bytes[segment.at + 6..segment.at + 10].copy_from_slice(&dts.to_be_bytes());
    }
    Ok(bytes)
}

/// Run a tool to its end, stopping it when `cancel` is set. `on_line` sees
/// each line it prints (`--gui-mode` progress).
fn run_tool(mut command: std::process::Command, cancel: &AtomicBool, mut on_line: impl FnMut(&str)) -> Result<(), String> {
    let program = command.get_program().to_string_lossy().to_string();
    let mut child = command
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|error| format!("Could not run {program}: {error}"))?;
    let (sender, lines) = std::sync::mpsc::channel::<String>();
    let stdout = child.stdout.take();
    let reader = std::thread::spawn(move || {
        if let Some(stdout) = stdout {
            for line in BufReader::new(stdout).lines().map_while(Result::ok) {
                if sender.send(line).is_err() {
                    break;
                }
            }
        }
    });
    let stderr = child.stderr.take();
    let errors = std::thread::spawn(move || {
        let mut text = String::new();
        if let Some(mut stderr) = stderr {
            let _ = std::io::Read::read_to_string(&mut stderr, &mut text);
        }
        text
    });
    let mut printed: Vec<String> = Vec::new();
    let status = loop {
        while let Ok(line) = lines.try_recv() {
            on_line(&line);
            printed.push(line);
        }
        if cancel.load(Ordering::SeqCst) {
            let _ = child.kill();
            let _ = child.wait();
            return Err("Cancelled".to_string());
        }
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) => std::thread::sleep(Duration::from_millis(100)),
            Err(error) => return Err(format!("{program} stopped answering: {error}")),
        }
    };
    let _ = reader.join();
    while let Ok(line) = lines.try_recv() {
        on_line(&line);
        printed.push(line);
    }
    let stderr = errors.join().unwrap_or_default();
    // mkvextract exits 1 for warnings, with the file written.
    if status.success() || (program.contains("mkvextract") && status.code() == Some(1)) {
        return Ok(());
    }
    let said: Vec<&str> = printed.iter().map(String::as_str).chain(stderr.lines()).filter(|line| !line.trim().is_empty() && !line.starts_with("#GUI#progress")).collect();
    let tail = said.iter().rev().take(3).rev().copied().collect::<Vec<_>>().join(" ");
    Err(format!("{program} failed{}", if tail.is_empty() { String::new() } else { format!(": {}", tail.trim()) }))
}

/// Matroska's id for the `stream`-th subtitle track (the N of `0:s:N`),
/// when it is PGS. `Ok(None)`: the file is not Matroska.
fn matroska_pgs_track(container: &Path, stream: usize) -> Result<Option<u64>, String> {
    let output = crate::hidden_command("mkvmerge").arg("-J").arg(container).output().map_err(|error| format!("Could not run mkvmerge: {error}"))?;
    let Ok(json) = serde_json::from_slice::<serde_json::Value>(&output.stdout) else { return Ok(None) };
    let kind = json.pointer("/container/type").and_then(serde_json::Value::as_str).unwrap_or("");
    if !kind.to_ascii_lowercase().contains("matroska") {
        return Ok(None);
    }
    let subtitles: Vec<&serde_json::Value> = json
        .get("tracks")
        .and_then(serde_json::Value::as_array)
        .map(|tracks| tracks.iter().filter(|track| track.get("type").and_then(serde_json::Value::as_str) == Some("subtitles")).collect())
        .unwrap_or_default();
    let Some(track) = subtitles.get(stream) else {
        return Err(format!("{} has no subtitle track {}.", file_name(container), stream + 1));
    };
    let codec_id = track.pointer("/properties/codec_id").and_then(serde_json::Value::as_str).unwrap_or("");
    let codec = track.get("codec").and_then(serde_json::Value::as_str).unwrap_or("");
    if codec_id != "S_HDMV/PGS" && !codec.to_ascii_lowercase().contains("pgs") {
        return Err(format!("Subtitle track {} of {} is not Blu-ray PGS ({}).", stream + 1, file_name(container), if codec.is_empty() { codec_id } else { codec }));
    }
    track.get("id").and_then(serde_json::Value::as_u64).map(Some).ok_or_else(|| "mkvmerge gave the track no id.".to_string())
}

fn file_name(path: &Path) -> String {
    path.file_name().map(|name| name.to_string_lossy().to_string()).unwrap_or_else(|| path.to_string_lossy().to_string())
}

/// Copy the `stream`-th subtitle track (the N of `0:s:N`) of a container out
/// as a `.sup`: with mkvextract from Matroska, for the very timestamps
/// mkvmerge muxes; else with FFmpeg, counted from the file's start as
/// mkvmerge counts them (an MPEG-TS clock starts anywhere).
pub(crate) fn extract(container: &Path, stream: usize, into: &Path, cancel: &AtomicBool, mut percent: impl FnMut(u64)) -> Result<(), String> {
    let mut command;
    if let Some(id) = matroska_pgs_track(container, stream)? {
        command = crate::hidden_command("mkvextract");
        command.arg("--gui-mode").arg(container).arg("tracks").arg(format!("{id}:{}", into.to_string_lossy()));
    } else {
        command = crate::hidden_command("ffmpeg");
        command
            .args(["-v", "error", "-nostdin", "-y", "-i"])
            .arg(container)
            .args(["-map", &format!("0:s:{stream}"), "-c", "copy", "-f", "sup"])
            .arg(into);
    }
    run_tool(command, cancel, |line| {
        if let Some(value) = line.strip_prefix("#GUI#progress ").and_then(|rest| rest.trim().trim_end_matches('%').parse::<u64>().ok()) {
            percent(value);
        }
    })?;
    if !into.is_file() {
        return Err(format!("No subtitle came out of {}.", file_name(container)));
    }
    Ok(())
}

#[cfg(test)]
pub(crate) mod testing {
    //! Small but well-formed PGS streams, for the tests.

    use super::*;

    fn segment(out: &mut Vec<u8>, pts: u32, kind: u8, payload: &[u8]) {
        out.extend_from_slice(b"PG");
        out.extend_from_slice(&pts.to_be_bytes());
        out.extend_from_slice(&0u32.to_be_bytes());
        out.push(kind);
        out.extend_from_slice(&(payload.len() as u16).to_be_bytes());
        out.extend_from_slice(payload);
    }

    fn composition(number: u16, state: u8, palette_only: bool, pictures: u8) -> Vec<u8> {
        let mut pcs = vec![0x07, 0x80, 0x04, 0x38, 0x10];
        pcs.extend_from_slice(&number.to_be_bytes());
        pcs.extend_from_slice(&[state, if palette_only { 0x80 } else { 0x00 }, 0x00, pictures]);
        for _ in 0..pictures {
            // Object 0 in window 0, uncropped, near the bottom.
            pcs.extend_from_slice(&[0x00, 0x00, 0x00, 0x00, 0x03, 0x00, 0x03, 0xC0]);
        }
        pcs
    }

    /// One shown picture: an 8x2 bitmap of one colour.
    fn picture(out: &mut Vec<u8>, pts: u32, number: u16) {
        segment(out, pts, COMPOSITION, &composition(number, 0x80, false, 1));
        segment(out, pts, WINDOW, &[0x01, 0x00, 0x03, 0x00, 0x03, 0xC0, 0x00, 0x08, 0x00, 0x02]);
        segment(out, pts, PALETTE, &[0x00, 0x00, 0x01, 0xEB, 0x80, 0x80, 0xFF]);
        // id, version, last-in-sequence, data length (3 bytes), width, height, RLE.
        let rle = [0x01, 0x01, 0x01, 0x01, 0x01, 0x01, 0x01, 0x01, 0x00, 0x00, 0x01, 0x01, 0x01, 0x01, 0x01, 0x01, 0x01, 0x01, 0x00, 0x00];
        let mut ods = vec![0x00, 0x00, 0x00, 0xC0];
        let length = (rle.len() + 4) as u32;
        ods.extend_from_slice(&length.to_be_bytes()[1..]);
        ods.extend_from_slice(&[0x00, 0x08, 0x00, 0x02]);
        ods.extend_from_slice(&rle);
        segment(out, pts, PICTURE, &ods);
        segment(out, pts, END, &[]);
    }

    fn clear(out: &mut Vec<u8>, pts: u32, number: u16) {
        segment(out, pts, COMPOSITION, &composition(number, 0x00, false, 0));
        segment(out, pts, WINDOW, &[0x01, 0x00, 0x03, 0x00, 0x03, 0xC0, 0x00, 0x08, 0x00, 0x02]);
        segment(out, pts, END, &[]);
    }

    fn fade(out: &mut Vec<u8>, pts: u32, number: u16) {
        segment(out, pts, COMPOSITION, &composition(number, 0x00, true, 1));
        segment(out, pts, PALETTE, &[0x00, 0x01, 0x01, 0xEB, 0x80, 0x80, 0x80]);
        segment(out, pts, END, &[]);
    }

    /// What a test stream does at a time (ms).
    #[derive(Debug, Clone, Copy)]
    pub(crate) enum Event {
        Show(u32),
        Fade(u32),
        Clear(u32),
    }

    pub(crate) fn stream(events: &[Event]) -> Vec<u8> {
        let mut out = Vec::new();
        for (number, event) in events.iter().enumerate() {
            match *event {
                Event::Show(ms) => picture(&mut out, ms * 90, number as u16),
                Event::Fade(ms) => fade(&mut out, ms * 90, number as u16),
                Event::Clear(ms) => clear(&mut out, ms * 90, number as u16),
            }
        }
        out
    }

    /// A stream showing each (start, end) in ms, cleared after each; `fades`
    /// lists lines that get a palette fade half-way through.
    pub(crate) fn sup(lines: &[(u32, u32)], fades: &[usize]) -> Vec<u8> {
        let mut events = Vec::new();
        for (n, &(start, end)) in lines.iter().enumerate() {
            events.push(Event::Show(start));
            if fades.contains(&n) {
                events.push(Event::Fade((start + end) / 2));
            }
            events.push(Event::Clear(end));
        }
        stream(&events)
    }

    /// The (start, end) of every line of an SRT, in ms.
    pub(crate) fn srt_times(text: &str) -> Vec<(u32, u32)> {
        text.lines()
            .filter_map(|row| row.split_once("-->"))
            .filter_map(|(from, to)| Some((parse_srt_clock(from)? as u32, parse_srt_clock(to.split_whitespace().next()?)? as u32)))
            .collect()
    }

    /// Every segment's (pts, type), in order: to compare streams.
    pub(crate) fn timeline(bytes: &[u8]) -> Vec<(u32, u8)> {
        let mut out = Vec::new();
        let mut at = 0;
        while at + HEADER_LEN <= bytes.len() {
            out.push((be32(bytes, at + 2), bytes[at + 10]));
            at += HEADER_LEN + be16(bytes, at + 11);
        }
        out
    }
}

#[cfg(test)]
mod tests {
    use super::testing::{stream, sup, timeline, Event};
    use super::*;
    use std::path::PathBuf;

    /// A PGS stream from anywhere (`MBM_REAL_SUP`, a Blu-ray rip's `.sup`),
    /// moved: FFmpeg still decodes every picture, now where it was put, and
    /// it goes into Matroska and back out the same.
    #[test]
    #[ignore = "needs ffprobe, mkvmerge, mkvextract and a .sup in MBM_REAL_SUP"]
    fn a_real_stream_moves_and_still_decodes() {
        let Some(path) = std::env::var_os("MBM_REAL_SUP") else {
            eprintln!("SKIPPED: set MBM_REAL_SUP to a .sup file");
            return;
        };
        // (pts in ms, pictures) of every subtitle FFmpeg decodes.
        let decoded = |path: &Path| -> Vec<(i64, u32)> {
            let output = crate::hidden_command("ffprobe")
                .args(["-v", "error", "-select_streams", "s:0", "-show_frames", "-show_entries", "frame=pts_time,num_rects", "-of", "json"])
                .arg(path)
                .output()
                .unwrap();
            assert!(output.status.success(), "{}", String::from_utf8_lossy(&output.stderr));
            let json: serde_json::Value = serde_json::from_slice(&output.stdout).unwrap();
            json["frames"]
                .as_array()
                .unwrap()
                .iter()
                .map(|frame| {
                    let time: f64 = frame["pts_time"].as_str().and_then(|t| t.parse().ok()).unwrap();
                    ((time * 1000.0).round() as i64, frame["num_rects"].as_u64().unwrap_or(0) as u32)
                })
                .collect()
        };
        let source = PathBuf::from(path);
        let parsed = parse(std::fs::read(&source).unwrap()).unwrap();
        let lines = lines(&parsed.sets);
        let shown = decoded(&source);
        println!("{}: {} display sets, {} lines, FFmpeg decodes {} subtitles", source.display(), parsed.sets.len(), lines.len(), shown.len());

        // 25 → 23.976 fps and half a second later.
        let ratio = 25.0 / 23.976;
        let at = |ms: i64| (ms as f64 * ratio + 500.0).round() as i64;
        let placed: HashMap<usize, (i64, i64)> = lines.iter().enumerate().map(|(n, line)| (n, (at(ms(line.start)), at(ms(line.end))))).collect();
        let dir = tempfile::tempdir().unwrap();
        let moved_path = dir.path().join("moved.sup");
        std::fs::write(&moved_path, retime(&parsed, &lines, &placed).unwrap()).unwrap();
        let moved = decoded(&moved_path);
        assert_eq!(moved.len(), shown.len(), "FFmpeg decodes as many subtitles");
        let worst = shown.iter().zip(&moved).map(|(was, now)| {
            assert_eq!(was.1, now.1, "the same pictures");
            (now.0 - at(was.0)).abs()
        }).max().unwrap_or(0);
        println!("moved: worst {worst} ms from where it was put");
        assert!(worst <= 2);

        // Into Matroska and back.
        let mks = dir.path().join("moved.mks");
        let back = dir.path().join("back.sup");
        let status = crate::hidden_command("mkvmerge").arg("-q").arg("-o").arg(&mks).arg(&moved_path).status().unwrap();
        assert!(status.code().is_some_and(|code| code <= 1));
        extract(&mks, 0, &back, &AtomicBool::new(false), |_| {}).unwrap();
        let round_trip = decoded(&back);
        assert_eq!(round_trip.len(), moved.len());
        let drift = moved.iter().zip(&round_trip).map(|(a, b)| (a.0 - b.0).abs()).max().unwrap_or(0);
        println!("through Matroska: worst {drift} ms");
        assert!(drift <= 1);
    }

    #[test]
    fn lines_run_from_the_picture_to_the_clear_and_fades_stay_in_them() {
        let parsed = parse(sup(&[(1000, 2500), (3000, 4000), (4000, 6000)], &[1])).unwrap();
        // Each line: picture, (fade), clear.
        assert_eq!(parsed.sets.len(), 7);
        let lines = lines(&parsed.sets);
        let times: Vec<(u32, u32)> = lines.iter().map(|line| (line.start / 90, line.end / 90)).collect();
        assert_eq!(times, vec![(1000, 2500), (3000, 4000), (4000, 6000)]);
        assert_eq!(lines[1].end_set, Some(4), "the fade at 3.5 s is no line of its own");
    }

    #[test]
    fn a_picture_replacing_another_ends_it_and_the_last_line_gets_an_end() {
        let bytes = stream(&[Event::Show(1000), Event::Show(1500), Event::Clear(1500), Event::Show(9000)]);
        let lines = lines(&parse(bytes).unwrap().sets);
        assert_eq!(lines.len(), 3);
        assert_eq!((lines[0].start / 90, lines[0].end / 90, lines[0].end_set), (1000, 1500, Some(1)));
        // The clear at the same moment as the second picture leaves it 0 long.
        assert_eq!((lines[1].start, lines[1].end), (1500 * 90, 1500 * 90));
        assert_eq!(lines[2].end, lines[2].start + LAST_LINE_TICKS);
        // Lines 0 long are not sent to the engine.
        assert_eq!(timing_srt(&lines).matches("-->").count(), 2);
    }

    #[test]
    fn what_is_not_pgs_is_refused() {
        assert!(parse(b"1\n00:00:01,000 --> 00:00:02,000\nHi\n".to_vec()).unwrap_err().contains("not a Blu-ray"));
        assert!(parse(Vec::new()).unwrap_err().contains("no subtitles"));
    }

    #[test]
    fn junk_between_segments_is_stepped_over_and_kept() {
        let first = sup(&[(1000, 2000)], &[]);
        let mut bytes = first.clone();
        bytes.extend_from_slice(b"\x00\x13junk");
        bytes.extend(sup(&[(3000, 4000)], &[]));
        let parsed = parse(bytes.clone()).unwrap();
        assert_eq!(lines(&parsed.sets).len(), 2);
        let moved = retime(&parsed, &lines(&parsed.sets), &HashMap::from([(0, (2000, 3000)), (1, (4000, 5000))])).unwrap();
        assert_eq!(&moved[first.len()..first.len() + 6], b"\x00\x13junk");
        assert_eq!(timeline(&moved).first().map(|(pts, _)| pts / 90), Some(2000));
    }

    #[test]
    fn the_timing_srt_round_trips_through_the_reader() {
        let lines = lines(&parse(sup(&[(1000, 2500), (61_234, 63_000)], &[])).unwrap().sets);
        let srt = timing_srt(&lines);
        assert_eq!(srt, "1\n00:00:01,000 --> 00:00:02,500\nline 0\n\n2\n00:01:01,234 --> 00:01:03,000\nline 1\n\n");
        let placed = read_timing_srt(&srt);
        assert_eq!(placed[&0], (1000, 2500));
        assert_eq!(placed[&1], (61_234, 63_000));
        // What the engine writes: a BOM, CRLF, renumbered, dot fractions.
        let engine = "\u{feff}1\r\n00:00:03.5 --> 00:00:05,000\r\nline 1\r\n\r\n";
        assert_eq!(read_timing_srt(engine), HashMap::from([(1, (3500, 5000))]));
    }

    #[test]
    fn a_shift_moves_every_segment_and_keeps_the_pictures() {
        let original = sup(&[(1000, 2500), (3000, 4000)], &[0]);
        let parsed = parse(original.clone()).unwrap();
        let lines = lines(&parsed.sets);
        let placed = HashMap::from([(0, (3500, 5000)), (1, (5500, 6500))]);
        let moved = retime(&parsed, &lines, &placed).unwrap();
        let before = timeline(&original);
        let after = timeline(&moved);
        assert_eq!(before.len(), after.len());
        for ((was, kind), (now, same)) in before.iter().zip(&after) {
            assert_eq!(kind, same);
            assert_eq!(*now, was + 2500 * 90);
        }
        // Only the timestamps differ.
        let strip = |bytes: &[u8]| {
            let mut out = bytes.to_vec();
            let mut at = 0;
            while at + HEADER_LEN <= out.len() {
                out[at + 2..at + 10].fill(0);
                at += HEADER_LEN + be16(&out, at + 11);
            }
            out
        };
        assert_eq!(strip(&original), strip(&moved));
    }

    #[test]
    fn a_stretch_moves_ends_and_fades_in_proportion() {
        let parsed = parse(sup(&[(10_000, 12_000)], &[0])).unwrap();
        let lines = lines(&parsed.sets);
        // 25 → 23.976 fps: everything × 1.0427.
        let placed = HashMap::from([(0, (10_427, 12_513))]);
        let sets: Vec<u32> = parse(retime(&parsed, &lines, &placed).unwrap()).unwrap().sets.iter().map(|set| set.pts / 90).collect();
        assert_eq!(sets, vec![10_427, 11_470, 12_513]);
    }

    #[test]
    fn a_dropped_line_moves_with_the_one_before_and_nothing_goes_back_in_time() {
        let parsed = parse(sup(&[(1000, 2000), (3000, 4000), (5000, 6000)], &[])).unwrap();
        let lines = lines(&parsed.sets);
        // Line 1 dropped (a cut), line 2 pulled 4 s earlier: past line 1.
        let placed = HashMap::from([(0, (1500, 2500)), (2, (1000, 2000))]);
        let sets: Vec<u32> = parse(retime(&parsed, &lines, &placed).unwrap()).unwrap().sets.iter().map(|set| set.pts / 90).collect();
        assert_eq!(sets, vec![1500, 2500, 3500, 4500, 4500, 4500]);
        assert!(retime(&parsed, &lines, &HashMap::new()).is_err());
    }

    #[test]
    fn nothing_goes_before_the_start() {
        let parsed = parse(sup(&[(1000, 2000), (3000, 4000)], &[])).unwrap();
        let lines = lines(&parsed.sets);
        let placed = HashMap::from([(0, (-500, 500)), (1, (1500, 2500))]);
        let sets: Vec<u32> = parse(retime(&parsed, &lines, &placed).unwrap()).unwrap().sets.iter().map(|set| set.pts / 90).collect();
        assert_eq!(sets, vec![0, 500, 1500, 2500]);
    }
}
