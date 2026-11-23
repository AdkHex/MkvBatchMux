import "@testing-library/jest-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { VideoFile } from "@/shared/types";

import { ModifyTracksDialog } from "./ModifyTracksDialog";

afterEach(cleanup);

const video = (id: string, language: string, isDefault: boolean): VideoFile => ({
  id,
  name: `${id}.mkv`,
  path: `/videos/${id}.mkv`,
  size: 1,
  status: "pending",
  tracks: [
    { id: "0", type: "video", codec: "HEVC", language: "und", isDefault: true, action: "keep" },
    { id: "1", type: "audio", codec: "AAC", language, isDefault, isForced: false, action: "keep" },
  ],
});

describe("ModifyTracksDialog", () => {
  it("applies untouched rows as no change, though the videos disagree on language and Default", () => {
    const files = [video("ep1", "jpn", true), video("ep2", "und", false)];
    const onFilesChange = vi.fn();
    render(<ModifyTracksDialog open onOpenChange={vi.fn()} videoFiles={files} onFilesChange={onFilesChange} />);
    fireEvent.click(screen.getByRole("tab", { name: /Audio/ }));

    expect(screen.getByRole("button", { name: "Language of track 1" })).toHaveTextContent("Multiple");
    fireEvent.click(screen.getByRole("button", { name: "Apply" }));

    const updated = onFilesChange.mock.calls[0][0] as VideoFile[];
    updated.forEach((file, index) => {
      expect(file.tracks.map(({ name, language, isDefault, isForced }) => ({ name, language, isDefault, isForced }))).toEqual(
        files[index].tracks.map(({ name, language, isDefault, isForced }) => ({ name, language, isDefault, isForced })),
      );
    });
  });

  it("applies a changed field to every video and leaves the others", () => {
    const files = [video("ep1", "jpn", true), video("ep2", "und", false)];
    const onFilesChange = vi.fn();
    render(<ModifyTracksDialog open onOpenChange={vi.fn()} videoFiles={files} onFilesChange={onFilesChange} />);
    fireEvent.click(screen.getByRole("tab", { name: /Audio/ }));
    fireEvent.click(screen.getByRole("checkbox", { name: "Forced track 1" }));
    fireEvent.click(screen.getByRole("button", { name: "Apply" }));

    const audio = (onFilesChange.mock.calls[0][0] as VideoFile[]).map((file) => file.tracks[1]);
    expect(audio.map((track) => [track.language, track.isDefault, track.isForced])).toEqual([
      ["jpn", true, true],
      ["und", false, true],
    ]);
  });
});
