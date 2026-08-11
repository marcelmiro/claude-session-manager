// Pure inbox lifecycle math (ADR 0013), shared by every surface that sets or
// interprets a snooze — wake daemon, sidebar, CLI verbs. No IO. This is the
// wake-timing slice only; section/age derivation moves here when the single
// renderer consumes it.

// LOCAL dates, not UTC — with ISO slicing a "snooze 1d" pressed at 00:30 local
// wakes ~90 minutes later (UTC midnight = 02:00 CEST). Day granularity means
// the user's day, so all day math uses local calendar components.
function localYMD(t: number): string {
  const dt = new Date(t);
  return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, "0")}-${String(dt.getDate()).padStart(2, "0")}`;
}

export function addDays(now: number, days: number): string {
  return localYMD(now + days * 86_400_000);
}

/** Local midnight of a YYYY-MM-DD (new Date("YYYY-MM-DD") would be UTC). */
export function localMidnight(ymd: string): number {
  const [y, m, d] = ymd.split("-").map(Number);
  return new Date(y!, m! - 1, d!).getTime();
}

/** Wake timestamp for a snooze: hours are exact, days land on local midnight. */
export function wakeAt(now: number, n: number, unit: "h" | "d"): number {
  return unit === "h" ? now + n * 3_600_000 : localMidnight(addDays(now, n));
}

/** A snoozed session whose wake moment has passed — a full attention event. */
export function isDue(until: number, now: number): boolean {
  return until <= now;
}

/** Compact "how long ago" for the wake banner: 3d / 16h / 5m (never 0m). */
export function snoozeSpan(snoozedAt: number, now: number): string {
  const span = now - snoozedAt;
  return span >= 86_400_000
    ? `${Math.round(span / 86_400_000)}d`
    : span >= 3_600_000
      ? `${Math.round(span / 3_600_000)}h`
      : `${Math.max(1, Math.round(span / 60_000))}m`;
}

/**
 * The line echoed above claude's UI in an auto-reopened wake window, so
 * walking into it later explains why the window exists.
 */
export function wakeBanner(snoozedAt: number, now: number): string {
  return `-- snooze wake: snoozed ${snoozeSpan(snoozedAt, now)} ago, due now - reopened automatically --`;
}
