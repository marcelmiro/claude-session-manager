/**
 * Single sidebar renderer (M2 chassis — ADR 0013 addendum 2). ONE process
 * (inside `csm daemon`) paints every window's sidebar pane by writing ANSI
 * to the pane's tty; the panes themselves are dumb `csm sidebar-pane` stubs
 * that raw-mode their tty and relay stdin bytes back over a unix socket.
 *
 * What the per-pane blessed chassis needed cross-process choreography for —
 * focus handoff files, SIGUSR1/2, destination pre-warm — is plain in-process
 * state here: every window's sidebar is always current, so a window switch
 * lands on painted content by construction.
 *
 * Spike-proven mechanics (see .plans + prototype/renderer-spike): writing a
 * pane's pty slave IS pane output; DECSET 1004/1006 written to the tty give
 * focus + SGR mouse through the same relay; a respawned pane gets a NEW tty
 * (EPERM/ENOENT on the old one ⇒ re-resolve and repaint).
 *
 * Stands down entirely while the prototype refresher runs (blessed sidebars
 * own the panes until the chassis swap) or while `M-S` hides sidebars.
 */
import { openSync, writeSync, closeSync } from "node:fs";
import { InboxStore } from "../core/inbox-store";
import { composeSessions, wakeAt, type InboxSession } from "../core/inbox-model";
import { prototypeRefresherAlive } from "../core/inbox-discovery";
import { resolveRestoreTarget } from "../core/resurrect";
import { PATHS } from "../core/config";
import { parseInput, type InputEvent } from "./input";
import { renderView, type ViewState, type VisibleRow } from "./rows";

const COLS = Number(process.env.CSM_SIDEBAR_COLS ?? 30);
export const SIDEBAR_SOCK = `${PATHS.dir}/sidebar.sock`;
// Same markers the prototype's ctl.ts owns — `on`/`off`/`M-S` keep working
// across the chassis swap with zero migration.
const AUTOSTART = `${PATHS.dir}/inbox-sidebar-autostart-default`;
const HIDDEN = `${PATHS.dir}/inbox-sidebar-hidden-default`;
/** start_command marker for stub panes (what discovery greps for). */
const STUB_MARK = "sidebar-pane";
/**
 * Field separator for tmux -F output. NOT \t: tmux sanitizes control
 * characters to `_` when the client runs OUTSIDE tmux (no TMUX env) — which
 * is exactly how this daemon always runs. Free-text fields (start_command)
 * go LAST so a separator collision inside them can't shift the fixed fields.
 */
const SEP = "<|>";
/**
 * The pane stub is a SHELL line, not a bun process: a bun runtime per pane
 * costs ~30MB — more than the blessed chassis this replaces; sh+nc+cat is
 * ~1MB. Raw-mode the tty so keys pass through unrendered, greet with the
 * pane id, then relay stdin bytes to the renderer socket verbatim. The
 * reconnect loop survives daemon restarts (nc dies with the socket, the
 * next keypress SIGPIPEs cat, the loop reconnects). `: sidebar-pane` is the
 * discovery marker in pane_start_command.
 */
const STUB_CMD = `: sidebar-pane; stty raw -echo; while :; do (printf 'hello %s\\n' "$TMUX_PANE"; exec cat) | nc -U ${SIDEBAR_SOCK} 2>/dev/null; sleep 1; done`;

interface WinState extends ViewState {
  windowId: string;
  stubPane: string | null;
  stubTty: string | null;
  stubBornAt: number;
  width: number;
  height: number;
  clickArmed: boolean;
  confirmKillId: string | null;
  /** Last painted rows per line — the diff baseline. */
  lastRows: string[];
  /** Mouse/focus modes + cursor-hide written to the current tty. */
  modesWritten: boolean;
  visible: VisibleRow[];
  rowAtLine: (string | undefined)[];
  focusPending: ReturnType<typeof setTimeout> | null;
}

function freshWin(windowId: string): WinState {
  return {
    windowId,
    stubPane: null,
    stubTty: null,
    stubBornAt: 0,
    width: COLS,
    height: 24,
    focused: false,
    clickArmed: false,
    selectedId: null,
    activePaneId: null,
    snoozeMenuFor: null,
    snoozeDigits: "",
    confirmKillId: null,
    blockNoteFor: null,
    blockNote: "",
    helpVisible: false,
    flash: "",
    flashUntil: 0,
    scrollTop: 0,
    lastRows: [],
    modesWritten: false,
    visible: [],
    rowAtLine: [],
    focusPending: null,
  };
}

