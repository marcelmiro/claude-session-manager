/**
 * Unified-patch → display lines, shared by the mobile bridge UI (served to the browser as
 * `/diff-lines.js`) and the tests. Plain ESM + a sibling `.d.ts` so the browser loads it
 * unbuilt, matching `time-ago.js`.
 *
 * The parse is HUNK-AWARE, and that is the whole point. Matching git's file-header patterns
 * against every line — the obvious implementation — silently eats real content: a deleted
 * `-- foo` line arrives as `--- foo` once the `-` marker is prepended, so it matches the
 * `--- ` file header and vanishes from the diff while the header still reports it as a
 * deletion. Same for an added `++ bar` (`+++ bar`), and for SQL/Lua/Haskell `--` comments
 * and markdown `---` rules generally. Header patterns therefore only apply BEFORE the first
 * `@@`; inside a hunk, the leading marker decides and nothing is dropped for looking like
 * metadata.
 */

/**
 * Inside a hunk every line carries a marker: ' ' context, '+' add, '-' del, '\' the
 * "\ No newline at end of file" note. A line with no marker means the hunk ended and the
 * next file's header block has begun (a *content* line reading "diff --git …" would still
 * be prefixed, so this can't misfire on real code).
 */
const MARKERS = new Set([" ", "+", "-", "\\"]);

/**
 * Parse a raw unified patch into `{t, s}` display lines, where `t` is
 * `"hunk" | "add" | "del" | "ctx"` and `s` is the content with any marker stripped so
 * gutters align. Git's file/hunk metadata (diff/index/---/+++, mode, rename, copy, binary
 * markers) is dropped. A trailing empty context line — the artifact of the patch's final
 * newline — is dropped too.
 *
 * A patch with no `@@` at all (a pure rename or a mode change) yields zero lines, which the
 * caller renders as a "metadata-only change" notice rather than a blank body.
 *
 * @param {string} patch raw `git diff` output for a single file
 * @returns {{t: "hunk"|"add"|"del"|"ctx", s: string}[]}
 */
export function parseDiffLines(patch) {
  const out = [];
  let inHunk = false;
  for (const raw of String(patch ?? "").split("\n")) {
    if (raw.startsWith("@@")) {
      inHunk = true;
      out.push({ t: "hunk", s: raw });
      continue;
    }
    if (inHunk) {
      const marker = raw[0];
      if (raw === "") {
        // A blank line inside a hunk: either a context line whose single space was stripped
        // by some tool, or the artifact of the patch's trailing newline (popped below).
        out.push({ t: "ctx", s: "" });
        continue;
      }
      if (MARKERS.has(marker)) {
        if (marker === "\\") continue; // "\ No newline at end of file"
        if (marker === "+") out.push({ t: "add", s: raw.slice(1) });
        else if (marker === "-") out.push({ t: "del", s: raw.slice(1) });
        else out.push({ t: "ctx", s: raw.slice(1) });
        continue;
      }
      inHunk = false; // unmarked line → this file's hunks are done; fall through as header
    }
    // Header region: everything up to the first `@@` of a file block is git metadata. A
    // multi-block patch (a rename diffed at both endpoints) re-enters here between blocks.
  }
  const last = out[out.length - 1];
  if (last && last.t === "ctx" && last.s === "") out.pop();
  return out;
}

/**
 * Infer the file's own indent step from the diff, in spaces. Tabs report 0 — they're one level
 * each regardless of width. Uses the most common positive *step* between consecutive lines'
 * indents rather than a GCD: a 4-space file with continuation lines at 6 has a GCD of 2 and
 * would be read as a 2-space file, whereas its dominant step is still 4.
 *
 * @param {{t: string, s: string}[]} lines
 * @returns {{unit: number, tabs: boolean}}
 */
export function indentUnit(lines) {
  const steps = new Map();
  let tabs = false;
  let prev = null;
  for (const l of lines) {
    if (l.t === "hunk") {
      prev = null; // hunks aren't contiguous, so no step across the boundary
      continue;
    }
    if (l.s.trim() === "") continue; // a blank line carries no indent information
    const ws = /^[\t ]*/.exec(l.s)[0];
    if (ws.includes("\t")) {
      tabs = true;
      prev = null;
      continue;
    }
    if (prev !== null && ws.length > prev) steps.set(ws.length - prev, (steps.get(ws.length - prev) || 0) + 1);
    prev = ws.length;
  }
  let unit = 0;
  let best = 0;
  for (const [step, n] of steps) if (n > best || (n === best && step < unit)) (unit = step), (best = n);
  return { unit, tabs };
}

/**
 * Rewrite each line's LEADING whitespace to `width` spaces per indent level, so deeply nested
 * code still fits a phone screen: a 4-space file at depth 5 spends 20 columns of a ~45-column
 * viewport before the first character.
 *
 * Leading whitespace only — interior spacing is never touched, so aligned trailing comments,
 * ASCII tables and continuation alignment survive. Levels are preserved exactly, so
 * indentation-significant languages still read correctly. This is a DISPLAY transform: the
 * patch is unchanged and the file on disk is unchanged.
 *
 * A no-op when there's nothing to gain (already at or below `width`, or no indentation found).
 *
 * @param {{t: string, s: string}[]} lines
 * @param {number} width spaces per level
 * @returns {{t: string, s: string}[]}
 */
export function narrowIndent(lines, width = 2) {
  const { unit, tabs } = indentUnit(lines);
  if (!tabs && (unit === 0 || unit <= width)) return lines;
  return lines.map((l) => {
    if (l.t === "hunk") return l;
    const ws = /^[\t ]*/.exec(l.s)[0];
    if (!ws) return l;
    const tabCount = (ws.match(/\t/g) || []).length;
    const spaces = ws.length - tabCount;
    // Tabs are one level each; spaces divide by the inferred unit, and any remainder is
    // alignment padding rather than a level, so it's carried through untouched.
    const levels = tabCount + (unit ? Math.floor(spaces / unit) : 0);
    const rem = unit ? spaces % unit : spaces;
    return { t: l.t, s: " ".repeat(levels * width + rem) + l.s.slice(ws.length) };
  });
}
