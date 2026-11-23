import "@testing-library/jest-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { VideoFile } from "@/shared/types";

import { MediaInfoDialog } from "./MediaInfoDialog";

afterEach(cleanup);

const video = (name: string): VideoFile => ({ id: name, name, path: `/videos/${name}`, size: 1, status: "pending", tracks: [] });

describe("MediaInfoDialog", () => {
  it("stays on the chosen video when the page re-renders with a new array of the same videos", () => {
    const files = [video("one.mkv"), video("two.mkv")];
    const view = render(<MediaInfoDialog open onOpenChange={vi.fn()} files={files} />);
    fireEvent.click(screen.getByRole("tab", { name: /two/ }));
    expect(screen.getByRole("tab", { name: /two/ })).toHaveAttribute("aria-selected", "true");

    // The Videos page passes `selected.slice(...)`: a fresh array every render.
    view.rerender(<MediaInfoDialog open onOpenChange={vi.fn()} files={[...files]} />);

    expect(screen.getByRole("tab", { name: /two/ })).toHaveAttribute("aria-selected", "true");
  });
});
