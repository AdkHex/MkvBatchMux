import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, cleanup, within, fireEvent, act, waitFor } from "@testing-library/react";
import { useState } from "react";
import type { ExternalFile, VideoFile } from "@/shared/types";
import type { SubsyncRequest, SubsyncResultEvent } from "@/shared/types/engineFeatures";
import { ShellContext, type PageCommands, type Shell } from "@/app/shell";
import { useTabState, type TrackConfig } from "@/features/workspace/store/useTabState";

// Nothing here scans or picks a folder; the module must still import outside Tauri.
vi.mock("@/shared/lib/backend", () => ({
  pickDirectory: vi.fn(),
  scanMedia: vi.fn(),
  inspectPaths: vi.fn(),
  audiosyncEngineStatus: () => Promise.resolve({ engineAvailable: true, ffmpegAvailable: true, enginePath: null, engineVersion: null, message: null }),
  measureDelaysCancel: vi.fn(),
}));

// Sync's command and events, held so a test can answer as the engine would.
const syncMock = vi.hoisted(() => ({ handlers: {} as Record<string, (payload: unknown) => unknown>, start: vi.fn(async (_request: unknown) => undefined) }));
vi.mock("@/shared/lib/engineFeatures", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/shared/lib/engineFeatures")>();
  const on = (name: string) => (handler: (payload: unknown) => unknown) => {
    syncMock.handlers[name] = handler;
    return Promise.resolve(() => undefined);
  };
  return { ...actual, subsyncStart: (request: unknown) => syncMock.start(request), listenSubsyncProgress: on("progress"), listenSubsyncResult: on("result"), listenSubsyncDone: on("done") };
});

import { SubtitlesPage } from "./SubtitlesPage";

const config = (delay: string): TrackConfig => ({
  sourceFolder: "",
  extension: "all",
  language: "eng",
  trackName: "",
  delay,
  isDefault: true,
  isForced: false,
  muxAfter: "audio",
});

const video = (n: number): VideoFile => ({ id: `v${n}`, name: `Episode 0${n}.mkv`, path: `/videos/Episode 0${n}.mkv`, size: 1, status: "pending", tracks: [] });

const sub = (id: string, extra: Partial<ExternalFile> = {}): ExternalFile => ({
  id,
  name: `${id}.ass`,
  path: `/subs/${id}.ass`,
  type: "subtitle",
  language: "eng",
  trackName: "",
  delay: 0,
  isDefault: true,
  isForced: false,
  muxAfter: "audio",
  ...extra,
});

let commands: PageCommands | null = null;
let filesByTrack: Record<string, ExternalFile[]> = {};

const shell: Shell = {
  active: "subtitles",
  show: vi.fn(),
  desktop: false,
  enginePage: null,
  claimEngine: () => true,
  releaseEngine: vi.fn(),
  log: vi.fn(),
  openOutput: vi.fn(),
  dock: { tab: null, setTab: vi.fn(), output: null, history: null },
  addHistory: vi.fn(),
  setCommands: (_page, next) => {
    commands = next;
  },
  openPreferences: vi.fn(),
  copy: vi.fn(),
  publishStatus: vi.fn(),
  runStatus: null,
};

const EMPTY: ExternalFile[] = [];

/** The page as Index holds it: one list of files per slot, the showing slot's passed in. */
function Harness({ initial, videos }: { initial: Record<string, ExternalFile[]>; videos: VideoFile[] }) {
  const active = useTabState((state) => state.activeSubtitleTrack);
  const [byTrack, setByTrack] = useState(initial);
  filesByTrack = byTrack;
  return (
    <ShellContext.Provider value={shell}>
      <SubtitlesPage hidden={false} subtitleFiles={byTrack[active] ?? EMPTY} videoFiles={videos} onSubtitleFilesChange={(files) => setByTrack((prev) => ({ ...prev, [active]: files }))} />
    </ShellContext.Provider>
  );
}

const slots = (ids: string[], delays: Record<string, string> = {}) =>
  useTabState.setState({
    subtitleTracks: ids,
    activeSubtitleTrack: ids[0],
    subtitleTrackConfigs: Object.fromEntries(ids.map((id) => [id, config(delays[id] ?? "0.000")])),
    subtitlePresetApplied: true,
  });

beforeEach(() => {
  cleanup();
  commands = null;
  filesByTrack = {};
  syncMock.start.mockClear();
});

