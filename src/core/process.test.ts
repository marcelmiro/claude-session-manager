/**
 * Session-id resolution from a claude process command line. The fork case is the
 * one that matters: `--fork-session` must NOT inherit the `--resume` (parent) id,
 * or a forked pane aliases onto its parent and renders the parent's status.
 */

import { test, expect } from "bun:test";
import { sessionIdFromCommand, dictatedSessionId } from "./process";

const UUID = "0076f009-6a87-4ba8-b9dc-31c548c227bb";
const FORK = "11111111-2222-3333-4444-555555555555";

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

test("dictatedSessionId reads --session-id", () => {
  expect(dictatedSessionId(`claude --session-id ${UUID}`)).toBe(UUID);
  expect(dictatedSessionId(`claude --session-id=${UUID}`)).toBe(UUID);
});

test("dictatedSessionId on a fork prefers the dictated id, not the --resume parent", () => {
  // The fork's own id is dictated with --session-id; --resume carries the PARENT.
  expect(dictatedSessionId(`claude --session-id ${FORK} --resume=${UUID} --fork-session`)).toBe(FORK);
});

test("dictatedSessionId → undefined when no --session-id", () => {
  expect(dictatedSessionId("claude")).toBeUndefined();
  expect(dictatedSessionId(`claude --resume ${UUID}`)).toBeUndefined();
});
