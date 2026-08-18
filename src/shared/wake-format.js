/**
 * Relative time UNTIL a wake — "45m" / "3h" / "2d" — shared by the Mac sidebar
 * (imported by `sidebar/ansi.ts`) and the mobile bridge UI (served to the
 * browser as `/wake-format.js`), so a snoozed row's countdown is the same
 * number on both surfaces. Ceil throughout: a wake never reads as closer than
 * it is, and "0m" appears only once the wake is actually due.
 */
export function formatWakeIn(until, now) {
  const m = Math.max(0, Math.ceil((until - now) / 60_000));
  if (m < 60) return `${m}m`;
  const h = Math.ceil(m / 60);
  if (h < 24) return `${h}h`;
  return `${Math.ceil(h / 24)}d`;
}
