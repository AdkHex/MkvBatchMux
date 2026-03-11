import { type Command, generateId } from "../Command";
import type { VideoFile } from "@/types";

export class AddVideosCommand implements Command {
  readonly id = generateId();
  readonly type = "ADD_VIDEOS" as const;
  readonly timestamp = Date.now();
  readonly description: string;

  constructor(
    private readonly videosToAdd: VideoFile[],
    private readonly getState: () => VideoFile[],
    private readonly setState: (videos: VideoFile[]) => void,
  ) {
    this.description = `Added ${videosToAdd.length} video${videosToAdd.length !== 1 ? "s" : ""}`;
  }

  execute(): void {
    this.setState([...this.getState(), ...this.videosToAdd]);
  }

  undo(): void {
    const toRemove = new Set(this.videosToAdd.map((v) => v.id));
    this.setState(this.getState().filter((v) => !toRemove.has(v.id)));
  }

  redo(): void {
    this.execute();
  }

  mergeWith(other: Command): Command | null {
    if (other.type !== "ADD_VIDEOS") return null;
    if (other.timestamp - this.timestamp > 1000) return null;
    const otherCmd = other as AddVideosCommand;
    return new AddVideosCommand(
      [...this.videosToAdd, ...otherCmd.videosToAdd],
      this.getState,
      this.setState,
    );
  }
}
