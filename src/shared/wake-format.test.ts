import { describe, expect, test } from "bun:test";
import { formatWakeIn } from "./wake-format";

const M = 60_000;
const H = 60 * M;
const D = 24 * H;

describe("formatWakeIn", () => {
  test("minutes below the hour, ceiled", () => {
    expect(formatWakeIn(45 * M, 0)).toBe("45m");
    expect(formatWakeIn(59 * M, 0)).toBe("59m");
    expect(formatWakeIn(44 * M + 1, 0)).toBe("45m"); // partial minute rounds up
  });

  test("promotes to hours at 60m, to days at 24h", () => {
    expect(formatWakeIn(60 * M, 0)).toBe("1h");
    expect(formatWakeIn(23 * H, 0)).toBe("23h");
    expect(formatWakeIn(24 * H, 0)).toBe("1d");
    expect(formatWakeIn(3 * D, 0)).toBe("3d");
  });

  test("a due or past wake clamps to 0m, never negative", () => {
    expect(formatWakeIn(0, 0)).toBe("0m");
    expect(formatWakeIn(0, 5 * M)).toBe("0m");
  });
});
