/**
 * Build (or copy) the AudioSync analysis engine into src-tauri/resources/engine.
 *
 * The engine is not vendored into this repo: it is under active development in
 * AudioSyncMaster, and a duplicated copy of the Python source would silently
 * diverge from the fixes that make its measurements accurate. This script
 * builds it from that checkout instead.
 *
 * Which revision gets built is pinned in package.json under `audiosyncEngine`,
 * and it is the release the AudioSyncMaster app itself ships. That pin is the
 * whole reason the two apps agree: they only measure the same delay for the
 * same files when they run the same engine code, and "whatever AudioSyncMaster's
 * main branch held at build time" is not the same engine as "the AudioSyncMaster
 * release installed on the user's machine". Building from an unreleased commit
 * once shipped an engine that flagged cuts and drift on files the released one
 * measured cleanly, and the two apps disagreed by tens of milliseconds -- with
 * nothing in either app to say why.
 *
 * Usage:
 *   npm run fetch-engine                    # build from the sibling checkout
 *   AUDIOSYNC_REPO=/path/to/repo npm run fetch-engine
 *   AUDIOSYNC_ENGINE_DIR=/path/to/built npm run fetch-engine   # copy a prebuilt tree
 *   AUDIOSYNC_ALLOW_UNPINNED=1 npm run fetch-engine            # build whatever the
 *                                                              # checkout has (dev only)
 *
 * To move both apps to a newer engine, bump `audiosyncEngine.ref` to the new
 * AudioSyncMaster release tag in one commit, so the change is visible in
 * history rather than happening silently on the next CI run.
 */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const destination = path.join(root, "src-tauri", "resources", "engine");

/** Stamped beside the built engine and read back by the app, so Settings can
 *  show which engine build is measuring -- the one fact that was missing when
 *  the two apps disagreed. Must match ENGINE_VERSION_FILE in audiosync.rs. */
const VERSION_FILE = "ENGINE_VERSION";

/** Fail with something the reader can act on. A silently engine-less build is
 *  the one outcome this script exists to prevent. */
function fail(message, hint) {
  console.error(`\nfetch-engine: ${message}\n`);
  if (hint) console.error(`${hint}\n`);
  process.exit(1);
}

function readPin() {
  const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
  const pin = pkg.audiosyncEngine;
  if (!pin || typeof pin.ref !== "string" || !pin.ref) {
    fail(
      "package.json has no audiosyncEngine.ref.",
      'Add { "audiosyncEngine": { "repository": "AdkHex/AudioSyncMaster", "ref": "v2.8.0" } }.',
    );
  }
  return pin;
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

  // A sibling checkout, at this level or any above it -- the same walk the
  // app's own development fallback makes (audiosync.rs: dev_bridge_script),
  // so the two find the same checkout.
  const tried = [];
  for (let dir = root; ; dir = path.dirname(dir)) {
    const candidate = path.join(path.dirname(dir), "AudioSyncMaster");
    tried.push(candidate);
    if (fs.existsSync(path.join(candidate, "python", "bridge.py"))) {
      return candidate;
    }
    if (path.dirname(dir) === dir) break;
  }

  fail(
    "Could not find the AudioSyncMaster checkout.",
    `Looked for a sibling directory at:\n${tried.map((t) => `    ${t}`).join("\n")}\n` +
      "Set AUDIOSYNC_REPO to its location, or AUDIOSYNC_ENGINE_DIR to a prebuilt engine tree.",
  );
}

/** Run git in the checkout; null when git is missing or the command fails. */
function git(repo, args) {
  const result = spawnSync("git", ["-C", repo, ...args], { stdio: "pipe", encoding: "utf8" });
  if (result.error || result.status !== 0) return null;
  return result.stdout.trim();
}

/**
 * Confirm the checkout is at the pinned revision with a clean engine tree.
 *
 * Returns the version string to stamp on the build. Refuses anything else
 * unless AUDIOSYNC_ALLOW_UNPINNED is set -- and then says so in the stamp, so a
 * build made that way can never be mistaken for a release engine.
 */