describe("SubtitlesPage slots", () => {
  it("gives a slot added after deleting one in the middle an id of its own", () => {
    slots(["1", "3"]);
    render(<Harness initial={{ "1": [], "3": [sub("kept")] }} videos={[]} />);
    fireEvent.click(screen.getByRole("button", { name: "New track (Ctrl+N)" }));
    expect(useTabState.getState().subtitleTracks).toEqual(["1", "3", "4"]);
    expect(useTabState.getState().activeSubtitleTrack).toBe("4");
    expect(filesByTrack["3"].map((file) => file.id)).toEqual(["kept"]);
  });

  it("gives a duplicated slot an id of its own too", () => {
    slots(["1", "3"]);
    render(<Harness initial={{}} videos={[]} />);
    fireEvent.click(screen.getByRole("button", { name: "Duplicate Subtitle 1" }));
    expect(useTabState.getState().subtitleTracks).toEqual(["1", "3", "4"]);
  });
});

describe("SubtitlesPage delays", () => {
  it("keeps a delay typed for every file when the slot tabs are switched", () => {
    slots(["1", "2"], { "1": "0.500", "2": "0.000" });
    render(<Harness initial={{ "1": [sub("a", { matchedVideoId: "v1" }), sub("b", { matchedVideoId: "v2" })], "2": [sub("c", { matchedVideoId: "v1" })] }} videos={[video(1), video(2)]} />);
    expect(filesByTrack["1"].map((file) => file.delay)).toEqual([0.5, 0.5]);

    fireEvent.doubleClick(screen.getByRole("row", { name: "a.ass" }));
    const dialog = screen.getByRole("dialog", { name: "Edit subtitle file" });
    fireEvent.change(within(dialog).getByRole("textbox", { name: "Delay" }), { target: { value: "2" } });
    fireEvent.click(within(dialog).getByRole("checkbox", { name: "This delay" }));
    fireEvent.click(within(dialog).getByRole("button", { name: "Save" }));
    expect(filesByTrack["1"].map((file) => file.delay)).toEqual([2, 2]);
    expect(filesByTrack["1"][1].delayProvenance).toBe("manual");

    fireEvent.click(screen.getByRole("tab", { name: /Subtitle 2/ }));
    fireEvent.click(screen.getByRole("tab", { name: /Subtitle 1/ }));
    expect(filesByTrack["1"].map((file) => file.delay)).toEqual([2, 2]);
  });

  it("still gives the slot's Delay to files whose delay came from the slot", () => {
    slots(["1"], { "1": "0.500" });
    render(<Harness initial={{ "1": [sub("a", { matchedVideoId: "v1" }), sub("b", { matchedVideoId: "v2", delay: 4, delayProvenance: "manual" })] }} videos={[video(1), video(2)]} />);
    fireEvent.change(screen.getByRole("textbox", { name: "Delay in seconds" }), { target: { value: "1.25" } });
    expect(filesByTrack["1"].map((file) => file.delay)).toEqual([1.25, 4]);
  });

  it("leaves a track following its file's delay when its pencil is saved without a new one", () => {
    slots(["1"], { "1": "1.500" });
    const tracks = [
      { id: "0", type: "subtitle" as const, language: "eng" },
      { id: "1", type: "subtitle" as const, language: "jpn" },
    ];
    render(<Harness initial={{ "1": [sub("a", { matchedVideoId: "v1", delay: 1.5, tracks, includedTrackIds: [0, 1] })] }} videos={[video(1)]} />);
    fireEvent.doubleClick(screen.getByRole("row", { name: "a.ass" }));
    fireEvent.click(screen.getAllByRole("button", { name: "Language, name and delay" })[1]);
    const trackDialog = screen.getByRole("dialog", { name: "Edit a track" });
    // It opens on the delay the track is muxed with: the file's.
    expect(within(trackDialog).getByRole("textbox", { name: "Delay" })).toHaveValue("1.5");
    fireEvent.click(within(trackDialog).getByRole("button", { name: "Save" }));
    expect(filesByTrack["1"][0].trackOverrides?.[1]?.delay).toBeUndefined();

    fireEvent.click(screen.getAllByRole("button", { name: "Language, name and delay" })[1]);
    const again = screen.getByRole("dialog", { name: "Edit a track" });
    fireEvent.change(within(again).getByRole("textbox", { name: "Delay" }), { target: { value: "2.25" } });
    fireEvent.click(within(again).getByRole("button", { name: "Save" }));
    expect(filesByTrack["1"][0].trackOverrides?.[1]?.delay).toBe(2.25);
  });
});

