import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, cleanup, within, fireEvent, act, waitFor } from "@testing-library/react";
import { useState } from "react";
import type { ExternalFile, MeasuredDelay, VideoFile } from "@/shared/types";
import type { ConformRequest, ConformResultEvent } from "@/shared/types/engineFeatures";
import { ShellContext, type PageCommands, type Shell } from "@/app/shell";
import { useTabState, type TrackConfig } from "@/features/workspace/store/useTabState";

// Nothing here scans or picks a folder; the module must still import outside Tauri.
vi.mock("@/shared/lib/backend", () => {
  const listen = () => Promise.resolve(() => undefined);
  return {
    pickDirectory: vi.fn(),
    scanMedia: vi.fn(),
    inspectPaths: vi.fn(),
    // Match by audio listens for its own run's events.
    listenMeasureDelaysProgress: listen,
    listenMeasureDelaysResult: listen,
    listenMeasureDelaysDone: listen,
    measureDelaysStart: vi.fn(),
    measureDelaysCancel: vi.fn(),
  };
});

// The engine is not under test: only whether a run is going, and whether it is there.
const measuring: { isMeasuring: boolean; engine: { engineAvailable: boolean; ffmpegAvailable: boolean; message: null } | null } = { isMeasuring: false, engine: null };
vi.mock("@/features/workspace/hooks/useMeasureDelays", () => ({
  useMeasureDelays: () => ({ engine: measuring.engine, isMeasuring: measuring.isMeasuring, progress: null, start: vi.fn(), cancel: vi.fn() }),
}));

// Conform's command and events, held so a test can answer as the engine would.
const conformMock = vi.hoisted(() => ({ handlers: {} as Record<string, (payload: unknown) => void>, start: vi.fn(async (_request: unknown) => undefined) }));
vi.mock("@/shared/lib/engineFeatures", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/shared/lib/engineFeatures")>();
  const on = (name: string) => (handler: (payload: unknown) => void) => {
    conformMock.handlers[name] = handler;
    return Promise.resolve(() => undefined);
  };
  return { ...actual, conformDubsStart: (request: unknown) => conformMock.start(request), listenConformProgress: on("progress"), listenConformResult: on("result"), listenConformDone: on("done") };
});

import { buildMuxJobRequests } from "@/features/workspace/lib/muxJobBuilder";
import { buildMeasurementPlan } from "@/features/workspace/lib/measurePairs";

import { AudioPage } from "./AudioPage";

const config = (delay: string): TrackConfig => ({
  sourceFolder: "",
  extension: "all",
  language: "hin",
  trackName: "",
  delay,
  isDefault: true,
  isForced: false,
  muxAfter: "video",
});

const video = (n: number): VideoFile => ({ id: `v${n}`, name: `Episode 0${n}.mkv`, path: `/videos/Episode 0${n}.mkv`, size: 1, status: "pending", tracks: [] });

const dub = (id: string, extra: Partial<ExternalFile> = {}): ExternalFile => ({
  id,
  name: `${id}.mka`,
  path: `/audio/${id}.mka`,
  type: "audio",
  language: "hin",
  trackName: "",
  delay: 0,
  isDefault: true,
  isForced: false,
  muxAfter: "video",
  ...extra,
});

let commands: PageCommands | null = null;
let filesByTrack: Record<string, ExternalFile[]> = {};

const shell: Shell = {
  active: "audio",
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
  const active = useTabState((state) => state.activeAudioTrack);
  const [byTrack, setByTrack] = useState(initial);
  filesByTrack = byTrack;
  return (
    <ShellContext.Provider value={shell}>
      <AudioPage hidden={false} audioFiles={byTrack[active] ?? EMPTY} videoFiles={videos} onAudioFilesChange={(files) => setByTrack((prev) => ({ ...prev, [active]: files }))} />
    </ShellContext.Provider>
  );
}

const slots = (ids: string[], delays: Record<string, string> = {}) =>
  useTabState.setState({
    audioTracks: ids,
    activeAudioTrack: ids[0],
    audioTrackConfigs: Object.fromEntries(ids.map((id) => [id, config(delays[id] ?? "0.000")])),
    audioPresetApplied: true,
  });

