// Remote switch and access password for installed copies of MKVBatchMux (docs/REMOTE-STATUS.md).
//
//   node scripts/mkvbatchmux-status.mjs status                 what the published document says
//   node scripts/mkvbatchmux-status.mjs maintenance ["message"] [--title t]
//   node scripts/mkvbatchmux-status.mjs ok [--min-version x] [--update-url u]
//   node scripts/mkvbatchmux-status.mjs password               set or change the access password (asked twice, hidden)
//   node scripts/mkvbatchmux-status.mjs password --off         no password
//
// Every change starts from the published document and touches only its own fields:
// maintenance and ok keep the password, password keeps the status. `ok` drops the
// maintenance text and any --min-version / --update-url not given again.
// Options:
//   --check-minutes n     how often the apps poll, 1..60 (kept when not given; 5 at first)
//   --out <file>          local copy (default ./remote-status/status.json)
//   --no-publish          change the local copy only (and start from it, not from the gist)
//   --serve <port>        serve the local copy on http://127.0.0.1:<port>/status.json for a
//                         debug build (implies --no-publish unless --publish is given)
//   --publish             publish even with --serve
//   serve --serve <port>  only serve the local copy (re-read on every request)
//
// The password never leaves this machine and is never printed or written: the
// document gets a salted PBKDF2-SHA256 hash of it. Piped input (not a terminal)
// is read as the password, for scripts and tests.
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";

// ---- where the published document lives (the URL baked into src-tauri/remote-status.json)
const GIST_ID = "0f0138ee791d85dc99e42d875600faa5";
const GIST_FILE = "mkvbatchmux-status.json";
const RAW_URL = `https://gist.githubusercontent.com/AdkHex/${GIST_ID}/raw/${GIST_FILE}`;

// ---- the password hash; src-tauri/src/remote_status.rs checks exactly this
const ALG = "pbkdf2-sha256";
const ITERATIONS = 600_000;
const MIN_PASSWORD = 8;

const argv = process.argv.slice(2);
const BOOL_FLAGS = ["--no-publish", "--publish", "--off", "--help", "-h"];
const VALUE_FLAGS = ["--title", "--min-version", "--update-url", "--check-minutes", "--out", "--serve"];
const flags = new Set(argv.filter((a) => BOOL_FLAGS.includes(a)));
const opt = (k, d) => (argv.includes(k) ? argv[argv.indexOf(k) + 1] : d);
const positional = argv.filter((a, i) => !a.startsWith("--") && a !== "-h" && !VALUE_FLAGS.includes(argv[i - 1]));
const [mode, message] = positional;

function die(msg) {
  console.error(`mkvbatchmux-status: ${msg}`);
  process.exit(1);
}

function usage() {
  const text = fs.readFileSync(new URL(import.meta.url), "utf8").split("\n").filter((l) => l.startsWith("//")).map((l) => l.slice(3));
  console.log(text.join("\n"));
}

function gh(args) {
  try {
    return execFileSync("gh", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  } catch (e) {
    die(`gh ${args.join(" ")} failed: ${(e.stderr || e.message || "").toString().trim()}\n(is the GitHub CLI installed and logged in as the gist owner?)`);
  }
}

function readPublished() {
  return gh(["gist", "view", GIST_ID, "--raw", "--filename", GIST_FILE]).trim();
}

/** The document a change starts from: the published one, or the local copy for --no-publish. */
function readBase(local, file) {
  let raw;
  if (local) {
    if (!fs.existsSync(file)) return {};
    raw = fs.readFileSync(file, "utf8");
  } else {
    raw = readPublished();
  }
  try {
    const doc = JSON.parse(raw);
    if (doc && typeof doc === "object" && !Array.isArray(doc)) return doc;
  } catch {
    /* falls through */
  }
  die(`the ${local ? "local" : "published"} document is not a JSON object; fix or remove it first:\n${raw}`);
}

/** Field order of the published document; unknown fields are kept at the end. */
function ordered(doc) {
  const keys = ["status", "title", "message", "minVersion", "updateUrl", "checkMinutes", "access"];
  const out = {};
  for (const k of keys) if (doc[k] !== undefined) out[k] = doc[k];
  for (const [k, v] of Object.entries(doc)) if (!keys.includes(k) && v !== undefined) out[k] = v;
  return out;
}

function applyCheckMinutes(doc) {
  const given = opt("--check-minutes");
  if (given !== undefined) {
    const minutes = Number(given);
    if (!Number.isFinite(minutes) || minutes < 1 || minutes > 60) die("--check-minutes must be 1..60");
    doc.checkMinutes = Math.round(minutes);
  } else if (doc.checkMinutes === undefined) {
    doc.checkMinutes = 5;
  }
}

function setMaintenance(doc) {
  doc.status = "maintenance";
  // The text belongs to this maintenance: what is not given again is dropped.
  doc.title = opt("--title") || undefined;
  doc.message = message || undefined;
}

function setOk(doc) {
  if (message || opt("--title")) die("ok takes no message or title");
  doc.status = "ok";
  doc.title = undefined;
  doc.message = undefined;
  const minVersion = opt("--min-version");
  const updateUrl = opt("--update-url");
  if (minVersion && !/^v?\d+(\.\d+)*([-+].*)?$/.test(minVersion)) die(`--min-version ${minVersion} is not a version like 1.80.0`);
  if (updateUrl && !/^https?:\/\//i.test(updateUrl)) die("--update-url must be an http(s) address");
  doc.minVersion = minVersion || undefined;
  doc.updateUrl = updateUrl || undefined;
}

/** Read a line without echoing it (a terminal), or the next piped line. */
function readSecret(prompt, piped) {
  if (piped) return Promise.resolve(piped.shift() ?? "");
  return new Promise((resolve) => {
    process.stdout.write(prompt);
    const stdin = process.stdin;
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding("utf8");
    let value = "";
    const onData = (chunk) => {
      for (const ch of chunk) {
        if (ch === "\r" || ch === "\n") {
          stdin.setRawMode(false);
          stdin.pause();
          stdin.off("data", onData);
          process.stdout.write("\n");
          resolve(value);
          return;
        }
        if (ch === "\u0003") {
          stdin.setRawMode(false);
          process.stdout.write("\n");
          process.exit(130);
        }
        if (ch === "\u007f" || ch === "\b") value = value.slice(0, -1);
        else value += ch;
      }
    };
    stdin.on("data", onData);
  });
}

function pipedLines() {
  if (process.stdin.isTTY) return null;
  const text = fs.readFileSync(0, "utf8");
  return text.split(/\r?\n/).filter((line, i, all) => line !== "" || i < all.length - 1);
}

/** The `access` block for a password: salt, PBKDF2-SHA256 hash, and the id an unlock remembers. */
export function accessFor(password, salt = crypto.randomBytes(16), iterations = ITERATIONS) {
  const hash = crypto.pbkdf2Sync(password.normalize("NFC"), salt, iterations, 32, "sha256");
  const id = crypto.createHash("sha256").update(Buffer.concat([salt, hash])).digest("hex").slice(0, 16);
  return { alg: ALG, iterations, salt: salt.toString("base64"), hash: hash.toString("base64"), id };
}

async function setPassword(doc) {
  if (flags.has("--off")) {
    doc.access = undefined;
    return "password off: nobody is asked";
  }
  const piped = pipedLines();
  const first = await readSecret("New access password: ", piped);
  const second = piped && piped.length === 0 ? first : await readSecret("Again: ", piped);
  if (first !== second) die("the two passwords differ; nothing changed");
  if (first.length < MIN_PASSWORD) die(`use at least ${MIN_PASSWORD} characters (a long passphrase is best: the hash is public to anyone with the link)`);
  doc.access = accessFor(first);
  if (doc.status === undefined) doc.status = "ok";
  return `password set (id ${doc.access.id}): every user enters it once on each computer`;
}

function writeLocal(file, doc) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(doc, null, 2) + "\n");
  console.log(`wrote ${file}`);
}

