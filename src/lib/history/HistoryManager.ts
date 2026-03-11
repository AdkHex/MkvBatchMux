import type { Command } from "./Command";

const MAX_SIZE = 50;

export class HistoryManager {
  private commands: Command[] = [];
  private currentIndex: number = -1;

  canUndo(): boolean {
    return this.currentIndex >= 0;
  }

  canRedo(): boolean {
    return this.currentIndex < this.commands.length - 1;
  }

  getUndoDescription(): string | null {
    if (!this.canUndo()) return null;
    return this.commands[this.currentIndex].description;
  }

  getRedoDescription(): string | null {
    if (!this.canRedo()) return null;
    return this.commands[this.currentIndex + 1].description;
  }

  /** Returns the most recent N commands (newest last). */
  getHistory(count = 10): Command[] {
    const start = Math.max(0, this.currentIndex + 1 - count);
    return this.commands.slice(start, this.currentIndex + 1);
  }

  push(command: Command): void {
    // Discard any redo history when branching
    if (this.currentIndex < this.commands.length - 1) {
      this.commands = this.commands.slice(0, this.currentIndex + 1);
    }

    // Attempt to merge with previous command
    const last = this.commands[this.commands.length - 1];
    if (last?.mergeWith) {
      const merged = last.mergeWith(command);
      if (merged) {
        this.commands[this.commands.length - 1] = merged;
        // currentIndex stays the same — we replaced the last entry
        return;
      }
    }

    this.commands.push(command);
    this.currentIndex++;

    // Enforce max size
    if (this.commands.length > MAX_SIZE) {
      this.commands.shift();
      this.currentIndex--;
    }
  }

  undo(): void {
    if (this.canUndo()) {
      this.commands[this.currentIndex].undo();
      this.currentIndex--;
    }
  }

  redo(): void {
    if (this.canRedo()) {
      this.currentIndex++;
      this.commands[this.currentIndex].redo();
    }
  }

  clear(): void {
    this.commands = [];
    this.currentIndex = -1;
  }
}
