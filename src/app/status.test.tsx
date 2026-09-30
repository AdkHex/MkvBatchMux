import { describe, expect, it, vi, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";

import { StatusPill, lcdStatus, type StatusProps } from "@/ui/frame";
import { ShellContext, useStatus, type PageId, type Shell } from "./shell";

// The toolbar's status is small and only there when something runs or has
// news; a page with nothing of its own shows the run going elsewhere.

afterEach(cleanup);

describe("lcdStatus", () => {
  it("shows nothing for an idle page", () => {
    expect(lcdStatus({ l1: "16 videos · 64.8 GB" })).toBeNull();
    expect(lcdStatus({ icon: "idle", l1: "The queue is empty" })).toBeNull();
  });

  it("keeps a run's words, progress and time, with the longer line on hover", () => {
    expect(lcdStatus({ icon: "run", l1: "Muxing 6 of 16", l2: "Episode 06.mkv", pct: 38, time: "6 min left" })).toEqual({
      icon: "run",
      text: "Muxing 6 of 16",
      detail: "Episode 06.mkv",
      pct: 38,
      time: "6 min left",
    });
  });
});

function Probe({ page, own }: { page: PageId; own: StatusProps | null }) {
  const status = useStatus(page, own);
  return status ? <StatusPill {...status} /> : <span>idle</span>;
}

const shell = (overrides: Partial<Shell>): Shell =>
  ({
    active: "videos",
    show: vi.fn(),
    publishStatus: vi.fn(),
    runStatus: null,
    ...overrides,
  }) as unknown as Shell;

describe("useStatus", () => {
  it("shows the page's own status first", () => {
    const value = shell({ runStatus: { page: "mux", status: { icon: "run", text: "Muxing 6 of 16" } } });
    render(
      <ShellContext.Provider value={value}>
        <Probe page="videos" own={{ icon: "run", text: "Reading media info 3 of 16" }} />
      </ShellContext.Provider>,
    );
    expect(screen.getByRole("status")).toHaveTextContent("Reading media info 3 of 16");
  });

  it("otherwise shows the run going on another page, which opens that page", () => {
    const show = vi.fn();
    const value = shell({ show, runStatus: { page: "mux", status: { icon: "run", text: "Muxing 6 of 16", pct: 38 } } });
    render(
      <ShellContext.Provider value={value}>
        <Probe page="videos" own={null} />
      </ShellContext.Provider>,
    );
    fireEvent.click(screen.getByRole("status"));
    expect(show).toHaveBeenCalledWith("mux");
  });

  it("does not repeat a page's own run back to it", () => {
    const value = shell({ runStatus: { page: "mux", status: { icon: "run", text: "Muxing 6 of 16" } } });
    render(
      <ShellContext.Provider value={value}>
        <Probe page="mux" own={null} />
      </ShellContext.Provider>,
    );
    expect(screen.getByText("idle")).toBeInTheDocument();
  });

  it("publishes the page's status for the other pages", () => {
    const publishStatus = vi.fn();
    const own: StatusProps = { icon: "warn", text: "4 to check" };
    render(
      <ShellContext.Provider value={shell({ publishStatus })}>
        <Probe page="audio" own={own} />
      </ShellContext.Provider>,
    );
    expect(publishStatus).toHaveBeenCalledWith("audio", own);
  });
});
