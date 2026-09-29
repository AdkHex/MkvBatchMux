// Usage: node scripts/set-version.mjs X.Y.Z
//
// Writes a version into every file that carries it. The release workflow runs
// this on its own checkout, so what it decides is never committed back.

import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

export function versionFiles(root) {
  return {
    pkg: path.join(root, "package.json"),
    pkgLock: path.join(root, "package-lock.json"),
    tauri: path.join(root, "src-tauri", "tauri.conf.json"),
    cargo: path.join(root, "src-tauri", "Cargo.toml"),
    cargoLock: path.join(root, "src-tauri", "Cargo.lock"),
  };
}

export function setVersion(root, version) {
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error(`Not a version: ${version}`);
  const files = versionFiles(root);

  const writeJson = (file, mutate) => {
    const data = JSON.parse(fs.readFileSync(file, "utf8"));
    mutate(data);
    fs.writeFileSync(file, JSON.stringify(data, null, 2) + "\n");
  };
  writeJson(files.pkg, (d) => { d.version = version; });
  writeJson(files.pkgLock, (d) => {
    d.version = version;
    if (d.packages?.[""]) d.packages[""].version = version;
  });
  writeJson(files.tauri, (d) => { d.package.version = version; });

  const cargo = fs.readFileSync(files.cargo, "utf8");
  fs.writeFileSync(files.cargo, cargo.replace(/^version\s*=\s*"[^"]+"/m, `version = "${version}"`));
  const crate = /^name\s*=\s*"([^"]+)"/m.exec(cargo)[1];
  // \r?: a Windows checkout has CRLF line ends, and a bare \n never matched there.
  const lock = fs.readFileSync(files.cargoLock, "utf8");
  fs.writeFileSync(
    files.cargoLock,
    lock.replace(new RegExp(`(\\[\\[package\\]\\]\\r?\\nname = "${crate}"\\r?\\nversion = ")[^"]+(")`), `$1${version}$2`),
  );
  return Object.values(files);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const version = process.argv[2];
  try {
    setVersion(process.cwd(), version);
  } catch (error) {
    console.error(String(error.message ?? error));
    process.exit(1);
  }
  console.log(`Version set to ${version}.`);
}
