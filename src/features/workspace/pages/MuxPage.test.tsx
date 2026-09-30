import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, cleanup, within, fireEvent } from "@testing-library/react";
import type { ReactNode } from "react";
import type { MuxJob, MuxPreviewResult, MuxSettings, OutputSettings, VideoFile } from "@/shared/types";
import { ShellContext, type Shell } from "@/app/shell";

// The page reaches for the backend when picking a folder; nothing here clicks
// that, but the module must still import cleanly outside Tauri.
vi.mock("@/shared/lib/backend", () => ({ pickDirectory: vi.fn() }));

import { MuxPage } from "./MuxPage";

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
  ...overrides,
});

const withShell = (children: ReactNode, overrides?: Partial<Shell>) => <ShellContext.Provider value={shell(overrides)}>{children}</ShellContext.Provider>;

function renderPage(overrides: {
  previewResults?: Record<string, MuxPreviewResult>;
  onStartMuxing?: () => void;
  overwriteExisting?: boolean;
  shell?: Partial<Shell>;
}) {
  const onStartMuxing = overrides.onStartMuxing ?? vi.fn();
  render(
    withShell(
      <MuxPage
        hidden={false}
        settings={{ ...outputSettings, overwriteExisting: overrides.overwriteExisting ?? false }}
        onSettingsChange={vi.fn()}
        muxSettings={muxSettings}
        onMuxSettingsChange={vi.fn()}
        fastMuxAvailable={false}
        externalLinkIssues={[]}
        unlinkedPage={null}
        jobs={[job]}
        videoFiles={[video]}
        queue={{ count: 0, add: vi.fn() }}
        onClearAll={vi.fn()}
        onRemoveJob={vi.fn()}
        onStartMuxing={onStartMuxing}
        onPauseMuxing={vi.fn()}
        onResumeMuxing={vi.fn()}
        onStopMuxing={vi.fn()}
        onViewLog={vi.fn()}
        previewResults={overrides.previewResults ?? {}}
        previewLoading={false}
        onPreviewQueue={vi.fn()}
        batch={{ startedAt: null, finishedAt: null, paused: false }}
        running={false}
      />,
      overrides.shell,
    ),
  );
  return { onStartMuxing };
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
