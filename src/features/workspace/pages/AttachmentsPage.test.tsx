import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, cleanup, fireEvent, act } from "@testing-library/react";
import type { ExternalFile, MuxSettings } from "@/shared/types";
import { ShellContext, type PageCommands, type Shell } from "@/app/shell";
import { useTabState } from "@/features/workspace/store/useTabState";

vi.mock("@/shared/lib/backend", () => ({ pickDirectory: vi.fn(), pickFiles: vi.fn(), scanMedia: vi.fn() }));

import { AttachmentsPage } from "./AttachmentsPage";

let commands: PageCommands | null = null;

const shell: Shell = {
  active: "attachments",
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
};

const font = (name: string): ExternalFile => ({ id: name, name, path: `/fonts/${name}`, type: "attachment" });

beforeEach(() => {
  cleanup();
  commands = null;
  useTabState.setState((state) => ({ attachmentTabState: { ...state.attachmentTabState, attachmentsEnabled: true } }));
});

describe("AttachmentsPage selection", () => {
  it("drops the selection when the search hides it, so Del cannot remove an unseen file", () => {
    render(
      <ShellContext.Provider value={shell}>
        <AttachmentsPage hidden={false} attachmentFiles={[font("alpha.ttf"), font("beta.otf")]} onAttachmentFilesChange={vi.fn()} muxSettings={{ discardOldAttachments: true } as MuxSettings} onMuxSettingsChange={vi.fn()} />
      </ShellContext.Provider>,
    );
    fireEvent.click(screen.getByRole("row", { name: "alpha.ttf" }));
    expect(commands?.removeSelected).toBeDefined();
    act(() => {
      fireEvent.change(screen.getByRole("textbox", { name: "Search attachments" }), { target: { value: "beta" } });
    });
    expect(commands?.removeSelected).toBeUndefined();
    expect(screen.getByRole("button", { name: "Remove (Del)" })).toBeDisabled();
  });
});
