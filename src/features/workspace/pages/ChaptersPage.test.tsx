import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { useState } from "react";
import type { ExternalFile, MuxSettings, VideoFile } from "@/shared/types";
import { ShellContext, type Shell } from "@/app/shell";
import { useTabState } from "@/features/workspace/store/useTabState";

vi.mock("@/shared/lib/backend", () => ({ pickDirectory: vi.fn(), scanMedia: vi.fn() }));

import { ChaptersPage } from "./ChaptersPage";

const video = (n: number): VideoFile => ({ id: `v${n}`, name: `Episode 0${n}.mkv`, path: `/videos/Episode 0${n}.mkv`, size: 1, status: "pending", tracks: [] });
const chapter = (n: number, matchedVideoId?: string): ExternalFile => ({ id: `c${n}`, name: `c${n}.xml`, path: `/chapters/c${n}.xml`, type: "chapter", matchedVideoId });

const shell: Shell = {
  active: "chapters",
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
};

let latest: ExternalFile[] = [];

function Harness({ initial, videos }: { initial: ExternalFile[]; videos: VideoFile[] }) {
  const [files, setFiles] = useState(initial);
  latest = files;
  return (
    <ShellContext.Provider value={shell}>
      <ChaptersPage hidden={false} chapterFiles={files} videoFiles={videos} onChapterFilesChange={setFiles} muxSettings={{ discardOldChapters: false } as MuxSettings} onMuxSettingsChange={vi.fn()} />
    </ShellContext.Provider>
  );
}

const links = () => latest.map((file) => [file.id, file.matchedVideoId ?? null, Boolean(file.isManuallyLinked)]);

beforeEach(() => {
  cleanup();
  useTabState.setState((state) => ({ chapterTabState: { ...state.chapterTabState, chaptersEnabled: true } }));
});

describe("ChaptersPage linking by hand", () => {
  it("gives the video's old chapter file this one's video in exchange", () => {
    render(<Harness initial={[chapter(1, "v1"), chapter(2, "v2")]} videos={[video(1), video(2)]} />);
    fireEvent.change(screen.getByRole("combobox", { name: "Video for c2.xml" }), { target: { value: "v1" } });
    expect(links()).toEqual([
      ["c1", "v2", true],
      ["c2", "v1", true],
    ]);

    // Back by order: both return to their own rows' videos.
    fireEvent.doubleClick(screen.getByRole("row", { name: "c2.xml" }));
    fireEvent.click(screen.getByRole("button", { name: "Link by order again" }));
    expect(links()).toEqual([
      ["c1", "v1", false],
      ["c2", "v2", false],
    ]);
  });

  it("never leaves a video with two chapter files when the linked one was past the last video", () => {
    render(<Harness initial={[chapter(1, "v1"), chapter(2)]} videos={[video(1)]} />);
    fireEvent.change(screen.getByRole("combobox", { name: "Video for c2.xml" }), { target: { value: "v1" } });
    expect(links()).toEqual([
      ["c1", null, false],
      ["c2", "v1", true],
    ]);
  });
});

describe("ChaptersPage pairing", () => {
  const episode = (n: number): VideoFile => ({ id: `e${n}`, name: `Show.S01E0${n}.mkv`, path: `/videos/Show.S01E0${n}.mkv`, size: 1, status: "pending", tracks: [] });
  const chapters = (n: number): ExternalFile => ({ id: `c${n}`, name: `Show.S01E0${n}.chapters.xml`, path: `/chapters/Show.S01E0${n}.chapters.xml`, type: "chapter" });

  it("pairs by episode with an empty row for a missing file, and a hand link still wins", () => {
    render(<Harness initial={[chapters(3), chapters(1)]} videos={[episode(1), episode(2), episode(3)]} />);
    expect(latest.map((file) => (file.placeholder ? "—" : file.id))).toEqual(["c1", "—", "c3"]);
    expect(latest.map((file) => file.matchedVideoId)).toEqual(["e1", "e2", "e3"]);
    expect(screen.getAllByText("Episode")).toHaveLength(2);

    // Linked by hand to episode 2: it moves to that row and stays.
    fireEvent.change(screen.getByRole("combobox", { name: "Video for Show.S01E03.chapters.xml" }), { target: { value: "e2" } });
    expect(latest.map((file) => (file.placeholder ? "—" : file.id))).toEqual(["c1", "c3"]);
    expect(latest[1]).toMatchObject({ matchedVideoId: "e2", isManuallyLinked: true });
  });
});

