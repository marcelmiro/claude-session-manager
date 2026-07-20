/** Types for `diff-lines.js` — the parser is plain ESM so the browser can load it unbuilt. */
type DiffLine = { t: "hunk" | "add" | "del" | "ctx"; s: string };

export declare function parseDiffLines(patch: string | null | undefined): DiffLine[];
export declare function indentUnit(lines: DiffLine[]): { unit: number; tabs: boolean };
export declare function narrowIndent(lines: DiffLine[], width?: number): DiffLine[];
