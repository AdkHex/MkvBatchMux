/**
 * Fetch ffmpeg + ffprobe into src-tauri/resources/ffmpeg so the installer can bundle them.
 * Falls back to whatever is on PATH when nothing is bundled (the normal state of a dev checkout).
 *
 * Usage:
 *   npm run fetch-ffmpeg                       # download a build for this platform
 *   FFMPEG_DIR=/path/to/bin npm run fetch-ffmpeg   # copy from a local directory
 */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const root = process.cwd();
const destination = path.join(root, "src-tauri", "resources", "ffmpeg");
const isWindows = process.platform === "win32";
const exe = (name) => (isWindows ? `${name}.exe` : name);

/** Fail with something the reader can act on. On GitHub Actions the reason
 *  is also written as an error annotation, which the run's summary (and its
 *  API) shows without opening the job's log. */
function fail(message, hint) {
  console.error(`\nfetch-ffmpeg: ${message}\n`);
  if (hint) console.error(`${hint}\n`);
  if (process.env.GITHUB_ACTIONS) {
    const text = [message, hint].filter(Boolean).join(" -- ").replace(/%/g, "%25").replace(/\r?\n/g, "%0A");
    console.log(`::error title=fetch-ffmpeg::${text}`);
  }
  process.exit(1);
}

// Static LGPL builds: no runtime shared libraries, and no GPL-only components,
// so the binaries can ship inside a proprietary installer.
// The builds moved from github.com/BtbN to github.com/FFmpeg-Builds; the old
// address only redirects here.
const BTBN = "https://github.com/FFmpeg-Builds/FFmpeg-Builds/releases/download/latest";

function downloadUrl() {
  const arch = process.arch;
  if (process.platform === "win32" && arch === "x64") {
    return { url: `${BTBN}/ffmpeg-n8.1-latest-win64-lgpl-8.1.zip`, archive: "zip" };
  }
  if (process.platform === "linux" && arch === "x64") {
    return { url: `${BTBN}/ffmpeg-n8.1-latest-linux64-lgpl-8.1.tar.xz`, archive: "tar.xz" };
  }
  if (process.platform === "darwin") {
    // evermeet.cx publishes ffmpeg and ffprobe as separate archives.
    return {
      url: [
        "https://evermeet.cx/ffmpeg/getrelease/ffmpeg/zip",
        "https://evermeet.cx/ffmpeg/getrelease/ffprobe/zip",
      ],
      archive: "zip-pair",
    };
  }
  fail(
    `No FFmpeg download is configured for ${process.platform}/${arch}.`,
    "Set FFMPEG_DIR to a directory containing ffmpeg and ffprobe to copy them instead.",
  );
}

/** Clear previously fetched binaries but keep the committed README, which is
 *  what holds the directory in git for checkouts that never fetch. */
function emptyDestination() {
  fs.mkdirSync(destination, { recursive: true });
  for (const entry of fs.readdirSync(destination)) {
    if (entry === "README.md") continue;
    fs.rmSync(path.join(destination, entry), { recursive: true, force: true });
  }
}

/** Run a tool; null when it worked, else why not, with the end of what it
 *  printed (Expand-Archive and tar explain themselves only there). */
function attempt(command, args, options = {}) {
  const result = spawnSync(command, args, { stdio: "pipe", encoding: "utf8", ...options });
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  if (result.error) return `Could not run ${command}: ${result.error.message}`;
  if (result.status !== 0) {
    const said = `${result.stderr || ""}${result.stdout || ""}`.trim().slice(-800);
    return `${command} exited with code ${result.status}.${said ? ` ${said}` : ""}`;
  }
  return null;
}

function run(command, args, options = {}) {
  const problem = attempt(command, args, options);
  if (problem) fail(problem);
}

/** What an archive body starts with: zip's local file header, xz's magic. */
function archiveKind(body) {
  if (body.length > 4 && body[0] === 0x50 && body[1] === 0x4b && body[2] === 0x03 && body[3] === 0x04) return "zip";
  if (body.length > 6 && body.subarray(0, 6).equals(Buffer.from([0xfd, 0x37, 0x7a, 0x58, 0x5a, 0x00]))) return "xz";
  return null;
}

/** Waits between download attempts. The builds' "latest" release is replaced
 *  every day, its files deleted and uploaded again, so a release build that
 *  lands in that window gets a 404 or a cut-off transfer that a later try does
 *  not; one failed attempt should not cost a release. */
const RETRY_DELAYS_MS = [10_000, 30_000, 60_000, 120_000];

