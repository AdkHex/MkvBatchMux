import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const pkgPath = path.join(root, "package.json");
const tauriConfPath = path.join(root, "src-tauri", "tauri.conf.json");
const cargoTomlPath = path.join(root, "src-tauri", "Cargo.toml");

const pkgRaw = fs.readFileSync(pkgPath, "utf8");
const pkg = JSON.parse(pkgRaw);

const version = pkg.version;
const match = /^([0-9]+)\.([0-9]+)\.([0-9]+)$/.exec(version);
if (!match) {
  console.error(`Unsupported version format in package.json: ${version}`);
  process.exit(1);
}

const major = Number(match[1]);
const minor = Number(match[2]) + 1;
const nextVersion = `${major}.${minor}.0`;

pkg.version = nextVersion;
fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + "\n");

const tauriRaw = fs.readFileSync(tauriConfPath, "utf8");
const tauriConf = JSON.parse(tauriRaw);
if (!tauriConf.package || !tauriConf.package.version) {
  console.error("tauri.conf.json missing package.version");
  process.exit(1);
}

tauriConf.package.version = nextVersion;
fs.writeFileSync(tauriConfPath, JSON.stringify(tauriConf, null, 2) + "\n");

const cargoRaw = fs.readFileSync(cargoTomlPath, "utf8");
const cargoNext = cargoRaw.replace(
  /^version\s*=\s*"[^"]+"/m,
  `version = "${nextVersion}"`
);
if (cargoNext === cargoRaw) {
  console.error("Failed to update Cargo.toml version");
  process.exit(1);
}
fs.writeFileSync(cargoTomlPath, cargoNext);

console.log(`Version bumped to ${nextVersion}`);
