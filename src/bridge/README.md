# CSM Bridge — mobile access

A thin `Bun.serve` HTTP/SSE server (`server.ts`) that exposes the headless
`core/` API + a no-build web page (`public/`) so you can drive Claude sessions
from an iPhone over Tailscale. Launched with `csm bridge`.

## Connect from your phone

### 1. Run the bridge on the Mac

Bind to **loopback** (the default) and keep the Mac awake:

```sh
caffeinate -s env CSM_BRIDGE_TOKEN=<your-token> csm bridge
# prints: csm bridge listening on http://127.0.0.1:8473
```

Generate a token once with `openssl rand -hex 32`. The bridge **refuses to start**
without `CSM_BRIDGE_TOKEN`, or if bound to a non-loopback / non-tailnet address.

### 2. Expose it over Tailscale with `tailscale serve`

macOS Tailscale runs in userspace mode and will **not** deliver inbound TCP to a
service bound on the tailnet IP — so don't set `CSM_BRIDGE_HOST=100.x`. Instead
proxy through tailscaled, which holds the tunnel:

```sh
tailscale serve --bg --http=8473 http://127.0.0.1:8473
tailscale serve status          # shows the tailnet URL
tailscale serve --http=8473 off # tear down
```

(GUI-app CLI lives at `/Applications/Tailscale.app/Contents/MacOS/Tailscale`.)

### 3. Open it in mobile Safari

Both devices on the same tailnet, then load the **MagicDNS hostname** (not the
`100.x` IP), typing `http://` explicitly so Safari doesn't hang trying HTTPS:

```
http://<your-mac>.<tailnet>.ts.net:8473/
```

Paste the token into the field → **Connect**. You'll see the live session list.

## Using it

- **List** — sessions grouped by repo, status dots, live via SSE (no refresh).
  Archived sessions are hidden behind a "Show N archived" toggle. A session blocked
  on a question/tool shows a peach `⏸` and sorts to the top — even if discovery
  mislabels it archived — so you can always reach it to answer.
- **Tap a session** — transcript as a chat thread (auto-scrolled to the newest turn).
  Assistant messages are **markdown-rendered** (code blocks, lists, links — raw HTML
  escaped first); user messages stay literal. A status/usage sub-row under the title
  shows the live status dot and **context-window usage** (`current/size · pct%`),
  colored at the same 50/75% thresholds as the Mac statusline.
- **Navigate sessions** — `↑`/`↓` in the header step to the previous/next session in
  list order; a horizontal **swipe** does the same (left → next, right → prev). `‹`
  returns to the list.
- **Approve / answer / send** — a docked bottom bar swaps by state: a tool prompt
  shows Allow/Deny, an open `AskUserQuestion` shows answer chips, otherwise a
  free-text composer. The result (`✓` / `✗ reason`) is shown inline. All three need a
  **live tmux pane on the Mac**; free-text send works in any state (TUI parity — keys
  go to the pane, and Claude queues input while running), shown immediately as an
  optimistic bubble until the transcript catches up.
- **Names** — each session shows its tmux-style AI name (shared `names.json` cache).
  Unnamed coding sessions are named in the background (`claude -p`, lock-coordinated
  with the monitor); non-coding/trivial sessions fall back to a summary snippet.

## Local development & testing

Run the bridge on the Mac without a phone — bind loopback with a throwaway token:

```sh
CSM_BRIDGE_TOKEN=test CSM_BRIDGE_HOST=127.0.0.1 CSM_BRIDGE_PORT=8479 \
  bun run bin/csm.ts bridge
```

**Hit the API.** The static shell (`/`, `/app.js`, vendor) is public; everything else
needs the cookie. Exchange the token once into a cookie jar, then reuse it:

```sh
curl -s http://127.0.0.1:8479/                                   # static shell + CSS (no auth)
curl -s -c /tmp/jar -X POST http://127.0.0.1:8479/auth \
  -H 'content-type: application/json' -d '{"token":"test"}'
curl -s -b /tmp/jar http://127.0.0.1:8479/sessions               # real core/ data, authed
curl -s -b /tmp/jar "http://127.0.0.1:8479/sessions/<id>/transcript?since=0"
```

**Fixtures mode** — set `CSM_BRIDGE_FIXTURES=1` to serve canned, deterministic data
(`fixtures.ts`: every status tier, a markdown turn, a tool chip, an open question)
instead of querying `core/`. Lets the UI render with no live sessions — ideal for
layout/CSS work. Auth + static serving stay real; only the data is faked:

```sh
CSM_BRIDGE_TOKEN=test CSM_BRIDGE_FIXTURES=1 bun run bin/csm.ts bridge
```

**Screenshots** — `bun run shoot` boots the bridge in fixtures mode, drives headless
Chrome over the DevTools Protocol, and writes `login.png` / `list.png` / `detail.png`
(iPhone viewport) so you can visually verify changes without a device:

```sh
bun run shoot --out /tmp/csm-shots      # needs Google Chrome (or set CHROME=/path/to/chrome)
```

It sets the auth cookie via CDP (which bypasses `HttpOnly`), navigates, and captures each
screen; `--keep` leaves the bridge + Chrome up for poking around. Flags: `--port`,
`--cdp-port`, `--out`.

## Config

| Env var | Default | Notes |
|---------|---------|-------|
| `CSM_BRIDGE_TOKEN` | — | **Required.** Exchanged once via `POST /auth` for an `HttpOnly` cookie; never rides in a URL. |
| `CSM_BRIDGE_HOST` | `127.0.0.1` | Fail-closed to loopback / tailnet (`100.64.0.0/10`). Keep `127.0.0.1` when using `tailscale serve`. |
| `CSM_BRIDGE_PORT` | `8473` | |
| `CSM_BRIDGE_FIXTURES` | — | Dev/test only: serve canned data (`fixtures.ts`) instead of `core/`. See [Local development & testing](#local-development--testing). |

## Notes

- **HTTPS (optional, nicer):** enable *HTTPS Certificates* in the Tailscale admin
  DNS page, then `tailscale serve --bg https://+:443 http://127.0.0.1:8473` for a
  padlocked `https://<mac>.<tailnet>.ts.net/` with no port.
- **Plain HTTP over the tailnet is fine** for the MVP — the tailnet is the
  encrypted transport and the wall; the token is defense-in-depth.
- The bridge is a foreground/background process — it does **not** survive reboot
  yet. Wrap it in a launchd agent or a persistent tmux window to make it durable.
