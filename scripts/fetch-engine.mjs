/**
 * Build (or copy) the AudioSync analysis engine into src-tauri/resources/engine.
 *
 * The engine is not vendored into this repo: it is under active development in
 * AudioSyncMaster, and a duplicated copy of the Python source would silently
 * diverge from the fixes that make its measurements accurate. This script
 * builds it from that checkout instead.
 *
 * Usage:
 *   npm run fetch-engine                    # build from the sibling checkout
 *   AUDIOSYNC_REPO=/path/to/repo npm run fetch-engine
 *   AUDIOSYNC_ENGINE_DIR=/path/to/built npm run fetch-engine   # copy a prebuilt tree
 */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const destination = path.join(root, "src-tauri", "resources", "engine");

/** Fail with something the reader can act on. A silently engine-less build is
 *  the one outcome this script exists to prevent. */
function fail(message, hint) {
  console.error(`\nfetch-engine: ${message}\n`);
  if (hint) console.error(`${hint}\n`);
  process.exit(1);
}

function resolveRepo() {
  const explicit = process.env.AUDIOSYNC_REPO;
  if (explicit) {
    if (!fs.existsSync(path.join(explicit, "python", "bridge.py"))) {
      fail(
        `AUDIOSYNC_REPO is set to "${explicit}", but that is not an AudioSyncMaster checkout.`,
        "Expected to find python/bridge.py inside it.",
      );
    }
    return explicit;
  }

  // The sibling layout, which is how the two repos sit in practice.
  const sibling = path.resolve(root, "..", "AudioSyncMaster");
  if (fs.existsSync(path.join(sibling, "python", "bridge.py"))) {
    return sibling;
  }

  fail(
    "Could not find the AudioSyncMaster checkout.",
    `Looked for a sibling directory at ${sibling}.\n` +
      "Set AUDIOSYNC_REPO to its location, or AUDIOSYNC_ENGINE_DIR to a prebuilt engine tree.",
  );
}

/** Clear a previous build but keep the committed README, which is what holds
 *  the directory in git for checkouts that never build the engine. */
function emptyDestination() {
  fs.mkdirSync(destination, { recursive: true });
  for (const entry of fs.readdirSync(destination)) {
    if (entry === "README.md") continue;
    fs.rmSync(path.join(destination, entry), { recursive: true, force: true });
  }
}

function copyTree(from, to) {
  fs.cpSync(from, to, { recursive: true });
}

const exeName = process.platform === "win32" ? "audiosync-cli.exe" : "audiosync-cli";

/** Confirm the result is actually runnable before declaring success. */
function verify() {
  const direct = path.join(destination, exeName);
  const nested = path.join(destination, "audiosync-cli", exeName);
  const found = [direct, nested].find((candidate) => fs.existsSync(candidate));
  if (!found) {
    fail(
      `The build finished but no ${exeName} was produced in ${destination}.`,
      "Check the PyInstaller output above for the real failure.",
    );
  }
  if (process.platform !== "win32") {
    // PyInstaller sets this itself, but a copied tree can lose the bit.
    fs.chmodSync(found, 0o755);
  }
  console.log(`\nfetch-engine: engine ready at ${found}\n`);
}

const prebuilt = process.env.AUDIOSYNC_ENGINE_DIR;
if (prebuilt) {
  if (!fs.existsSync(prebuilt)) {
    fail(`AUDIOSYNC_ENGINE_DIR is set to "${prebuilt}", which does not exist.`);
  }
  console.log(`fetch-engine: copying prebuilt engine from ${prebuilt}`);
  emptyDestination();
  copyTree(prebuilt, destination);
  verify();
  process.exit(0);
}

const repo = resolveRepo();
const spec = path.join(repo, "audiosync-cli.spec");
if (!fs.existsSync(spec)) {
  fail(
    `No audiosync-cli.spec found in ${repo}.`,
    "The engine build needs AudioSyncMaster's PyInstaller spec file.",
  );
}

// Prefer the checkout's own virtualenv, which is where its pinned PyInstaller
// and the engine's dependencies live.
const venvPython =
  process.platform === "win32"
    ? path.join(repo, "python", ".venv", "Scripts", "python.exe")
    : path.join(repo, "python", ".venv", "bin", "python");
const python = fs.existsSync(venvPython)
  ? venvPython
  : process.platform === "win32"
    ? "python"
    : "python3";

console.log(`fetch-engine: building the engine from ${repo}`);
console.log(`fetch-engine: using ${python}`);

const buildDir = path.join(repo, "build", "mkvbatchmux-engine");
const distDir = path.join(repo, "dist", "mkvbatchmux-engine");

const result = spawnSync(
  python,
  [
    "-m",
    "PyInstaller",
    "--noconfirm",
    "--distpath",
    distDir,
    "--workpath",
    buildDir,
    spec,
  ],
  { cwd: repo, stdio: "inherit" },
);

if (result.error) {
  fail(
    `Could not run PyInstaller: ${result.error.message}`,
    `Install it in the AudioSyncMaster checkout: ${python} -m pip install pyinstaller`,
  );
}
if (result.status !== 0) {
  fail(
    `PyInstaller exited with code ${result.status}.`,
    "The engine was not built; see the output above.",
  );
}

// The spec produces dist/<name>/; take whichever directory it created.
const produced = fs.existsSync(path.join(distDir, "audiosync-cli"))
  ? path.join(distDir, "audiosync-cli")
  : distDir;

if (!fs.existsSync(produced)) {
  fail(`PyInstaller reported success but ${produced} does not exist.`);
}

emptyDestination();
copyTree(produced, destination);
verify();
