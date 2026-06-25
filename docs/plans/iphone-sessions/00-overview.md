# iPhone Sessions — Plan Suite Overview

> **Status:** DRAFT — for agent iteration. These documents are *plans*, not
> implementation specs. Each is meant to be picked up by an agent, refined
> against the real codebase and live Claude Code behavior, and only then
> implemented. Treat every "Open question" as a gate that must be closed
> before code is written.

## The goal

Access and continue Claude Code sessions from an iPhone, so work is no longer
tied to carrying the Mac. The plan is to run the existing setup (tmux + zsh +
`claude`) on an always-on EC2 box, keep CSM running there, and build a small
single-user companion app that lists and drives those sessions from the phone.

The naive alternative — SSH via Tailscale + Termius into raw tmux — is rejected:
the Claude Code TUI is keyboard-centric and miserable on a touch keyboard. The
companion app instead exposes the *operations* you actually do from a phone
(see what needs you, read the latest output/question, approve a tool, send a
short instruction) as buttons and text boxes, not as a terminal.

## The architectural decision: Camp 1 (hooks + JSONL)

Research into how mature Claude Code wrappers capture session state found two
camps (full detail and citations in [`90-references.md`](./90-references.md)):

- **Camp 1 — observe the real interactive session.** Keep `claude` running in
  tmux; derive status from **Claude Code hooks**, read conversation state from
  the **JSONL transcript**, and inject input via a blocking hook (for approvals)
  or `tmux send-keys` (for free text). Reference implementation: **ccgram**.
- **Camp 2 — own the process.** Spawn `claude -p --output-format stream-json`
  headless, parse the event stream, and drive approvals over a stdin control
  protocol. Reference implementation: **vibe-kanban**.

**We chose Camp 1.** Rationale:

1. The stated goal is to keep "my same setup of tmux, zsh, and Claude" and have
   CSM observe *real* sessions that are also reachable by SSH from the Mac.
   Camp 2 replaces real sessions with an app-owned process and rebuilds the
   entire UX — a different (much larger) product that discards CSM.
2. Camp 1 is an **incremental upgrade** to CSM: the `SessionStart` hook is
   already installed, and `core/` is already headless and reusable.
3. The only thing actually wrong with CSM today is the *sensing layer* (scraping
   the rendered TUI viewport). Camp 1 replaces just that layer. The substrate
   (interactive `claude` in tmux) was always correct — it is the only mode that
   preserves human-in-the-loop tool approval.

Critically, **viewport scraping is the wrong data source** and every camp agrees
on this — even Camp 1 tools read the JSONL transcript + hooks and treat
`capture-pane` as, at most, a display thumbnail.

## The two problems this fixes

1. **Status is lost on scroll.** Claude's TUI runs in the terminal alternate
   screen; `capture-pane` only sees the rendered viewport, so scrolling up makes
   a "running" session look "finished." Fix: derive status from **hook event
   edges**, which are independent of what is on screen.
2. **Answering questions / sending messages is poor UX.** Today the answer UI is
   reconstructed by regexing `☐` glyphs off the screen. Fix: `AskUserQuestion`
   options and pending tool calls are **structured data in the JSONL transcript**
   — render real buttons from real data.

## The three implementations

The work is three large, sequential implementations. Each unblocks the next.

```
┌─────────────────────────────────────────────────────────────────────┐
│ 1. Wrapper Contract Test Suite                                        │
│    Pin the behavior of the Claude-Code-wrapping layer as executable   │
│    contracts. EXPECTED TO FAIL against today's scraper — the failing  │
│    tests ARE the spec for implementation #2. Also a version-drift     │
│    canary: a future Claude release that changes payloads fails loudly.│
│    → docs: 01-wrapper-contract-tests.md                               │
└───────────────────────────────┬───────────────────────────────────────┘
                                 │ unblocks (defines the target contract)
                                 ▼
┌─────────────────────────────────────────────────────────────────────┐
│ 2. Camp 1 Migration (hooks + JSONL)        [internal to CSM]          │
│    Replace viewport-scraping with event-sourced status + transcript   │
│    parsing + blocking-hook approval. Many sub-phases. Makes the tests  │
│    from #1 pass and exposes a clean internal API for the bridge.      │
│    → docs: 02-camp1-hooks-jsonl.md                                    │
└───────────────────────────────┬───────────────────────────────────────┘
                                 │ unblocks (stable core API)
                                 ▼
┌─────────────────────────────────────────────────────────────────────┐
│ 3. Monorepo + Mobile App                                              │
│    Restructure to a monorepo, extract a reusable core package, add a  │
│    bridge server package and a PWA/mobile app package + push (ntfy).  │
│    → docs: 03-monorepo-mobile-app.md                                  │
└─────────────────────────────────────────────────────────────────────┘
```

