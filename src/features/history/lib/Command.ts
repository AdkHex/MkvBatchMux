export type CommandType =
  | "ADD_VIDEOS"
  | "REMOVE_VIDEOS"
  | "ADD_EXTERNAL_FILES"
  | "REMOVE_EXTERNAL_FILES"
  | "MODIFY_TRACKS"
  | "REORDER_TRACKS"
  | "UPDATE_SETTINGS";

export interface Command {
  readonly id: string;
  readonly type: CommandType;
  readonly timestamp: number;
  readonly description: string;
  execute(): void;
  undo(): void;
  redo(): void;
  /** Attempt to merge with a subsequent command. Return merged command or null. */
  mergeWith?(other: Command): Command | null;
}

export function generateId(): string {
  return typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}
