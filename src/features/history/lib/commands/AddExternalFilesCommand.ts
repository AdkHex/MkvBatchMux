import { type Command, generateId } from "../Command";
import type { ExternalFile } from "@/shared/types";

type ExternalType = "audio" | "subtitle" | "chapter" | "attachment";

/** Generic command for adding external files (audio, subtitle, chapter, attachment). */
export class AddExternalFilesCommand implements Command {
  readonly id = generateId();
  readonly type = "ADD_EXTERNAL_FILES" as const;
  readonly timestamp = Date.now();
  readonly description: string;

  constructor(
    private readonly filesToAdd: ExternalFile[],
    private readonly fileType: ExternalType,
    private readonly getState: () => ExternalFile[],
    private readonly setState: (files: ExternalFile[]) => void,
  ) {
    const typeLabel = fileType === "audio" ? "audio" : fileType === "subtitle" ? "subtitle" : fileType;
    this.description = `Added ${filesToAdd.length} ${typeLabel} file${filesToAdd.length !== 1 ? "s" : ""}`;
  }

  execute(): void {
    this.setState([...this.getState(), ...this.filesToAdd]);
  }

  undo(): void {
    const toRemove = new Set(this.filesToAdd.map((f) => f.id));
    this.setState(this.getState().filter((f) => !toRemove.has(f.id)));
  }

  redo(): void {
    this.execute();
  }

  mergeWith(other: Command): Command | null {
    if (other.type !== "ADD_EXTERNAL_FILES") return null;
    if (other.timestamp - this.timestamp > 1000) return null;
    const otherCmd = other as AddExternalFilesCommand;
    if (otherCmd.fileType !== this.fileType) return null;
    return new AddExternalFilesCommand(
      [...this.filesToAdd, ...otherCmd.filesToAdd],
      this.fileType,
      this.getState,
      this.setState,
    );
  }
}