### Why this order

- Tests first because they (a) define the contract the migration must satisfy,
  (b) provide a regression net so the migration is measurable ("scroll-up no
  longer flips status" becomes a passing assertion), and (c) become a permanent
  canary against Claude Code version drift.
- Migration second because the mobile app should consume a *stable, reliable*
  internal API. Building the app on top of the current scraper would bake the
  fragility into the product.
- Monorepo + app last because it depends on a settled `core` API surface from #2
  and is mostly additive (new packages) rather than a change to existing logic.

## Document index

| Doc | Implementation | Scope |
|-----|----------------|-------|
| [`01-wrapper-contract-tests.md`](./01-wrapper-contract-tests.md) | #1 | Contract tests + fixtures + version-drift canary |
| [`02-camp1-hooks-jsonl.md`](./02-camp1-hooks-jsonl.md) | #2 | Hooks, event-status, transcript reader, approval IPC |
| [`03-monorepo-mobile-app.md`](./03-monorepo-mobile-app.md) | #3 | Monorepo layout, bridge server, PWA, push, security |
| [`04-verification-gates.md`](./04-verification-gates.md) | all | Pre-implementation gates that must be 🟢 before any code |
| [`90-references.md`](./90-references.md) | all | Verified Claude Code facts + competitor research + URLs |

## Enforcement protocol (read before implementing anything)

Each implementation has a **Verification Gate** in
[`04-verification-gates.md`](./04-verification-gates.md): a checklist of
falsifiable assumptions (especially about how Claude Code wraps — hook payloads,
transcript shapes, blocking-hook approval) that must be empirically confirmed
*before* implementation begins. The gate exists so an implementation agent never
has to deviate from a plan mid-build because reality differed from an assumption.

**Three rules, enforced:**

1. **Gate-first.** Do not write implementation code for an implementation until
   its gate is 🟢 (Verified & plan reconciled) **and committed**. An agent
   assigned an implementation must first check the gate; if it is not 🟢, the
   agent's task becomes *running the verification spike*, not implementing.
2. **Contradiction rule.** Any verification result that conflicts with a plan
   (⚠️/❌) means: **stop, amend the plan doc to match reality, note the change,
   then re-evaluate the gate.** Plans bend to findings; code does not start until
   they agree.
3. **Auditable artifact.** A verification spike is its own commit and produces
   committed evidence: filled Result slots in `04-verification-gates.md` plus the
   pinned `test/fixtures/SCHEMA.md`. "We verified" must be provable.

Enforcement is documentation-driven (agents follow the plan), so the gate is
loud and linked from every plan. An optional *hard* enforcement — a guard test
that keeps `bun test` red until a required gate is 🟢 — is described in the gates
doc; enable it per-implementation if you want a mechanical stop.

## Conventions for agents iterating on these docs

- **Close open questions empirically.** Where a doc says a field name or hook
  behavior is "assumed/inferred," verify it against a live session on the EC2
  box before relying on it. The single most important shared task is *Schema
  Pinning* (see doc 01 §Fixtures and doc 02 §1b.0).
- **Keep `capture-pane` as fallback only.** No new feature should depend on
  parsing the rendered viewport as its source of truth.
- **Single user.** This is a personal tool. No multi-tenancy, no auth beyond a
  bearer token, no App Store. Prefer a PWA over native unless a hard requirement
  forces otherwise.
- **No new runtime deps without justification.** CSM's convention is "no
  external deps beyond blessed" and Bun built-ins. The bridge/app may add deps,
  but keep them minimal and document why.

## Glossary

- **Hook** — a Claude Code lifecycle callback (`SessionStart`, `PreToolUse`,
  `Notification`, `Stop`, …) that runs a script with a JSON payload on stdin.
- **Transcript** — the append-only JSONL conversation log at
  `~/.claude/projects/<encoded-cwd>/<sessionId>.jsonl`.
- **Event-sourced status** — session status derived from the last hook event
  edge, not from the rendered screen.
- **Bridge** — the Bun HTTP/WS server on EC2 that the phone talks to.
- **Camp 1 / Camp 2** — the two wrapper architectures (see above).
