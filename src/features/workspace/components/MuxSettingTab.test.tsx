import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, cleanup, within, fireEvent } from "@testing-library/react";
import type { MuxJob, MuxPreviewResult, MuxSettings, OutputSettings, VideoFile } from "@/shared/types";

// The tab reaches for the backend when picking a folder; nothing here clicks
// that, but the module must still import cleanly outside Tauri.
vi.mock("@/shared/lib/backend", () => ({ pickDirectory: vi.fn() }));

import { MuxSettingTab } from "./MuxSettingTab";

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

function renderTab(overrides: {
  previewResults?: Record<string, MuxPreviewResult>;
  onStartMuxing?: () => void;
  overwriteExisting?: boolean;
}) {
  const onStartMuxing = overrides.onStartMuxing ?? vi.fn();
  render(
    <MuxSettingTab
      settings={{ ...outputSettings, overwriteExisting: overrides.overwriteExisting ?? false }}
      onSettingsChange={vi.fn()}
      muxSettings={muxSettings}
      onMuxSettingsChange={vi.fn()}
      fastMuxAvailable={false}
      externalLinkIssues={[]}
      jobs={[job]}
      videoFiles={[video]}
      onAddToQueue={vi.fn()}
      onClearAll={vi.fn()}
      onStartMuxing={onStartMuxing}
      onPauseMuxing={vi.fn()}
      onResumeMuxing={vi.fn()}
      onStopMuxing={vi.fn()}
      onViewLog={vi.fn()}
      previewResults={overrides.previewResults ?? {}}
      previewLoading={false}
      onPreviewQueue={vi.fn()}
    />,
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

describe("MuxSettingTab start confirmation", () => {
  beforeEach(cleanup);

  it("starts immediately when validation found nothing", async () => {
    const { onStartMuxing } = renderTab({ previewResults: {} });

    fireEvent.click(screen.getByRole("button", { name: /start muxing/i }));

    // No alert for the common, clean case.
    expect(onStartMuxing).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
  });

  it("asks first when validation produced warnings, and lists them", async () => {
    const { onStartMuxing } = renderTab({ previewResults: withWarnings });

    fireEvent.click(screen.getByRole("button", { name: /^start muxing$/i }));

    expect(onStartMuxing).not.toHaveBeenCalled();
    // BaseModal renders the title twice on purpose -- once visible, once for
    // screen readers -- so match the heading rather than the raw text.
    const dialog = screen.getByRole("alertdialog");
    // Both copies are headings (Radix renders the screen-reader title as one),
    // so assert the title is present rather than that it is unique.
    expect(
      within(dialog).getAllByRole("heading", { name: /start muxing with 2 warnings\?/i }).length,
    ).toBeGreaterThan(0);
    expect(within(dialog).getByText(/Output file already exists/)).toBeInTheDocument();
    expect(within(dialog).getByText(/Subtitle track has no language/)).toBeInTheDocument();
  });

  it("does not start when the confirmation is cancelled", async () => {
    const { onStartMuxing } = renderTab({ previewResults: withWarnings });

    fireEvent.click(screen.getByRole("button", { name: /^start muxing$/i }));
    fireEvent.click(screen.getByRole("button", { name: /^cancel$/i }));

    expect(onStartMuxing).not.toHaveBeenCalled();
  });

  it("starts once the confirmation is accepted", async () => {
    const { onStartMuxing } = renderTab({ previewResults: withWarnings });

    fireEvent.click(screen.getByRole("button", { name: /^start muxing$/i }));
    const dialog = screen.getByRole("alertdialog");
    fireEvent.click(within(dialog).getByRole("button", { name: /^start muxing$/i }));

    expect(onStartMuxing).toHaveBeenCalledTimes(1);
  });

  it("says the sources will be replaced when overwrite is on", async () => {
    renderTab({ previewResults: withWarnings, overwriteExisting: true });

    fireEvent.click(screen.getByRole("button", { name: /^start muxing$/i }));

    expect(screen.getByText(/replace the source files/i)).toBeInTheDocument();
    expect(screen.getByText(/cannot be undone/i)).toBeInTheDocument();
  });
});
