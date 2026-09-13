// Usage: npm run release -- <patch|minor|major|X.Y.Z> [--push]
//
// Writes the new version into every file that carries it, commits
// "Release vX.Y.Z", tags it, and (with --push) pushes both. Pushing the tag
// is what triggers the release build.

import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

const root = process.cwd();
const files = {
  pkg: path.join(root, "package.json"),
  pkgLock: path.join(root, "package-lock.json"),
  tauri: path.join(root, "src-tauri", "tauri.conf.json"),
  cargo: path.join(root, "src-tauri", "Cargo.toml"),
  cargoLock: path.join(root, "src-tauri", "Cargo.lock"),
};

const args = process.argv.slice(2);
const push = args.includes("--push");
const spec = args.find((a) => !a.startsWith("--"));
if (!spec) {
  console.error("Usage: npm run release -- <patch|minor|major|X.Y.Z> [--push]");
  process.exit(1);
}

const git = (...a) => execFileSync("git", a, { encoding: "utf8" }).trim();
if (git("status", "--porcelain")) {
  console.error("Working tree is not clean. Commit or stash first.");
  process.exit(1);
}

const pkg = JSON.parse(fs.readFileSync(files.pkg, "utf8"));
const [major, minor, patch] = pkg.version.split(".").map(Number);
const next =
  spec === "major" ? `${major + 1}.0.0`
  : spec === "minor" ? `${major}.${minor + 1}.0`
  : spec === "patch" ? `${major}.${minor}.${patch + 1}`
  : spec;
if (!/^\d+\.\d+\.\d+$/.test(next)) {
  console.error(`Not a version: ${spec}`);
  process.exit(1);
}

const writeJson = (file, mutate) => {
  const data = JSON.parse(fs.readFileSync(file, "utf8"));
  mutate(data);
  fs.writeFileSync(file, JSON.stringify(data, null, 2) + "\n");
};

writeJson(files.pkg, (d) => { d.version = next; });
writeJson(files.pkgLock, (d) => {
  d.version = next;
  if (d.packages?.[""]) d.packages[""].version = next;
});
writeJson(files.tauri, (d) => { d.package.version = next; });

const cargo = fs.readFileSync(files.cargo, "utf8");
fs.writeFileSync(files.cargo, cargo.replace(/^version\s*=\s*"[^"]+"/m, `version = "${next}"`));
const crate = /^name\s*=\s*"([^"]+)"/m.exec(cargo)[1];
const lock = fs.readFileSync(files.cargoLock, "utf8");
fs.writeFileSync(
  files.cargoLock,
  lock.replace(new RegExp(`(\\[\\[package\\]\\]\\nname = "${crate}"\\nversion = ")[^"]+(")`), `$1${next}$2`),
);

git("add", ...Object.values(files));
git("commit", "-m", `Release v${next}`);
git("tag", "-a", `v${next}`, "-m", `v${next}`);
console.log(`Release v${next} committed and tagged.`);

if (push) {
  git("push");
  git("push", "origin", `v${next}`);
  console.log("Pushed. The release workflow is building the installer.");
} else {
  console.log(`Run: git push && git push origin v${next}`);
}
