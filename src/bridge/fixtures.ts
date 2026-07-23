/**
 * Deterministic fixture data for the bridge UI — enabled by CSM_BRIDGE_FIXTURES.
 *
 * When set, server.ts serves these canned payloads instead of querying `core/`, so the
 * web app renders stable, representative content (every status, a markdown turn, a tool
 * chip, an open question) without any live tmux sessions. Used by `scripts/shoot.ts` to
 * screenshot the UI and by anyone testing layout/CSS headlessly. Auth + static serving
 * stay real; ONLY the data is faked.
 */

// Relative timestamps so the list shows natural ages (2m, 40s, 3h…) whenever it runs.
const ago = (ms: number) => new Date(Date.now() - ms).toISOString();

// Projected session shape — mirrors projectSession() in server.ts. Covers every status
// tier; the blocked (waiting + question + unread) session sorts to the top with a glow.
export const FIXTURE_SESSIONS = [
  {
    id: "fix-auth",
    repo: "csm",
    branch: "eng-2687-cookie-auth",
    status: "waiting",
    name: "cookie-auth",
    label: "ENG-2687 · cookie-auth",
    pending: "question",
    unread: true,
    contextPercent: 62,
    messageCount: 14,
    summary: "Switch the bridge token to an HttpOnly cookie",
    statusSource: "fixture",
    modified: ago(2 * 60_000),
  },
  {
    id: "api-refactor",
    repo: "csm",
    branch: "refactor-session-api",
    status: "running",
    name: "session-api",
    label: "refactor-session-api",
    pending: null,
    unread: false,
    contextPercent: 38,
    messageCount: 9,
    summary: "Extract session-api helpers from sessions.ts",
    statusSource: "fixture",
    modified: ago(40_000),
  },
  {
    id: "docs-pass",
    repo: "csm",
    branch: "main",
    status: "ready",
    name: "docs-pass",
    label: "docs-pass",
    pending: null,
    unread: false,
    contextPercent: 12,
    messageCount: 4,
    summary: "Tighten the README wording",
    statusSource: "fixture",
    modified: ago(11 * 60_000),
    // Reads ready but waits on a background script → inline ⏳ after the name,
    // counted into the header's 🔄 chip.
    pendingScripts: 1,
  },
  {
    id: "ingest",
    repo: "throxy",
    branch: "main",
    status: "idle",
    name: "ingest",
    label: "ingest",
    pending: null,
    unread: false,
    contextPercent: 4,
    messageCount: 2,
    summary: "Batch ingest pipeline",
    statusSource: "fixture",
    modified: ago(3 * 3_600_000),
  },
  {
    id: "old-thing",
    repo: "throxy",
    branch: "spike-old",
    status: "archived",
    name: "spike",
    label: "spike-old",
    pending: null,
    unread: false,
    contextPercent: 0,
    messageCount: 1,
    summary: "Old spike, parked",
    statusSource: "fixture",
    modified: ago(5 * 86_400_000),
  },
];

// Transcript shape — mirrors getTranscript() plus the approval/statusline spread the
// /transcript route adds. Exercises a user bubble, a markdown assistant bubble (code +
// list), a tool chip, and an open AskUserQuestion (so the question card + its tags show).
export const FIXTURE_TRANSCRIPT = {
  turns: [
    {
      role: "user",
      content: [{ type: "text", text: "Can you switch the bridge token to an HttpOnly cookie?" }],
    },
    {
      role: "assistant",
      content: [
        {
          type: "text",
          text: [
            "Here's the plan:",
            "",
            "1. Exchange the token **once** via `POST /auth`",
            "2. Set an `HttpOnly` cookie so JS never touches it",
            "3. Gate every other route on the cookie",
            "",
            "```ts",
            'res.headers.set("set-cookie", `csm=${tok}; HttpOnly; SameSite=Strict`);',
            "```",
            "",
            "Wiring it up now.",
          ].join("\n"),
        },
        { type: "tool_use", name: "Edit", input: { file_path: "src/bridge/server.ts" } },
      ],
    },
    { role: "user", content: [{ type: "text", text: "looks good — ship it" }] },
    // An executed slash command → normal user bubble showing the typed command.
    { role: "user", content: [], command: "/pr-triage" },
    {
      role: "assistant",
      content: [{ type: "text", text: "Shipping — wiring the cookie into the auth route now." }],
    },
    // A message consumed from the input queue MID-turn (queued_command attachment, never a
    // `user` record) — renders as a normal user bubble, excluded from rewind checkpoints.
    {
      role: "user",
      queued: true,
      content: [{ type: "text", text: "also double-check the cookie's SameSite setting" }],
    },
  ],
  // Still sitting in the input queue (sent mid-turn, unconsumed) → dim "queued" bubble.
  queuedPending: ["and update the README auth section once that lands"],
  usage: { percent: 62, current: 124_000, size: 200_000 },
  mode: "auto",
  statusline: "124k/200k • eng-2687-cookie-auth",
  // Background work: one script wait + agents on both sides of lastPromptAt, so the
  // pill (🤖 1 ⏳ 1) and the sheet's waiting/running/fresh/earlier grouping all render.
  pendingScripts: [
    {
      toolUseId: "toolu_fixture1",
      kind: "script",
      label: "Background wait for Codex review to post",
      status: "pending",
      taskId: "bfixture1",
      launchedAt: new Date(Date.now() - 12 * 60_000).toISOString(),
    },
  ],
  lastPromptAt: new Date(Date.now() - 30 * 60_000).toISOString(),
  subagents: [
    {
      agentId: "afix1",
      agentType: "Explore",
      description: "Trace the cookie exchange path",
      status: "running",
    },
    {
      agentId: "afix2",
      agentType: "code-reviewer",
      description: "Review the auth diff",
      status: "done",
      finishedAt: new Date(Date.now() - 5 * 60_000).toISOString(),
    },
    {
      agentId: "afix3",
      agentType: "general-purpose",
      description: "Survey token storage options",
      status: "done",
      finishedAt: new Date(Date.now() - 3 * 60 * 60_000).toISOString(),
    },
    {
      agentId: "afix4",
      agentType: "Explore",
      description: "Map current auth routes",
      status: "done",
      finishedAt: new Date(Date.now() - 4 * 60 * 60_000).toISOString(),
    },
  ],
  openQuestion: {
    question: "Which storage should the token use?",
    options: [
      { label: "HttpOnly cookie", description: "Server-set; JavaScript can't read it — safest for a bearer token." },
      { label: "localStorage", description: "Trivial to use but readable by any XSS on the page." },
      {
        label: "In-memory only",
        description: "Cleared on every reload; forces re-auth each visit.",
        preview: "store.set(token)\n// gone on refresh ↻",
      },
    ],
  },
  approval: null,
  pendingTool: null,
};

