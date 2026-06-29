#!/usr/bin/env -S bun --env-file=/dev/null
export {};

function help() {
  console.log(`
  \x1b[1mcsm\x1b[0m — Claude Session Manager

  \x1b[1mUsage:\x1b[0m  csm [command]

  \x1b[1mCommands:\x1b[0m
    \x1b[36m(none)\x1b[0m              Open the full TUI
    \x1b[36mnext\x1b[0m                Switch to next attention session (oldest first)
    \x1b[36mreset\x1b[0m               Reset all window names and clear attention state
    \x1b[36mstatus\x1b[0m              Tmux status-right monitor (⚡3 🔄2)
    \x1b[36mlist\x1b[0m                Print sessions with status, repo, and context %
    \x1b[36mswitch <name>\x1b[0m       Fuzzy-match a session by name and switch to it
    \x1b[36msetup\x1b[0m               Install SessionStart hook for session tracking
    \x1b[36msave-sessions\x1b[0m       Snapshot pane→session map for tmux-resurrect
    \x1b[36mrestore-sessions\x1b[0m    Restore Claude sessions after tmux-resurrect restore
    \x1b[36mbridge\x1b[0m              Serve the HTTP/SSE bridge for the mobile web app

  \x1b[1mOptions:\x1b[0m
    \x1b[36m-h, --help\x1b[0m          Show this help message
`.trimEnd());
}

const cmd = process.argv[2];

switch (cmd) {
  case undefined:
    await import("../src/index");
    break;
  case "-h":
  case "--help":
  case "help":
    help();
    break;
  case "next":
    await import("../src/cli").then((m) => m.next());
    break;
  case "reset":
    await import("../src/cli").then((m) => m.reset());
    break;
  case "status":
    await import("../src/monitor");
    break;
  case "list":
    await import("../src/cli").then((m) => m.list());
    break;
  case "switch":
    await import("../src/cli").then((m) => m.switchTo(process.argv[3]));
    break;
  case "setup":
    await import("../src/cli").then((m) => m.setup());
    break;
  case "save-sessions":
    await import("../src/cli").then((m) => m.saveSessions());
    break;
  case "restore-sessions":
    await import("../src/cli").then((m) => m.restoreSessions());
    break;
  case "bridge":
    try {
      await import("../src/bridge/server").then((m) => m.startBridge());
    } catch (err) {
      console.error(err instanceof Error ? err.message : String(err));
      process.exit(1);
    }
    break;
  default:
    console.error(`Unknown command: ${cmd}`);
    help();
    process.exit(1);
}