describe("SubtitlesPage rows", () => {
  it("imports into the row it names, not past an empty one", () => {
    slots(["1"]);
    const first = { ...video(1), tracks: [{ id: "2", type: "subtitle" as const, language: "eng" }] };
    render(<Harness initial={{ "1": [sub("a", { matchedVideoId: "v1" })] }} videos={[first, video(2), video(3)]} />);
    fireEvent.click(screen.getByRole("row", { name: "Episode 03.mkv" }));
    fireEvent.click(screen.getByRole("button", { name: "Import from a video" }));
    const dialog = screen.getByRole("dialog", { name: "Import subtitles from a video" });
    expect(dialog).toHaveTextContent("Into row 2, beside Episode 02.mkv, the first without a file");
    fireEvent.click(within(dialog).getByRole("checkbox", { name: "Import stream 1" }));
    fireEvent.click(within(dialog).getByRole("button", { name: "Import 1" }));
    expect(filesByTrack["1"].map((file) => file.matchedVideoId)).toEqual(["v1", "v2"]);
  });

  it("drops the selection when the search hides it, so Del cannot remove an unseen file", () => {
    slots(["1"]);
    render(<Harness initial={{ "1": [sub("alpha", { matchedVideoId: "v1" }), sub("beta", { matchedVideoId: "v2" })] }} videos={[video(1), video(2)]} />);
    fireEvent.click(screen.getByRole("row", { name: "alpha.ass" }));
    expect(commands?.removeSelected).toBeDefined();
    act(() => {
      fireEvent.change(screen.getByRole("textbox", { name: "Search subtitles" }), { target: { value: "beta" } });
    });
    expect(commands?.removeSelected).toBeUndefined();
    expect(screen.getByRole("button", { name: "Remove (Del)" })).toBeDisabled();
  });
});

describe("SubtitlesPage pairing", () => {
  const episode = (n: number): VideoFile => ({ id: `e${n}`, name: `Show.S01E0${n}.mkv`, path: `/videos/Show.S01E0${n}.mkv`, size: 1, status: "pending", tracks: [] });
  const english = (n: number) => sub(`Show.S01E0${n}.en`, { name: `Show.S01E0${n}.en.srt`, path: `/subs/Show.S01E0${n}.en.srt` });

  it("pairs by episode, an empty row where a subtitle is missing, and keeps that row out of every count", () => {
    slots(["1"]);
    render(<Harness initial={{ "1": [english(3), english(1)] }} videos={[episode(1), episode(2), episode(3)]} />);
    expect(filesByTrack["1"].map((file) => (file.placeholder ? "—" : file.name))).toEqual(["Show.S01E01.en.srt", "—", "Show.S01E03.en.srt"]);
    expect(screen.getByRole("combobox", { name: "Pair by" })).toHaveValue("episode");
    // A delay for every file reaches the files, not the empty row.
    fireEvent.doubleClick(screen.getByRole("row", { name: "Show.S01E01.en.srt" }));
    const dialog = screen.getByRole("dialog", { name: "Edit subtitle file" });
    expect(dialog).toHaveTextContent("By episode");
    fireEvent.change(within(dialog).getByRole("textbox", { name: "Delay" }), { target: { value: "1" } });
    fireEvent.click(within(dialog).getByRole("checkbox", { name: "This delay" }));
    fireEvent.click(within(dialog).getByRole("button", { name: "Save" }));
    expect(filesByTrack["1"].map((file) => file.delay)).toEqual([1, undefined, 1]);
  });

  it("keeps a pairing by hand when the name says another episode", () => {
    slots(["1"]);
    // Two names of three: pairing stays by order, and row 2's file names another episode.
    const odd = sub("odd", { name: "odd.srt", path: "/subs/odd.srt" });
    render(<Harness initial={{ "1": [english(1), english(3), odd] }} videos={[episode(1), episode(2), episode(3)]} />);
    expect(screen.getByRole("combobox", { name: "Pair by" })).toHaveValue("order");
    expect(within(screen.getByRole("row", { name: "Show.S01E03.en.srt" })).getByText("Other episode")).toBeInTheDocument();
    fireEvent.doubleClick(screen.getByRole("row", { name: "Show.S01E03.en.srt" }));
    fireEvent.click(within(screen.getByRole("dialog", { name: "Edit subtitle file" })).getByRole("button", { name: "Keep this pairing" }));
    expect(filesByTrack["1"][1]).toMatchObject({ matchedVideoId: "e2", isManuallyLinked: true });
    expect(within(screen.getByRole("row", { name: "Show.S01E03.en.srt" })).getByText("By hand")).toBeInTheDocument();
  });
});