export const FIXTURE_REPOS = [
  { name: "throxy", path: "/Users/throxy/Documents/throxy", branch: "main", isWorktree: false },
  { name: "throxy", path: "/Users/throxy/Documents/throxy-add-tomba-as-enrichment-provider", branch: "add-tomba-as-enrichment-provider", isWorktree: true },
  { name: "throxy", path: "/Users/throxy/Documents/throxy-workspace-cleanup", branch: "feature/workspace-context-cleanup", isWorktree: true },
  { name: "csm", path: "/Users/throxy/Documents/csm", branch: "main", isWorktree: false },
  { name: "customeros", path: "/Users/throxy/Documents/customeros", branch: "main", isWorktree: false },
  { name: "customeros", path: "/Users/throxy/Documents/customeros-ticket-output-piping", branch: "ticket-output-piping", isWorktree: true },
  { name: "~", path: "/Users/throxy", branch: "", isWorktree: false },
  { name: "wiki", path: "/Users/throxy/Documents/wiki", branch: "main", isWorktree: false },
];

// Branch-vs-base changed files for the changed-files card/list demo (latest-modified first).
const FIXTURE_CHANGES = {
  root: "/Users/throxy/Documents/csm",
  branch: "eng-2687-cookie-auth",
  base: "main",
  files: [
    { path: "src/bridge/server.ts", status: "M", add: 34, del: 6, binary: false },
    { path: "src/bridge/diff-view.ts", status: "R", orig: "src/bridge/file-view.ts", add: 12, del: 3, binary: false },
    { path: "src/bridge/public/app.js", status: "M", add: 88, del: 2, binary: false },
    { path: "src/core/session-api.ts", status: "M", add: 41, del: 0, binary: false },
    { path: "src/bridge/public/index.html", status: "M", add: 22, del: 4, binary: false },
    { path: "src/core/repo-files.ts", status: "A", add: 190, del: 0, binary: false },
    { path: "public/icons/badge.png", status: "A", add: 0, del: 0, binary: true },
  ],
};

// Single-file diff for the diff-view demo — mirrors FileDiff (status letter + a small
// unified patch the client colors). Served for any /diff path so tapping any changed-files
// row renders a representative diff (with the A/M/D status badge in the header).
const FIXTURE_DIFF = {
  branch: "eng-2687-cookie-auth",
  base: "main",
  status: "M",
  add: 34,
  del: 6,
  patch: [
    "diff --git a/src/bridge/server.ts b/src/bridge/server.ts",
    "index 1111111..2222222 100644",
    "--- a/src/bridge/server.ts",
    "+++ b/src/bridge/server.ts",
    "@@ -40,7 +40,9 @@ export function serve() {",
    '   const token = req.headers.get("authorization");',
    "-  if (!token) return unauthorized();",
    '+  const cookie = parseCookie(req.headers.get("cookie"));',
    "+  if (!cookie?.csm) return unauthorized();",
    "+  // token now lives in an HttpOnly cookie, never in JS",
    "   return handler(req);",
    "@@ -80,3 +82,4 @@ function routes() {",
    '   res.set("cache-control", "no-cache");',
    "+  res.set(\"set-cookie\", `csm=${tok}; HttpOnly; SameSite=Strict`);",
    " }",
  ].join("\n"),
};

