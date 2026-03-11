import { type Command, generateId } from "../Command";
import type { MuxSettings, OutputSettings } from "@/types";

type SettingsType = "mux" | "output";

/** Command for updating MuxSettings or OutputSettings. */
export class UpdateSettingsCommand implements Command {
  readonly id = generateId();
  readonly type = "UPDATE_SETTINGS" as const;
  readonly timestamp = Date.now();
  readonly description: string;

  constructor(
    private readonly settingsType: SettingsType,
    private readonly previousSettings: MuxSettings | OutputSettings,
    private readonly nextSettings: MuxSettings | OutputSettings,
    private readonly setState: (settings: MuxSettings | OutputSettings) => void,
  ) {
    this.description = `Updated ${settingsType === "mux" ? "mux" : "output"} settings`;
  }

  execute(): void {
    this.setState(this.nextSettings);
  }

  undo(): void {
    this.setState(this.previousSettings);
  }

  redo(): void {
    this.execute();
  }

  mergeWith(other: Command): Command | null {
    if (other.type !== "UPDATE_SETTINGS") return null;
    if (other.timestamp - this.timestamp > 2000) return null;
    const otherCmd = other as UpdateSettingsCommand;
    if (otherCmd.settingsType !== this.settingsType) return null;
    // Merge: keep original previous, use the latest next
    return new UpdateSettingsCommand(
      this.settingsType,
      this.previousSettings,
      otherCmd.nextSettings,
      this.setState,
    );
  }
}
