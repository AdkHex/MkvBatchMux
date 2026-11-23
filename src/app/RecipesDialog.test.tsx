import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/ui/toast", () => ({ toast: vi.fn() }));
vi.mock("@/shared/lib/backend", () => ({ pickDirectory: vi.fn() }));

import { DEFAULT_SLOT } from "@/features/workspace/lib/recipes";
import type { MuxSettings } from "@/shared/types";
import type { Recipe } from "@/shared/types/recipes";
import { RecipesDialog, recipeFromWorkspace, type RecipeSource } from "./RecipesDialog";
import type { RecipesState } from "./useRecipes";

const source: RecipeSource = {
  videoFiles: [{ id: "v1", name: "Goblin.S01E01.mkv", path: "D:\\Shows\\Goblin (2016)\\Season 1\\Goblin.S01E01.mkv", size: 1, status: "pending", tracks: [] }],
  audioTracks: ["1"],
  audioTrackConfigs: { "1": { ...DEFAULT_SLOT, sourceFolder: "D:\\Dubs", language: "hin", isDefault: true } },
  subtitleTracks: ["1"],
  subtitleTrackConfigs: { "1": { ...DEFAULT_SLOT } },
  muxSettings: { destinationDir: "x", outputNamingPattern: "y", overwriteSource: true, removeGlobalTags: true, verifyOutput: true } as MuxSettings,
  outputSettings: { directory: "D:\\Out", namingPattern: "{show} - {episode}", overwriteExisting: false },
};

function state(recipes: Recipe[] = []): RecipesState {
  return { recipes, loaded: true, error: null, save: vi.fn(async () => null), remove: vi.fn(async () => null) };
}

describe("recipes", () => {
  it("are made from the workspace as it is", () => {
    const recipe = recipeFromWorkspace("Goblin", source);
    expect(recipe).toMatchObject({ name: "Goblin", show: "Goblin", namingPattern: "{show} - {episode}", destination: "D:\\Out", overwriteExisting: false, subtitleSlots: [] });
    expect(recipe.audioSlots).toEqual([{ ...DEFAULT_SLOT, sourceFolder: "D:\\Dubs", language: "hin", isDefault: true }]);
    // Where to mux and how to name are the recipe's own fields, not mux options.
    expect(recipe.muxOptions).toEqual({ removeGlobalTags: true, verifyOutput: true });
  });

  it("are saved from the dialog only once they are valid", async () => {
    const recipes = state();
    render(<RecipesDialog recipes={recipes} source={source} onApply={vi.fn()} onClose={vi.fn()} />);
    const dialog = screen.getByRole("dialog", { name: "Recipes" });
    fireEvent.click(within(dialog).getByRole("button", { name: "From the workspace" }));
    const name = within(dialog).getByRole("textbox", { name: "Recipe name" });
    expect(name).toHaveValue("Goblin");
    expect(within(dialog).getByText("Goblin - S01E01.mkv")).toBeInTheDocument();

    fireEvent.change(name, { target: { value: " " } });
    expect(within(dialog).getByText("Give the recipe a name.")).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "Save" })).toBeDisabled();

    fireEvent.change(name, { target: { value: "Goblin — Hindi" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Add rule" }));
    fireEvent.change(within(dialog).getByRole("textbox", { name: "Name pattern" }), { target: { value: "commentary" } });
    expect(within(dialog).getByText(/choose what the rule does/)).toBeInTheDocument();
    fireEvent.change(within(dialog).getByRole("combobox", { name: "Keep or remove" }), { target: { value: "remove" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(recipes.save).toHaveBeenCalled());
    const saved = vi.mocked(recipes.save).mock.calls[0][0];
    expect(saved).toMatchObject({ name: "Goblin — Hindi", trackRules: [{ match: { nameRegex: "commentary" }, action: { keep: false } }] });
  });

  it("asks before closing over unsaved changes", () => {
    const onClose = vi.fn();
    render(<RecipesDialog recipes={state()} source={source} onApply={vi.fn()} onClose={onClose} />);
    const dialog = screen.getByRole("dialog", { name: "Recipes" });
    fireEvent.click(within(dialog).getByRole("button", { name: "New" }));
    const close = () => within(dialog).getAllByRole("button", { name: /^Close/ }).at(-1)!;
    fireEvent.click(close());
    expect(onClose).not.toHaveBeenCalled();
    expect(within(dialog).getByText("Unsaved changes are lost.")).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole("button", { name: "Close anyway" }));
    expect(onClose).toHaveBeenCalled();
  });
});
