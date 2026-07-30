/**
 * Guard against a subprocess await that never settles. Under concurrent subprocess
 * churn, Bun (observed on 1.3.14) occasionally loses a child's exit: the process is
 * gone but the awaited promise stays pending forever. In a long-lived process (the
 * bridge) one lost await wedges everything behind it permanently, so every
 * subprocess await on a hot path gets a deadline.
 */

/** Reject with DeadlineError if `promise` doesn't settle within `ms`. */
export class DeadlineError extends Error {
  constructor(label: string, ms: number) {
    super(`deadline: ${label} did not settle within ${ms}ms`);
    this.name = "DeadlineError";
  }
}

export function withDeadline<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new DeadlineError(label, ms)), ms);
    promise.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}

/**
 * Run `fn` with a deadline; on timeout, retry once with a fresh invocation (the lost
 * exit is per-spawn, so a re-spawn almost always succeeds). Throws after the retry
 * also times out — callers keep their existing catch-and-default behavior.
 */
export async function retryOnDeadline<T>(fn: () => Promise<T>, ms: number, label: string): Promise<T> {
  try {
    return await withDeadline(fn(), ms, label);
  } catch (e) {
    if (!(e instanceof DeadlineError)) throw e;
    return withDeadline(fn(), ms, `${label} (retry)`);
  }
}
