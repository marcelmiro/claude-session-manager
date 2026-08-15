import { describe, expect, test } from "bun:test";
import blessed from "blessed";
import { C } from "./colors";
import { BLESSED_TERMINAL } from "./layout";

// Blessed exposes these at runtime but omits them from @types/blessed.
const blessedInternals = blessed as unknown as {
  tput(options: { terminal: string }): { colors: number };
  colors: { convert(color: string): number };
};

describe("terminal color capabilities", () => {
  test("the CSM layout gives Blessed its full 256-color table", () => {
    expect(blessedInternals.tput({ terminal: BLESSED_TERMINAL }).colors).toBe(256);
  });

  test("the Vesper base colors use exact ANSI palette slots", () => {
    expect({
      bg: blessedInternals.colors.convert(C.bg),
      fg: blessedInternals.colors.convert(C.fg),
      muted: blessedInternals.colors.convert(C.muted),
      dim: blessedInternals.colors.convert(C.dim),
      peach: blessedInternals.colors.convert(C.peach),
      mint: blessedInternals.colors.convert(C.mint),
      red: blessedInternals.colors.convert(C.red),
    }).toEqual({ bg: 0, fg: 15, muted: 7, dim: 8, peach: 11, mint: 10, red: 9 });
  });
});