// History browse page: several days, several repos, one still-live row, and all three
// restore states (yes / relocated / no) so the row + drill-in treatments are exercised.
const FIXTURE_HISTORY = {
  rows: [
    {
      id: "api-refactor",
      repo: "csm",
      branch: "refactor-session-api",
      name: "session-api",
      summary: "Extract session-api helpers from sessions.ts",
      firstPrompt: "extract the pane helpers out of sessions.ts",
      lastAssistant: "Moved the pane helpers into session-api.ts and updated the imports.",
      modified: ago(40_000),
      isActive: true,
    },
    {
      id: "hist-restore-fix",
      repo: "csm",
      branch: "restore-sessions",
      name: "resurrect-fix",
      summary: "Never overwrite a real cwd with $HOME in pickSavedCwd",
      firstPrompt: "restore-sessions resumes in the home dir after a crash",
      lastAssistant: "pickSavedCwd now keeps the recorded repo path when a restored pane still reports $HOME.",
      modified: ago(3 * 3_600_000),
      isActive: false,
      restorable: "yes",
    },
    {
      id: "hist-diff-view",
      repo: "csm",
      branch: "portkey-diff-view",
      name: "diff-view",
      summary: "Changed-files strip styling for the thread",
      firstPrompt: "make the changed-files glance readable on a phone",
      lastAssistant: "The strip is full-bleed with hairline rules now — no more assistant-bubble look.",
      modified: ago(7 * 3_600_000),
      isActive: false,
      restorable: "yes",
    },
    {
      id: "hist-tomba",
      repo: "throxy",
      branch: "cursor/add-tomba-provider",
      name: "tomba-provider",
      summary: "Add Tomba as an enrichment provider",
      firstPrompt: "add tomba as an enrichment provider behind the existing interface",
      lastAssistant: "Tomba is wired behind the provider interface with retries matching the others.",
      modified: ago(26 * 3_600_000),
      isActive: false,
      restorable: "relocated", // worktree deleted → resumes in the base repo
    },
    {
      id: "hist-icp",
      repo: "cortex",
      branch: "main",
      name: "icp-notes",
      summary: "Summarize ICP interview notes",
      firstPrompt: "summarize the ICP interview notes into a one-pager",
      lastAssistant: "One-pager written to notes/icp-summary.md.",
      modified: ago(30 * 3_600_000),
      isActive: false,
      restorable: "no", // repo folder gone — readable only
    },
    {
      id: "hist-usage",
      repo: "csm",
      branch: "main",
      name: "usage-readout",
      summary: "Token-usage readout thresholds",
      firstPrompt: "mirror the statusline usage colors on the phone",
      lastAssistant: "Usage now colors at the same 50/75% thresholds as the Mac statusline.",
      modified: ago(3 * 86_400_000),
      isActive: false,
      restorable: "yes",
    },
  ],
  before: null,
  // cortex lives outside repoPaths in this fixture → no chip (rows still list).
  repos: [
    { repo: "csm", count: 4 },
    { repo: "throxy", count: 1 },
  ],
};

// Search page for the same surface: flat, relevance-ranked, with match provenance —
// the snippet carries the query word so the .hl highlight renders.
const FIXTURE_HISTORY_SEARCH = {
  rows: [
    {
      ...FIXTURE_HISTORY.rows[1]!,
      matchField: "summary",
      matchSnippet: "…the resurrect map kept $HOME after a crash-restore…",
    },
    {
      ...FIXTURE_HISTORY.rows[5]!,
      matchField: "content",
      matchSnippet: "…tested resurrect end-to-end after the threshold change…",
    },
  ],
  before: null,
  repos: [{ repo: "csm", count: 2 }],
};

/**
 * Canned payload for a request, or `undefined` if this isn't a fixture route (so the
 * caller falls through to the real handler — e.g. `/stream` keeps its live SSE).
 */
export function fixtureData(method: string, path: string, params?: URLSearchParams): unknown | undefined {
  if (method === "GET" && path === "/sessions") return FIXTURE_SESSIONS;
  if (method === "GET" && path === "/repos") return FIXTURE_REPOS;
  if (method === "GET" && path === "/history") {
    return params?.get("q") ? FIXTURE_HISTORY_SEARCH : FIXTURE_HISTORY;
  }
  if (method === "GET" && path === "/pending") return [];
  if (method === "GET" && /^\/sessions\/[^/]+\/transcript$/.test(path)) return FIXTURE_TRANSCRIPT;
  if (method === "GET" && /^\/sessions\/[^/]+\/changes$/.test(path)) return FIXTURE_CHANGES;
  if (method === "GET" && /^\/sessions\/[^/]+\/diff$/.test(path)) return FIXTURE_DIFF;
  // Stub the mutating actions so the UI's optimistic flows resolve cleanly in a demo.
  if (method === "POST" && path === "/sessions/new") return { ok: true, sessionId: FIXTURE_SESSIONS[0]!.id };
  if (method === "POST" && /^\/sessions\/[^/]+\/(decision|message|answer|read|rewind)$/.test(path)) {
    return { ok: true };
  }
  return undefined;
}
