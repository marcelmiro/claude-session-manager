/** Types for `time-ago.js` — the formatter is plain ESM so the browser can load it unbuilt. */
export declare function formatTimeAgo(
  when: Date | string | number | null | undefined,
  opts?: { now?: number; verbose?: boolean },
): string;
