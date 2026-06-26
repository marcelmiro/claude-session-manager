/**
 * Session-id resolution from a claude process command line. The fork case is the
 * one that matters: `--fork-session` must NOT inherit the `--resume` (parent) id,
 * or a forked pane aliases onto its parent and renders the parent's status.
 */

import { test, expect } from "bun:test";
import { sessionIdFromCommand } from "./process";

const UUID = "0076f009-6a87-4ba8-b9dc-31c548c227bb";

test("plain --resume yields the session id", () => {
  expect(sessionIdFromCommand(`claude --resume=${UUID}`)).toBe(UUID);
});

test("-r short form with a space yields the session id", () => {
  expect(sessionIdFromCommand(`claude -r ${UUID}`)).toBe(UUID);
});

test("--fork-session suppresses the parent id (the bug fix)", () => {
  // The fork resumes FROM the parent but gets its own new id (hook-supplied).
  expect(sessionIdFromCommand(`claude --resume=${UUID} --fork-session`)).toBeUndefined();
  expect(sessionIdFromCommand(`claude --resume ${UUID} --fork-session`)).toBeUndefined();
});

test("no resume flag → undefined", () => {
  expect(sessionIdFromCommand("claude")).toBeUndefined();
  expect(sessionIdFromCommand("zsh -c claude")).toBeUndefined();
});
