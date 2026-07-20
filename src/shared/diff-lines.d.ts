/** Types for `diff-lines.js` — the parser is plain ESM so the browser can load it unbuilt. */
export declare function parseDiffLines(
  patch: string | null | undefined,
): { t: "hunk" | "add" | "del" | "ctx"; s: string }[];