beforeEach(() => {
  cleanup();
  commands = null;
  filesByTrack = {};
  measuring.isMeasuring = false;
  measuring.engine = null;
  conformMock.start.mockClear();
  vi.mocked(shell.releaseEngine).mockClear();
  shell.enginePage = null;
});

describe("AudioPage", () => {
  it("gives a slot added after deleting one in the middle an id of its own", () => {
    slots(["1", "3"]);
    render(<Harness initial={{}} videos={[]} />);
    fireEvent.click(screen.getByRole("button", { name: "New track (Ctrl+N)" }));
    expect(useTabState.getState().audioTracks).toEqual(["1", "3", "4"]);
  });

  it("keeps a delay typed for every row when the slot tabs are switched", () => {
    slots(["1", "2"], { "1": "0.500", "2": "0.000" });
    render(<Harness initial={{ "1": [dub("a", { matchedVideoId: "v1" }), dub("b", { matchedVideoId: "v2" })], "2": [dub("c", { matchedVideoId: "v1" })] }} videos={[video(1), video(2)]} />);
    expect(filesByTrack["1"].map((file) => file.delay)).toEqual([0.5, 0.5]);

    fireEvent.doubleClick(screen.getByRole("row", { name: "a.mka" }));
    const dialog = screen.getByRole("dialog", { name: "a.mka" });
    fireEvent.change(within(dialog).getByRole("textbox", { name: "Delay" }), { target: { value: "2" } });
    fireEvent.click(within(dialog).getByRole("checkbox", { name: "This delay to every row" }));
    fireEvent.click(within(dialog).getByRole("button", { name: "Save" }));
    expect(filesByTrack["1"].map((file) => file.delay)).toEqual([2, 2]);

    fireEvent.click(screen.getByRole("tab", { name: /Audio 2/ }));
    fireEvent.click(screen.getByRole("tab", { name: /Audio 1/ }));
    expect(filesByTrack["1"].map((file) => file.delay)).toEqual([2, 2]);

    // A file whose delay came from the slot still follows the slot's Delay.
    fireEvent.click(screen.getByRole("tab", { name: /Audio 2/ }));
    fireEvent.change(screen.getByRole("textbox", { name: "Delay in seconds" }), { target: { value: "1.25" } });
    expect(filesByTrack["2"][0].delay).toBe(1.25);
  });

  it("leaves a track following its file's delay when its pencil is saved without a new one", () => {
    slots(["1"], { "1": "1.500" });
    const tracks = [
      { id: "0", type: "audio" as const, language: "hin" },
      { id: "1", type: "audio" as const, language: "tam" },
    ];
    render(<Harness initial={{ "1": [dub("a", { matchedVideoId: "v1", delay: 1.5, tracks, includedTrackIds: [0, 1] })] }} videos={[video(1)]} />);
    fireEvent.doubleClick(screen.getByRole("row", { name: "a.mka" }));
    fireEvent.click(screen.getAllByRole("button", { name: "Language, name and delay" })[1]);
    const trackDialog = screen.getByRole("dialog", { name: "Edit a track" });
    expect(within(trackDialog).getByRole("textbox", { name: "Delay" })).toHaveValue("1.5");
    fireEvent.click(within(trackDialog).getByRole("button", { name: "Save" }));
    const saved = filesByTrack["1"][0];
    expect(saved.trackOverrides?.[1]?.delay).toBeUndefined();
    expect(saved.trackOverrides?.[1]?.delayProvenance).toBeUndefined();
    expect(saved.delay).toBe(1.5);
  });

  it("imports into the row it names, not past an empty one", () => {
    slots(["1"]);
    const first = { ...video(1), tracks: [{ id: "1", type: "audio" as const, language: "hin" }] };
    render(<Harness initial={{ "1": [dub("a", { matchedVideoId: "v1" })] }} videos={[first, video(2), video(3)]} />);
    fireEvent.click(screen.getByRole("row", { name: "Episode 03.mkv" }));
    fireEvent.click(screen.getByRole("button", { name: "Import from a video" }));
    const dialog = screen.getByRole("dialog", { name: "Import audio from a video" });
    expect(dialog).toHaveTextContent("Into row 2, beside Episode 02.mkv, the first without a file");
    fireEvent.click(within(dialog).getByRole("checkbox", { name: "Import stream 1" }));
    fireEvent.click(within(dialog).getByRole("button", { name: "Import 1" }));
    expect(filesByTrack["1"].map((file) => file.matchedVideoId)).toEqual(["v1", "v2"]);
  });

  it("drops the selection when the search hides it", () => {
    slots(["1"]);
    render(<Harness initial={{ "1": [dub("alpha", { matchedVideoId: "v1" }), dub("beta", { matchedVideoId: "v2" })] }} videos={[video(1), video(2)]} />);
    fireEvent.click(screen.getByRole("row", { name: "alpha.mka" }));
    expect(commands?.removeSelected).toBeDefined();
    act(() => {
      fireEvent.change(screen.getByRole("textbox", { name: "Search audio" }), { target: { value: "beta" } });
    });
    expect(commands?.removeSelected).toBeUndefined();
    expect(screen.getByRole("button", { name: "Duplicate the file" })).toBeDisabled();
  });

  it("turns off Choose folder and Import from a video while measuring", () => {
    slots(["1"]);
    measuring.isMeasuring = true;
    render(<Harness initial={{ "1": [dub("a", { matchedVideoId: "v1" })] }} videos={[video(1)]} />);
    expect(commands?.disabled?.chooseFolder).toBe(true);
    expect(commands?.disabled?.importFromVideo).toBe(true);
  });

  describe("pairing by episode", () => {
    const episode = (n: number): VideoFile => ({ id: `e${n}`, name: `Show.S01E0${n}.1080p.mkv`, path: `/videos/Show.S01E0${n}.1080p.mkv`, size: 1, status: "pending", tracks: [] });
    const hindi = (n: number, extra: Partial<ExternalFile> = {}) => dub(`Show.S01E0${n}.Hindi`, { name: `Show.S01E0${n}.Hindi.eac3`, path: `/dubs/Show.S01E0${n}.Hindi.eac3`, ...extra });
    const videos = [episode(1), episode(2), episode(3)];

    it("leaves an empty row where a dub is missing, so the next stays with its own episode", () => {
      slots(["1"]);
      render(<Harness initial={{ "1": [hindi(1), hindi(3)] }} videos={videos} />);
      const files = filesByTrack["1"];
      expect(files.map((file) => (file.placeholder ? "—" : file.name))).toEqual(["Show.S01E01.Hindi.eac3", "—", "Show.S01E03.Hindi.eac3"]);
      expect(files.map((file) => file.matchedVideoId)).toEqual(["e1", "e2", "e3"]);
      expect(screen.getByRole("combobox", { name: "Pair by" })).toHaveValue("episode");
      expect(within(screen.getByRole("row", { name: "Show.S01E03.Hindi.eac3" })).getByText("Episode")).toBeInTheDocument();
      // The empty row is the video's, with no file and nothing to open.
      const gapRow = screen.getByRole("row", { name: "Show.S01E02.1080p.mkv" });
      fireEvent.doubleClick(gapRow);
      expect(screen.queryByRole("dialog")).toBeNull();
    });

    it("keeps empty rows out of the mux and the measurement", () => {
      slots(["1"]);
      render(<Harness initial={{ "1": [hindi(3, { delay: 1.5, delayProvenance: "manual" }), hindi(1)] }} videos={videos} />);
      const files = filesByTrack["1"];
      expect(files.some((file) => file.placeholder)).toBe(true);
      // Each file kept its own delay as it moved to its episode's row.
      expect(files[2]).toMatchObject({ name: "Show.S01E03.Hindi.eac3", delay: 1.5, matchedVideoId: "e3" });

      const jobs = videos.map((video) => ({ id: `job-${video.id}`, videoFile: video, status: "queued" as const, progress: 0 }));
      const requests = buildMuxJobRequests({ videoFiles: videos, jobs, audioFilesByTrack: filesByTrack, subtitleFilesByTrack: {}, chapterFiles: [], attachmentFiles: [], perVideoExternal: {} });
      expect(requests.map((request) => request.audios.map((file) => file.name))).toEqual([["Show.S01E01.Hindi.eac3"], [], ["Show.S01E03.Hindi.eac3"]]);

      const plan = buildMeasurementPlan({ videoFiles: videos, audioFiles: files, force: true });
      expect(plan.measurements.map((m) => [m.audioName, m.videoId])).toEqual([
        ["Show.S01E01.Hindi.eac3", "e1"],
        ["Show.S01E03.Hindi.eac3", "e3"],
      ]);
      expect(plan.unmatched).toEqual([]);
    });

    it("goes back to pairing by row when asked, dropping the empty rows", () => {
      slots(["1"]);
      render(<Harness initial={{ "1": [hindi(1), hindi(3)] }} videos={videos} />);
      fireEvent.change(screen.getByRole("combobox", { name: "Pair by" }), { target: { value: "order" } });
      expect(filesByTrack["1"].map((file) => [file.name, file.matchedVideoId])).toEqual([
        ["Show.S01E01.Hindi.eac3", "e1"],
        ["Show.S01E03.Hindi.eac3", "e2"],
      ]);
      // By row, a dub beside another episode is a conflict the Match column shows.
      expect(within(screen.getByRole("row", { name: "Show.S01E03.Hindi.eac3" })).getByText("Other episode")).toBeInTheDocument();
    });

    it("puts a file no video takes after the last video, offering Match by audio", () => {
      slots(["1"]);
      const odd = dub("Track 2", { name: "Track 2.eac3", path: "/dubs/Track 2.eac3" });
      // Four names of five read: 80 %, so the page pairs by episode on its own.
      const five = [...videos, episode(4), episode(5)];
      render(<Harness initial={{ "1": [hindi(1), hindi(2), hindi(4), hindi(5), odd] }} videos={five} />);
      expect(filesByTrack["1"].map((file) => (file.placeholder ? "—" : file.name))).toEqual(["Show.S01E01.Hindi.eac3", "Show.S01E02.Hindi.eac3", "—", "Show.S01E04.Hindi.eac3", "Show.S01E05.Hindi.eac3", "Track 2.eac3"]);
      expect(filesByTrack["1"][5].matchedVideoId).toBeUndefined();
      expect(within(screen.getByRole("row", { name: "Track 2.eac3" })).getByText("No episode")).toBeInTheDocument();
      // The engine is missing in this test, so it is offered but cannot run.
      expect(screen.getByRole("button", { name: "Match by audio" })).toBeDisabled();
    });

    it("duplicates into the next empty row and keeps the copy there by hand", () => {
      slots(["1"]);
      render(<Harness initial={{ "1": [hindi(1), hindi(3)] }} videos={videos} />);
      fireEvent.click(screen.getByRole("row", { name: "Show.S01E01.Hindi.eac3" }));
      fireEvent.click(screen.getByRole("button", { name: "Duplicate the file" }));
      const files = filesByTrack["1"];
      expect(files.map((file) => [file.name, file.matchedVideoId, Boolean(file.isManuallyLinked)])).toEqual([
        ["Show.S01E01.Hindi.eac3", "e1", false],
        ["Show.S01E01.Hindi.eac3", "e2", true],
        ["Show.S01E03.Hindi.eac3", "e3", false],
      ]);
    });
  });

  describe("conforming a different cut", () => {
    const e02: VideoFile = { ...video(2), tracks: [{ id: "0", type: "video" }, { id: "1", type: "audio", language: "kor" }] };
    const measured = (extra: Partial<MeasuredDelay> = {}): MeasuredDelay => ({
      engineDelayMs: 840,
      appliedMs: -840,
      confidence: 0.98,
      driftMsPerS: null,
      hasSignificantDrift: false,
      isRateMismatch: false,
      isLikelyCut: true,
      cutPositionS: 100,
      cutMagnitudeMs: -10000,
      correctionRatio: null,
      rateSourceFps: null,
      rateTargetFps: null,
      rateExplanation: null,
      referenceTrack: 0,
      primaryFps: 23.976,
      measuredAt: "2026-11-23T10:00:00.000Z",
      error: null,
      videoPath: e02.path,
      ...extra,
    });
    const cut = (extra: Partial<ExternalFile> = {}) =>
      dub("a", { matchedVideoId: "v2", tracks: [{ id: "0", type: "audio", codec: "E-AC3" }], includedTrackIds: [0], measuredDelay: measured(), ...extra });
    const result = (runId: string, extra: Partial<ConformResultEvent> = {}): ConformResultEvent => ({
      runId,
      key: "a",
      outputPath: "/audio/MKVBatchMux conformed/a.conformed.eac3",
      mode: "render",
      codec: "eac3",
      verified: true,
      verificationText: "Checked against the video: every spot within 1 ms.",
      residualMs: -0.15,
      plan: null,
      description: null,
      error: null,
      fallbackReason: null,
      ...extra,
    });

    it("offers Conform beside the result, runs it, says Conformed, and undoes it", async () => {
      slots(["1"]);
      measuring.engine = { engineAvailable: true, ffmpegAvailable: true, message: null };
      render(<Harness initial={{ "1": [dub("x", { matchedVideoId: "v1" }), cut()] }} videos={[video(1), e02]} />);
      const row = () => screen.getByRole("row", { name: "a.mka" });
      expect(within(row()).getByText("Different cut")).toBeInTheDocument();
      expect(within(row()).getByRole("button", { name: "Conform" })).toBeEnabled();

      fireEvent.click(screen.getByRole("button", { name: "Conform 1 dub" }));
      await waitFor(() => expect(conformMock.start).toHaveBeenCalledTimes(1));
      const request = conformMock.start.mock.calls[0][0] as ConformRequest;
      expect(request).toMatchObject({
        mode: "render",
        codec: "same",
        outputDir: null,
        pairs: [{ key: "a", primaryPath: e02.path, secondaryPath: "/audio/a.mka", primaryTrack: 0, secondaryTrack: 0 }],
      });
      // While it runs, the row shows its progress and nothing else can start.
      act(() => conformMock.handlers.progress({ runId: request.runId, key: "a", percent: 40, stage: "Rendering", processed: 0, total: 1 }));
      expect(within(row()).getByText("Rendering")).toBeInTheDocument();
      expect(screen.getByRole("button", { name: /Stop/ })).toBeInTheDocument();

      act(() => conformMock.handlers.result(result(request.runId)));
      act(() => conformMock.handlers.done({ runId: request.runId, cancelled: false, error: null }));
      expect(filesByTrack["1"][1].conformed).toMatchObject({ path: "/audio/MKVBatchMux conformed/a.conformed.eac3", verified: true, residualMs: -0.15, videoPath: e02.path, sourceTrack: 0 });
      expect(within(row()).getByText("Conformed")).toBeInTheDocument();
      expect(within(row()).getByText("conformed")).toBeInTheDocument();
      expect(shell.releaseEngine).toHaveBeenCalledWith("audio");
      expect(screen.queryByRole("button", { name: /^Conform \d/ })).toBeNull();

      // The popup shows the check, and Undo goes back to the original file.
      fireEvent.doubleClick(row());
      const dialog = screen.getByRole("dialog", { name: "a.mka" });
      expect(dialog).toHaveTextContent("Checked against the video: every spot within 1 ms. Largest offset left: -0.1 ms.");
      fireEvent.click(within(dialog).getByRole("button", { name: "Undo: mux the original" }));
      expect(filesByTrack["1"][1].conformed).toBeUndefined();
      expect(filesByTrack["1"][1].measuredDelay).toEqual(measured());
    });

    it("names what holds the engine instead of offering to run", () => {
      slots(["1"]);
      measuring.engine = { engineAvailable: true, ffmpegAvailable: true, message: null };
      shell.enginePage = "watch";
      render(<Harness initial={{ "1": [dub("x", { matchedVideoId: "v1" }), cut()] }} videos={[video(1), e02]} />);
      const conform = screen.getByRole("button", { name: "Conform 1 dub" });
      expect(conform).toBeDisabled();
      expect(conform).toHaveAttribute("title", "A watch folder is working on new episodes");
      expect(commands?.start).toBeUndefined();
    });

    it("explains why a file muxing two dubs cannot be conformed", () => {
      slots(["1"]);
      measuring.engine = { engineAvailable: true, ffmpegAvailable: true, message: null };
      const two = cut({
        tracks: [
          { id: "1", type: "audio", language: "hin" },
          { id: "2", type: "audio", language: "tam" },
        ],
        includedTrackIds: [1, 2],
        measuredDelay: undefined,
        trackOverrides: { 1: { measuredDelay: measured() }, 2: { measuredDelay: measured() } },
      });
      render(<Harness initial={{ "1": [dub("x", { matchedVideoId: "v1" }), two] }} videos={[video(1), e02]} />);
      expect(screen.queryByRole("button", { name: /^Conform/ })).toBeNull();
      fireEvent.doubleClick(screen.getByRole("row", { name: "a.mka" }));
      expect(screen.getByRole("dialog", { name: "a.mka" })).toHaveTextContent("Conforming works on one audio track, and 2 of this file's are muxed.");
    });

    it("won't conform a dub that brings subtitles into the mux, and says why in the row, the bulk button and the popup", () => {
      slots(["1"]);
      measuring.engine = { engineAvailable: true, ffmpegAvailable: true, message: null };
      const withSubs = cut({ tracks: [{ id: "0", type: "audio", codec: "E-AC3" }, { id: "1", type: "subtitle", codec: "SubRip/SRT" }], includeSubtitles: true, includedSubtitleTrackIds: [1] });
      render(<Harness initial={{ "1": [dub("x", { matchedVideoId: "v1" }), withSubs] }} videos={[video(1), e02]} />);
      const why = /This file also brings a subtitle track into the mux, and a conformed dub carries only its audio/;
      const rowButton = within(screen.getByRole("row", { name: "a.mka" })).getByRole("button", { name: /^Can't conform: / });
      expect(rowButton).toBeDisabled();
      expect(rowButton.getAttribute("aria-label")).toMatch(why);
      const bulk = screen.getByRole("button", { name: "Can't conform 1 dub" });
      expect(bulk).toBeDisabled();
      expect(bulk.getAttribute("title")).toMatch(why);
      fireEvent.doubleClick(screen.getByRole("row", { name: "a.mka" }));
      expect(screen.getByRole("dialog", { name: "a.mka" }).textContent).toMatch(why);
      expect(within(screen.getByRole("dialog", { name: "a.mka" })).queryByText("Conform to this cut")).toBeNull();
    });

    it("marks a result measured against another video, and leaves it out of Apply and Conform", () => {
      slots(["1"]);
      measuring.engine = { engineAvailable: true, ffmpegAvailable: true, message: null };
      // Measured against E01, now beside E02: both its pending delay and its cut answer for E01.
      const moved = cut({ pendingDelay: -0.84, measuredDelay: measured({ isLikelyCut: false, videoPath: video(1).path }) });
      render(<Harness initial={{ "1": [dub("x", { matchedVideoId: "v1" }), moved] }} videos={[video(1), e02]} />);
      expect(within(screen.getByRole("row", { name: "a.mka" })).getByText("Measured against another video")).toBeInTheDocument();
      expect(screen.queryByRole("button", { name: /^Apply/ })).toBeNull();
      expect(screen.queryByRole("button", { name: /^Conform/ })).toBeNull();
      fireEvent.doubleClick(screen.getByRole("row", { name: "a.mka" }));
      const dialog = screen.getByRole("dialog", { name: "a.mka" });
      expect(within(dialog).queryByRole("button", { name: "Apply" })).toBeNull();
      expect(within(dialog).getByRole("button", { name: "Measure again" })).toBeInTheDocument();
    });
  });
});

