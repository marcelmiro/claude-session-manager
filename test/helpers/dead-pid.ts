/**
 * A pid guaranteed not to be running — spawn a trivial process and wait for it to exit.
 *
 * Used by the abandoned-hold tests: a `pending/*.json` marker stamped with this pid is
 * exactly what a killed hook leaves behind, so readers must treat it as dead rather than
 * writing a decision nobody will poll for.
 */
export async function deadPid(): Promise<number> {
  const proc = Bun.spawn(["true"]);
  await proc.exited;
  return proc.pid;
}
