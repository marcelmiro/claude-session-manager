/**
 * Characterization test for the scroll-up status bug (Contract C — only this
 * row kept for MVP).
 *
 * This PINS the current buggy behavior; it does NOT fix it. When the user
 * scrolls up mid-run, Claude's TUI keeps the `❯` prompt but swaps the spinner
 * line for "Jump to bottom (ctrl+End) ↓", so `detectStatus` finds no spinner and
 * falls through to `ready` even though the process is running.
 *
 * `fixture()` returns RAW file text; `detectStatus` needs ANSI-stripped input,
 * so the `.plain.txt` variants are used.
 *
 * TEMPORARY: these assertions encode buggy output. When Impl #2 makes
 * `event-status` the primary status source, this test must be deleted or
 * inverted (the scroll-up case should become `running`). It is Impl #2's job to
 * do so — do not "fix" it here.
 */

import { test, expect } from "bun:test";
import { detectStatus } from "./status";
import { fixture } from "../../test/helpers/fixture";

test("scroll-up viewport is misread as ready (the bug Impl #2 migrates away from)", () => {
  const scrolled = fixture("viewport/running-scrolled-up.plain.txt");
  expect(detectStatus(scrolled, true).status).toBe("ready");
});

test("non-scrolled running viewport is correctly read as running (control)", () => {
  const running = fixture("viewport/running.plain.txt");
  expect(detectStatus(running, true).status).toBe("running");
});
