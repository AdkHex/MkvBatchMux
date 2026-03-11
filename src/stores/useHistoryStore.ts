import { create } from "zustand";
import { HistoryManager } from "@/lib/history/HistoryManager";
import type { Command } from "@/lib/history/Command";

// Single shared HistoryManager instance (outside React)
const manager = new HistoryManager();

interface HistoryStoreState {
  canUndo: boolean;
  canRedo: boolean;
  undoDescription: string | null;
  redoDescription: string | null;
  /** Snapshot of recent commands for display (newest last). */
  recentHistory: Command[];

  push: (command: Command) => void;
  undo: () => void;
  redo: () => void;
  clear: () => void;
}

function buildSnapshot() {
  return {
    canUndo: manager.canUndo(),
    canRedo: manager.canRedo(),
    undoDescription: manager.getUndoDescription(),
    redoDescription: manager.getRedoDescription(),
    recentHistory: manager.getHistory(10),
  };
}

export const useHistoryStore = create<HistoryStoreState>()((set) => ({
  canUndo: false,
  canRedo: false,
  undoDescription: null,
  redoDescription: null,
  recentHistory: [],

  push: (command) => {
    command.execute();
    manager.push(command);
    set(buildSnapshot());
  },

  undo: () => {
    manager.undo();
    set(buildSnapshot());
  },

  redo: () => {
    manager.redo();
    set(buildSnapshot());
  },

  clear: () => {
    manager.clear();
    set(buildSnapshot());
  },
}));
