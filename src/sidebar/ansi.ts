/**
 * Raw-ANSI text helpers for the sidebar renderer. The renderer paints pane
 * ttys directly (no blessed), so styling is plain SGR — truecolor fg/bg with
 * explicit resets, never a bare full-reset mid-line (a row-wide bg must
 * survive its inner fg changes).
 */

// Vesper palette (CLAUDE.md)
export const C = {
  fg: "#FFFFFF",
  muted: "#A0A0A0",
  dim: "#505050",
  surface: "#1C1C1C",
  // selection bg: surface (#1C1C1C) on bg (#101010) was near-invisible, and
  // #333333 still washed out on lesser displays — the selector needs to read
  // at a glance from the main pane
  sel: "#404040",
  peach: "#FFC799",
  mint: "#99FFE4",
  red: "#FF8080",
} as const;

function rgb(hex: string): [number, number, number] {
  return [
    parseInt(hex.slice(1, 3), 16),
    parseInt(hex.slice(3, 5), 16),
    parseInt(hex.slice(5, 7), 16),
  ];
}

export function fg(color: string, s: string): string {
  const [r, g, b] = rgb(color);
  return `\x1b[38;2;${r};${g};${b}m${s}\x1b[39m`;
}

export function bold(s: string): string {
  return `\x1b[1m${s}\x1b[22m`;
}

/** Row-wide background (the selector). 49 = default bg, not a full reset. */
export function bg(color: string, s: string): string {
  const [r, g, b] = rgb(color);
  return `\x1b[48;2;${r};${g};${b}m${s}\x1b[49m`;
}

const SGR = /\x1b\[[0-9;]*m/g;
const GRAPHEMES = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/** Printable terminal-cell width of a line, ignoring the SGR sequences we emit. */
export function plainLen(s: string): number {
  return Bun.stringWidth(s.replace(SGR, ""));
}

export function truncate(s: string, w: number): string {
  if (w <= 0) return "";
  if (Bun.stringWidth(s) <= w) return s;

  const ellipsis = "…";
  const contentWidth = w - Bun.stringWidth(ellipsis);
  if (contentWidth <= 0) return ellipsis;

  let out = "";
  let used = 0;
  for (const { segment } of GRAPHEMES.segment(s)) {
    const segmentWidth = Bun.stringWidth(segment);
    if (used + segmentWidth > contentWidth) break;
    out += segment;
    used += segmentWidth;
  }
  return out + ellipsis;
}

export function fmtAge(ms: number): string {
  const m = Math.floor(ms / 60_000);
  if (m < 1) return "now";
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}

// Wake display on rows: RELATIVE ("in how long"), matching the age style —
// "8-14" style dates read as noise at a glance. Exact moment lives in the
// selection detail line via fmtWakeAbs.
export function fmtWake(until: number, now: number): string {
  const m = Math.max(0, Math.ceil((until - now) / 60_000));
  if (m < 60) return `${m}m`;
  const h = Math.ceil(m / 60);
  if (h < 24) return `${h}h`;
  return `${Math.ceil(h / 24)}d`;
}

// Exact wake for the detail line: clock time within a day, else day/month plus
// clock time — day snoozes are exact relative offsets (and phone-set day wakes
// land at 8AM local), so a >24h wake has a meaningful time part.
export function fmtWakeAbs(until: number, now: number): string {
  const dt = new Date(until);
  const hm = `${dt.getHours()}:${String(dt.getMinutes()).padStart(2, "0")}`;
  if (until - now < 86_400_000) return hm;
  return `${dt.getDate()}/${dt.getMonth() + 1} ${hm}`;
}

// Branch names bury the ticket ID mid-string; the prefix before it is the
// useless half ("marcelmiro-ENG-2687-pass-…" → "ENG-2687-pass-…").
export function displayName(name: string): string {
  const m = name.match(/[A-Z][A-Z0-9]+-\d+/);
  return m && m.index! > 0 ? name.slice(m.index!) : name;
}
