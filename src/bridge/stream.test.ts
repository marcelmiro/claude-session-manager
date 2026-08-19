import { test, expect } from "bun:test";
import { deltaTurns, turnKey } from "./stream";

const keys = (...texts: string[]) => texts.map((t) => turnKey({ role: "user", text: t }));

test("first push (no prior keys) is a snapshot", () => {
  expect(deltaTurns(null, keys("a"))).toEqual({ kind: "snapshot" });
});

test("pure extension appends from the prefix end", () => {
  expect(deltaTurns(keys("a", "b"), keys("a", "b", "c"))).toEqual({ kind: "append", fromIndex: 2 });
});

test("identical turn lists append zero turns (volatile-only change)", () => {
  expect(deltaTurns(keys("a", "b"), keys("a", "b"))).toEqual({ kind: "append", fromIndex: 2 });
});

test("last turn amended in place (streaming text) appends from that turn", () => {
  expect(deltaTurns(keys("a", "partial"), keys("a", "partial grown", "next"))).toEqual({
    kind: "append",
    fromIndex: 1,
  });
});

test("one-turn truncation is an append with no new turns", () => {
  expect(deltaTurns(keys("a", "b"), keys("a"))).toEqual({ kind: "append", fromIndex: 1 });
});

test("rewind (shrink past the last turn) is a snapshot", () => {
  expect(deltaTurns(keys("a", "b", "c"), keys("a"))).toEqual({ kind: "snapshot" });
});

test("branch flip (diverging prefix) is a snapshot", () => {
  expect(deltaTurns(keys("a", "b", "c"), keys("a", "x", "y", "z"))).toEqual({ kind: "snapshot" });
});

test("turnKey is stable for equal turns and differs for different ones", () => {
  const t = { role: "assistant", content: [{ type: "text", text: "hi" }] };
  expect(turnKey(t)).toBe(turnKey(structuredClone(t)));
  expect(turnKey(t)).not.toBe(turnKey({ ...t, role: "user" }));
});
