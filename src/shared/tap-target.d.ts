/** Types for `tap-target.js` — plain ESM so the browser can load it unbuilt. */
export declare function tapTarget(
  pushed: Record<string, number>,
  shownTags: Iterable<string>,
  now: number,
  ttlMs?: number,
): string | null;