async function download(url, into) {
  for (let tries = 0; ; tries += 1) {
    console.log(`fetch-ffmpeg: downloading ${url}${tries ? ` (attempt ${tries + 1})` : ""}`);
    let problem;
    try {
      const response = await fetch(url, { redirect: "follow" });
      if (response.ok) {
        const body = Buffer.from(await response.arrayBuffer());
        const kind = archiveKind(body);
        if (kind) {
          fs.writeFileSync(into, body);
          return;
        }
        // A page in place of the file (an error, a sign-in, a cut-off transfer).
        problem = `the response is not an archive (${response.headers.get("content-type") || "no content type"}, ${body.length} bytes, from ${response.url})`;
      } else {
        problem = `${response.status} ${response.statusText}`;
        // Gone for good: asking again only delays the failure.
        if (response.status === 410) fail(`Download failed: ${problem}`, `URL: ${url}`);
      }
    } catch (error) {
      problem = error instanceof Error ? error.message : String(error);
    }
    if (tries >= RETRY_DELAYS_MS.length) fail(`Download failed: ${problem}`, `URL: ${url}`);
    console.log(`fetch-ffmpeg: download failed (${problem}); trying again in ${RETRY_DELAYS_MS[tries] / 1000} s`);
    await new Promise((resolve) => setTimeout(resolve, RETRY_DELAYS_MS[tries]));
  }
}

/** Pull the two binaries out of an extracted tree, wherever they landed. */
function harvest(fromDir) {
  const wanted = new Set([exe("ffmpeg"), exe("ffprobe")]);
  const found = new Map();

  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (wanted.has(entry.name) && !found.has(entry.name)) found.set(entry.name, full);
    }
  };
  walk(fromDir);

  for (const name of wanted) {
    const source = found.get(name);
    if (!source) {
      fail(
        `The archive did not contain ${name}.`,
        "The upstream layout may have changed; check the download URL in this script.",
      );
    }
    const target = path.join(destination, name);
    fs.copyFileSync(source, target);
    if (!isWindows) fs.chmodSync(target, 0o755);
  }
}

/** Confirm the result actually runs before declaring success. */
function verify() {
  for (const name of ["ffmpeg", "ffprobe"]) {
    const binary = path.join(destination, exe(name));
    if (!fs.existsSync(binary)) fail(`${exe(name)} is missing from ${destination}.`);
    const probe = spawnSync(binary, ["-version"], { stdio: "pipe" });
    if (probe.status !== 0) {
      fail(
        `${exe(name)} was fetched but does not run on this machine.`,
        String(probe.stderr || probe.error?.message || "").trim(),
      );
    }
    const version = String(probe.stdout).split("\n")[0];
    console.log(`fetch-ffmpeg: ${version}`);
  }
  console.log(`\nfetch-ffmpeg: ffmpeg and ffprobe ready in ${destination}\n`);
}

const local = process.env.FFMPEG_DIR;
if (local) {
  if (!fs.existsSync(local)) fail(`FFMPEG_DIR is set to "${local}", which does not exist.`);
  console.log(`fetch-ffmpeg: copying from ${local}`);
  emptyDestination();
  harvest(local);
  verify();
  process.exit(0);
}

const { url, archive } = downloadUrl();
const work = fs.mkdtempSync(path.join(os.tmpdir(), "mkvbatchmux-ffmpeg-"));

try {
  emptyDestination();

  if (archive === "zip-pair") {
    for (const single of url) {
      const zip = path.join(work, `${path.basename(single)}.zip`);
      await download(single, zip);
      run("unzip", ["-o", "-q", zip, "-d", work]);
    }
  } else if (archive === "zip") {
    const zip = path.join(work, "ffmpeg.zip");
    await download(url, zip);
    // PowerShell's Expand-Archive is always present on the Windows runners.
    if (isWindows) {
      const expanded = attempt("powershell", [
        "-NoProfile",
        "-Command",
        `Expand-Archive -Path "${zip}" -DestinationPath "${work}" -Force`,
      ]);
      if (expanded) {
        // Windows 10 and later also ship bsdtar, which reads zip archives.
        console.log(`fetch-ffmpeg: Expand-Archive failed (${expanded}); trying tar`);
        const untarred = attempt("tar", ["-xf", zip, "-C", work]);
        if (untarred) fail(`Could not unpack the download. Expand-Archive: ${expanded} tar: ${untarred}`);
      }
    } else {
      run("unzip", ["-o", "-q", zip, "-d", work]);
    }
  } else {
    const tarball = path.join(work, "ffmpeg.tar.xz");
    await download(url, tarball);
    run("tar", ["-xf", tarball, "-C", work]);
  }

  harvest(work);
  verify();
} finally {
  fs.rmSync(work, { recursive: true, force: true });
}
