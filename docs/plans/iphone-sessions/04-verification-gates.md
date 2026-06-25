# Verification Gates — run before implementing

> **Status:** DRAFT — for agent iteration.
> **Purpose:** Each implementation has a gate of falsifiable assumptions that
> **must be empirically verified and recorded here before any implementation
> code is written.** This is the safeguard against discovering mid-build that we
> scoped Claude Code's wrapping behavior wrong.

## How a gate works

Each gate item has: an **assumption**, **how to verify** it (a concrete
experiment, runnable on the EC2 box or any machine with `claude` + tmux), the
**expected** result, a **Result** slot (filled in when run), and a **status**.

**Item status:** ⬜ not run · ✅ verified as expected · ⚠️ verified but differs
from plan (→ amend the plan) · ❌ assumption false (→ amend the plan, possibly
re-architect).

**Gate status:** 🔴 Unverified · 🟡 Partial · 🟢 Verified & plan reconciled.

## The three rules (enforced — see `00-overview.md` §Enforcement protocol)

1. **Gate-first.** Do not write implementation code for an implementation until
   its gate below is 🟢 and that state is committed.
2. **Contradiction rule.** Any ⚠️/❌ result means: stop, update the relevant plan
   doc to match reality, note what changed, then re-evaluate the gate.
3. **Auditable artifact.** Running a gate produces committed evidence: this file
   with Result slots filled, plus `test/fixtures/SCHEMA.md` for the schema items.
   Throwaway probe scripts go under a scratch dir and are not shipped.

