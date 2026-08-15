import { describe, expect, test } from "bun:test";
import { fg, plainLen, truncate } from "./ansi";

describe("terminal cell width", () => {
  test("measures wide emoji, CJK, combining marks, and ANSI by terminal cells", () => {
    expect(plainLen("⚡")).toBe(2);
    expect(plainLen("日本")).toBe(4);
    expect(plainLen("e\u0301")).toBe(1);
    expect(plainLen(fg("#FFFFFF", "✅ ok"))).toBe(5);
  });

  test("truncates on grapheme boundaries and never exceeds the cell budget", () => {
    expect(truncate("ab⚡cd", 5)).toBe("ab⚡…");
    expect(plainLen(truncate("ab⚡cd", 5))).toBe(5);
    expect(truncate("e\u0301clair", 4)).toBe("e\u0301cl…");
    expect(plainLen(truncate("e\u0301clair", 4))).toBe(4);
    expect(truncate("👨‍👩‍👧‍👦 family", 3)).toBe("👨‍👩‍👧‍👦…");
  });
});