/** Publish step: replace the gist file with the local document. Swap this out to move hosting. */
function publish(file) {
  gh(["gist", "edit", GIST_ID, "--filename", GIST_FILE, file]);
  console.log(`published to gist ${GIST_ID} (${RAW_URL})`);
  console.log("installed copies see it within their checkMinutes plus up to 5 min of GitHub caching");
}

function describe(raw) {
  try {
    const d = JSON.parse(raw);
    const lock =
      d.status === "maintenance"
        ? "LOCKED (maintenance)"
        : d.minVersion
          ? `ok, builds older than ${d.minVersion} locked ("Update required")`
          : "ok (running normally)";
    const pw = d.access ? `password ON (id ${d.access.id})` : "password off";
    return `${lock}; ${pw}; apps check every ${d.checkMinutes ?? 5} min`;
  } catch {
    return "not valid JSON: installed copies ignore it and keep their last known state";
  }
}

function serve(file, port) {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    if (url.pathname !== "/status.json") {
      res.writeHead(404).end("try /status.json");
      return;
    }
    let body;
    try {
      body = fs.readFileSync(file);
    } catch {
      res.writeHead(404).end("no status file yet");
      return;
    }
    res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
    res.end(body);
    console.log(`${new Date().toLocaleTimeString()} GET ${req.url} -> ${describe(body.toString())}`);
  });
  server.listen(port, "127.0.0.1", () => console.log(`serving ${file} on http://127.0.0.1:${port}/status.json`));
}

async function main() {
  if (flags.has("--help") || flags.has("-h") || !mode) {
    usage();
    process.exit(mode ? 0 : 1);
  }
  const out = path.resolve(opt("--out", "remote-status/status.json"));
  const port = opt("--serve") ? Number(opt("--serve")) : null;
  if (port != null && !(port > 0 && port < 65536)) die("--serve needs a port number");
  const local = flags.has("--no-publish") || (port != null && !flags.has("--publish"));

  switch (mode) {
    case "status": {
      const raw = local ? fs.readFileSync(out, "utf8").trim() : readPublished();
      console.log(raw);
      console.log(`\n${describe(raw)}`);
      break;
    }
    case "serve":
      if (port == null) die("serve needs --serve <port>");
      serve(out, port);
      break;
    case "ok":
    case "maintenance":
    case "password": {
      const doc = readBase(local, out);
      let note = "";
      if (mode === "maintenance") setMaintenance(doc);
      else if (mode === "ok") setOk(doc);
      else note = await setPassword(doc);
      applyCheckMinutes(doc);
      const final = ordered(doc);
      writeLocal(out, final);
      console.log(describe(JSON.stringify(final)));
      if (note) console.log(note);
      if (local) console.log("not published (local only)");
      else publish(out);
      if (port != null) serve(out, port);
      break;
    }
    default:
      die(`unknown mode "${mode}" (use status, maintenance, ok, password or serve; --help for details)`);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) await main();
