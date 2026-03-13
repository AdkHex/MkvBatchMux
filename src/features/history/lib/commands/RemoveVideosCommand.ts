import { type Command, generateId } from "../Command";
import type { VideoFile } from "@/shared/types";

export class RemoveVideosCommand implements Command {
  readonly id = generateId();
  readonly type = "REMOVE_VIDEOS" as const;
  readonly timestamp = Date.now();
  readonly description: string;

  constructor(
    private readonly removedVideos: VideoFile[],
    private readonly getState: () => VideoFile[],
    private readonly setState: (videos: VideoFile[]) => void,
  ) {
    this.description = `Removed ${removedVideos.length} video${removedVideos.length !== 1 ? "s" : ""}`;
  }

  execute(): void {
    const toRemove = new Set(this.removedVideos.map((v) => v.id));
    this.setState(this.getState().filter((v) => !toRemove.has(v.id)));
  }

  undo(): void {
    // Re-insert the removed videos. We need to restore them to their original positions.
    // Simplest approach: append them back in original order
    const current = this.getState();
    const currentIds = new Set(current.map((v) => v.id));
    const toRestore = this.removedVideos.filter((v) => !currentIds.has(v.id));
    this.setState([...current, ...toRestore]);
  }

  redo(): void {
    this.execute();
  }
}