export function runSidebarRenderer(): void {
  console.error(`[sidebar] renderer starting (pid ${process.pid})`);
  const store = new InboxStore();
  let sessions: InboxSession[] = [];
  let lastDataVersion = -1;
  const wins = new Map<string, WinState>();
  const paneToWin = new Map<string, string>(); // stub paneId → windowId
  let standing = false; // currently active (markers allow, prototype absent)
  let lastMinute = -1;

  function reloadSessions(): void {
    try {
      lastDataVersion = store.dataVersion();
      sessions = composeSessions(store);
    } catch {}
  }

  function findSession(id: string | null | undefined): InboxSession | undefined {
    return id ? sessions.find((s) => s.id === id) : undefined;
  }

  // ── painting ─────────────────────────────────────────────────────────────

  function paint(win: WinState): void {
    if (!win.stubTty) return;
    const view = renderView(sessions, win, { width: win.width, height: win.height }, Date.now());
    win.scrollTop = view.scrollTop;
    win.visible = view.visible;
    win.rowAtLine = view.rowAtLine;
    const full = !win.modesWritten;
    let out = "";
    if (full) {
      // hide cursor; SGR mouse + focus reporting (arrive back via the relay)
      out += "\x1b[?25l\x1b[?1000h\x1b[?1006h\x1b[?1004h\x1b[2J";
    }
    for (let i = 0; i < view.rows.length; i++) {
      if (!full && win.lastRows[i] === view.rows[i]) continue;
      out += `\x1b[${i + 1};1H\x1b[2K${view.rows[i]}`;
    }
    // lines beyond the new frame (pane shrank): clear them
    if (!full) {
      for (let i = view.rows.length; i < win.lastRows.length; i++) out += `\x1b[${i + 1};1H\x1b[2K`;
    }
    if (!out) return;
    try {
      const fd = openSync(win.stubTty, "w");
      writeSync(fd, out);
      closeSync(fd);
      win.lastRows = view.rows;
      win.modesWritten = true;
    } catch {
      // tty vanished (pane respawned/killed) — re-resolve next topology tick
      win.stubTty = null;
      win.modesWritten = false;
      win.lastRows = [];
    }
  }

  function paintAll(): void {
    for (const win of wins.values()) paint(win);
  }

  function showFlash(win: WinState, msg: string): void {
    win.flash = msg;
    win.flashUntil = Date.now() + 2500;
  }

  // Verbs are single SQLite transactions. Apply, re-read, repaint everywhere.
  function applyVerb(fn: () => boolean): boolean {
    let ok = false;
    try {
      ok = fn();
    } catch {}
    reloadSessions();
    return ok;
  }

  // ── selection ────────────────────────────────────────────────────────────

  function seedSelection(win: WinState): void {
    const from = sessions.find((s) => s.real?.paneId === win.activePaneId);
    if (from && win.visible.some((v) => v.id === from.id)) win.selectedId = from.id;
    else if (!win.visible.some((v) => v.id === win.selectedId)) win.selectedId = win.visible[0]?.id ?? null;
  }

  function move(win: WinState, delta: number): void {
    if (!win.visible.length) return;
    const i = win.visible.findIndex((v) => v.id === win.selectedId);
    const next = Math.min(win.visible.length - 1, Math.max(0, (i === -1 ? 0 : i) + delta));
    win.selectedId = win.visible[next]!.id;
  }

  // J/K: jump between sections. J → first row of the next section; K → first
  // row of this section, or the previous one's if already there.
  function jumpSection(win: WinState, dir: 1 | -1): void {
    const visible = win.visible;
    if (!visible.length) return;
    const i = Math.max(0, visible.findIndex((v) => v.id === win.selectedId));
    const sec = visible[i]!.section;
    if (dir === 1) {
      const next = visible.findIndex((v, j) => j > i && v.section !== sec);
      if (next !== -1) win.selectedId = visible[next]!.id;
    } else {
      const first = visible.findIndex((v) => v.section === sec);
      if (i > first) win.selectedId = visible[first]!.id;
      else if (first > 0) {
        const prevSec = visible[first - 1]!.section;
        win.selectedId = visible[visible.findIndex((v) => v.section === prevSec)]!.id;
      }
    }
  }

  // After a verb the item leaves its list; the cursor falls to the row UNDER
  // it (crossing section borders), else the one above.
  function nextSelectionAfterVerb(win: WinState, id: string): string | null {
    const i = win.visible.findIndex((v) => v.id === id);
    if (i === -1) return win.visible[0]?.id ?? null;
    return win.visible[i + 1]?.id ?? win.visible[i - 1]?.id ?? null;
  }

  // ── tmux actions ─────────────────────────────────────────────────────────

  async function windowOf(paneId: string): Promise<string> {
    try {
      return (await Bun.$`tmux display-message -p -t ${paneId} ${"#{window_id}"}`.quiet().text()).trim();
    } catch {
      return "";
    }
  }

  // After a disposition the VIEW follows the selection: show the next
  // session's window, focused in its sidebar. All in-process — no handoff
  // files, no signals.
  async function followSelection(from: WinState, nextId: string | null): Promise<void> {
    if (!nextId) return;
    const next = findSession(nextId);
    if (!next?.real) return;
    const win = await windowOf(next.real.paneId);
    if (!win || win === from.windowId) return; // already looking at it
    const target = wins.get(win);
    try {
      await Bun.$`tmux select-window -t ${win}`.quiet();
      if (!target?.stubPane) return; // no sidebar there (hidden?) — window shown, done
      target.focused = true;
      target.clickArmed = true;
      target.selectedId = nextId;
      await Bun.$`tmux select-pane -t ${target.stubPane}`.quiet();
      paint(target);
    } catch {}
  }

  // Leave a dying window for the next session's sidebar, selection carried.
  async function handOffTo(nextId: string | null, dyingWin: string): Promise<void> {
    try {
      const next = findSession(nextId);
      let targetWin: string | null = null;
      if (next?.real) targetWin = (await windowOf(next.real.paneId)) || null;
      if (!targetWin || targetWin === dyingWin) {
        const order = [...wins.keys()];
        const i = order.indexOf(dyingWin);
        targetWin =
          [...order.slice(i + 1), ...order.slice(0, i)].find((w) => w !== dyingWin) ?? null;
      }
      if (!targetWin) return;
      await Bun.$`tmux select-window -t ${targetWin}`.quiet();
      const target = wins.get(targetWin);
      if (!target?.stubPane) return;
      target.focused = true;
      target.clickArmed = true;
      if (nextId) target.selectedId = nextId;
      else seedSelection(target);
      await Bun.$`tmux select-pane -t ${target.stubPane}`.quiet();
      paint(target);
    } catch {}
  }

  // snooze/block/done close the pane (a live pane exists only for active
  // work — ADR 0013). When the pane is its window's last work pane, kill the
  // WINDOW — and when that window is the one being SHOWN, navigate away
  // FIRST so the demolition happens off-screen.
  async function killPaneOf(from: WinState, s: InboxSession | undefined, nextId?: string | null): Promise<void> {
    if (!s?.real) return;
    try {
      const win = await windowOf(s.real.paneId);
      if (!win) return;
      const panes = (
        await Bun.$`tmux list-panes -t ${win} -F ${`#{pane_id}${SEP}#{pane_start_command}`}`.quiet().text()
      )
        .trim()
        .split("\n")
        .filter((l) => !l.startsWith(`${s.real!.paneId}${SEP}`) && !l.includes(STUB_MARK));
      if (panes.length === 0) {
        if (win === from.windowId) await handOffTo(nextId ?? null, win);
        wins.delete(win);
        await Bun.$`tmux kill-window -t ${win}`.quiet();
      } else {
        await Bun.$`tmux kill-pane -t ${s.real.paneId}`.quiet();
      }
    } catch {}
  }

  // Enter and click share this. A row whose pane died resumes on demand;
  // re-engaging an ARCHIVED session un-archives into Needs You.
  async function switchTo(win: WinState, s: InboxSession): Promise<void> {
    if (s.archivedAt) {
      applyVerb(() => store.unarchive(s.id, Date.now()));
      showFlash(win, "restored — reopening");
    }
    if (s.real) {
      try {
        await Bun.$`tmux display-message -p -t ${s.real.paneId} ok`.quiet(); // pane alive?
        await Bun.$`tmux select-window -t ${s.real.target}`.quiet();
        await Bun.$`tmux select-pane -t ${s.real.paneId}`.quiet();
      } catch {
        await resumeSession(win, s);
      }
    } else if (s.repoPath) {
      await resumeSession(win, s);
    }
  }

  async function resumeSession(win: WinState, s: InboxSession): Promise<void> {
    try {
      const home = process.env.HOME ?? "/";
      const dir = (await resolveRestoreTarget(s.id, s.repoPath ?? home)) ?? s.repoPath ?? home;
      await Bun.$`tmux new-window -c ${dir} claude -r ${s.id}`.quiet();
      showFlash(win, "pane gone — resuming in new window");
    } catch {
      showFlash(win, "resume failed");
    }
  }

  async function unfocusToPane(win: WinState): Promise<void> {
    cancelPendingFocus(win);
    win.focused = false;
    win.clickArmed = false;
    win.helpVisible = false;
    paint(win);
    try {
      if (win.stubPane) await Bun.$`tmux select-pane -l -t ${win.stubPane}`.quiet();
    } catch {}
  }

  // Focus that arrives WITHOUT an explanation (focus-in escape) may be a
  // click still in flight — the terminal sends focus-in before the mouse
  // sequence. Defer the first chrome paint one beat; anything that knows
  // better (click, M-s, keypress) cancels and paints itself.
  function gainFocusSoon(win: WinState): void {
    if (win.focused || win.focusPending) return;
    win.focusPending = setTimeout(() => {
      win.focusPending = null;
      win.focused = true;
      seedSelection(win);
      paint(win);
    }, 80);
  }

  function cancelPendingFocus(win: WinState): void {
    if (win.focusPending) {
      clearTimeout(win.focusPending);
      win.focusPending = null;
    }
  }

  // ── verbs / keys (port of the prototype keypress handler) ───────────────

  const VERBS: Record<string, string[]> = {
    "needs-you": ["s", "b", "e"],
    running: ["e"],
    parked: ["s", "b", "e"],
    done: ["e"],
  };

  async function handleKey(win: WinState, ev: { name: string; ch?: string; shift?: boolean; ctrl?: boolean }): Promise<void> {
    win.clickArmed = true;

    // first key after regaining focus only reveals the cursor — a blind
    // "M-s, e" used to archive whatever was selected on the LAST visit
    if (!win.focused) {
      cancelPendingFocus(win);
      win.focused = true;
      seedSelection(win);
      paint(win);
      return;
    }

    if (ev.name !== "e") win.confirmKillId = null;

    // inline block-note input: free typing until ↵ commits / esc cancels
    if (win.blockNoteFor) {
      const id = win.blockNoteFor;
      if (ev.name === "escape") {
        win.blockNoteFor = null;
        paint(win);
        return;
      }
      if (ev.name === "enter") {
        win.blockNoteFor = null;
        const note = win.blockNote.trim() || "waiting on external";
        const prev = win.selectedId;
        win.selectedId = nextSelectionAfterVerb(win, id);
        const target = findSession(id);
        const ok = applyVerb(() => store.block(id, note, Date.now()));
        if (ok) {
          await killPaneOf(win, target, win.selectedId);
          showFlash(win, `blocked${target?.real ? " — pane closed" : ""}`);
          paintAll();
          await followSelection(win, win.selectedId);
        } else {
          win.selectedId = prev;
          showFlash(win, "gone — nothing blocked");
          paint(win);
        }
        return;
      }
      if (ev.name === "backspace") {
        win.blockNote = win.blockNote.slice(0, -1);
        paint(win);
        return;
      }
      if (ev.ch && !ev.ctrl && ev.ch.length === 1 && ev.ch >= " ") {
        win.blockNote += ev.ch;
        paint(win);
      }
      return;
    }

    // ? overlay: deliberate close only (? / q / esc); other keys inert
    if (win.helpVisible) {
      if (ev.ch === "?" || ev.name === "q" || ev.name === "escape") {
        win.helpVisible = false;
        paint(win);
      }
      return;
    }
    if (ev.ch === "?" && !win.snoozeMenuFor) {
      win.helpVisible = true;
      paint(win);
      return;
    }

    if (win.snoozeMenuFor) {
      // digits-then-unit, unit commits instantly: "16h", "3d"; digits REQUIRED
      const id = win.snoozeMenuFor;
      if (ev.name === "q") {
        win.snoozeMenuFor = null;
        win.snoozeDigits = "";
        await unfocusToPane(win);
        return;
      }
      if (/^[0-9]$/.test(ev.ch ?? "") && win.snoozeDigits.length < 3) {
        win.snoozeDigits += ev.ch;
        paint(win);
        return;
      }
      if (ev.name === "backspace") {
        win.snoozeDigits = win.snoozeDigits.slice(0, -1);
        paint(win);
        return;
      }
      if (ev.ch === "h" || ev.ch === "d") {
        if (win.snoozeDigits === "") {
          showFlash(win, "amount first — e.g. 16h, 3d");
          paint(win);
          return;
        }
        const unit = ev.ch;
        const n = Number(win.snoozeDigits);
        win.snoozeMenuFor = null;
        win.snoozeDigits = "";
        if (n >= 1) {
          const prev = win.selectedId;
          if (win.selectedId === id) win.selectedId = nextSelectionAfterVerb(win, id);
          const target = findSession(id);
          const ok = applyVerb(() => store.snooze(id, wakeAt(Date.now(), n, unit), Date.now()));
          if (ok) {
            await killPaneOf(win, target, win.selectedId);
            showFlash(win, `snoozed ${n}${unit}${target?.real ? " — pane closed" : ""}`);
            paintAll();
            await followSelection(win, win.selectedId);
            return;
          }
          win.selectedId = prev;
          showFlash(win, "gone — nothing snoozed");
        }
        paint(win);
        return;
      }
      win.snoozeMenuFor = null;
      win.snoozeDigits = "";
      paint(win);
      return;
    }

    const row = win.visible.find((v) => v.id === win.selectedId);
    const verb = ["s", "b", "e"].includes(ev.name) && !ev.shift ? ev.name : null;
    if (verb && row && !VERBS[row.section]!.includes(verb)) {
      showFlash(win, row.section === "done" ? "archived — read-only" : `no '${verb}' here`);
      paint(win);
      return;
    }

    switch (ev.name) {
      case "j":
      case "down":
        ev.shift ? jumpSection(win, 1) : move(win, 1);
        paint(win);
        break;
      case "k":
      case "up":
        ev.shift ? jumpSection(win, -1) : move(win, -1);
        paint(win);
        break;
      case "g": {
        if (!win.visible.length) break;
        win.selectedId = ev.shift ? win.visible[win.visible.length - 1]!.id : win.visible[0]!.id;
        paint(win);
        break;
      }
      case "enter": {
        const s = findSession(row?.id);
        if (s) await switchTo(win, s);
        paint(win);
        break;
      }
      case "f": {
        // fork, TUI parity — beside the parent; works on any real row,
        // RECENT included.
        const s = findSession(row?.id);
        if (s && (s.repoPath || s.real)) {
          try {
            const home = process.env.HOME ?? "/";
            const dir = (await resolveRestoreTarget(s.id, s.repoPath ?? home)) ?? s.repoPath ?? home;
            const parentWin = s.real ? await windowOf(s.real.paneId) : "";
            if (parentWin) {
              await Bun.$`tmux new-window -a -t ${parentWin} -c ${dir} claude -r ${s.id} --fork-session`.quiet();
            } else {
              await Bun.$`tmux new-window -c ${dir} claude -r ${s.id} --fork-session`.quiet();
            }
            showFlash(win, "forked → new window");
          } catch {
            showFlash(win, "fork failed");
          }
        }
        paint(win);
        break;
      }
      case "s": {
        if (row) {
          win.snoozeMenuFor = row.id;
          paint(win);
        }
        break;
      }
      case "b": {
        if (!row) break;
        // on a PARKED row, b is the undo: unpark, reopen, back into Needs You
        if (row.section === "parked") {
          const s = findSession(row.id);
          const was = applyVerb(() => store.clearDisposition(row.id, Date.now(), "manual") !== null);
          if (was && s) {
            showFlash(win, "unparked — reopening");
            await switchTo(win, s); // dead pane (dispositions kill) → resumes
          } else showFlash(win, "gone — nothing to unpark");
          paintAll();
          break;
        }
        win.blockNoteFor = row.id;
        win.blockNote = "";
        paint(win);
        break;
      }
      case "e": {
        if (!row) break;
        // RECENT: e toggles — undo done, back to Needs you
        if (row.section === "done") {
          const prev = win.selectedId;
          win.selectedId = nextSelectionAfterVerb(win, row.id);
          const ok = applyVerb(() => store.unarchive(row.id, Date.now()));
          if (ok) showFlash(win, "restored — needs you");
          else {
            win.selectedId = prev;
            showFlash(win, "gone — nothing to restore");
          }
          paintAll();
          break;
        }
        // done closes the pane. RUNNING keeps the double-tap — killing a
        // mid-turn Claude throws away in-flight work.
        const s = findSession(row.id);
        const willKill = !!s?.real;
        if (row.section === "running" && willKill && win.confirmKillId !== row.id) {
          win.confirmKillId = row.id;
          showFlash(win, "e again — done + close pane (mid-turn!)");
          paint(win);
          break;
        }
        win.confirmKillId = null;
        // advance the cursor NOW — the next rapid keypress must aim at the
        // next row, not re-target this one while the mutate is in flight
        const prev = win.selectedId;
        win.selectedId = nextSelectionAfterVerb(win, row.id);
        const ok = applyVerb(() => store.archive(row.id, Date.now()));
        if (ok) {
          if (willKill && s?.real) {
            await killPaneOf(win, s, win.selectedId);
            showFlash(win, "done — pane closed");
          } else showFlash(win, "archived");
          paintAll();
          await followSelection(win, win.selectedId);
          break;
        }
        win.selectedId = prev;
        showFlash(win, "gone — nothing archived");
        paint(win);
        break;
      }
      case "q":
      case "escape":
        await unfocusToPane(win);
        break;
    }
  }

  async function handleEvent(win: WinState, ev: InputEvent): Promise<void> {
    if (ev.type === "focus") {
      if (ev.in) gainFocusSoon(win);
      else {
        cancelPendingFocus(win);
        win.focused = false;
        win.clickArmed = false;
        win.helpVisible = false;
        win.blockNoteFor = null;
        // selection deliberately kept — invisible unfocused, re-seeded on gain
        paint(win);
      }
      return;
    }
    if (ev.type === "wheel") {
      win.scrollTop = Math.max(0, win.scrollTop + ev.dir * 2);
      paint(win);
      return;
    }
    if (ev.type === "click") {
      const line = ev.y - 1 + win.scrollTop;
      const id = win.rowAtLine[line];
      // select-then-commit: first click focuses + highlights; a click on a
      // non-highlighted row moves the highlight; the highlighted row commits
      if (!win.focused || !win.clickArmed) {
        cancelPendingFocus(win); // the click IS the focus event
        win.focused = true;
        win.clickArmed = true;
        if (id && win.visible.some((v) => v.id === id)) win.selectedId = id;
        else seedSelection(win);
        paint(win);
        return;
      }
      const s = findSession(id);
      if (!s) return;
      if (win.selectedId === s.id) await switchTo(win, s);
      else win.selectedId = s.id;
      paint(win);
      return;
    }
    await handleKey(win, ev);
  }

  // ── control (M-s / M-S via `csm sidebar-ctl`) ───────────────────────────

  async function ctlFocus(invokerPane: string): Promise<void> {
    const winId = await windowOf(invokerPane);
    const win = wins.get(winId);
    if (!win?.stubPane) return;
    if (invokerPane === win.stubPane) {
      await unfocusToPane(win); // M-s from the sidebar = toggle back out
      return;
    }
    // select the pane FIRST — the topology tick reads pane_active as the
    // focus fallback, and painting chrome before the move lets a tick land
    // in between and blur it right back
    try {
      await Bun.$`tmux select-pane -t ${win.stubPane}`.quiet();
    } catch {}
    cancelPendingFocus(win);
    win.focused = true;
    win.clickArmed = true;
    reloadSessions();
    const from = sessions.find((s) => s.real?.paneId === invokerPane);
    if (from) win.selectedId = from.id;
    else seedSelection(win);
    paint(win);
  }

  async function ctlToggle(invokerPane: string): Promise<void> {
    if (await Bun.file(HIDDEN).exists()) {
      // show: current window's sidebar first, focused; ensure() fills the rest
      try {
        await Bun.$`rm -f ${HIDDEN}`.quiet();
      } catch {}
      const winId = await windowOf(invokerPane);
      await ensure(winId || undefined);
      const win = wins.get(winId);
      if (win?.stubPane) {
        win.focused = true;
        win.clickArmed = true;
        seedSelection(win);
        paint(win);
        try {
          await Bun.$`tmux select-pane -t ${win.stubPane}`.quiet();
        } catch {}
      }
    } else {
      await Bun.write(HIDDEN, "");
      for (const win of wins.values()) {
        if (win.stubPane) {
          try {
            await Bun.$`tmux kill-pane -t ${win.stubPane}`.quiet();
          } catch {}
        }
      }
      wins.clear();
      paneToWin.clear();
    }
  }

  // ── topology + ensure ────────────────────────────────────────────────────

  interface PaneRow {
    windowId: string;
    paneId: string;
    left: number;
    width: number;
    height: number;
    paneActive: boolean;
    windowActive: boolean;
    tty: string;
    startCmd: string;
    currentCmd: string;
  }

  async function listAllPanes(): Promise<PaneRow[]> {
    const fmt = ["#{window_id}", "#{pane_id}", "#{pane_left}", "#{pane_width}", "#{pane_height}", "#{pane_active}", "#{window_active}", "#{pane_tty}", "#{pane_current_command}", "#{pane_start_command}"].join(SEP);
    const out = (await Bun.$`tmux list-panes -a -F ${fmt}`.quiet().text()).trim();
    if (!out) return [];
    return out.split("\n").map((l) => {
      const parts = l.split(SEP);
      const [windowId, paneId, left, width, height, pa, wa, tty, currentCmd] = parts;
      return {
        windowId: windowId!,
        paneId: paneId!,
        left: Number(left),
        width: Number(width),
        height: Number(height),
        paneActive: pa === "1",
        windowActive: wa === "1",
        tty: tty ?? "",
        // start_command is free text — it goes last and swallows any SEP hits
        startCmd: parts.slice(9).join(SEP),
        currentCmd: currentCmd ?? "",
      };
    });
  }

  /**
   * Resurrect restores stub panes as bare shells (left=0, thin, no
   * start_command, idle shell) — reclaim them so ensure() can split real
   * stubs. Ports the prototype's corpse detection.
   */
  async function reclaimCorpses(panes: PaneRow[]): Promise<void> {
    const suspects = panes.filter(
      (p) =>
        p.left === 0 &&
        p.width <= 60 &&
        !p.startCmd &&
        /^(zsh|bash|fish|sh)$/.test(p.currentCmd) &&
        panes.filter((q) => q.windowId === p.windowId).length > 1,
    );
    if (!suspects.length) return;
    try {
      // one ps pass: a corpse shell has no children
      const ppids = new Set(
        (await Bun.$`ps -ax -o ppid=`.quiet().text()).trim().split("\n").map((s) => s.trim()),
      );
      const pids = (
        await Bun.$`tmux list-panes -a -F ${`#{pane_id}${SEP}#{pane_pid}`}`.quiet().text()
      )
        .trim()
        .split("\n")
        .reduce((m, l) => {
          const [pane, pid] = l.split(SEP);
          if (pane && pid) m.set(pane, pid);
          return m;
        }, new Map<string, string>());
      for (const p of suspects) {
        const pid = pids.get(p.paneId);
        if (pid && !ppids.has(pid)) {
          try {
            await Bun.$`tmux kill-pane -t ${p.paneId}`.quiet();
          } catch {}
        }
      }
    } catch {}
  }

  async function ensure(onlyWindow?: string): Promise<void> {
    const panes = await listAllPanes();
    await reclaimCorpses(panes);
    const byWindow = new Map<string, PaneRow[]>();
    for (const p of panes) {
      if (!byWindow.has(p.windowId)) byWindow.set(p.windowId, []);
      byWindow.get(p.windowId)!.push(p);
    }
    await Promise.all(
      [...byWindow.entries()].map(async ([winId, winPanes]) => {
        if (onlyWindow && winId !== onlyWindow) return;
        const stubs = winPanes.filter((p) => p.startCmd.includes(STUB_MARK));
        const work = winPanes.filter((p) => !p.startCmd.includes(STUB_MARK));
        try {
          // a window that is ONLY sidebar (work pane closed) dies naturally —
          // grace period covers the split-window creation race
          if (work.length === 0 && stubs.length) {
            const win = wins.get(winId);
            if (!win || Date.now() - win.stubBornAt > 3000) {
              wins.delete(winId);
              await Bun.$`tmux kill-window -t ${winId}`.quiet();
            }
            return;
          }
          // dedupe: keep the leftmost stub
          for (const extra of stubs.slice(1)) {
            await Bun.$`tmux kill-pane -t ${extra.paneId}`.quiet();
          }
          let stub: PaneRow | undefined = stubs.find((p) => p.left === 0) ?? stubs[0];
          if (stub && stub.left !== 0) {
            await Bun.$`tmux kill-pane -t ${stub.paneId}`.quiet();
            stub = undefined;
          }
          if (!stub) {
            const created = (
              await Bun.$`tmux split-window -f -h -b -d -l ${COLS} -t ${winId} -P -F ${`#{pane_id}${SEP}#{pane_tty}`} ${STUB_CMD}`
                .quiet()
                .text()
            )
              .trim()
              .split(SEP);
            const win = wins.get(winId) ?? freshWin(winId);
            win.stubPane = created[0] ?? null;
            win.stubTty = created[1] ?? null;
            win.stubBornAt = Date.now();
            win.modesWritten = false;
            win.lastRows = [];
            wins.set(winId, win);
            if (win.stubPane) paneToWin.set(win.stubPane, winId);
          } else if (stub.width !== COLS) {
            await Bun.$`tmux resize-pane -t ${stub.paneId} -x ${COLS}`.quiet();
          }
        } catch (e) {
          console.error(`[sidebar] ensure ${winId} failed:`, (e as { stderr?: Buffer }).stderr?.toString() ?? e);
        }
      }),
    );
  }

  function syncTopology(panes: PaneRow[]): void {
    const seen = new Set<string>();
    const byWindow = new Map<string, PaneRow[]>();
    for (const p of panes) {
      if (!byWindow.has(p.windowId)) byWindow.set(p.windowId, []);
      byWindow.get(p.windowId)!.push(p);
    }
    for (const [winId, winPanes] of byWindow) {
      const stub = winPanes.find((p) => p.startCmd.includes(STUB_MARK));
      if (!stub) continue;
      seen.add(winId);
      const win = wins.get(winId) ?? freshWin(winId);
      wins.set(winId, win);
      if (win.stubPane !== stub.paneId || win.stubTty !== stub.tty) {
        // new/respawned stub (new tty) — full repaint
        if (win.stubPane) paneToWin.delete(win.stubPane);
        win.stubPane = stub.paneId;
        win.stubTty = stub.tty;
        win.modesWritten = false;
        win.lastRows = [];
        paneToWin.set(stub.paneId, winId);
      }
      if (win.width !== stub.width || win.height !== stub.height) {
        win.width = stub.width;
        win.height = stub.height;
        win.modesWritten = false; // repaint full frame at the new size
        win.lastRows = [];
      }
      // pin: this window's active WORK pane (survives a visit to the sidebar)
      const activeWork = winPanes.find((p) => p.paneActive && !p.startCmd.includes(STUB_MARK));
      if (activeWork) win.activePaneId = activeWork.paneId;
      // focus fallback (focus escapes are the fast path): sidebar pane active
      // in the active window ⇔ focused
      const nowFocused = stub.paneActive && stub.windowActive;
      if (win.focused && !nowFocused) {
        win.focused = false;
        win.clickArmed = false;
        win.helpVisible = false;
        win.blockNoteFor = null;
      } else if (!win.focused && nowFocused) {
        gainFocusSoon(win);
      }
    }
    for (const [winId, win] of wins) {
      if (!seen.has(winId)) {
        if (win.stubPane) paneToWin.delete(win.stubPane);
        wins.delete(winId);
      }
    }
  }

  // ── input socket ─────────────────────────────────────────────────────────

  try {
    require("node:fs").rmSync(SIDEBAR_SOCK, { force: true });
  } catch {}
  // Protocol: one greeting line, then raw bytes. A stub sends `hello <pane>`
  // and every subsequent byte is that pane's stdin verbatim (nc can't frame);
  // `csm sidebar-ctl` connections send a single `focus <pane>` / `toggle
  // <pane>` line and close.
  function feedInput(paneId: string, bytes: string): void {
    const winId = paneToWin.get(paneId);
    const win = winId ? wins.get(winId) : undefined;
    if (!win) return;
    for (const ev of parseInput(bytes)) void handleEvent(win, ev);
  }

  Bun.listen<{ paneId?: string; buf: string; greeted: boolean }>({
    unix: SIDEBAR_SOCK,
    socket: {
      open(sock) {
        sock.data = { buf: "", greeted: false };
      },
      data(sock, chunk) {
        if (sock.data.greeted) {
          if (sock.data.paneId) feedInput(sock.data.paneId, chunk.toString());
          return;
        }
        sock.data.buf += chunk.toString();
        const nl = sock.data.buf.indexOf("\n");
        if (nl === -1) return;
        const line = sock.data.buf.slice(0, nl).trim();
        const rest = sock.data.buf.slice(nl + 1);
        sock.data.buf = "";
        sock.data.greeted = true;
        const [cmd, arg] = line.split(" ");
        if (cmd === "hello" && arg) {
          sock.data.paneId = arg;
          if (rest) feedInput(arg, rest);
        } else if (cmd === "focus" && arg) {
          void ctlFocus(arg);
        } else if (cmd === "toggle" && arg) {
          void ctlToggle(arg);
        }
      },
      error() {},
      close() {},
    },
  });

  // ── tmux wiring (bindings + bounce hook) ────────────────────────────────
  //
  // Installed on every stand-up, idempotently: tmux server state dies with
  // the server, and the daemon outliving it is exactly the point — a fresh
  // server gets rebound within a tick, no tmux.conf hook needed. The
  // after-new-window hook the prototype needed is gone too: ensure() splits
  // a missing stub within a second.
  async function installTmuxWiring(): Promise<void> {
    const ctl = (cmd: string) =>
      `${process.execPath} ${process.argv[1]} sidebar-ctl ${cmd} '#{pane_id}'`;
    try {
      await Bun.$`tmux bind-key -n M-s run-shell ${ctl("focus")}`.quiet();
      await Bun.$`tmux bind-key -n M-S run-shell ${ctl("toggle")}`.quiet();
      // cycling windows never lands you inside a sidebar — bounce to the pane
      // right of it (pure tmux, alt+[ / ] untouched)
      await Bun.$`tmux set-hook -g after-select-window ${`if -F "#{&&:#{m:*${STUB_MARK}*,#{pane_start_command}},#{e|>:#{window_panes},1}}" "select-pane -t '{right-of}'"`}`.quiet();
    } catch {}
  }

  // ── main loop ────────────────────────────────────────────────────────────

  reloadSessions();
  let tickCount = 0;
  let phase = "idle"; // what the tick was doing — named by the watchdog on a hang

  async function tick(): Promise<void> {
    tickCount++;
    // stand down while the prototype chassis owns the panes or M-S hides them
    phase = "gate";
    const active =
      (await Bun.file(AUTOSTART).exists()) &&
      !(await Bun.file(HIDDEN).exists()) &&
      !(await prototypeRefresherAlive());
    if (!active) {
      if (standing) console.error("[sidebar] standing down (markers/prototype)");
      standing = false;
      return;
    }
    const firstTick = !standing;
    standing = true;
    if (firstTick) console.error("[sidebar] standing up");
    // periodic re-install, not just first tick: a tmux SERVER restart wipes
    // bindings while the daemon (and its `standing` flag) live on
    phase = "wiring";
    if (firstTick || tickCount % 30 === 0) await installTmuxWiring();
    phase = "ensure";
    await ensure();
    phase = "topology";
    syncTopology(await listAllPanes());

    phase = "store";
    try {
      const dv = store.dataVersion();
      if (dv !== lastDataVersion) reloadSessions();
    } catch {}
    const minute = Math.floor(Date.now() / 60_000);
    if (minute !== lastMinute) lastMinute = minute;
    // paint() diffs per line, so ticking every second is cheap
    phase = "paint";
    paintAll();
    phase = "idle";
  }

  // Self-scheduling loop, NOT setInterval: Bun's setInterval waits for an
  // async callback's promise, so one hung tmux call would freeze rendering
  // forever (while the daemon's other loops live on). The watchdog races
  // every tick; a hang logs the phase it died in and the loop keeps going.
  (async () => {
    while (true) {
      try {
        await Promise.race([
          tick(),
          Bun.sleep(10_000).then(() => {
            throw new Error(`watchdog: tick hung in phase '${phase}'`);
          }),
        ]);
      } catch (e) {
        console.error("[sidebar] tick failed:", e);
      }
      await Bun.sleep(1000);
    }
  })();
}
