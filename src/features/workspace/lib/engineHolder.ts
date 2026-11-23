/** Who holds the engine, said the way a refusal says it. The engine runs one
 *  command at a time (src/app/shell.tsx), so a page that cannot start names
 *  what is running instead: muxing, another page's run, or a watch folder. */

import type { EnginePage } from "@/app/shell";

export function engineHolder(page: EnginePage | null): string | null {
  switch (page) {
    case "mux":
      return "Muxing is running";
    case "watch":
      return "A watch folder is working on new episodes";
    case "audio":
      return "Audio is measuring or conforming";
    case "subtitles":
      return "Subtitles are syncing";
    default:
      return null;
  }
}
