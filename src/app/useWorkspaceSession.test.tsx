import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { MuxSettings, OutputSettings, VideoFile } from "@/shared/types";
import type { SessionFile, WorkspaceSnapshot } from "@/shared/types/recipes";

const store = vi.hoisted(() => ({
  readAutosave: vi.fn(),
  writeAutosave: vi.fn(async (_value: unknown) => ({ ok: true as const, value: undefined })),
  openSessionFile: vi.fn(),
  saveSessionFile: vi.fn(async (_path: string, _value: unknown) => ({ ok: true as const, value: undefined })),
  pickSessionOpenPath: vi.fn(async () => "D:\\Sessions\\Show S01.mbmux" as string | null),
  pickSessionSavePath: vi.fn(async (_default?: string) => "D:\\Sessions\\Show S01.mbmux" as string | null),
  pathsExist: vi.fn(async (paths: string[]) => paths.map(() => true)),
}));
const toast = vi.hoisted(() => vi.fn());
vi.mock("@/shared/lib/workspaceStore", () => store);
vi.mock("@/ui/toast", () => ({ toast }));

import { buildSessionFile } from "@/features/workspace/lib/session";
import { useWorkspaceSession } from "./useWorkspaceSession";

const video = (n: number): VideoFile => ({ id: `v${n}`, name: `E0${n}.mkv`, path: `W:\\Show\\E0${n}.mkv`, size: 1, status: "pending", tracks: [] });
const empty: WorkspaceSnapshot = {
  videoFiles: [],
  audioFilesByTrack: { "1": [] },
  subtitleFilesByTrack: { "1": [] },
  chapterFiles: [],
  attachmentFiles: [],
  perVideoExternal: {},
  tabState: {} as WorkspaceSnapshot["tabState"],
  muxSettings: { verifyOutput: true } as MuxSettings,
  outputSettings: { directory: "", namingPattern: "{original_filename}", overwriteExisting: false } as OutputSettings,
};
const saved = (over: Partial<WorkspaceSnapshot> = {}): SessionFile =>
  buildSessionFile({
    ...empty,
    videoFiles: [video(1), video(2)],
    audioFilesByTrack: {
      "1": [
        { id: "a1", name: "E01.hin.eac3", path: "W:\\Dubs\\E01.hin.eac3", type: "audio", matchedVideoId: "v1" },
        { id: "gap-v2", name: "", path: "", type: "audio", placeholder: true, matchedVideoId: "v2" },
      ],
    },
    muxSettings: { verifyOutput: false } as MuxSettings,
    outputSettings: { directory: "W:\\Out", namingPattern: "{show} - {episode}", overwriteExisting: false },
    ...over,
  });

function setup(snapshot = empty) {
  const apply = vi.fn();
  const applySettings = vi.fn();
  const log = vi.fn();
  const hook = renderHook((props: { snapshot: WorkspaceSnapshot; busy: boolean }) => useWorkspaceSession({ snapshot: props.snapshot, apply, applySettings, ready: true, busy: props.busy, log }), { initialProps: { snapshot, busy: false } });
  return { hook, apply, applySettings, log };
}

const offerToast = () => toast.mock.calls.map(([input]) => input).find((input) => input.title === "Pick up where you left off?");

describe("sessions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    store.pathsExist.mockImplementation(async (paths: string[]) => paths.map(() => true));
  });

  it("brings the options back at launch and offers the files, without overwriting them meanwhile", async () => {
    store.readAutosave.mockResolvedValue({ ok: true, value: saved() });
    const { hook, apply, applySettings } = setup();
    await waitFor(() => expect(offerToast()).toBeDefined());
    expect(applySettings).toHaveBeenCalledWith({ verifyOutput: false }, { directory: "W:\\Out", namingPattern: "{show} - {episode}", overwriteExisting: false });
    expect(offerToast().description).toMatch(/^2 videos, 1 audio file/);
    expect(hook.result.current.autosaveOn).toBe(false);

    // Restore: every file is there, nothing loaded now: it opens without a dialog.
    await act(async () => offerToast().action.onClick());
    await waitFor(() => expect(apply).toHaveBeenCalled());
    expect(apply.mock.calls[0][0].videoFiles.map((item: VideoFile) => item.id)).toEqual(["v1", "v2"]);
    expect(hook.result.current.pending).toBeNull();
    expect(hook.result.current.autosaveOn).toBe(true);
  });

  it("takes loading other files as declining, and autosaves those", async () => {
    store.readAutosave.mockResolvedValue({ ok: true, value: saved() });
    const { hook } = setup();
    await waitFor(() => expect(offerToast()).toBeDefined());
    const loaded = { ...empty, videoFiles: [video(7)] };
    hook.rerender({ snapshot: loaded, busy: false });
    await waitFor(() => expect(hook.result.current.autosaveOn).toBe(true));
    await waitFor(() => expect(store.writeAutosave).toHaveBeenCalled(), { timeout: 4000 });
    const written = store.writeAutosave.mock.calls.at(-1)![0] as SessionFile;
    expect(written.videoFiles.map((item) => item.id)).toEqual(["v7"]);
  });

  it("lists missing files before opening, and never counts an empty row as one", async () => {
    store.readAutosave.mockResolvedValue({ ok: true, value: null });
    store.openSessionFile.mockResolvedValue({ ok: true, value: saved() });
    store.pathsExist.mockImplementation(async (paths: string[]) => paths.map((path) => !path.endsWith("E02.mkv")));
    const { hook, apply } = setup({ ...empty, videoFiles: [video(9)] });
    await act(() => hook.result.current.open());
    const pending = hook.result.current.pending!;
    expect(pending.missing).toEqual([{ path: "W:\\Show\\E02.mkv", kind: "video", name: "E02.mkv" }]);
    expect(store.pathsExist.mock.calls[0][0]).not.toContain("");
    expect(pending.replaces).toBe(true);
    expect(apply).not.toHaveBeenCalled();
    act(() => hook.result.current.commit(pending));
    expect(apply).toHaveBeenCalledTimes(1);
    expect(toast).toHaveBeenLastCalledWith(expect.objectContaining({ title: "Opened Show S01.mbmux", description: expect.stringMatching(/1 file is missing/) }));
  });

  it("won't open over a running batch, and saves where asked", async () => {
    store.readAutosave.mockResolvedValue({ ok: true, value: null });
    const { hook } = setup({ ...empty, videoFiles: [video(1)] });
    hook.rerender({ snapshot: { ...empty, videoFiles: [video(1)] }, busy: true });
    await act(() => hook.result.current.open());
    expect(store.pickSessionOpenPath).not.toHaveBeenCalled();
    await act(() => hook.result.current.save());
    expect(store.saveSessionFile).toHaveBeenCalledWith("D:\\Sessions\\Show S01.mbmux", expect.objectContaining({ format: "mkvbatchmux-session", videoFiles: [video(1)] }));
  });
});
