/**
 * core/ import-boundary guard (Inc7, ADR-6).
 *
 * `src/core/` must stay headless and EC2/Linux-portable: no `blessed`, no imports
 * from `src/ui/`. This keeps the future `src/bridge/` (Impl #3) able to consume
 * `core/` without dragging in the terminal UI. If this fails, move the offending
 * UI/Darwin logic up into `index.ts`/`ui/` and import the headless piece down.
 */

import { test, expect } from "bun:test";
import { Glob } from "bun";

test("core/ has no blessed or ui imports", async () => {
  const offenders: string[] = [];
  for await (const f of new Glob("src/core/**/*.ts").scan(".")) {
    if (f.endsWith(".test.ts")) continue;
    const src = await Bun.file(f).text();
    if (/from ["']blessed["']|from ["'][^"']*\/ui\//.test(src)) offenders.push(f);
  }
  expect(offenders).toEqual([]);
});
