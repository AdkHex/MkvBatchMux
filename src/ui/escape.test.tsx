import { describe, expect, it, vi, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";

import { Dialog } from "./frame";
import { LangCombo } from "./kit";

// Escape closes the innermost thing only: the language list before the dialog
// it sits in, a name being edited before its dialog, the top dialog before the
// one under it.

afterEach(cleanup);

describe("Escape", () => {
  it("closes the language list, wherever focus is in it, and not the dialog under it", () => {
    const onClose = vi.fn();
    render(
      <Dialog title="Edit tracks" onClose={onClose} foot={null}>
        <LangCombo value="hin" onChange={() => {}} label="Language" />
      </Dialog>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Language" }));
    expect(screen.getByRole("listbox")).toBeInTheDocument();

    const option = screen.getAllByRole("option")[0];
    option.focus();
    fireEvent.keyDown(option, { key: "Escape" });
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
    expect(onClose).not.toHaveBeenCalled();

    fireEvent.keyDown(screen.getByRole("button", { name: "Language" }), { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("leaves the dialog open when a field inside it handles Escape itself", () => {
    const onClose = vi.fn();
    render(
      <Dialog title="Edit tracks" onClose={onClose} foot={null}>
        <input aria-label="Track name" onKeyDown={(event) => event.key === "Escape" && event.stopPropagation()} />
      </Dialog>,
    );
    fireEvent.keyDown(screen.getByRole("textbox", { name: "Track name" }), { key: "Escape" });
    expect(onClose).not.toHaveBeenCalled();
  });

  it("closes only the topmost of two dialogs", () => {
    const under = vi.fn();
    const over = vi.fn();
    render(
      <>
        <Dialog title="Edit tracks" onClose={under} foot={null}>body</Dialog>
        <Dialog title="Remove track" onClose={over} foot={null}>body</Dialog>
      </>,
    );
    fireEvent.keyDown(document.body, { key: "Escape" });
    expect(over).toHaveBeenCalledTimes(1);
    expect(under).not.toHaveBeenCalled();
  });
});
