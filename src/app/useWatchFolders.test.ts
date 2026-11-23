import { describe, expect, it, vi } from "vitest";

vi.mock("@/shared/lib/workspaceStore", () => ({}));

import { DEFAULT_WATCH_EXTENSIONS, STALE_STOP_MS, newWatchFolder, parseWatchFolders, resolveStopped, watchProblem } from "./useWatchFolders";

describe("watch folders as stored", () => {
  it("are off until turned on, and read back field by field", () => {
    const fresh = newWatchFolder();
    expect(fresh).toMatchObject({ enabled: false, recipeId: null, intervalSeconds: 10, videoExtensions: DEFAULT_WATCH_EXTENSIONS });
    const stored = {
      version: 1,
      folders: [
        { ...fresh, id: "a", enabled: true, videoFolder: "W:\\In", recipeId: "r1", videoExtensions: ["MKV", "exe"], intervalSeconds: 0.01 },
        { id: "a", videoFolder: "duplicate" },
        { id: "", videoFolder: "no id" },
        "junk",
        { id: "b", videoFolder: "\\\\nas\\tv", intervalSeconds: "often" },
      ],
    };
    const folders = parseWatchFolders(stored);
    expect(folders.map((folder) => folder.id)).toEqual(["a", "b"]);
    expect(folders[0]).toMatchObject({ enabled: true, recipeId: "r1", videoExtensions: ["MKV"], intervalSeconds: 1 });
    expect(folders[1]).toMatchObject({ enabled: false, recipeId: null, intervalSeconds: 10, videoExtensions: DEFAULT_WATCH_EXTENSIONS, audioFolder: "" });
    expect(parseWatchFolders(null)).toEqual([]);
  });

  it("says what stops one from being turned on", () => {
    const config = { ...newWatchFolder(), videoFolder: "W:\\In", recipeId: "r1" };
    expect(watchProblem(config, ["r1"])).toBeNull();
    expect(watchProblem({ ...config, videoFolder: " " }, ["r1"])).toMatch(/folder new episodes arrive in/);
    expect(watchProblem(config, [])).toMatch(/recipe/);
    expect(watchProblem({ ...config, audioFolder: "w:\\in" }, ["r1"])).toMatch(/must differ/);
  });
});

describe("a watcher's stopped status", () => {
  const stopped = { id: "a", state: "stopped" as const, error: null };
  const info = (state: "watching" | "paused") => ({ id: "a", folder: "W:\\In", extensions: [], recursive: false, intervalSeconds: 10, stablePolls: 2, state, error: null, paused: state === "paused", settling: 0, reported: 0, held: 0 });

  it("is the replaced watcher's last word when one still runs under that id", async () => {
    await expect(resolveStopped(stopped, { list: async () => [info("watching")] })).resolves.toEqual({ state: "watching", error: null });
    await expect(resolveStopped(stopped, { list: async () => [info("paused")] })).resolves.toEqual({ state: "paused", error: null });
  });

  it("means off when none runs", async () => {
    await expect(resolveStopped(stopped, { list: async () => [] })).resolves.toEqual({ state: "off", error: null });
  });

  it("is ignored right after a restart when the backend can't be asked", async () => {
    const failing = async () => Promise.reject(new Error("no backend"));
    await expect(resolveStopped(stopped, { launchedAt: 1000, now: 1000 + STALE_STOP_MS - 1, list: failing })).resolves.toBeNull();
    await expect(resolveStopped(stopped, { launchedAt: 1000, now: 1000 + STALE_STOP_MS + 1, list: failing })).resolves.toEqual({ state: "off", error: null });
  });
});
