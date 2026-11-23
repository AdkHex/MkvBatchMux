/** Edit tracks: edits survive a file added from inside the dialog, and an
 *  unnamed track is not given its codec as a name. */

import "@testing-library/jest-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { ExternalFile, VideoFile } from "@/shared/types";

vi.mock("@/shared/lib/backend", () => ({ pickFiles: vi.fn() }));

import { VideoFileEditDialog } from "./VideoFileEditDialog";

afterEach(cleanup);

const video: VideoFile = {
  id: "v1",
  name: "Episode 01.mkv",
  path: "/videos/Episode 01.mkv",
  size: 1,
  status: "pending",
  tracks: [
    { id: "0", type: "video", codec: "HEVC", language: "und", isDefault: true, action: "keep" },
    { id: "1", type: "audio", codec: "AAC", language: "jpn", isDefault: true, isForced: false, action: "keep" },
    { id: "2", type: "audio", name: "Commentary", codec: "AAC", language: "eng", isDefault: false, isForced: false, action: "keep" },
  ],
};

const dub: ExternalFile = { id: "ext-1", name: "dub.ac3", path: "/dubs/dub.ac3", type: "audio", source: "per-file", language: "hin", trackName: "Hindi", delay: 0, matchedVideoId: "v1" };

function renderDialog(externalAudioFiles: ExternalFile[] = []) {
  const onSave = vi.fn();
  const onExternalFilesChange = vi.fn();
  const props = { open: true, onOpenChange: vi.fn(), videoFile: video, allVideoFiles: [video], onSave, onAddExternalFiles: vi.fn(), onExternalFilesChange, externalSubtitleFiles: [] };
  const view = render(<VideoFileEditDialog {...props} externalAudioFiles={externalAudioFiles} />);
  fireEvent.click(screen.getByRole("tab", { name: /Audio/ }));
  return { onSave, onExternalFilesChange, rerender: (files: ExternalFile[]) => view.rerender(<VideoFileEditDialog {...props} externalAudioFiles={files} />) };
}

const checkbox = (name: string) => screen.getByRole("checkbox", { name });

describe("VideoFileEditDialog", () => {
  it("keeps unsaved edits when a file is added from the dialog", () => {
    const { rerender } = renderDialog([]);
    fireEvent.click(checkbox("Copy track 2"));
    expect(checkbox("Copy track 2")).toHaveAttribute("aria-checked", "false");

    // Index adds the picked file to the video's list: a new array arrives.
    rerender([dub]);

    expect(checkbox("Copy track 2")).toHaveAttribute("aria-checked", "false");
    expect(screen.getByRole("row", { name: "Hindi" })).toBeInTheDocument();
  });

  it("drops the row of an added file that is gone from the list, and keeps the edits", () => {
    const { rerender } = renderDialog([dub]);
    fireEvent.click(checkbox("Copy track 2"));

    rerender([]);

    expect(screen.queryByRole("row", { name: "Hindi" })).not.toBeInTheDocument();
    expect(checkbox("Copy track 2")).toHaveAttribute("aria-checked", "false");
  });

  it("leaves an unnamed track unnamed on Apply, showing its codec only in its place", () => {
    const { onSave } = renderDialog();
    expect(screen.getByRole("row", { name: "AAC" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Apply" }));

    const saved = onSave.mock.calls[0][0] as VideoFile;
    expect(saved.tracks.map((track) => track.name)).toEqual([undefined, undefined, "Commentary"]);
    expect(saved.tracks.map((track) => track.action)).toEqual(["keep", "keep", "keep"]);
  });
});
