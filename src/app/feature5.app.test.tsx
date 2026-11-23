import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

// The whole app in jsdom, its desktop half played by the browser demo's
// mocks (src/dev/demo.ts): recipes, sessions and a watch folder end to end,
// through the real Index wiring, with the demo's commands sped up.
vi.hoisted(() => {
  (globalThis as Record<string, unknown>).__APP_VERSION__ = "0.0.0-test";
  window.history.replaceState(null, "", "/?demo=empty&recipes=1&watch=1&speed=0.01&os=windows");
});

import { installDemo } from "@/dev/demo";
import Index from "./Index";

type Demo = { watch: (paths?: string[]) => void };
const demo = () => (window as unknown as { __demo: Demo }).__demo;

beforeAll(() => {
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  vi.stubGlobal("matchMedia", () => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} }));
  Element.prototype.scrollIntoView = () => {};
  installDemo("empty");
});
afterAll(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const openFileMenu = async (item: string) => {
  fireEvent.click(screen.getByRole("menuitem", { name: "File" }));
  fireEvent.click(await screen.findByRole("menuitem", { name: new RegExp(`^${item}`) }));
};

describe("recipes, sessions and watch folders in the app", () => {
  it("muxes a new episode from a watch folder left on, records it, and applies and shows recipes", async () => {
    render(<Index />);
    // The watch folder was left on: it is watching again at launch.
    await screen.findByRole("button", { name: "Watching 1 folder" }, { timeout: 4000 });

    await act(async () => demo().watch());
    const history = await waitFor(
      () => {
        const raw = localStorage.getItem("mkvbatchmux.history");
        const entries = raw ? (JSON.parse(raw) as { name: string; outcome: { text: string }; files: { name: string; text: string }[] }[]) : [];
        const entry = entries.find((item) => item.name.startsWith("Watch"));
        if (!entry) throw new Error("no watch run in History yet");
        return entry;
      },
      { timeout: 15000, interval: 100 },
    );
    expect(history.name).toBe("Watch Season 1: Goblin.S01E17.1080p.WEB-DL.x264-HDEX");
    expect(history.files).toEqual([{ name: "Goblin.S01E17.1080p.WEB-DL.x264-HDEX.mkv", tone: "ok", text: "Muxed and verified" }]);
    expect(history.outcome.text).toMatch(/1 muxed/);

    // Apply recipe lists its changes first.
    await openFileMenu("Apply recipe");
    const dialog = await screen.findByRole("dialog", { name: "Apply a recipe" });
    // The watch folder ran the recipe's track rules on the video it added: no track change is left.
    expect(within(dialog).queryByText(/: removed$/)).not.toBeInTheDocument();
    expect(within(dialog).getByText("Output name: {original_filename} → {show} - {episode}")).toBeInTheDocument();
    expect(within(dialog).getByText("Goblin.S01E17.1080p.WEB-DL.x264-HDEX.mkv → Goblin - S01E17.mkv")).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole("button", { name: "Apply" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Apply a recipe" })).not.toBeInTheDocument());

    // The watch folder and recipe dialogs show what is stored.
    await openFileMenu("Watch folders");
    const watch = await screen.findByRole("dialog", { name: "Watch folders" });
    expect(within(watch).getByRole("option", { name: /Season 1\s*Watching/ })).toBeInTheDocument();
    fireEvent.click(within(watch).getByRole("button", { name: "Pause" }));
    await within(watch).findByRole("button", { name: "Resume" });
    fireEvent.click(within(watch).getAllByRole("button", { name: "Close" }).at(-1)!);

    await openFileMenu("Recipes");
    const recipes = await screen.findByRole("dialog", { name: "Recipes" });
    expect(within(recipes).getByRole("option", { name: "Goblin — Hindi" })).toBeInTheDocument();
    expect(within(recipes).getByRole("textbox", { name: "Output name pattern" })).toHaveValue("{show} - {episode}");
    fireEvent.click(within(recipes).getAllByRole("button", { name: "Close" }).at(-1)!);
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Recipes" })).not.toBeInTheDocument());

    // A session saved and opened again: it would replace what is loaded, so it asks first.
    await openFileMenu("Save session");
    await openFileMenu("Open session");
    const open = await screen.findByRole("dialog", { name: "Open Goblin S01.mbmux?" });
    expect(within(open).getByText(/replaces the files loaded now/)).toBeInTheDocument();
    fireEvent.click(within(open).getByRole("button", { name: "Open" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: /Open Goblin/ })).not.toBeInTheDocument());
  }, 30000);
});
