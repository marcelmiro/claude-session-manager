/**
 * Relative-time formatting shared by the TUI (imported by `core/status.ts`) and the
 * mobile bridge UI (served to the browser as `/time-ago.js`). Plain ESM + a sibling
 * `.d.ts` so both runtimes consume the SAME code — the two surfaces previously had
 * separate copies that drifted (only one grew the `6d 3h` remainder branch).
 *
 * Rounding, not truncation: `Math.floor` reported `1h59m` as "1h", a 59-minute
 * under-report at the exact magnitude a user is deciding whether a session is stale.
 * Values round to the nearest displayed unit and carry into the next tier ("59.6m"
 * → "1h", not "60m").
 *
 * Compact form (default) is ≤4 chars so it fits the TUI's fixed 5-col time column.
 * `verbose: true` adds the remainder unit ("1h 59m", "6d 3h") where there's room.
 */

const MIN = 60;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const WEEK = 7 * DAY;
const MONTH = 30 * DAY;

/** Tiers for the compact form: below `limit`, render in `unit`; overflow promotes to `next`. */
const TIERS = [
  { limit: HOUR, unit: MIN, label: "m", next: "1h" },
  { limit: DAY, unit: HOUR, label: "h", next: "1d" },
  { limit: WEEK, unit: DAY, label: "d", next: "1w" },
  { limit: MONTH, unit: WEEK, label: "w", next: "1mo" },
];

/** Accept a Date, an ISO string (the bridge's wire format), or epoch ms. NaN if unparseable. */
function toMs(when) {
  if (when instanceof Date) return when.getTime();
  if (typeof when === "number") return when;
  if (typeof when === "string" && when) return new Date(when).getTime();
  return NaN;
}

/**
 * Two-unit form: floor the major unit, round the remainder into the minor one, and
 * carry when the remainder rounds up to a whole major unit (89m59s → "1h 30m", not
 * "1h 60m"). Promotes to `next` when the carry crosses the tier boundary.
 */
function pair(sec, major, minor, majorLabel, minorLabel, limit, next) {
  let big = Math.floor(sec / major);
  let small = Math.round((sec - big * major) / minor);
  if (small * minor >= major) {
    big += 1;
    small = 0;
  }
  if (big * major >= limit) return next;
  return small ? `${big}${majorLabel} ${small}${minorLabel}` : `${big}${majorLabel}`;
}

/**
 * Format a past instant as elapsed time: "now", "42m", "3h", "6d", "2w", "5mo".
 *
 * @param {Date|string|number|null|undefined} when instant to measure from
 * @param {{now?: number, verbose?: boolean}} [opts] `now` overrides the clock (tests);
 *   `verbose` adds the remainder unit at hour/day scale ("1h 59m", "6d 3h")
 * @returns {string} the label, or "" when `when` is missing/unparseable
 */
export function formatTimeAgo(when, opts = {}) {
  const now = opts.now ?? Date.now();
  const then = toMs(when);
  if (!Number.isFinite(then)) return "";
  // Clamp: a future timestamp (clock skew between phone and Mac) reads as "now",
  // never as a negative age.
  const sec = Math.max(0, (now - then) / 1000);

  if (sec < 30) return "now";
  if (opts.verbose) {
    if (sec >= HOUR && sec < DAY) return pair(sec, HOUR, MIN, "h", "m", DAY, "1d");
    if (sec >= DAY && sec < WEEK) return pair(sec, DAY, HOUR, "d", "h", WEEK, "1w");
  }
  for (const tier of TIERS) {
    if (sec >= tier.limit) continue;
    const n = Math.round(sec / tier.unit);
    return n * tier.unit >= tier.limit ? tier.next : `${n}${tier.label}`;
  }
  return `${Math.round(sec / MONTH)}mo`;
}
