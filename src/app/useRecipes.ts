/** The saved recipes (`recipes.json` in the app data folder): read once at
 *  launch, written whole on every change. */

import { useCallback, useEffect, useRef, useState } from "react";

import { parseRecipesFile, RECIPES_VERSION } from "@/features/workspace/lib/recipes";
import { readRecipesRaw, writeRecipes } from "@/shared/lib/workspaceStore";
import type { Recipe } from "@/shared/types/recipes";

/** A failed call's message; null when it worked. (`strict` is off here, so `ok` alone doesn't narrow.) */
const failure = (result: { ok: boolean }): string | null => ("error" in result ? String((result as { error: unknown }).error) : null);

export interface RecipesState {
  recipes: Recipe[];
  /** False until the file has been read. */
  loaded: boolean;
  /** Why the file couldn't be read, or the last save failed. */
  error: string | null;
  /** Add or replace (by id); resolves with the save's error, if any. */
  save: (recipe: Recipe) => Promise<string | null>;
  remove: (id: string) => Promise<string | null>;
}

export function useRecipes(enabled = true): RecipesState {
  const [recipes, setRecipes] = useState<Recipe[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const current = useRef<Recipe[]>([]);

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    void readRecipesRaw().then((result) => {
      if (cancelled) return;
      if (!result.ok) {
        setError(failure(result));
      } else {
        const parsed = parseRecipesFile(result.value);
        current.current = parsed.recipes;
        setRecipes(parsed.recipes);
        setError(parsed.error ?? (parsed.skipped ? `${parsed.skipped} saved recipe${parsed.skipped === 1 ? " was" : "s were"} damaged and left out.` : null));
      }
      setLoaded(true);
    });
    return () => {
      cancelled = true;
    };
  }, [enabled]);

  const write = useCallback(async (next: Recipe[]) => {
    const previous = current.current;
    current.current = next;
    setRecipes(next);
    const result = await writeRecipes(next, RECIPES_VERSION);
    if (result.ok) {
      setError(null);
      return null;
    }
    // The list on screen goes back to what is on disk.
    current.current = previous;
    setRecipes(previous);
    setError(failure(result));
    return failure(result);
  }, []);

  const save = useCallback(
    (recipe: Recipe) => {
      const list = current.current;
      const stamped = { ...recipe, updatedAt: new Date().toISOString() };
      const next = list.some((item) => item.id === recipe.id) ? list.map((item) => (item.id === recipe.id ? stamped : item)) : [...list, stamped];
      return write(next);
    },
    [write],
  );

  const remove = useCallback((id: string) => write(current.current.filter((item) => item.id !== id)), [write]);

  return { recipes, loaded, error, save, remove };
}