> **Hard enforcement — DECIDED: enabled (built as part of Impl #1).** A guard
> test makes the gate a red test instead of a convention. Skipping it then
> requires *deleting a test*, which is loud in a reviewed diff. Spec below.

### Hard-enforcement spec (deliverable of Impl #1)

Machine-readable source of truth lives next to these docs as
`verification.json`; the 🔴/🟢 statuses in this file are the human-readable
mirror and must be kept in sync.

```jsonc
// docs/plans/iphone-sessions/verification.json
{
  "gates": {
    "A": { "title": "Claude Code wrapping",     "status": "unverified", "enforce": false },
    "B": { "title": "Test harness",             "status": "unverified", "enforce": false },
    "C": { "title": "Monorepo + mobile app",    "status": "unverified", "enforce": false }
  }
}
// status ∈ "unverified" | "partial" | "verified"
```

`verification-gate.test.ts` (runs under `bun test`):
- Reads `verification.json`.
- **Fails for any gate where `enforce: true` and `status !== "verified"`**, with a
  message naming the gate and pointing here.
- Gates with `enforce: false` are ignored, so unrelated work is never blocked.

**This makes the gate self-enforcing:** the first step of starting an
implementation is to flip `enforce: true` for its required gate(s) — Gate A for
Impl #1 & #2, Gate B for Impl #1, Gate C for Impl #3 — in its own commit. The
suite immediately goes red and stays red until the verification spike records
`status: "verified"`. Only then does `bun test` pass and implementation begin.

> Until Impl #1 exists there is no `bun test`, so the guard test is created there
> (see `01-wrapper-contract-tests.md` §Test infrastructure tasks). Before that,
> the documentation-level gate (banners + Enforcement protocol) applies.

---

## Gate A — Claude Code wrapping (prerequisite for Impl #1 AND #2)

**Gate status:** 🔴 Unverified

This is the gate the whole project hinges on. The prior research cited
capabilities from docs but several field names were *inferred*; these items pin
ground truth. Record exact shapes in `test/fixtures/SCHEMA.md`.

Setup for most items: install a throwaway hook that appends its stdin to a dump
file, register it for all events, and drive a real session through each scenario.

| ID | Assumption | How to verify | Expected | Result | Status |
|----|------------|---------------|----------|--------|--------|
| A1 | Every hook payload includes `session_id`, `cwd`, `transcript_path`, `hook_event_name` | Dump stdin for each hook; inspect keys | All four present | _(fill)_ | ⬜ |
| A2 | `Notification` distinguishes "needs permission" from "idle waiting for input" via a field | Trigger a permission prompt; separately let a session sit idle; diff the two `Notification` payloads | A field (e.g. `notification_type`) with two distinct values | _(fill)_ | ⬜ |
| A3 | A pending `tool_use` is written to the transcript **before** approval | Trigger a permission-required tool; `tail -f` the transcript; check before answering | A `tool_use` record appears pre-decision | _(fill)_ | ⬜ |
| A4 | `AskUserQuestion` question + options are structured `tool_input` in the transcript | Trigger an AskUserQuestion; inspect the transcript record | `{ question, options:[{label, description}] }`-ish structure | _(fill)_ | ⬜ |
| A5 | Real transcript line discriminators (kills the inferred `user_message`/etc. names) | Inspect raw transcript lines for user/assistant/tool_use/tool_result | Documented exact `type` tags + nesting | _(fill)_ | ⬜ |
| A6 | **Blocking `PreToolUse` hook controls approval** (HIGHEST RISK) | Write a `PreToolUse` hook that blocks N s then returns `permissionDecision`; test: (a) a decision suppresses the TUI prompt, (b) a neutral/timeout exit falls through to the TUI prompt, (c) the block doesn't destabilize Claude | All three hold | _(fill)_ | ⬜ |
| A7 | Event-writer hook latency is negligible | Time a session with the writer hook installed vs not | < ~50ms added per event | _(fill)_ | ⬜ |
| A8 | `AskUserQuestion` can be answered programmatically (hook) or via `send-keys` | Attempt hook-supplied answer; else `send-keys` arrow-to-index + Enter | One reliable method identified | _(fill)_ | ⬜ |
| A9 | `tmux send-keys` (text + keys) lands correctly in a **headless/detached** tmux pane (no attached client) | On EC2, send to a detached pane; confirm receipt | Input received reliably | _(fill)_ | ⬜ |
| A10 | The `encoded-cwd → transcript path` mapping is known | Derive a live session's transcript path from its cwd; confirm file match | Deterministic mapping documented | _(fill)_ | ⬜ |

**Blocks:** Impl #1 (fixtures/contracts depend on A1–A5), Impl #2 (all). Until
🟢, neither should write implementation code.

---

## Gate B — Test harness (Impl #1)

**Gate status:** 🔴 Unverified
**Prerequisite:** Gate A items A1–A5 (the fixtures are the captured shapes).

| ID | Assumption | How to verify | Expected | Result | Status |
|----|------------|---------------|----------|--------|--------|
| B1 | `bun:test` runs in this repo and can import `src/core/*` | Add `"test":"bun test"`; write a trivial test importing `status.ts`; run | Green | _(fill)_ | ⬜ |
| B2 | Tests run hermetically with no tmux / no `claude` present | Run the suite in an env without tmux/claude | Pass (except the gated live canary) | _(fill)_ | ⬜ |
| B3 | Captured fixtures faithfully reproduce the scroll-up bug | Feed `viewport/running-scrolled-up.txt` to current `detectStatus` | Returns `ready` (the bug, reproduced) | _(fill)_ | ⬜ |

---

## Gate C — Monorepo + mobile app (Impl #3)

**Gate status:** 🔴 Unverified
**Prerequisite:** Impl #2 complete (stable `core/` API).

| ID | Assumption | How to verify | Expected | Result | Status |
|----|------------|---------------|----------|--------|--------|
| C1 | Bun workspaces support the split without behavior change | Prototype moving one `core` module to a package; run `bun run start`, `status`, tests | All unchanged | _(fill)_ | ⬜ |
| C2 | iPhone can reach the EC2 bridge over Tailscale | `curl` a probe endpoint from the phone on the tailnet | 200 OK | _(fill)_ | ⬜ |
| C3 | ntfy delivers push to the iOS app | POST to an ntfy topic; observe the phone | Notification received | _(fill)_ | ⬜ |
| C4 | SSE/WS works from iOS Safari (PWA) over Tailscale | Open a stream from a test page on the phone | Live events received | _(fill)_ | ⬜ |
| C5 | PWA installs to the home screen with a working service worker | Add-to-home-screen; relaunch offline-tolerant | Installs, launches | _(fill)_ | ⬜ |
| C6 | `capture-pane` thumbnail renders acceptably on mobile (optional) | Render a captured pane in the PWA | Legible fallback | _(fill)_ | ⬜ |

---

## Suggested workflow per implementation

1. Agent opens the implementation's plan; the banner points here.
2. If the gate is not 🟢: run the verification spike, fill Result slots, set
   item statuses, commit (this file + `SCHEMA.md`).
3. Reconcile: for every ⚠️/❌, amend the plan doc, then set the gate 🟢.
4. Only now: begin implementation against the (now accurate) plan.
