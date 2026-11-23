import { describe, expect, it, vi, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";

import { OutputBody } from "./dock";

// Every page has its own Output, and a hidden page's cannot scroll: when the
// page is shown, its Output catches up with the end of the log, unless it was
// scrolled up to read.

let resized: (() => void) | null = null;

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  resized = null;
});

function renderLog() {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      constructor(callback: () => void) {
        resized = callback;
      }
      observe() {}
      disconnect() {}
    },
  );
  render(<OutputBody lines={[{ at: "10:00", text: "Muxing 1 job" }, { at: "10:01", text: "Muxed" }]} />);
  const log = screen.getByRole("log");
  // jsdom lays nothing out: give the log the sizes a shown page would have.
  Object.defineProperty(log, "scrollTop", { value: 0, writable: true, configurable: true });
  Object.defineProperty(log, "scrollHeight", { value: 0, configurable: true });
  Object.defineProperty(log, "clientHeight", { value: 0, configurable: true });
  const show = () => {
    Object.defineProperty(log, "scrollHeight", { value: 600, configurable: true });
    Object.defineProperty(log, "clientHeight", { value: 200, configurable: true });
    resized?.();
  };
  return { log, show };
}

describe("OutputBody", () => {
  it("scrolls to the end when a hidden page's log is shown", () => {
    const { log, show } = renderLog();
    show();
    expect(log.scrollTop).toBe(600);
  });

  it("stays where it was scrolled up to", () => {
    const { log, show } = renderLog();
    show();
    log.scrollTop = 100;
    fireEvent.scroll(log);
    resized?.();
    expect(log.scrollTop).toBe(100);
  });
});
