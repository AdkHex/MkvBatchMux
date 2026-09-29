// Usage: npm run release -- <patch|minor|major|X.Y.Z> [--push]
//
// Only needed to choose a number: every push to main is released anyway, as
// the next minor. Writes the version into every file that carries it, commits
// "Release vX.Y.Z" and (with --push) pushes it; the release workflow then
// publishes that number, because it is newer than every tag.

import fs from "node:fs";
import { execFileSync } from "node:child_process";
import { setVersion, versionFiles } from "./set-version.mjs";

const root = process.cwd();
const files = versionFiles(root);

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

setVersion(root, next);

git("add", ...Object.values(files));
git("commit", "-m", `Release v${next}`);
console.log(`Release v${next} committed.`);

if (push) {
  git("push");
  console.log("Pushed. The release workflow is building the installer.");
} else {
  console.log("Run: git push");
}
