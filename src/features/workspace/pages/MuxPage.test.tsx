import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, cleanup, within, fireEvent } from "@testing-library/react";
import type { ReactNode } from "react";
import type { MuxJob, MuxPreviewResult, MuxSettings, OutputSettings, VideoFile } from "@/shared/types";
import type { VerificationReport } from "@/shared/types/verify";
import { ShellContext, type Shell } from "@/app/shell";

// The page reaches for the backend when picking a folder; nothing here clicks
// that, but the module must still import cleanly outside Tauri.
vi.mock("@/shared/lib/backend", () => ({ pickDirectory: vi.fn() }));

import { MuxPage, type JobReport } from "./MuxPage";

const video: VideoFile = {
  id: "v1",
  name: "Episode 01.mkv",
  path: "/videos/Episode 01.mkv",
  size: 1024,
  status: "pending",
  tracks: [],
};

const job: MuxJob = { id: "j1", videoFile: video, status: "queued", progress: 0 };

const outputSettings: OutputSettings = {
  directory: "/out",
  namingPattern: "{original_filename}",
  overwriteExisting: false,
};

const muxSettings = {
  destinationDir: "/out",
  overwriteSource: false,
  addCrc: false,
  removeOldCrc: false,
  keepLogFile: false,
  abortOnErrors: false,
  maxParallelJobs: 1,
  onlyKeepAudiosEnabled: false,
  onlyKeepSubtitlesEnabled: false,
  onlyKeepAudioLanguages: [],
  onlyKeepSubtitleLanguages: [],
  discardOldChapters: false,
  discardOldAttachments: false,
  allowDuplicateAttachments: false,
  attachmentsExpertMode: false,
  removeGlobalTags: false,
  useMkvpropedit: false,
} satisfies MuxSettings;

const shell = (overrides: Partial<Shell> = {}): Shell => ({
  active: "mux",
  show: vi.fn(),
  desktop: false,
  enginePage: null,
  claimEngine: () => true,
  releaseEngine: vi.fn(),
  log: vi.fn(),
  openOutput: vi.fn(),
  dock: { tab: null, setTab: vi.fn(), output: null, history: null },
  addHistory: vi.fn(),
  setCommands: vi.fn(),
  openPreferences: vi.fn(),
  copy: vi.fn(),
  publishStatus: vi.fn(),
  runStatus: null,
  ...overrides,
});

const withShell = (children: ReactNode, overrides?: Partial<Shell>) => <ShellContext.Provider value={shell(overrides)}>{children}</ShellContext.Provider>;

const onSettingsChange = vi.fn();

function renderPage(overrides: {
  previewResults?: Record<string, MuxPreviewResult>;
  onStartMuxing?: () => void;
  overwriteExisting?: boolean;
  shell?: Partial<Shell>;
  getJobReport?: (jobId: string) => JobReport | null;
  jobs?: MuxJob[];
  muxSettings?: Partial<MuxSettings>;
  onMuxSettingsChange?: (settings: Partial<MuxSettings>) => void;
}) {
  const onStartMuxing = overrides.onStartMuxing ?? vi.fn();
  const onClearQueue = vi.fn();
  render(
    withShell(
      <MuxPage
        hidden={false}
        settings={{ ...outputSettings, overwriteExisting: overrides.overwriteExisting ?? false }}
        onSettingsChange={onSettingsChange}
        muxSettings={{ ...muxSettings, ...overrides.muxSettings }}
        onMuxSettingsChange={overrides.onMuxSettingsChange ?? vi.fn()}
        fastMuxAvailable={false}
        externalLinkIssues={[]}
        unlinkedPage={null}
        jobs={overrides.jobs ?? [job]}
        videoFiles={(overrides.jobs ?? [job]).map((each) => each.videoFile)}
        onClearQueue={onClearQueue}
        onStartMuxing={onStartMuxing}
        onPauseMuxing={vi.fn()}
        onResumeMuxing={vi.fn()}
        onStopMuxing={vi.fn()}
        previewResults={overrides.previewResults ?? {}}
        getJobReport={overrides.getJobReport}
        previewLoading={false}
        onPreviewQueue={vi.fn()}
        batch={{ startedAt: null, finishedAt: null, paused: false }}
        running={false}
      />,
      overrides.shell,
    ),
  );
  return { onStartMuxing, onClearQueue };
}

const withWarnings: Record<string, MuxPreviewResult> = {
  j1: {
    jobId: "j1",
    command: "mkvmerge ...",
    warnings: ["Output file already exists", "Subtitle track has no language"],
    plan: { video: video.path, output: "/out/Episode 01.mkv", audios: [], subtitles: [], chapters: [], attachments: [] },
  },
};

