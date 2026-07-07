/**
 * Slash-command enumeration. Exercised through the public `listSlashCommands` with a
 * throwaway project dir as the `project` source — this covers frontmatter parsing,
 * command namespacing, source precedence, and builtins without depending on whatever
 * happens to live in the real `~/.claude`.
 */

import { test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listSlashCommands } from "./skills";

let PROJ: string;

beforeAll(() => {
  PROJ = mkdtempSync(join(tmpdir(), "csm-skills-"));
  const skills = join(PROJ, ".claude", "skills");
  const cmds = join(PROJ, ".claude", "commands");
  mkdirSync(skills, { recursive: true });
  mkdirSync(join(cmds, "git"), { recursive: true });

  // (a) normal skill with frontmatter
  mkdirSync(join(skills, "my-skill"));
  writeFileSync(
    join(skills, "my-skill", "SKILL.md"),
    "---\nname: my-skill\ndescription: Do a specific thing\n---\n\nbody\n",
  );
  // (e) missing description → "" ; (a) name still parses
  mkdirSync(join(skills, "bare-skill"));
  writeFileSync(join(skills, "bare-skill", "SKILL.md"), "---\nname: bare-skill\n---\nbody\n");
  // multi-line description → only the first line is kept (locks line-based behavior)
  mkdirSync(join(skills, "wordy"));
  writeFileSync(
    join(skills, "wordy", "SKILL.md"),
    "---\nname: wordy\ndescription: First line here\n  continued second line\n---\nbody\n",
  );
  // lowercase filename is still recognized; bundled ref .md in a subdir is ignored
  mkdirSync(join(skills, "lower"));
  writeFileSync(join(skills, "lower", "skill.md"), "---\nname: lower\ndescription: lc\n---\n");
  mkdirSync(join(skills, "lower", "references"));
  writeFileSync(join(skills, "lower", "references", "extra.md"), "not a skill\n");
  // dot-prefixed skill folder must be enumerated (default glob skips dotfiles)
  mkdirSync(join(skills, ".dotted"));
  writeFileSync(join(skills, ".dotted", "SKILL.md"), "---\nname: .dotted\ndescription: hidden dir\n---\n");
  // (c) project skill named "compact" shadows the builtin of the same name
  mkdirSync(join(skills, "compact"));
  writeFileSync(join(skills, "compact", "SKILL.md"), "---\nname: compact\ndescription: PROJECT compact\n---\n");

  // (b) namespaced command → dir:name ; flat command
  writeFileSync(join(cmds, "sync.md"), "---\nname: sync\ndescription: sync it\n---\nprompt\n");
  writeFileSync(join(cmds, "git", "amend.md"), "---\ndescription: amend last commit\n---\nprompt\n");
});

afterAll(() => {
  rmSync(PROJ, { recursive: true, force: true });
});

test("parses name/description from skill frontmatter", async () => {
  const list = await listSlashCommands(PROJ);
  const s = list.find((c) => c.name === "my-skill");
  expect(s).toEqual({ name: "my-skill", description: "Do a specific thing", source: "project" });
});

test("missing description falls back to empty string without throwing", async () => {
  const list = await listSlashCommands(PROJ);
  expect(list.find((c) => c.name === "bare-skill")?.description).toBe("");
});

test("multi-line description keeps only the first line", async () => {
  const list = await listSlashCommands(PROJ);
  expect(list.find((c) => c.name === "wordy")?.description).toBe("First line here");
});

test("recognizes lowercase skill.md and ignores bundled reference .md files", async () => {
  const list = await listSlashCommands(PROJ);
  expect(list.find((c) => c.name === "lower")?.description).toBe("lc");
  expect(list.some((c) => c.name === "extra")).toBe(false);
});

test("command filename becomes the name; namespaced dirs join with ':'", async () => {
  const list = await listSlashCommands(PROJ);
  expect(list.find((c) => c.name === "sync")?.description).toBe("sync it");
  const amend = list.find((c) => c.name === "git:amend");
  expect(amend).toEqual({ name: "git:amend", description: "amend last commit", source: "project" });
});

test("enumerates dot-prefixed skill folders (e.g. .cap)", async () => {
  const list = await listSlashCommands(PROJ);
  expect(list.find((c) => c.name === ".dotted")?.description).toBe("hidden dir");
});

test("builtins are always present", async () => {
  const list = await listSlashCommands();
  expect(list.some((c) => c.name === "help" && c.source === "builtin")).toBe(true);
  expect(list.some((c) => c.name === "clear" && c.source === "builtin")).toBe(true);
});

test("project source shadows a builtin of the same name (one row, project wins)", async () => {
  const list = await listSlashCommands(PROJ);
  const compacts = list.filter((c) => c.name === "compact");
  expect(compacts).toHaveLength(1);
  expect(compacts[0]).toEqual({ name: "compact", description: "PROJECT compact", source: "project" });
});
