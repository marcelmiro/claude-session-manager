/**
 * Inbox activity discovery — the single snapshot producer (ADR 0013
 * addendum 2). One pass discovers real sessions, stamps observed
 * transitions, and replaces the store's activity snapshot wholesale;
 * authored facts (dispositions, archived) live in their own tables and are
 * never touched by the replace.
 *
 * Run via `csm daemon --discover-once` in a FRESH process per tick: an
 * in-process discovery loop leaks (~1.5 MB/s — JSC never returns
 * discovery's heap), so the long-lived daemon only spawns and reaps.
 */
import { discoverSessions } from "./sessions";
import { loadNameCache } from "./names";
import { branchPullRequest } from "./pull-request";
import { detectScriptWaits } from "./script-wait";
import { readLastPromptAt, resolveTranscriptPath } from "./last-turn";
import { loadState } from "./state";
import type { InboxStore } from "./inbox-store";
import { stripOverlay, type InboxSession } from "./inbox-model";

export async function discoveryTick(store: InboxStore): Promise<void> {
  const nameCache = await loadNameCache(); // AI names, same source as the TUI
  const { sessions } = await discoverSessions({ skipArchivedSummaries: true, nameMap: nameCache.names });
  // ⏳ tier: `ready` but still waiting on a live run_in_background script —
  // that session hasn't handed you anything yet, so it belongs in RUNNING,
  // not Needs You. Same detector as the tmux ⏳ prefix (cached transcript
  // parse + lsof liveness), so the two surfaces can't disagree.
  const readyIds = sessions.filter((s) => s.tmuxPane && s.status === "ready").map((s) => s.id);
  const scriptWaits = readyIds.length ? await detectScriptWaits(readyIds) : new Set<string>();
  const now = Date.now();
  const disp = store.dispositions();
  const arch = store.archivedAt();
  const prevRows: InboxSession[] = [];
  for (const r of store.loadSnapshot()) {
    try {
      prevRows.push(JSON.parse(r.data) as InboxSession);
    } catch {}
  }
  const prevById = new Map(prevRows.map((s) => [s.id, s]));
  const byId = new Map<string, InboxSession>();

  for (const s of sessions) {
    if (!s.tmuxPane) continue;
    if (s.status !== "running" && s.status !== "waiting" && s.status !== "ready") continue;
    // one session can sit at two panes (e.g. a stray numeric tmux session) —
    // duplicate ids break selection, keep the pane in a named tmux session
    const dup = byId.get(s.id);
    if (dup && !/^\d+:/.test(dup.real!.target)) continue;
    const p = prevById.get(s.id);
    // effective status: script-waiting `ready` counts as running, and the
    // transition script-done → truly-ready stamps `since` like any other
    const eff = s.status === "ready" && scriptWaits.has(s.id) ? "running" : s.status;
    const statusChanged = p?.real?.status !== eff;
    // age = how long in this state: an OBSERVED transition stamps now (we
    // watched it happen — the transcript's lastTurnAt can lag or lie); first
    // sight falls back to the transcript. RUNNING ages from your last prompt
    // ("how long has it been churning on my instruction"), which also spans
    // the turn-end → script-wait handover without a reset.
    let since = !p ? (s.lastTurnAt ? +s.lastTurnAt : now) : statusChanged ? now : p.since;
    if (eff === "running" && (!p || (statusChanged && p.real?.status !== "running"))) {
      try {
        const path = await resolveTranscriptPath(s.id);
        const promptAt = path ? await readLastPromptAt(path) : null;
        if (promptAt) since = promptAt;
      } catch {}
    }
    const row: InboxSession = {
      id: s.id,
      repo: s.repo,
      repoPath: s.repoPath,
      branch: s.branch,
      autoResumed: p?.autoResumed,
      needsYou: p?.needsYou,
      // AI name from the shared cache (discovery only maps names onto
      // unmatched sessions, so look active ones up directly), else branch
      name: nameCache.names[s.id] || s.name || s.branch || s.id.slice(0, 8),
      reason: s.status === "waiting" ? "approval" : "turn-done",
      since,
      running: eff === "running" ? { finishAt: Number.MAX_SAFE_INTEGER } : undefined,
      script: eff === "running" && s.status === "ready" ? true : undefined,
      // ⧗ ages from when the script-wait STATE began (age = time in state,
      // like every other section): the observed turn→script transition, or
      // the transcript's last record for scripts already waiting at startup
      scriptSince: undefined, // filled below once `script` is known
      fromSnooze: p?.fromSnooze,
      real: {
        paneId: s.tmuxPane.paneId,
        target: `${s.tmuxPane.sessionName}:${s.tmuxPane.windowIndex}`,
        status: eff,
      },
    };
    if (row.script) {
      const firstSight = s.lastTurnAt ? +s.lastTurnAt : now; // already waiting when we arrived
      row.scriptSince = p?.script
        ? (p.scriptSince ?? firstSight) // same stretch — carry (or backfill) the anchor
        : p
          ? now // observed the turn→script transition this tick
          : firstSight;
    }
    // it started working again — you clearly went back to it, so the parked/
    // archived overlay no longer describes reality (reply observed, per ADR)
    if (statusChanged && eff === "running") {
      const was = store.clearDisposition(s.id, now, "reply");
      if (arch.has(s.id)) store.unarchive(s.id, now);
      row.fromSnooze = was === "snoozed";
      row.needsYou = undefined; // the reply handled it — admission resets
    }
    // Needs You admission (ADR 0013 / M3): only an OBSERVED transition into
    // ready/waiting admits — `p` required, so a session merely found sitting
    // at a prompt on first sight lands in OPEN instead. (A first-sight
    // approval prompt still reads needs-you via its reason: the prompt on
    // screen is present-tense evidence.) The event log feeds the scoreboard.
    if (p && statusChanged && (eff === "waiting" || (eff === "ready" && p.real?.status === "running"))) {
      row.needsYou = true;
      store.transition(s.id, now, p.real?.status ?? null, eff);
    }
    row.pr = p?.pr; // carried; refreshed below on its own cadence
    byId.set(s.id, row);
  }

  // PR numbers: `gh` per repo is slow (~0.5s), so refresh at most 5 stale rows
  // per tick (oldest first, 60s TTL) — the store is the cache, since each
  // tick is a fresh process. A "none" result is cached too (no re-hammering).
  const repoPathById = new Map(
    sessions.filter((s) => byId.has(s.id)).map((s) => [s.id, s.repoPath]),
  );
  const prStale = [...repoPathById.keys()]
    .filter((id) => now - (byId.get(id)!.pr?.fetchedAt ?? 0) > 60_000)
    .sort((a, b) => (byId.get(a)!.pr?.fetchedAt ?? 0) - (byId.get(b)!.pr?.fetchedAt ?? 0))
    .slice(0, 5);
  await Promise.all(
    prStale.map(async (id) => {
      try {
        const pr = await branchPullRequest(repoPathById.get(id)!);
        byId.get(id)!.pr = {
          number: "number" in pr ? pr.number : undefined,
          state: pr.state,
          fetchedAt: now,
        };
      } catch {}
    }),
  );

  // One-time Needs You seed from the monitor's ⚡ flags, so the inbox and the
  // attention system agree on day one — everything without a flag starts in
  // OPEN and earns its way in via observed transitions from here on.
  if (byId.size && !store.getKV("needs-you-seeded")) {
    store.setKV("needs-you-seeded", "1");
    try {
      const st = await loadState();
      const flagged = new Set(
        Object.values(st.sessions)
          .filter((v) => v.needsAttention)
          .map((v) => v.tmuxPane),
      );
      for (const row of byId.values()) {
        if (row.real && flagged.has(row.real.paneId)) row.needsYou = true;
      }
    } catch {}
  }

  // a transient discovery hiccup (tmux/ps failing mid-call) yields zero rows;
  // writing that would wipe the activity snapshot — skip the tick instead
  // (the authored overlay is safe in its own tables regardless)
  if (byId.size === 0 && prevRows.some((s) => s.real)) return;

  const rows = [...byId.values()];
  // authored rows outlive discovery: parked (disposition) rows don't need a
  // live pane, archived rows stay in RECENT for their 24h window, and a row
  // RESTORED by explicit user action (e-undo, b-unpark) sits in Needs You
  // pane-less — its latest event is the marker, else the snapshot replace
  // would vanish it one tick after the undo. Only explicit intent preserves:
  // a reply-observed unpark must NOT pin a row here after its pane closes.
  for (const p of prevRows) {
    if (byId.has(p.id)) continue;
    if (disp.has(p.id) || (arch.has(p.id) && now - arch.get(p.id)! < 86_400_000)) {
      rows.push(p);
      continue;
    }
    const ev = store.latestEvent(p.id);
    if (
      ev?.type === "unarchive" ||
      (ev?.type === "unpark" && (ev.meta as { reason?: string } | null)?.reason === "manual")
    ) {
      rows.push(p);
    }
  }

  store.saveSnapshot(
    rows.map((r) => ({ sessionId: r.id, data: JSON.stringify(stripOverlay(r)) })),
    now,
  );
}

/**
 * The prototype sidebar's refresher owns the snapshot while it runs — there
 * must be exactly ONE producer at any moment, so the daemon defers to it
 * until the chassis swap retires it.
 */
export async function prototypeRefresherAlive(): Promise<boolean> {
  // CSM_HOME = test seam: a scratch home never defers to the real prototype.
  if (process.env.CSM_HOME) return false;
  try {
    const pid = Number(await Bun.file("/tmp/csm-sidebar-refresher-default.pid").text());
    if (pid > 0) {
      process.kill(pid, 0); // throws if dead
      return true;
    }
  } catch {}
  return false;
}
