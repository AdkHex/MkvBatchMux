/** File › Apply recipe: pick a recipe, see every change it would make to the
 *  workspace (tracks, slots, options, output names), then apply them all at
 *  once, or not at all. */

import { useMemo, useState } from "react";

import type { RecipePlan } from "@/features/workspace/lib/recipeApply";
import type { Recipe } from "@/shared/types/recipes";
import { Dialog } from "@/ui/frame";
import { Btn, Combo, InfoBar } from "@/ui/kit";

export function ApplyRecipeDialog({
  recipes,
  initialId,
  plan,
  onApply,
  onManage,
  onClose,
}: {
  recipes: Recipe[];
  initialId?: string | null;
  /** What applying a recipe would change. */
  plan: (recipe: Recipe) => RecipePlan;
  onApply: (plan: RecipePlan) => void;
  /** Open the Recipes dialog. */
  onManage: () => void;
  onClose: () => void;
}) {
  const [id, setId] = useState<string | null>(initialId && recipes.some((recipe) => recipe.id === initialId) ? initialId : (recipes[0]?.id ?? null));
  const recipe = recipes.find((item) => item.id === id) ?? null;
  const result = useMemo(() => (recipe ? plan(recipe) : null), [recipe, plan]);

  return (
    <Dialog
      size="mid"
      title="Apply a recipe"
      sub="Every change it makes to what is loaded, before anything changes."
      onClose={onClose}
      left={<Btn onClick={onManage}>Recipes…</Btn>}
      foot={
        <>
          <Btn onClick={onClose}>Cancel</Btn>
          <Btn accent disabled={!result || result.empty} onClick={() => result && onApply(result)}>Apply</Btn>
        </>
      }
    >
      {recipes.length === 0 ? (
        <InfoBar tone="info">No recipes yet. Make one in Recipes…, from the workspace once a show is set up the way you like.</InfoBar>
      ) : (
        <>
          <Combo label="Recipe" value={id} w="100%" options={recipes.map((item) => ({ value: item.id, label: item.name }))} onChange={(value) => setId(String(value))} />
          {result?.empty && <InfoBar tone="ok">The workspace already matches {result.recipe.name}: nothing to change.</InfoBar>}
          {result && result.collisions.length > 0 && (
            <InfoBar tone="warn">
              {result.collisions.length} output name{result.collisions.length === 1 ? " is" : "s are"} shared, for example by {result.collisions[0].join(" and ")}. Muxing won't start until the names differ.
            </InfoBar>
          )}
          {result?.sections.map((section) => (
            <div key={section.title}>
              <div className="group-h" style={{ marginTop: 8 }}>{section.title}</div>
              <ul className="sm" style={{ margin: 0, paddingLeft: 18, display: "flex", flexDirection: "column", gap: 2 }}>
                {section.lines.map((line, index) => (
                  <li key={index} className="t2" style={{ overflowWrap: "anywhere" }}>{line}</li>
                ))}
              </ul>
            </div>
          ))}
        </>
      )}
    </Dialog>
  );
}
