/**
 * `slashCommandIntent` — turns a Claude Code slash-command user message into a
 * clean naming signal. Skill-launched sessions (e.g. `/implement-plan`) store the
 * real intent only in the command block; the message that follows is generic
 * skill boilerplate ("Base directory for this skill: …"). Naming off the
 * boilerplate produced unstable, hallucinated names (a csm session got named
 * `papi-list-methods`); surfacing the command makes it stable.
 */

import { test, expect } from "bun:test";
import { slashCommandIntent } from "./sessions";

test("extracts /implement-plan with its plan path", () => {
  const msg =
    "<command-message>implement-plan</command-message>\n" +
    "<command-name>/implement-plan</command-name>\n" +
    "<command-args>@.plans/native-status/plan.md</command-args>";
  expect(slashCommandIntent(msg)).toBe("/implement-plan @.plans/native-status/plan.md");
});

test("skips meta commands that carry no intent", () => {
  const clear =
    "<command-name>/clear</command-name>\n" +
    "<command-message>clear</command-message>\n" +
    "<command-args></command-args>";
  expect(slashCommandIntent(clear)).toBeNull();
  expect(slashCommandIntent("<command-name>/compact</command-name><command-args></command-args>")).toBeNull();
});

test("command with no args returns just the name", () => {
  expect(slashCommandIntent("<command-name>/review</command-name><command-args></command-args>")).toBe("/review");
});

test("returns null for plain text and for non-command XML (caveats)", () => {
  expect(slashCommandIntent("fix the auth bug")).toBeNull();
  expect(slashCommandIntent("<local-command-caveat>Caveat: …</local-command-caveat>")).toBeNull();
});

test("collapses whitespace in args", () => {
  const msg = "<command-name>/run</command-name><command-args>  foo   bar  </command-args>";
  expect(slashCommandIntent(msg)).toBe("/run foo bar");
});