function verifyCheckout(repo, pin) {
  const allowUnpinned = process.env.AUDIOSYNC_ALLOW_UNPINNED === "1";
  const head = git(repo, ["rev-parse", "HEAD"]);
  if (!head) {
    if (allowUnpinned) {
      console.warn("fetch-engine: not a git checkout; building it unverified.");
      return `unknown (unverified build from ${repo})`;
    }
    fail(
      `${repo} is not a git checkout, so it cannot be verified against the pinned ${pin.ref}.`,
      "Clone AudioSyncMaster with git, or set AUDIOSYNC_ALLOW_UNPINNED=1 to build it anyway.",
    );
  }

  const described = git(repo, ["describe", "--tags", "--always", "--dirty"]) ?? head.slice(0, 7);
  const pinned = git(repo, ["rev-parse", "--verify", "--quiet", `${pin.ref}^{commit}`]);
  // Only the engine's own files matter: an edit to the AudioSyncMaster UI does
  // not change what this build measures. Untracked files do not either -- a
  // venv or __pycache__ is not a source change, and a new module can only be
  // reached through an edit to a tracked one, which does show up here.
  const dirty = git(repo, [
    "status",
    "--porcelain",
    "--untracked-files=no",
    "--",
    "audiosync",
    "python",
  ]);

  const problems = [];
  if (!pinned) {
    problems.push(
      `The pinned ref ${pin.ref} is not known to that checkout. Run: git -C "${repo}" fetch --tags`,
    );
  } else if (pinned !== head) {
    problems.push(
      `The checkout is at ${described} (${head.slice(0, 7)}), not the pinned ${pin.ref} ` +
        `(${pinned.slice(0, 7)}). Run: git -C "${repo}" checkout ${pin.ref}`,
    );
  }
  if (dirty) {
    problems.push(
      "The engine sources have uncommitted changes:\n" +
        dirty
          .split("\n")
          .map((line) => `    ${line}`)
          .join("\n"),
    );
  }

  if (problems.length === 0) {
    return `AudioSyncMaster ${pin.ref} (${head.slice(0, 7)})`;
  }

  if (!allowUnpinned) {
    fail(
      `The AudioSyncMaster checkout at ${repo} does not match the pinned engine.`,
      problems.join("\n\n") +
        "\n\nThe app must ship the same engine the AudioSyncMaster release ships, or the two " +
        "report different delays for the same files. To build the checkout as it is anyway " +
        "(for local testing of an unreleased engine), set AUDIOSYNC_ALLOW_UNPINNED=1.",
    );
  }

  console.warn(`fetch-engine: building an UNPINNED engine (${described}); the pin is ${pin.ref}.`);
  for (const problem of problems) console.warn(`fetch-engine:   ${problem.split("\n")[0]}`);
  return `AudioSyncMaster ${described} (${head.slice(0, 7)}) -- UNPINNED, release is ${pin.ref}`;
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

function writeVersion(version) {
  fs.writeFileSync(path.join(destination, VERSION_FILE), `${version}\n`);
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
  // An engine that cannot import its dependencies is the most common
  // packaging failure, and it is invisible until a user presses Measure.
  const ping = spawnSync(found, [], { input: '{"command":"ping"}\n', encoding: "utf8" });
  if (ping.error || !String(ping.stdout).includes('"pong"')) {
    fail(
      `${found} started but did not answer a ping.`,
      (ping.error ? ping.error.message : String(ping.stderr).trim().split("\n").slice(-5).join("\n")) ||
        "No output. Check the PyInstaller hidden imports.",
    );
  }
  const version = fs.readFileSync(path.join(destination, VERSION_FILE), "utf8").trim();
  console.log(`\nfetch-engine: engine ready at ${found}`);
  console.log(`fetch-engine: ${version}\n`);
}

const pin = readPin();

const prebuilt = process.env.AUDIOSYNC_ENGINE_DIR;
if (prebuilt) {
  if (!fs.existsSync(prebuilt)) {
    fail(`AUDIOSYNC_ENGINE_DIR is set to "${prebuilt}", which does not exist.`);
  }
  console.log(`fetch-engine: copying prebuilt engine from ${prebuilt}`);
  emptyDestination();
  copyTree(prebuilt, destination);
  // A tree built by this script carries its own stamp; one from anywhere else
  // is recorded as exactly that rather than claimed to be the pinned release.
  if (!fs.existsSync(path.join(destination, VERSION_FILE))) {
    writeVersion(`unknown (prebuilt copy from ${prebuilt}; pin is ${pin.ref})`);
  }
  verify();
  process.exit(0);
}

const repo = resolveRepo();

const entry = path.join(repo, "python", "bridge.py");
if (!fs.existsSync(entry)) {
  fail(
    `No python/bridge.py found in ${repo}.`,
    "That file is the engine's entry point; the checkout looks incomplete.",
  );
}

const version = verifyCheckout(repo, pin);

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

console.log(`fetch-engine: building ${version} from ${repo}`);
console.log(`fetch-engine: using ${python}`);

const buildDir = path.join(repo, "build", "mkvbatchmux-pyi");
const distDir = path.join(repo, "build", "mkvbatchmux-engine");

// These flags are AudioSyncMaster's own release workflow's, verbatim (its
// .github/workflows, "Build the analysis engine"), so the bundle here is built
// the way the bundle in the AudioSyncMaster installer is. In particular
// --onedir, NOT --onefile: a onefile build re-extracts itself to a temp
// directory on every launch, which for an engine spawned per batch is both
// slow and a reliable source of antivirus false positives. The hidden imports
// are what let the frozen engine find its own package: without --paths the
// build only worked because `python -m` happened to put the cwd on sys.path.
const result = spawnSync(
  python,
  [
    "-m",
    "PyInstaller",
    "--onedir",
    "--clean",
    "--noconfirm",
    "--log-level",
    "WARN",
    "--distpath",
    distDir,
    "--workpath",
    buildDir,
    "--specpath",
    buildDir,
    "--name",
    "audiosync-cli",
    "--paths",
    ".",
    ...[
      "audiosync",
      "audiosync.analyze",
      "audiosync.batch",
      "audiosync.correlate",
      "audiosync.matching",
      "audiosync.media",
      "audiosync.mux",
    ].flatMap((module) => ["--hidden-import", module]),
    "--collect-all",
    "numpy",
    ...["scipy", "matplotlib", "tkinter", "PIL", "pandas", "pytest"].flatMap((module) => [
      "--exclude-module",
      module,
    ]),
    entry,
  ],
  { cwd: repo, stdio: "inherit" },
);

if (result.error) {
  fail(
    `Could not run PyInstaller: ${result.error.message}`,
    `Install it first: ${python} -m pip install pyinstaller`,
  );
}
if (result.status !== 0) {
  fail(
    `PyInstaller exited with code ${result.status}.`,
    "The engine was not built; see the output above.",
  );
}

// --onedir puts everything under dist/<name>/.
const produced = path.join(distDir, "audiosync-cli");
if (!fs.existsSync(produced)) {
  fail(`PyInstaller reported success but ${produced} does not exist.`);
}

emptyDestination();
copyTree(produced, destination);
writeVersion(version);
verify();