describe("MuxPage start confirmation", () => {
  beforeEach(cleanup);

  it("starts immediately when validation found nothing", () => {
    const { onStartMuxing } = renderPage({ previewResults: {} });

    fireEvent.click(screen.getByRole("button", { name: /^start muxing$/i }));

    // No question for the common, clean case.
    expect(onStartMuxing).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
  });

  it("asks first when validation produced warnings, and lists them", () => {
    const { onStartMuxing } = renderPage({ previewResults: withWarnings });

    fireEvent.click(screen.getByRole("button", { name: /^start muxing$/i }));

    expect(onStartMuxing).not.toHaveBeenCalled();
    const dialog = screen.getByRole("alertdialog");
    expect(within(dialog).getByRole("heading", { name: /start muxing with 2 warnings\?/i })).toBeInTheDocument();
    expect(within(dialog).getByText(/Output file already exists/)).toBeInTheDocument();
    expect(within(dialog).getByText(/Subtitle track has no language/)).toBeInTheDocument();
  });

  it("does not start when the confirmation is cancelled", () => {
    const { onStartMuxing } = renderPage({ previewResults: withWarnings });

    fireEvent.click(screen.getByRole("button", { name: /^start muxing$/i }));
    fireEvent.click(screen.getByRole("button", { name: /^cancel$/i }));

    expect(onStartMuxing).not.toHaveBeenCalled();
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
  });

  it("starts once the confirmation is accepted", () => {
    const { onStartMuxing } = renderPage({ previewResults: withWarnings });

    fireEvent.click(screen.getByRole("button", { name: /^start muxing$/i }));
    const dialog = screen.getByRole("alertdialog");
    fireEvent.click(within(dialog).getByRole("button", { name: /^start muxing$/i }));

    expect(onStartMuxing).toHaveBeenCalledTimes(1);
  });

  it("says the sources will be replaced when overwrite is on", () => {
    renderPage({ previewResults: withWarnings, overwriteExisting: true });

    fireEvent.click(screen.getByRole("button", { name: /^start muxing$/i }));

    expect(screen.getByText(/replace the source files/i)).toBeInTheDocument();
    expect(screen.getByText(/cannot be undone/i)).toBeInTheDocument();
  });

  it("will not start while Audio is measuring: one engine command at a time", () => {
    const { onStartMuxing } = renderPage({ shell: { enginePage: "audio" } });

    const start = screen.getByRole("button", { name: /^start muxing$/i });
    expect(start).toBeDisabled();
    fireEvent.click(start);
    expect(onStartMuxing).not.toHaveBeenCalled();
  });
});

describe("MuxPage queue", () => {
  beforeEach(cleanup);

  it("asks before clearing the queue, and clears only when told to", () => {
    const { onClearQueue } = renderPage({});

    fireEvent.click(screen.getByRole("button", { name: /^clear the queue$/i }));
    const dialog = screen.getByRole("alertdialog");
    fireEvent.click(within(dialog).getByRole("button", { name: /^cancel$/i }));
    expect(onClearQueue).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: /^clear the queue$/i }));
    fireEvent.click(within(screen.getByRole("alertdialog")).getByRole("button", { name: /^clear$/i }));
    expect(onClearQueue).toHaveBeenCalledTimes(1);
  });

  it("opens a job's details on a double-click, with the removed tracks folded away", () => {
    const report: JobReport = {
      title: video.name,
      sections: [],
      tracks: [
        { type: "video", name: "AVC", from: "Source", flags: ["Default"] },
        { type: "audio", language: "hin", name: "E-AC3", from: "Episode 01.hin.eac3", flags: [], added: true },
        { type: "subtitle", language: "eng", name: "SDH", from: "Source", flags: [], removed: true },
      ],
      also: [["Global tags", "Removed"]],
    };
    renderPage({ getJobReport: () => report });

    fireEvent.doubleClick(screen.getByRole("row", { name: video.name }));
    const dialog = screen.getByRole("dialog", { name: video.name });
    expect(within(dialog).getByText("Episode 01.hin.eac3")).toBeInTheDocument();
    expect(within(dialog).queryByText("SDH")).not.toBeInTheDocument();

    fireEvent.click(within(dialog).getByRole("button", { name: /1 removed/i }));
    expect(within(dialog).getByText("SDH")).toBeInTheDocument();
    expect(within(dialog).getByText("Removed", { selector: ".also span" })).toBeInTheDocument();
  });

  it("keeps the options out of sight until Options opens them", () => {
    renderPage({});

    expect(screen.queryByRole("dialog", { name: "Mux options" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /^options$/i }));
    const options = screen.getByRole("dialog", { name: "Mux options" });
    expect(within(options).getByText("Remove from the source")).toBeInTheDocument();
    expect(within(options).getByRole("switch", { name: /remove global tags from the source/i })).toBeInTheDocument();
  });
});

