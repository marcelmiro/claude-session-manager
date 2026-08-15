# Verification — linux-vm-migration

End-to-end acceptance, run by a human. Scenarios 1–3 run on the Mac before cutover (cross-platform guarantee); 4–10 run against the VM during/after inc-5. Every scenario targets a site that fails *silently* — "looks fine" is not a pass.

## 1. Darwin behavior unchanged (pre-cutover gate, after inc-1..3)
GIVEN the Mac setup running inc-1..3 code
WHEN a session goes running→waiting with Ghostty frontmost on that pane
THEN no ⚡ is raised and no push is sent (unchanged), AND with Ghostty NOT frontmost the ⚡ + phone push arrive (unchanged), AND `Space→c` still copies via pbcopy, AND a phone-held AskUserQuestion still releases to the native picker on refocus.

## 2. Portability fixes observable on the Mac
GIVEN inc-1 merged
WHEN `bun test` runs and a session drives a `run_in_background` script
THEN the ⏳ prefix and portkey pill behave exactly as before (lsof resolution regression check).

## 3. OSC 52 framing
GIVEN inc-3 merged
WHEN the clipboard unit tests run
THEN the emitted sequences match the spec exactly (DCS-wrapped inside `$TMUX`, doubled ESC, `ESC \` close), including the >90KB refusal path.

## 4. VM foundation (after inc-4 + provision)
GIVEN a freshly provisioned VM and a reboot
WHEN the user has NOT yet SSHed in
THEN `systemctl --user status tmux csm-bridge` (via `ssh vm systemctl --user …`) shows both active, `tailscale serve status` shows 8473 proxied, and `POST /auth` from the phone returns 200 — i.e., the box came back with no human touch.

## 5. Presence — the five silent sites (on the VM)
GIVEN a Claude session running on the VM with the Mac attached over Mosh/SSH
WHEN the user is actively typing and the session turns ready
THEN no phone push arrives and ⚡ auto-clears on the focused window;
WHEN the Mac is closed (no activity > 60s) and another session turns waiting
THEN ⚡ appears, the phone push arrives, and `csm next` from a fresh attach lands on it;
WHEN an AskUserQuestion fires while the phone drove the turn and no client is active
THEN the question is held and answerable from portkey, AND resumes the native picker within ~15s of the user typing at the Mac again.

## 6. Approval flow inversion check (on the VM)
GIVEN the steady state of a permanently-attached but idle (>60s) SSH client
WHEN Claude requests an Edit approval on a phone-driven session
THEN the hook block-polls for the phone decision (does NOT fall through to the desk prompt merely because a client is attached) — the pre-cutover behavior would have failed this.

## 7. Cutover integrity
GIVEN the runbook executed
WHEN the user opens portkey on the phone at the new ts.net origin
THEN previously-active sessions are listed with correct repos/names (names.json carried), an archived session resumes by tap (transcript paths valid — D10 home-dir check), and a test push round-trips after re-subscribe.

## 8. Reboot durability with live sessions
GIVEN 3+ live Claude sessions in tmux on the VM
WHEN the VM is deliberately rebooted
THEN after boot, tmux is back with the layout restored and each pane resumed its session via `csm restore-sessions` (`claude --resume` visible in each), with no duplicate claude processes per pane.

## 9. Clipboard over the wire
GIVEN the Mac attached to VM tmux through Mosh (and separately through plain SSH)
WHEN `Space→c` fires on a session with preview text
THEN the text is in the macOS clipboard (Ghostty `clipboard-write=allow`, tmux `set-clipboard on` + `allow-passthrough on` all proven in one go).

## 10. Backup failure is loud (after inc-6)
GIVEN the DLM policies active and the snapshot-staleness timer running
WHEN the 4-hourly DLM policy is suspended on purpose
THEN a push notification reaches the phone once the latest snapshot exceeds the staleness window, AND (separately) a volume restored from the most recent snapshot mounts and one repo diff-matches the live tree.
