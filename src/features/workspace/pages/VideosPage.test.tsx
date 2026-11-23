/** The Videos list: what a selection scopes, and what stays locked while a
 *  batch is muxing. */

import "@testing-library/jest-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import type { VideoFile } from "@/shared/types";
import { ShellContext, type PageCommands, type Shell } from "@/app/shell";

vi.mock("@/shared/lib/backend", () => ({
  cancelScan: vi.fn(),
  inspectPathsStream: vi.fn(),
  listenInspectPathsStreamChunk: vi.fn(),
  listenInspectPathsStreamDone: vi.fn(),
  listenInspectPathsStreamError: vi.fn(),
  pickDirectory: vi.fn(),
  pickFiles: vi.fn(),
  scanMedia: vi.fn(),
}));

import { VideosPage } from "./VideosPage";

afterEach(cleanup);

// jsdom has no ResizeObserver; the list only uses it to size its virtual window.
vi.stubGlobal(
  "ResizeObserver",
  class {
    observe() {}
    disconnect() {}
  },
);

const video = (name: string, size: number): VideoFile => ({
  id: name,
  name,
  path: `/videos/${name}`,
  size,
  status: "pending",
  tracks: [{ id: "1", type: "audio", codec: "AAC", language: "jpn", action: "keep" }],
});

// Loaded order b, c, a; sizes so "Largest first" reverses it to a, c, b.
const FILES = [video("b.mkv", 2), video("c.mkv", 3), video("a.mkv", 4)];

function renderPage(shellOverrides: Partial<Shell> = {}) {
  let commands: PageCommands | null = null;
  const onSourceFolderChange = vi.fn();
  const onFilesChange = vi.fn();
  const shell: Shell = {
    active: "videos",
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
    ...shellOverrides,
  } as Shell;
  const wrap = (children: ReactNode) => <ShellContext.Provider value={shell}>{children}</ShellContext.Provider>;
  render(wrap(<VideosPage hidden={false} files={FILES} sourceFolder="/videos" onSourceFolderChange={onSourceFolderChange} onFilesChange={onFilesChange} />));
  return { commands: () => commands!, onSourceFolderChange, onFilesChange };
}

const row = (name: string) => screen.getByRole("row", { name });

describe("VideosPage", () => {
  it("scopes Modify tracks to the selected videos, not one of them", () => {
    renderPage();
    fireEvent.click(row("b.mkv"));
    fireEvent.click(row("c.mkv"), { ctrlKey: true });
    fireEvent.click(screen.getByRole("button", { name: /Modify tracks/ }));

    expect(screen.getByText("2 selected videos, track by position")).toBeInTheDocument();
  });

  it("never scopes Modify tracks to a video Ctrl+click just deselected", () => {
    renderPage();
    fireEvent.click(row("b.mkv"));
    fireEvent.click(row("c.mkv"), { ctrlKey: true });
    fireEvent.click(row("b.mkv"), { ctrlKey: true });
    fireEvent.click(screen.getByRole("button", { name: /Modify tracks/ }));

    // Only c is selected now, so only c shows in the dialog as well as in
    // the list.
    expect(screen.getAllByText("c.mkv")).toHaveLength(2);
    expect(screen.getAllByText("b.mkv")).toHaveLength(1);
  });

  it("modifies every video after Select all", () => {
    const { commands } = renderPage();
    fireEvent.click(row("b.mkv"));
    // Select all through the page's command, as Ctrl+A does.
    commands().selectAll?.();
    fireEvent.click(screen.getByRole("button", { name: /Modify tracks/ }));

    expect(screen.getByText("Every loaded video, track by position")).toBeInTheDocument();
  });

  it("extends a Shift+click range from the clicked video even after the list is re-sorted", () => {
    renderPage();
    // b is first in loaded order; after "Largest first" it is last (a, c, b).
    fireEvent.click(row("b.mkv"));
    fireEvent.change(screen.getByLabelText("Sort"), { target: { value: "size-desc" } });
    fireEvent.click(row("c.mkv"), { shiftKey: true });

    expect(row("b.mkv")).toHaveAttribute("aria-selected", "true");
    expect(row("c.mkv")).toHaveAttribute("aria-selected", "true");
    expect(row("a.mkv")).toHaveAttribute("aria-selected", "false");
  });

  it("locks removing, clearing and replacing the list while a batch is muxing", () => {
    const { commands, onSourceFolderChange } = renderPage({ enginePage: "mux" });
    fireEvent.click(row("b.mkv"));

    expect(commands().disabled).toMatchObject({ removeSelected: true, clear: true, chooseFolder: true });
    expect(screen.getByRole("button", { name: "Remove (Del)" })).toBeDisabled();
    expect(screen.getByRole("button", { name: /Choose folder/ })).toBeDisabled();

    commands().drop?.(["/videos/Season 2"]);
    expect(onSourceFolderChange).not.toHaveBeenCalled();
  });

  it("leaves them available when nothing is muxing", () => {
    const { commands } = renderPage();
    fireEvent.click(row("b.mkv"));

    expect(commands().disabled).toMatchObject({ removeSelected: false, clear: false, chooseFolder: false });
  });
});
