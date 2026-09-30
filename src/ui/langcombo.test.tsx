import { describe, expect, it, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";

import { LangCombo } from "./kit";

// The search box only ever held one letter: the list opened with focus still
// on the button, so each key typed replaced the search with that key.

afterEach(cleanup);

describe("LangCombo search", () => {
  it("moves focus into the search box when the list opens", () => {
    render(<LangCombo value="hin" onChange={() => {}} label="Language" />);
    fireEvent.click(screen.getByRole("button", { name: "Language" }));
    expect(document.activeElement).toBe(screen.getByRole("textbox", { name: "Search languages" }));
  });

  it("keeps what was typed when a key reaches the button of an open list", () => {
    render(<LangCombo value="hin" onChange={() => {}} label="Language" />);
    const button = screen.getByRole("button", { name: "Language" });
    fireEvent.keyDown(button, { key: "g" });
    const search = screen.getByRole("textbox", { name: "Search languages" });
    expect(search).toHaveValue("g");
    fireEvent.change(search, { target: { value: "ge" } });
    fireEvent.keyDown(button, { key: "r" });
    expect(search).toHaveValue("ge");
  });
});
