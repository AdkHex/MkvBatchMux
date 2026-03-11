import { useCallback } from "react";
import { useHistoryStore } from "@/stores/useHistoryStore";
import type { Command } from "@/lib/history/Command";

/**
 * Hook that exposes a `dispatch` function to execute commands through the history store.
 * Also re-exports undo/redo for convenience.
 */
export function useCommand() {
  const push = useHistoryStore((s) => s.push);
  const undo = useHistoryStore((s) => s.undo);
  const redo = useHistoryStore((s) => s.redo);
  const canUndo = useHistoryStore((s) => s.canUndo);
  const canRedo = useHistoryStore((s) => s.canRedo);

  const dispatch = useCallback(
    (command: Command) => {
      push(command);
    },
    [push],
  );

  return { dispatch, undo, redo, canUndo, canRedo };
}
