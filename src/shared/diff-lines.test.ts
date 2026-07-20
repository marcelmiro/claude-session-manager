import { expect, test } from "bun:test";
import { realpathSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { parseDiffLines, indentUnit, narrowIndent } from "./diff-lines.js";

const text = (lines: { t: string; s: string }[]) => lines.map((l) => `${l.t}:${l.s}`);

test("splits a hunk into add / del / ctx and keeps the @@ header", () => {
  const patch = [
    "diff --git a/a.txt b/a.txt",
    "index 111..222 100644",
    "--- a/a.txt",
    "+++ b/a.txt",
    "@@ -1,3 +1,3 @@",
    " one",
    "-two",
    "+TWO",
    " three",
    "",
  ].join("\n");
  expect(text(parseDiffLines(patch))).toEqual([
    "hunk:@@ -1,3 +1,3 @@",
    "ctx:one",
    "del:two",
    "add:TWO",
    "ctx:three",
  ]);
});

// --- the regression this module exists for ---

test("a deleted line starting with `-- ` survives (reads as `--- ` once marked)", () => {
  const patch = ["@@ -1,2 +1,2 @@", "-- a SQL comment", "+-- a better SQL comment", " SELECT 1"].join("\n");
  expect(text(parseDiffLines(patch))).toEqual([
    "hunk:@@ -1,2 +1,2 @@",
    "del:- a SQL comment",
    "add:-- a better SQL comment",
    "ctx:SELECT 1",
  ]);
});

test("an added line starting with `++ ` survives (reads as `+++ ` once marked)", () => {
  const patch = ["@@ -1 +1,2 @@", " x", "++ incremented"].join("\n");
  expect(text(parseDiffLines(patch))).toEqual(["hunk:@@ -1 +1,2 @@", "ctx:x", "add:+ incremented"]);
});

test("a deleted markdown `---` rule survives", () => {
  const patch = ["@@ -1,3 +1,2 @@", " intro", "----", " outro"].join("\n");
  expect(text(parseDiffLines(patch))).toEqual(["hunk:@@ -1,3 +1,2 @@", "ctx:intro", "del:---", "ctx:outro"]);
});

// --- metadata handling ---

test("drops file headers, mode/rename/binary markers and the no-newline note", () => {
  const patch = [
    "diff --git a/x b/x",
    "old mode 100644",
    "new mode 100755",
    "similarity index 90%",
    "rename from x",
    "rename to y",
    "index abc..def",
    "--- a/x",
    "+++ b/y",
    "@@ -1 +1 @@",
    "-old",
    "+new",
    "\\ No newline at end of file",
  ].join("\n");
  expect(text(parseDiffLines(patch))).toEqual(["hunk:@@ -1 +1 @@", "del:old", "add:new"]);
});

test("a two-block patch (rename diffed at both endpoints) drops BOTH header blocks", () => {
  const patch = [
    "diff --git a/old.ts b/old.ts",
    "deleted file mode 100644",
    "index 111..000",
    "--- a/old.ts",
    "+++ /dev/null",
    "@@ -1 +0,0 @@",
    "-gone",
    "diff --git a/new.ts b/new.ts",
    "new file mode 100644",
    "index 000..222",
    "--- /dev/null",
    "+++ b/new.ts",
    "@@ -0,0 +1 @@",
    "+fresh",
  ].join("\n");
  expect(text(parseDiffLines(patch))).toEqual([
    "hunk:@@ -1 +0,0 @@",
    "del:gone",
    "hunk:@@ -0,0 +1 @@",
    "add:fresh",
  ]);
});

test("a metadata-only patch (pure rename) yields no display lines", () => {
  const patch = [
    "diff --git a/a.txt b/b.txt",
    "similarity index 100%",
    "rename from a.txt",
    "rename to b.txt",
  ].join("\n");
  expect(parseDiffLines(patch)).toEqual([]);
});

// --- edge cases ---

test("a blank context line inside a hunk is kept, the trailing one is dropped", () => {
  const patch = ["@@ -1,3 +1,3 @@", " top", "", " bottom", ""].join("\n");
  expect(text(parseDiffLines(patch))).toEqual(["hunk:@@ -1,3 +1,3 @@", "ctx:top", "ctx:", "ctx:bottom"]);
});

test("empty / missing input yields no lines", () => {
  expect(parseDiffLines("")).toEqual([]);
  expect(parseDiffLines(null)).toEqual([]);
  expect(parseDiffLines(undefined)).toEqual([]);
});

// --- against a patch git actually produced ---

test("real `git diff` output: a replaced `--` comment line round-trips", async () => {
  const root = realpathSync(mkdtempSync(`${tmpdir()}/dl-repo-`));
  await Bun.$`git -C ${root} init -q`.quiet();
  await Bun.$`git -C ${root} config user.email t@t.t`.quiet();
  await Bun.$`git -C ${root} config user.name t`.quiet();
  writeFileSync(`${root}/q.sql`, "-- old comment\nSELECT 1;\n");
  await Bun.$`git -C ${root} add -A`.quiet();
  await Bun.$`git -C ${root} commit -qm init`.quiet();
  writeFileSync(`${root}/q.sql`, "-- new comment\nSELECT 1;\n");
  const patch = (await Bun.$`git -C ${root} diff -- q.sql`.nothrow().quiet()).stdout.toString();

  const lines = parseDiffLines(patch);
  // Both sides of the comment swap must be present; the deletion is the one that used to
  // disappear into the `--- ` file-header pattern.
  // The raw patch line is `--- old comment` (content `-- old comment` + the `-` marker) —
  // byte-for-byte the `--- ` file-header pattern that used to swallow it.
  expect(patch).toContain("\n--- old comment");
  expect(text(lines)).toContain("del:-- old comment");
  expect(text(lines)).toContain("add:-- new comment");
  expect(lines.filter((l) => l.t === "del")).toHaveLength(1);
  expect(lines.filter((l) => l.t === "add")).toHaveLength(1);
  // ...and no metadata leaked through as content.
  expect(text(lines).some((s) => s.includes("diff --git") || s.includes("index "))).toBe(false);
  rmSync(root, { recursive: true, force: true });
});

// --- indentUnit / narrowIndent ---

const L = (...pairs: string[]) => pairs.map((s) => ({ t: "ctx" as const, s }));

test("indentUnit reads the dominant step, not the GCD", () => {
  // A 4-space file with a continuation line at 6: GCD is 2, but the step is 4.
  expect(indentUnit(L("a", "    b", "        c", "      cont", "    d"))).toEqual({ unit: 4, tabs: false });
});

test("indentUnit reports tabs and doesn't guess a space width for them", () => {
  expect(indentUnit(L("a", "\tb", "\t\tc"))).toEqual({ unit: 0, tabs: true });
});

test("indentUnit ignores blank lines and doesn't step across a hunk boundary", () => {
  const lines = [...L("a", "  b", ""), { t: "hunk" as const, s: "@@ -9,2 +9,2 @@" }, ...L("        z")];
  expect(indentUnit(lines)).toEqual({ unit: 2, tabs: false });
});

test("narrowIndent collapses 4-space levels to 2 and preserves depth", () => {
  const out = narrowIndent(L("fn()", "    if x:", "        go()"));
  expect(out.map((l) => l.s)).toEqual(["fn()", "  if x:", "    go()"]);
});

test("narrowIndent turns each tab into one 2-space level", () => {
  expect(narrowIndent(L("a", "\tb", "\t\tc")).map((l) => l.s)).toEqual(["a", "  b", "    c"]);
});

test("narrowIndent never touches interior spacing", () => {
  // An aligned trailing comment and an ASCII table must survive re-indentation.
  const out = narrowIndent(L("x", "    a = 1    # one", "        | a | b |"));
  expect(out.map((l) => l.s)).toEqual(["x", "  a = 1    # one", "    | a | b |"]);
});

test("narrowIndent carries a sub-unit remainder through as alignment, not a level", () => {
  // 6 spaces in a 4-space file = one level + 2 columns of alignment padding. The 4-steps have
  // to outnumber the 2-step, or the file genuinely is 2-space indented.
  const lines = L("x", "    a", "        b", "            c", "      cont");
  expect(narrowIndent(lines).map((l) => l.s)).toEqual(["x", "  a", "    b", "      c", "    cont"]);
});

test("narrowIndent is a no-op on a file already at or below the target width", () => {
  const lines = L("a", "  b", "    c");
  expect(narrowIndent(lines)).toBe(lines);
  expect(narrowIndent(L("a", "b"))).toEqual(L("a", "b"));
});

test("narrowIndent leaves hunk headers alone", () => {
  const lines = [{ t: "hunk" as const, s: "@@ -1,2 +1,2 @@ def f():" }, ...L("        deep")];
  expect(narrowIndent(lines)[0]!.s).toBe("@@ -1,2 +1,2 @@ def f():");
});