describe("Sync subtitles", () => {
  const withText = (n: number): VideoFile => ({
    ...video(n),
    tracks: [
      { id: "0", type: "video" },
      { id: "1", type: "audio", language: "kor" },
      { id: "2", type: "subtitle", codec: "SubRip/SRT", language: "eng" },
    ],
  });
  const speechOnly = (n: number): VideoFile => ({ ...video(n), tracks: [{ id: "0", type: "video" }, { id: "1", type: "audio", language: "kor" }] });
  const srt = (n: number) => sub(`s${n}`, { name: `Episode 0${n}.en.srt`, path: `/subs/Episode 0${n}.en.srt`, matchedVideoId: `v${n}` });
  const result = (request: SubsyncRequest, key: string, extra: Partial<SubsyncResultEvent> = {}): SubsyncResultEvent => ({
    runId: request.runId,
    key,
    offsetS: -2.5003,
    ratio: 1,
    splits: 0,
    score: 1,
    method: request.engine,
    description: "Matched.",
    retimedPath: `/subs/MKVBatchMux synced/${key}.srt`,
    error: null,
    applied: true,
    confidence: "high",
    framerate: null,
    splitPoints: [],
    warnings: [],
    ...extra,
  });

  it("shows a measured positive delay with one plus sign", async () => {
    slots(["1"]);
    render(<Harness initial={{ "1": [srt(1)] }} videos={[withText(1)]} />);
    const syncButton = await screen.findByRole("button", { name: "Sync subtitles" });
    await waitFor(() => expect(syncButton).toBeEnabled());
    fireEvent.click(syncButton);
    await waitFor(() => expect(syncMock.start).toHaveBeenCalledTimes(1));
    const request = syncMock.start.mock.calls[0][0] as SubsyncRequest;
    act(() => void syncMock.handlers.result(result(request, "s1", { offsetS: 1.2 })));
    await act(async () => void (await syncMock.handlers.done({ runId: request.runId, cancelled: false, error: null })));
    const row = screen.getByRole("row", { name: "Episode 01.en.srt" });
    expect(within(row).getByText("+1.200")).toBeInTheDocument();
    expect(within(row).queryByText("++1.200")).not.toBeInTheDocument();
  });

  it("syncs against the video's own subtitle track first, then speech, and fills in only what it is sure of", async () => {
    slots(["1"]);
    render(<Harness initial={{ "1": [srt(1), srt(2), srt(3)] }} videos={[withText(1), speechOnly(2), withText(3)]} />);
    const syncButton = await screen.findByRole("button", { name: "Sync subtitles" });
    await waitFor(() => expect(syncButton).toBeEnabled());
    fireEvent.click(syncButton);
    await waitFor(() => expect(syncMock.start).toHaveBeenCalledTimes(1));

    const first = syncMock.start.mock.calls[0][0] as SubsyncRequest;
    expect(first).toMatchObject({ engine: "subtitle", maxOffsetS: 60, detectFramerate: true, allowSplits: true, outputDir: null });
    expect(first.jobs.map((job) => [job.key, job.referenceTrack, job.videoPath])).toEqual([
      ["s1", 0, "/videos/Episode 01.mkv"],
      ["s3", 0, "/videos/Episode 03.mkv"],
    ]);
    // A pure offset, and a frame-rate change answered with the engine's copy.
    act(() => void syncMock.handlers.result(result(first, "s1")));
    act(() => void syncMock.handlers.result(result(first, "s3", { ratio: 1.0427083, offsetS: -0.0722, framerate: "25 → 23.976" })));
    await act(async () => void (await syncMock.handlers.done({ runId: first.runId, cancelled: false, error: null })));

    await waitFor(() => expect(syncMock.start).toHaveBeenCalledTimes(2));
    const second = syncMock.start.mock.calls[1][0] as SubsyncRequest;
    expect(second.engine).toBe("audio");
    expect(second.jobs.map((job) => [job.key, job.audioTrack, job.referenceTrack])).toEqual([["s2", 0, null]]);
    // Speech, and not sure: shown, not filled in.
    act(() => void syncMock.handlers.result(result(second, "s2", { offsetS: 0.48, score: 0.62, confidence: "medium" })));
    await act(async () => void (await syncMock.handlers.done({ runId: second.runId, cancelled: false, error: null })));
    expect(shell.releaseEngine).toHaveBeenCalledWith("subtitles");

    const [s1, s2, s3] = filesByTrack["1"];
    expect([s1.pendingDelay, s1.delay]).toEqual([-2.5, 0]);
    expect(s2.pendingDelay).toBeUndefined();
    expect(s3.retimed?.path).toBe("/subs/MKVBatchMux synced/s3.srt");
    const row = (n: number) => screen.getByRole("row", { name: `Episode 0${n}.en.srt` });
    expect(within(row(1)).getByText("Measured")).toBeInTheDocument();
    expect(within(row(1)).getByText("-2.500")).toBeInTheDocument();
    expect(within(row(2)).getByText("Low confidence")).toBeInTheDocument();
    expect(within(row(3)).getByText("Re-timed copy")).toBeInTheDocument();
    expect(within(row(3)).getByText("Subtitle 1 · eng · SubRip/SRT")).toBeInTheDocument();
    expect(within(row(2)).getByText("Speech · audio 1 · kor")).toBeInTheDocument();

    // Apply takes the sure delay only.
    fireEvent.click(screen.getByRole("button", { name: "Apply 1 delay" }));
    expect(filesByTrack["1"][0]).toMatchObject({ delay: -2.5, delayProvenance: "measured", pendingDelay: undefined });
    expect(within(row(1)).getByText("Applied")).toBeInTheDocument();

    // Apply anyway, from the popup, for the one it was not sure of.
    fireEvent.doubleClick(row(2));
    const dialog = screen.getByRole("dialog", { name: "Edit subtitle file" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Apply anyway" }));
    expect(filesByTrack["1"][1]).toMatchObject({ delay: 0.48, delayProvenance: "measured" });
    // Save keeps it: the form follows the delay just applied.
    fireEvent.click(within(dialog).getByRole("button", { name: "Save" }));
    expect(filesByTrack["1"][1]).toMatchObject({ delay: 0.48, delayProvenance: "measured" });

    // Undo goes back to the original subtitle.
    fireEvent.click(row(3));
    fireEvent.click(screen.getByRole("button", { name: "Undo sync" }));
    expect(filesByTrack["1"][2].retimed).toBeUndefined();
    expect(filesByTrack["1"][2].subsync).toBeUndefined();
  });

  it("says a DVD picture subtitle can't be synced, without asking the engine", async () => {
    slots(["1"]);
    const idx = sub("p1", { name: "Episode 01.idx", path: "/subs/Episode 01.idx", matchedVideoId: "v1" });
    render(<Harness initial={{ "1": [idx] }} videos={[withText(1)]} />);
    const syncButton = await screen.findByRole("button", { name: "Sync subtitles" });
    await waitFor(() => expect(syncButton).toBeEnabled());
    expect(within(screen.getByRole("row", { name: "Episode 01.idx" })).getByText("DVD pictures")).toBeInTheDocument();
    fireEvent.click(syncButton);
    await waitFor(() => expect(within(screen.getByRole("row", { name: "Episode 01.idx" })).getByText("Can't be synced automatically")).toBeInTheDocument());
    expect(syncMock.start).not.toHaveBeenCalled();
  });

  it("syncs a Blu-ray picture subtitle by its timing and muxes its re-timed copy", async () => {
    slots(["1"]);
    const sup = sub("p1", { name: "Episode 01.sup", path: "/subs/Episode 01.sup", matchedVideoId: "v1" });
    render(<Harness initial={{ "1": [sup] }} videos={[withText(1)]} />);
    const syncButton = await screen.findByRole("button", { name: "Sync subtitles" });
    await waitFor(() => expect(syncButton).toBeEnabled());
    const row = () => screen.getByRole("row", { name: "Episode 01.sup" });
    expect(within(row()).getByText("Subtitle 1 · eng · SubRip/SRT")).toBeInTheDocument();
    fireEvent.click(syncButton);
    await waitFor(() => expect(syncMock.start).toHaveBeenCalledTimes(1));
    const request = syncMock.start.mock.calls[0][0] as SubsyncRequest;
    expect(request.jobs).toEqual([expect.objectContaining({ key: "p1", subtitlePath: "/subs/Episode 01.sup", subtitlePictures: true, referencePictures: false })]);
    const copy = "/subs/MKVBatchMux synced/Episode 01.synced.sup";
    act(() => void syncMock.handlers.result(result(request, "p1", { ratio: 1.0427083, offsetS: -0.0722, framerate: "25 → 23.976", retimedPath: copy })));
    await act(async () => void (await syncMock.handlers.done({ runId: request.runId, cancelled: false, error: null })));
    expect(within(row()).getByText("Re-timed copy")).toBeInTheDocument();
    expect(within(row()).getByText("copy")).toBeInTheDocument();
  });
});

