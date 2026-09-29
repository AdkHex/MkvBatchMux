// Decide which version a push to main is released as. Prints GitHub Actions
// outputs (version, tag).
//
// The repo's version when it is newer than every v* tag -- a number chosen with
// `npm run release` -- otherwise the next minor after the newest tag. So an
// ordinary push is released as the next version without anyone editing the
// number. Tags rather than releases: a tag only exists once a release was
// published, and one left behind by a failed build is not reused.

import fs from "node:fs";
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";

const parse = (v) => v.split(".").map(Number);

export function compareVersions(a, b) {
  const x = parse(a);
  const y = parse(b);
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] - y[i];
  return 0;
}

export function decideVersion(repo, tags) {
  // As versions, not strings: 1.9.0 comes before 1.10.0.
  const latest = tags
    .filter((tag) => /^v\d+\.\d+\.\d+$/.test(tag))
    .map((tag) => tag.slice(1))
    .sort(compareVersions)
    .pop();
  if (!latest || compareVersions(repo, latest) > 0) return repo;
  const [major, minor] = parse(latest);
  return `${major}.${minor + 1}.0`;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const repo = JSON.parse(fs.readFileSync("package.json", "utf8")).version;
  const tags = execFileSync("git", ["tag", "--list", "v*"], { encoding: "utf8" }).split(/\r?\n/).filter(Boolean);
  const version = decideVersion(repo, tags);
  const lines = [`version=${version}`, `tag=v${version}`];
  if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, lines.join("\n") + "\n");
  console.log(lines.join("\n"));
}
