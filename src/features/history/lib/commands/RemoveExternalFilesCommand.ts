import { type Command, generateId } from "../Command";
import type { ExternalFile } from "@/shared/types";

type ExternalType = "audio" | "subtitle" | "chapter" | "attachment";

/** Generic command for removing external files (audio, subtitle, chapter, attachment). */
export class RemoveExternalFilesCommand implements Command {
  readonly id = generateId();
  readonly type = "REMOVE_EXTERNAL_FILES" as const;
  readonly timestamp = Date.now();
  readonly description: string;

  constructor(
    private readonly removedFiles: ExternalFile[],
    private readonly fileType: ExternalType,
    private readonly getState: () => ExternalFile[],
    private readonly setState: (files: ExternalFile[]) => void,
  ) {
    const typeLabel = fileType === "audio" ? "audio" : fileType === "subtitle" ? "subtitle" : fileType;
    this.description = `Removed ${removedFiles.length} ${typeLabel} file${removedFiles.length !== 1 ? "s" : ""}`;
  }

  execute(): void {
    const toRemove = new Set(this.removedFiles.map((f) => f.id));
    this.setState(this.getState().filter((f) => !toRemove.has(f.id)));
  }

  undo(): void {
    const current = this.getState();
    const currentIds = new Set(current.map((f) => f.id));
    const toRestore = this.removedFiles.filter((f) => !currentIds.has(f.id));
    this.setState([...current, ...toRestore]);
  }

  redo(): void {
    this.execute();
  }
}
