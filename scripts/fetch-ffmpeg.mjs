/**
 * Fetch ffmpeg + ffprobe into src-tauri/resources/ffmpeg so the installer can
 * bundle them.
 *
 * Delay measurement shells out to both tools. Requiring the user to install
 * FFmpeg themselves meant a fresh install silently disabled the feature, so
 * release builds ship a known-good pair instead. The app still falls back to
 * whatever is on PATH when nothing is bundled (which is the normal state of a
 * development checkout).
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

/** Fail with something the reader can act on. */
function fail(message, hint) {
  console.error(`\nfetch-ffmpeg: ${message}\n`);
  if (hint) console.error(`${hint}\n`);
  process.exit(1);
}

/** Static builds, chosen because they need no runtime shared libraries. */
function downloadUrl() {
  const arch = process.arch;
  if (process.platform === "win32" && arch === "x64") {
    return {
      url: "https://github.com/GyanD/codexffmpeg/releases/download/7.1/ffmpeg-7.1-essentials_build.zip",
      archive: "zip",
    };
  }
  if (process.platform === "linux" && arch === "x64") {
    return {
      url: "https://johnvansickle.com/ffmpeg/releases/ffmpeg-release-amd64-static.tar.xz",
      archive: "tar.xz",
    };
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

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { stdio: "inherit", ...options });
  if (result.error) fail(`Could not run ${command}: ${result.error.message}`);
  if (result.status !== 0) fail(`${command} exited with code ${result.status}.`);
}

async function download(url, into) {
  console.log(`fetch-ffmpeg: downloading ${url}`);
  const response = await fetch(url, { redirect: "follow" });
  if (!response.ok) {
    fail(`Download failed: ${response.status} ${response.statusText}`, `URL: ${url}`);
  }
  fs.writeFileSync(into, Buffer.from(await response.arrayBuffer()));
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
      run("powershell", [
        "-NoProfile",
        "-Command",
        `Expand-Archive -Path "${zip}" -DestinationPath "${work}" -Force`,
      ]);
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
