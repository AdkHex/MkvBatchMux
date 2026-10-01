/** How far a measurement run has got, from the engine's events. It measures
 *  several pairs at once, so "3 of 5" says little: the pairs in flight are
 *  tracked by name, each with its own progress. */

export interface RunProgress {
  processed: number;
  total: number;
  /** Pairs in flight: the video's file name, and how far along it is (0-100). */
  active: Record<string, number>;
}

/** A pair started or moved on. A late event for a pair already done is ignored. */
export function pairMoved<P extends RunProgress>(progress: P, file: string, percent: number, done: ReadonlySet<string>): P {
  if (done.has(file)) return progress;
  return { ...progress, active: { ...progress.active, [file]: Math.max(progress.active[file] ?? 0, Math.min(100, percent)) } };
}

/** A pair finished: it leaves the ones in flight. */
export function pairDone<P extends RunProgress>(progress: P, file: string | null, processed: number, total: number): P {
  const active = { ...progress.active };
  if (file) delete active[file];
  return { ...progress, processed, total, active };
}

/** The share of the run done, 0-1, counting the pairs in flight by how far
 *  along they are -- so the bar moves while the slow ones run, instead of
 *  standing still between results. */
export function runFraction(progress: RunProgress): number {
  if (progress.total <= 0) return 0;
  const inFlight = Object.values(progress.active).reduce((sum, percent) => sum + percent / 100, 0);
  return Math.min(1, (progress.processed + inFlight) / progress.total);
}
