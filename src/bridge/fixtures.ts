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
  ],
  usage: { percent: 62, current: 124_000, size: 200_000 },
  mode: "auto",
  statusline: "124k/200k • eng-2687-cookie-auth",
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
  { name: "csm", path: "/Users/you/Documents/csm" },
  { name: "throxy", path: "/Users/you/throxy" },
];

/**
 * Canned payload for a request, or `undefined` if this isn't a fixture route (so the
 * caller falls through to the real handler — e.g. `/stream` keeps its live SSE).
 */
export function fixtureData(method: string, path: string): unknown | undefined {
  if (method === "GET" && path === "/sessions") return FIXTURE_SESSIONS;
  if (method === "GET" && path === "/repos") return FIXTURE_REPOS;
  if (method === "GET" && path === "/pending") return [];
  if (method === "GET" && /^\/sessions\/[^/]+\/transcript$/.test(path)) return FIXTURE_TRANSCRIPT;
  // Stub the mutating actions so the UI's optimistic flows resolve cleanly in a demo.
  if (method === "POST" && path === "/sessions/new") return { ok: true, sessionId: FIXTURE_SESSIONS[0]!.id };
  if (method === "POST" && /^\/sessions\/[^/]+\/(decision|message|answer|read|rewind)$/.test(path)) {
    return { ok: true };
  }
  return undefined;
}
