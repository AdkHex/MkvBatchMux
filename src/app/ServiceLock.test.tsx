import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

import type { ServiceLock } from "@/shared/lib/backend";

// The lock screen only shows what the Rust core decided; these check that each
// reason gets its screen, that the password goes to the core and its refusal
// shows, and that the window underneath is out of reach while it is up.

const backend = vi.hoisted(() => ({
  serviceLock: vi.fn(),
  checkServiceStatus: vi.fn(),
  unlockAccess: vi.fn(),
  listenServiceLock: vi.fn(),
}));
vi.mock("@/shared/lib/backend", () => backend);

import { ServiceLockScreen, isServiceLocked } from "./ServiceLock";

const lock = (overrides: Partial<ServiceLock>): ServiceLock => ({
  locked: true,
  reason: "maintenance",
  title: null,
  message: null,
  updateUrl: null,
  minVersion: null,
  appVersion: "1.70.0",
  enabled: true,
  checkedAt: null,
  lastError: null,
  ...overrides,
});

let pushLock: (value: ServiceLock) => void = () => undefined;

beforeEach(() => {
  backend.listenServiceLock.mockImplementation((handler: (value: ServiceLock) => void) => {
    pushLock = handler;
    return Promise.resolve(() => undefined);
  });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

function renderWith(initial: ServiceLock) {
  backend.serviceLock.mockResolvedValue(initial);
  return render(
    <>
      <div className="win">
        <button>Start muxing</button>
      </div>
      <ServiceLockScreen />
    </>,
  );
}

describe("ServiceLockScreen", () => {
  it("shows nothing while unlocked", async () => {
    renderWith(lock({ locked: false, reason: null }));
    await waitFor(() => expect(backend.serviceLock).toHaveBeenCalled());
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(isServiceLocked()).toBe(false);
  });

  it("shows the maintenance title and message, and makes the window inert", async () => {
    renderWith(lock({ message: "Back in ten minutes." }));
    expect(await screen.findByRole("heading", { name: "Work is in progress" })).toBeInTheDocument();
    expect(screen.getByText("Back in ten minutes.")).toBeInTheDocument();
    expect(screen.getByText("Your work is paused and will continue when MKVBatchMux is back.")).toBeInTheDocument();
    expect((document.querySelector(".win") as HTMLElement).inert).toBe(true);
    expect(isServiceLocked()).toBe(true);
  });

  it("asks for the password with the owner's warning, and shows a refusal", async () => {
    renderWith(lock({ reason: "access" }));
    expect(await screen.findByRole("heading", { name: "Enter the access password" })).toBeInTheDocument();
    expect(screen.getByText("This app is strictly Prohibited to be used by others, if you are the trusted one enter the password")).toBeInTheDocument();

    backend.unlockAccess.mockRejectedValueOnce("Wrong password");
    fireEvent.change(screen.getByLabelText("Access password"), { target: { value: "guess" } });
    fireEvent.click(screen.getByRole("button", { name: "Unlock" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Wrong password");
    expect(backend.unlockAccess).toHaveBeenCalledWith("guess");
    expect(screen.getByLabelText("Access password")).toHaveValue("");

    backend.unlockAccess.mockResolvedValueOnce(lock({ locked: false, reason: null }));
    fireEvent.change(screen.getByLabelText("Access password"), { target: { value: "right one" } });
    fireEvent.click(screen.getByRole("button", { name: "Unlock" }));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    expect((document.querySelector(".win") as HTMLElement).inert).toBe(false);
  });

  it("offers the download for an update that is required", async () => {
    renderWith(lock({ reason: "update", minVersion: "1.80.0", updateUrl: "https://example.com/new" }));
    expect(await screen.findByRole("heading", { name: "Update required" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Download the new version" })).toBeInTheDocument();
    expect(screen.getByText("Version 1.70.0 · required 1.80.0")).toBeInTheDocument();
  });

  it("asks a first run to connect once, and checks again on request", async () => {
    renderWith(lock({ reason: "connect", lastError: "cannot reach the status server" }));
    expect(await screen.findByRole("heading", { name: "Connect to the internet once" })).toBeInTheDocument();
    backend.checkServiceStatus.mockResolvedValueOnce(lock({ locked: false, reason: null }));
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull(), { timeout: 2000 });
  });

  it("keeps the focus in the password field when the screen appears", async () => {
    renderWith(lock({ reason: "access" }));
    expect(await screen.findByLabelText("Access password")).toHaveFocus();
  });

  it("listens before it reads, and an earlier event wins over the read", async () => {
    let answer: (value: ServiceLock) => void = () => undefined;
    backend.serviceLock.mockReturnValue(new Promise<ServiceLock>((resolve) => (answer = resolve)));
    render(<ServiceLockScreen />);
    await waitFor(() => expect(backend.serviceLock).toHaveBeenCalled());
    expect(backend.listenServiceLock.mock.invocationCallOrder[0]).toBeLessThan(backend.serviceLock.mock.invocationCallOrder[0]);
    act(() => pushLock(lock({ title: "Locked while reading" })));
    await act(async () => answer(lock({ locked: false, reason: null })));
    expect(screen.getByRole("heading", { name: "Locked while reading" })).toBeInTheDocument();
  });

  it("follows the backend's event", async () => {
    renderWith(lock({ locked: false, reason: null }));
    await waitFor(() => expect(backend.listenServiceLock).toHaveBeenCalled());
    act(() => pushLock(lock({ title: "Scheduled maintenance" })));
    expect(await screen.findByRole("heading", { name: "Scheduled maintenance" })).toBeInTheDocument();
    act(() => pushLock(lock({ locked: false, reason: null })));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
  });
});
