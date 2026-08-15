import { describe, expect, test } from "bun:test";
import blessed from "blessed";
import { C } from "./colors";
import { BLESSED_TERMINAL } from "./layout";

describe("terminal color capabilities", () => {
  test("the CSM layout gives Blessed its full 256-color table", () => {
    expect(blessed.tput({ terminal: BLESSED_TERMINAL }).colors).toBe(256);
  });

  test("the primary foreground resolves to bright white, not muted ANSI white", () => {
    expect(blessed.colors.convert(C.fg)).toBe(15);
  });
});
