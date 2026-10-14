import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

import { accessFor } from "./mkvbatchmux-status.mjs";

// vitest runs from the repository root.
const script = path.resolve("scripts/mkvbatchmux-status.mjs");

/** Run the CLI on a local copy only (never the gist). */
function run(out, args, input) {
  return execFileSync(process.execPath, [script, ...args, "--no-publish", "--out", out], { input, encoding: "utf8" });
}

const read = (file) => JSON.parse(fs.readFileSync(file, "utf8"));

describe("mkvbatchmux-status", () => {
  // CI checks out on Windows, where `* text=auto` turns every line ending into
  // CRLF; a `#!` line then stops vitest from loading the module at all.
  it("loads from a Windows checkout (CRLF line endings)", async () => {
    // Beside the script: vitest only loads modules from inside the project.
    const copy = path.join(path.dirname(script), `.crlf-check-${process.pid}.mjs`);
    fs.writeFileSync(copy, fs.readFileSync(script, "utf8").replace(/\r?\n/g, "\r\n"));
    try {
      const loaded = await import(pathToFileURL(copy).href);
      expect(typeof loaded.accessFor).toBe("function");
    } finally {
      fs.rmSync(copy, { force: true });
    }
  });

  it("hashes the password exactly as the app checks it", () => {
    // The same vector src-tauri/src/remote_status.rs tests against.
    const access = accessFor("correct horse battery staple", Buffer.alloc(16, 7), 100_000);
    expect(access).toEqual({
      alg: "pbkdf2-sha256",
      iterations: 100_000,
      salt: "BwcHBwcHBwcHBwcHBwcHBw==",
      hash: "L1U+q2ApcN8+qcNIEQqmbdBSgeOo/XF8vufu6pzUxWU=",
      id: "c4137bd2b4cdf0a2",
    });
    // A fresh salt every time, so the same password never publishes the same hash.
    expect(accessFor("same password").hash).not.toBe(accessFor("same password").hash);
  });

  it("changes only its own fields", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mbm-status-"));
    const out = path.join(dir, "status.json");

    const said = run(out, ["password"], "a long test passphrase\na long test passphrase\n");
    expect(said).not.toContain("a long test passphrase");
    const withPassword = read(out);
    expect(withPassword.status).toBe("ok");
    expect(withPassword.checkMinutes).toBe(5);
    expect(withPassword.access).toMatchObject({ alg: "pbkdf2-sha256", iterations: 600_000 });
    expect(fs.readFileSync(out, "utf8")).not.toContain("passphrase");

    run(out, ["maintenance", "Back soon", "--title", "Scheduled", "--check-minutes", "2"]);
    expect(read(out)).toEqual({ status: "maintenance", title: "Scheduled", message: "Back soon", checkMinutes: 2, access: withPassword.access });

    run(out, ["ok", "--min-version", "1.80.0", "--update-url", "https://example.com/new"]);
    expect(read(out)).toEqual({ status: "ok", minVersion: "1.80.0", updateUrl: "https://example.com/new", checkMinutes: 2, access: withPassword.access });

    run(out, ["ok"]);
    expect(read(out)).toEqual({ status: "ok", checkMinutes: 2, access: withPassword.access });

    run(out, ["password"], "another long passphrase\n");
    expect(read(out).access.id).not.toBe(withPassword.access.id);

    run(out, ["password", "--off"]);
    expect(read(out)).toEqual({ status: "ok", checkMinutes: 2 });
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("refuses passwords that differ or are short, and changes nothing", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mbm-status-"));
    const out = path.join(dir, "status.json");
    run(out, ["ok"]);
    const before = fs.readFileSync(out, "utf8");
    expect(() => run(out, ["password"], "first passphrase\nsecond passphrase\n")).toThrow(/differ/);
    expect(() => run(out, ["password"], "short\n")).toThrow(/at least 8/);
    expect(fs.readFileSync(out, "utf8")).toBe(before);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