describe("MuxPage Overwrite", () => {
  beforeEach(cleanup);

  it("sits outside Save to, one click away", () => {
    onSettingsChange.mockClear();
    renderPage({});

    expect(screen.queryByRole("dialog", { name: "Save to" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("checkbox", { name: "Overwrite" }));
    expect(onSettingsChange).toHaveBeenCalledWith({ overwriteExisting: true });
  });
});

describe("MuxPage verification", () => {
  beforeEach(cleanup);

  const checked = (overrides: Partial<VerificationReport>): VerificationReport => ({
    ok: true,
    checks: [
      { id: "tracks", label: "Tracks", status: "pass", detail: "1 video, 2 audio, 1 subtitle tracks" },
      { id: "chapters", label: "Chapters", status: "skip", detail: "None added" },
      { id: "sync", label: "Sync: Episode 01.hin.eac3", status: "pass", detail: "In sync: 5 ms late, within 40 ms (100 % confidence)" },
    ],
    residualMs: 5.3,
    syncConfidence: 0.99,
    ...overrides,
  });
  const episode = (n: number, rest: Partial<MuxJob>): MuxJob => ({
    id: `j${n}`,
    videoFile: { ...video, id: `v${n}`, name: `Episode 0${n}.mkv`, path: `/videos/Episode 0${n}.mkv` },
    status: "completed",
    progress: 100,
    ...rest,
  });
  const failed = checked({
    ok: false,
    checks: [{ id: "sync", label: "Sync: Episode 03.hin.eac3", status: "fail", detail: "Episode 03.hin.eac3 plays 1317 ms late, more than the 40 ms allowed (100 % confidence)" }],
    residualMs: 1317.3,
    keptPath: "/out/Episode 03.unverified.mkv",
  });
  const jobs = [
    episode(1, { verification: checked({}) }),
    episode(2, { verification: checked({ checks: [{ id: "flags", label: "Names and flags", status: "warn", detail: "Audio 2 is not default" }] }) }),
    episode(3, { status: "error", errorMessage: "Verification failed: Episode 03.hin.eac3 plays 1317 ms late", verification: failed }),
    episode(4, { status: "processing", stage: "verifying" }),
    episode(5, {}),
  ];

  it("shows each job's verification in the queue's Status", () => {
    renderPage({ jobs });

    expect(within(screen.getByRole("row", { name: "Episode 01.mkv" })).getByText("Verified")).toBeInTheDocument();
    const warned = within(screen.getByRole("row", { name: "Episode 02.mkv" })).getByText("Verified with warnings");
    expect(warned.closest("[title]")).toHaveAttribute("title", "Names and flags: Audio 2 is not default");
    expect(within(screen.getByRole("row", { name: "Episode 03.mkv" })).getByText("Verification failed")).toBeInTheDocument();
    expect(within(screen.getByRole("row", { name: "Episode 04.mkv" })).getByText("Verifying")).toBeInTheDocument();
    // Checking turned off: done, as before.
    expect(within(screen.getByRole("row", { name: "Episode 05.mkv" })).getByText("Done")).toBeInTheDocument();
  });

  it("lists the checks in the job's details, and where a failed file was kept", () => {
    renderPage({ jobs });

    fireEvent.doubleClick(screen.getByRole("row", { name: "Episode 01.mkv" }));
    let dialog = screen.getByRole("dialog", { name: "Episode 01.mkv" });
    const checks = within(dialog).getByRole("table", { name: "Checks on the new file" });
    expect(within(checks).getByRole("row", { name: "Tracks" })).toHaveTextContent("Passed");
    expect(within(checks).getByRole("row", { name: "Chapters" })).toHaveTextContent("Not checked");
    expect(within(checks).getByText(/In sync: 5 ms late/)).toBeInTheDocument();
    fireEvent.click(within(dialog).getAllByRole("button", { name: /^close$/i })[0]);

    fireEvent.doubleClick(screen.getByRole("row", { name: "Episode 03.mkv" }));
    dialog = screen.getByRole("dialog", { name: "Episode 03.mkv" });
    expect(within(dialog).getByText(/Kept as \/out\/Episode 03\.unverified\.mkv; the source was not touched/)).toBeInTheDocument();
    expect(within(dialog).getByRole("row", { name: "Sync: Episode 03.hin.eac3" })).toHaveTextContent("Failed");
  });

  it("turns the checks on and off in Options, sync only while checking is on", () => {
    const onMuxSettingsChange = vi.fn();
    renderPage({ onMuxSettingsChange });

    fireEvent.click(screen.getByRole("button", { name: /^options$/i }));
    const options = screen.getByRole("dialog", { name: "Mux options" });
    // Absent from older settings: on.
    const check = within(options).getByRole("switch", { name: "Check each new file" });
    expect(check).toHaveAttribute("aria-checked", "true");
    expect(within(options).getByRole("switch", { name: "Check the sync of added audio" })).toBeEnabled();
    fireEvent.click(check);
    expect(onMuxSettingsChange).toHaveBeenCalledWith({ verifyOutput: false });
    fireEvent.change(within(options).getByRole("combobox", { name: "Sync may be off by" }), { target: { value: "80" } });
    expect(onMuxSettingsChange).toHaveBeenCalledWith({ verifySyncToleranceMs: 80 });
  });

  it("leaves sync off while checking is off", () => {
    renderPage({ muxSettings: { verifyOutput: false, verifySync: true } });

    fireEvent.click(screen.getByRole("button", { name: /^options$/i }));
    const options = screen.getByRole("dialog", { name: "Mux options" });
    const sync = within(options).getByRole("switch", { name: "Check the sync of added audio" });
    expect(sync).toBeDisabled();
    expect(sync).toHaveAttribute("aria-checked", "false");
    expect(within(options).getByRole("combobox", { name: "Sync may be off by" })).toBeDisabled();
  });
});
