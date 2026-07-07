import { homedir } from "os";
import { existsSync } from "fs";

/**
 * A slash-command the bridge composer can suggest. `name` is stored WITHOUT the
 * leading `/` (the UI prepends it). Sending `/${name} ` to a pane runs it — see the
 * live-verified note in the plan; the trailing space the UI adds closes Claude's own
 * native `/` autocomplete so the submit lands on the literal buffer.
 */
export interface SlashCommand {
  name: string;
  description: string;
  source: "builtin" | "user" | "project";
}

/**
 * Built-in Claude Code commands. These are NOT file-backed (they live in the binary),
 * so the common set is curated here. Descriptions are short — the disk skills carry the
 * long trigger-phrase descriptions.
 */
const BUILTIN_COMMANDS: Omit<SlashCommand, "source">[] = [
  { name: "compact", description: "Summarize the conversation to free up context" },
  { name: "clear", description: "Clear the conversation history" },
  { name: "help", description: "Show help and available commands" },
  { name: "model", description: "Switch the active model" },
  { name: "cost", description: "Show token usage and cost for this session" },
  { name: "context", description: "Show the context-window breakdown" },
  { name: "resume", description: "Resume a previous conversation" },
  { name: "review", description: "Review a pull request" },
  { name: "config", description: "Open settings" },
  { name: "agents", description: "Manage subagents" },
  { name: "memory", description: "Edit Claude memory files" },
  { name: "export", description: "Export the conversation" },
  { name: "status", description: "Show session and account status" },
  { name: "init", description: "Initialize a CLAUDE.md for the codebase" },
];

/**
 * Parse the leading `---` YAML frontmatter block for `name`/`description`. Line-based
 * (first matching line wins) — multi-line/folded values keep only their first line,
 * which is fine for the one-line descriptions skills use. Returns {} when there's no
 * frontmatter.
 */
function parseFrontmatter(text: string): { name?: string; description?: string } {
  if (!text.startsWith("---")) return {};
  const end = text.indexOf("\n---", 3);
  if (end === -1) return {};
  const block = text.slice(3, end);
  const out: { name?: string; description?: string } = {};
  for (const line of block.split("\n")) {
    const m = line.match(/^(name|description):\s*(.*)$/);
    if (m && out[m[1] as "name" | "description"] === undefined) {
      out[m[1] as "name" | "description"] = m[2].trim();
    }
  }
  return out;
}

/**
 * Enumerate skills + commands under a `.claude` dir (skips silently if absent). Skills
 * are `skills/<name>/SKILL.md` (case-insensitive filename) named by their folder;
 * commands are `commands/**\/*.md` named by their path (namespaced dirs joined with `:`).
 * Plugin dirs are never touched. Per-file failures are skipped; the whole thing never
 * throws.
 */
async function readClaudeDir(
  claudeDir: string,
  source: "user" | "project",
): Promise<SlashCommand[]> {
  const out: SlashCommand[] = [];

  const skillsDir = `${claudeDir}/skills`;
  if (existsSync(skillsDir)) {
    try {
      const glob = new Bun.Glob("*/*.md");
      // dot:true — user skill folders are commonly dot-prefixed (.cap, .fix-bug), which the
      // default glob would skip entirely.
      for await (const rel of glob.scan({ cwd: skillsDir, followSymlinks: true, dot: true })) {
        const [folder, file] = rel.split("/");
        if (!folder || file?.toLowerCase() !== "skill.md") continue; // ignore bundled refs
        try {
          const fm = parseFrontmatter(await Bun.file(`${skillsDir}/${rel}`).text());
          out.push({ name: folder, description: fm.description ?? "", source });
        } catch {}
      }
    } catch {}
  }

  const cmdDir = `${claudeDir}/commands`;
  if (existsSync(cmdDir)) {
    try {
      const glob = new Bun.Glob("**/*.md");
      for await (const rel of glob.scan({ cwd: cmdDir, followSymlinks: true, dot: true })) {
        const name = rel.replace(/\.md$/, "").split("/").join(":");
        try {
          const fm = parseFrontmatter(await Bun.file(`${cmdDir}/${rel}`).text());
          out.push({ name, description: fm.description ?? "", source });
        } catch {}
      }
    } catch {}
  }

  return out;
}

/**
 * The slash-commands available to a session: built-in defaults + the user's global
 * skills/commands (`~/.claude`) + (when `projectDir` is given) that repo's project
 * skills/commands. Merged with precedence project > user > builtin — a later source
 * shadows an earlier one of the same name, keeping one row.
 */
export async function listSlashCommands(projectDir?: string): Promise<SlashCommand[]> {
  const builtin: SlashCommand[] = BUILTIN_COMMANDS.map((c) => ({ ...c, source: "builtin" }));
  const user = await readClaudeDir(`${homedir()}/.claude`, "user");
  const project = projectDir ? await readClaudeDir(`${projectDir}/.claude`, "project") : [];

  const byName = new Map<string, SlashCommand>();
  for (const c of [...builtin, ...user, ...project]) byName.set(c.name, c);
  return [...byName.values()];
}
