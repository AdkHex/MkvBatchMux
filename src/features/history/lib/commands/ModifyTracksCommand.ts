import { type Command, generateId } from "../Command";
import type { VideoFile } from "@/shared/types";

export class ModifyTracksCommand implements Command {
  readonly id = generateId();
  readonly type = "MODIFY_TRACKS" as const;
  readonly timestamp = Date.now();
  readonly description: string;

  constructor(
    /** Snapshot of affected videos BEFORE the modification. */
    private readonly previousVideos: VideoFile[],
    /** Snapshot of affected videos AFTER the modification. */
    private readonly nextVideos: VideoFile[],
    private readonly getState: () => VideoFile[],
    private readonly setState: (videos: VideoFile[]) => void,
    description?: string,
  ) {
    this.description = description ?? `Modified tracks on ${nextVideos.length} video${nextVideos.length !== 1 ? "s" : ""}`;
  }

  execute(): void {
    this._applyVideos(this.nextVideos);
  }

  undo(): void {
    this._applyVideos(this.previousVideos);
  }

  redo(): void {
    this.execute();
  }

  private _applyVideos(updates: VideoFile[]): void {
    const updateMap = new Map(updates.map((v) => [v.id, v]));
    this.setState(this.getState().map((v) => updateMap.get(v.id) ?? v));
  }
}
