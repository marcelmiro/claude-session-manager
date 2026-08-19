#!/usr/bin/env bun

import { createHash } from "node:crypto";
import { homedir, hostname } from "node:os";
import { basename, dirname, extname, join, relative, resolve } from "node:path";
import {
  copyFile,
  lstat,
  mkdir,
  readFile,
  readdir,
  readlink,
  rename,
  symlink,
  unlink,
  writeFile,
  link,
} from "node:fs/promises";

export type WorktreePlan = {
  sourcePath: string;
  targetPath: string;
  branch: string | null;
  initializedSubmodules: boolean;
};

export type RepoPlan = {
  name: string;
  sourcePath: string;
  targetPath: string;
  worktrees: WorktreePlan[];
};

export type ProjectDirPlan = { sourceName: string; targetName: string };

export type MigrationManifest = {
  schemaVersion: 1;
  createdAt: string;
  host: string;
  sourceHome: string;
  targetHome: string;
  sourceRoot: string;
  targetRoot: string;
  repos: RepoPlan[];
  projectDirs: ProjectDirPlan[];
  warnings: string[];
  blockers: string[];
};

type WorktreeRecord = { path: string; branch: string | null };

function git(args: string[], cwd?: string): { ok: boolean; stdout: string; stderr: string } {
  const result = Bun.spawnSync(["git", ...(cwd ? ["-C", cwd] : []), ...args], {
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    ok: result.exitCode === 0,
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString().trim(),
  };
}

export function encodeClaudeProjectPath(path: string): string {
  return path.replace(/\//g, "-");
}

export function replacePathPrefix(path: string, from: string, to: string): string {
  if (path === from) return to;
  if (path.startsWith(`${from}/`)) return `${to}${path.slice(from.length)}`;
  return path;
}

export function parseWorktreePorcelain(output: string): WorktreeRecord[] {
  const records: WorktreeRecord[] = [];
  let current: WorktreeRecord | undefined;
  for (const line of output.split("\n")) {
    if (line.startsWith("worktree ")) {
      if (current) records.push(current);
      current = { path: line.slice(9), branch: null };
    } else if (current && line.startsWith("branch ")) {
      current.branch = line.slice(7).replace(/^refs\/heads\//, "");
    }
  }
  if (current) records.push(current);
  return records;
}

function targetWorktreeName(record: WorktreeRecord, repoName: string, used: Set<string>): string {
  const currentName = basename(record.path);
  const friendly = currentName.startsWith(`${repoName}-`)
    ? currentName.slice(repoName.length + 1)
    : currentName;
  let result = friendly
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "") || "worktree";
  if (used.has(result)) {
    result = `${result}-${createHash("sha256").update(record.path).digest("hex").slice(0, 8)}`;
  }
  used.add(result);
  return result;
}

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch {
    return false;
  }
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await lstat(path)).isDirectory();
  } catch {
    return false;
  }
}

async function initializedSubmodules(worktree: string): Promise<boolean> {
  const status = git(["submodule", "status", "--recursive"], worktree);
  if (!status.ok) return false;
  return status.stdout.split("\n").some((line) => line.length > 0 && line[0] !== "-");
}

async function hasDirtySubmodules(worktree: string): Promise<boolean> {
  const status = git([
    "submodule",
    "foreach",
    "--recursive",
    "--quiet",
    'test -z "$(git status --porcelain)" || { echo "$sm_path"; exit 1; }',
  ], worktree);
  return !status.ok || status.stdout.trim().length > 0;
}

function expandTilde(path: string, home: string): string {
  return path === "~" ? home : path.startsWith("~/") ? join(home, path.slice(2)) : resolve(path);
}

function value(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  if (index === -1) return undefined;
  if (!args[index + 1]) throw new Error(`${name} requires a value`);
  return args[index + 1];
}

async function listBaseRepos(root: string): Promise<string[]> {
  const entries = await readdir(root, { withFileTypes: true });
  const repos: string[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const candidate = join(root, entry.name);
    if (await isDirectory(join(candidate, ".git"))) repos.push(candidate);
  }
  return repos.sort((a, b) => a.localeCompare(b));
}

async function projectDirPlans(
  projectsDir: string,
  sourceHome: string,
  targetHome: string,
  pathMappings: Array<[string, string]>,
): Promise<ProjectDirPlan[]> {
  if (!(await isDirectory(projectsDir))) return [];
  const exact = new Map(pathMappings.map(([from, to]) => [encodeClaudeProjectPath(from), encodeClaudeProjectPath(to)]));
  const sourcePrefix = encodeClaudeProjectPath(sourceHome);
  const targetPrefix = encodeClaudeProjectPath(targetHome);
  const plans: ProjectDirPlan[] = [];
  for (const entry of await readdir(projectsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const targetName = exact.get(entry.name)
      ?? (entry.name === sourcePrefix || entry.name.startsWith(`${sourcePrefix}-`)
        ? `${targetPrefix}${entry.name.slice(sourcePrefix.length)}`
        : entry.name);
    if (targetName !== entry.name) plans.push({ sourceName: entry.name, targetName });
  }
  return plans;
}

export async function buildManifest(options: {
  sourceHome: string;
  targetHome: string;
  sourceRoot: string;
  targetRoot: string;
}): Promise<MigrationManifest> {
  const { sourceHome, targetHome, sourceRoot, targetRoot } = options;
  const warnings: string[] = [];
  const blockers: string[] = [];
  const repos: RepoPlan[] = [];

  if (!(await isDirectory(sourceRoot))) blockers.push(`source root does not exist: ${sourceRoot}`);
  const bases = blockers.length ? [] : await listBaseRepos(sourceRoot);
  if (!bases.length && !blockers.length) warnings.push(`no base repositories found directly under ${sourceRoot}`);

  for (const sourcePath of bases) {
    const name = basename(sourcePath);
    const targetPath = join(targetRoot, name);
    const targetBeforeAccountRename = replacePathPrefix(targetPath, targetHome, sourceHome);
    if (
      (targetPath !== sourcePath && await exists(targetPath))
      || (targetBeforeAccountRename !== sourcePath && await exists(targetBeforeAccountRename))
    ) {
      blockers.push(`repository destination already exists: ${targetPath}`);
    }
    const listed = git(["worktree", "list", "--porcelain"], sourcePath);
    if (!listed.ok) {
      blockers.push(`cannot list worktrees for ${sourcePath}: ${listed.stderr}`);
      continue;
    }
    const records = parseWorktreePorcelain(listed.stdout);
    const linked = records.slice(1);
    const used = new Set<string>();
    const worktrees: WorktreePlan[] = [];
    for (const record of linked) {
      const wtName = targetWorktreeName(record, name, used);
      const wtTarget = join(targetPath, ".claude", "worktrees", wtName);
      const initialized = await initializedSubmodules(record.path);
      if (initialized && await hasDirtySubmodules(record.path)) {
        blockers.push(`dirty or unreadable initialized submodule in ${record.path}`);
      }
      const wtTargetBeforeAccountRename = replacePathPrefix(wtTarget, targetHome, sourceHome);
      if (
        (wtTarget !== record.path && await exists(wtTarget))
        || (wtTargetBeforeAccountRename !== record.path && await exists(wtTargetBeforeAccountRename))
      ) {
        blockers.push(`worktree destination already exists: ${wtTarget}`);
      }
      worktrees.push({
        sourcePath: record.path,
        targetPath: wtTarget,
        branch: record.branch,
        initializedSubmodules: initialized,
      });
    }
    repos.push({ name, sourcePath, targetPath, worktrees });
  }

  const mappings: Array<[string, string]> = [];
  for (const repo of repos) {
    for (const wt of repo.worktrees) mappings.push([wt.sourcePath, wt.targetPath]);
    mappings.push([repo.sourcePath, repo.targetPath]);
  }
  mappings.push([sourceHome, targetHome]);
  mappings.sort((a, b) => b[0].length - a[0].length);

  const projectDirs = await projectDirPlans(join(sourceHome, ".claude", "projects"), sourceHome, targetHome, mappings);
  const targetNames = new Set<string>();
  for (const plan of projectDirs) {
    if (targetNames.has(plan.targetName)) blockers.push(`multiple Claude project directories map to ${plan.targetName}`);
    targetNames.add(plan.targetName);
    if (
      await exists(join(sourceHome, ".claude", "projects", plan.targetName))
      || await exists(join(targetHome, ".claude", "projects", plan.targetName))
    ) {
      blockers.push(`Claude project destination already exists: ${plan.targetName}`);
    }
  }

  const processCheck = Bun.spawnSync(["pgrep", "-fl", "claude|c0|tmux"], { stdout: "pipe", stderr: "ignore" });
  if (processCheck.exitCode === 0) warnings.push("Claude/Claude0/tmux processes are running; stop them immediately before account cutover");

  return {
    schemaVersion: 1,
    createdAt: new Date().toISOString(),
    host: hostname(),
    sourceHome,
    targetHome,
    sourceRoot,
    targetRoot,
    repos,
    projectDirs,
    warnings,
    blockers,
  };
}

function allPathMappings(manifest: MigrationManifest): Array<[string, string]> {
  const mappings: Array<[string, string]> = [];
  for (const repo of manifest.repos) {
    for (const wt of repo.worktrees) {
      mappings.push([wt.sourcePath, wt.targetPath]);
      mappings.push([currentLocation(wt.sourcePath, manifest), wt.targetPath]);
    }
    mappings.push([repo.sourcePath, repo.targetPath]);
    mappings.push([currentLocation(repo.sourcePath, manifest), repo.targetPath]);
  }
  mappings.push([manifest.sourceRoot, manifest.targetRoot]);
  mappings.push([currentLocation(manifest.sourceRoot, manifest), manifest.targetRoot]);
  mappings.push(["~/Documents", "~/dev"]);
  mappings.push([manifest.sourceHome, manifest.targetHome]);
  return mappings
    .filter(([from, to]) => from !== to)
    .sort((a, b) => b[0].length - a[0].length);
}

export function rewritePaths(text: string, mappings: Array<[string, string]>): string {
  let result = text;
  for (const [from, to] of mappings) result = result.split(from).join(to);
  return result;
}

function currentLocation(oldPath: string, manifest: MigrationManifest): string {
  return replacePathPrefix(oldPath, manifest.sourceHome, manifest.targetHome);
}

async function backupFile(path: string, backupRoot: string, home: string): Promise<void> {
  const dest = join(backupRoot, relative(home, path));
  await mkdir(dirname(dest), { recursive: true });
  const info = await lstat(path);
  if (info.isSymbolicLink()) {
    await symlink(await readlink(path), dest);
    return;
  }
  try {
    await link(path, dest);
  } catch {
    await copyFile(path, dest);
  }
}

async function rewriteFile(path: string, mappings: Array<[string, string]>, backupRoot: string, home: string): Promise<boolean> {
  const before = await readFile(path, "utf8");
  if (before.includes("\0")) return false;
  const after = rewritePaths(before, mappings);
  if (after === before) return false;
  await backupFile(path, backupRoot, home);
  const temp = `${path}.c0-migration.tmp`;
  await writeFile(temp, after);
  await rename(temp, path);
  return true;
}

const REWRITABLE_EXTENSIONS = new Set([".json", ".jsonl", ".plist", ".service", ".conf", ".txt", ".md"]);

async function collectTextFiles(path: string, result: string[], direct = true): Promise<void> {
  if (!(await exists(path))) return;
  const info = await lstat(path);
  if (info.isSymbolicLink()) return;
  if (info.isFile()) {
    if (direct || REWRITABLE_EXTENSIONS.has(extname(path).toLowerCase())) result.push(path);
    return;
  }
  if (!info.isDirectory()) return;
  for (const entry of await readdir(path)) await collectTextFiles(join(path, entry), result, false);
}

async function rewriteKnownState(
  manifest: MigrationManifest,
  backupRoot: string,
  renamedProjectDirs: string[],
): Promise<number> {
  const home = manifest.targetHome;
  const mappings = allPathMappings(manifest);
  const files: string[] = [];
  const candidates = [
    join(home, ".config", "c0", "config.json"),
    join(home, ".config", "c0", "state.json"),
    join(home, ".config", "c0", "events"),
    join(home, ".claude", "settings.json"),
    join(home, ".claude.json"),
    join(home, ".tmux", "resurrect", "last"),
    join(home, "Library", "LaunchAgents"),
    join(home, ".config", "systemd", "user"),
    join(home, ".ssh", "config"),
    join(home, ".gitconfig"),
  ];
  for (const candidate of candidates) await collectTextFiles(candidate, files);
  for (const dir of renamedProjectDirs) await collectTextFiles(dir, files);
  let changed = 0;
  for (const file of [...new Set(files)]) {
    try {
      if (await rewriteFile(file, mappings, backupRoot, home)) changed++;
    } catch (error) {
      throw new Error(`failed to rewrite ${file}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return changed;
}

async function rewriteHomeSymlinks(manifest: MigrationManifest, backupRoot: string): Promise<number> {
  let changed = 0;
  for (const root of [join(manifest.targetHome, ".local", "bin"), join(manifest.targetHome, ".bun", "bin")]) {
    if (!(await isDirectory(root))) continue;
    for (const name of await readdir(root)) {
      const path = join(root, name);
      let target: string;
      try {
        if (!(await lstat(path)).isSymbolicLink()) continue;
        target = await readlink(path);
      } catch {
        continue;
      }
      const rewritten = rewritePaths(target, allPathMappings(manifest));
      if (rewritten === target) continue;
      await backupFile(path, backupRoot, manifest.targetHome);
      await unlink(path);
      await symlink(rewritten, path);
      changed++;
    }
  }
  return changed;
}

async function applyManifest(manifestPath: string): Promise<void> {
  const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as MigrationManifest;
  if (manifest.schemaVersion !== 1) throw new Error("unsupported migration manifest version");
  if (manifest.blockers.length) throw new Error(`manifest has blockers:\n- ${manifest.blockers.join("\n- ")}`);
  if (homedir() !== manifest.targetHome) {
    throw new Error(`account rename has not completed: current home is ${homedir()}, expected ${manifest.targetHome}`);
  }

  const runId = new Date().toISOString().replace(/[:.]/g, "-");
  const backupRoot = join(manifest.targetHome, ".config", "c0", "migrations", `${runId}-backup`);
  await mkdir(backupRoot, { recursive: true });
  await mkdir(manifest.targetRoot, { recursive: true });

  for (const repo of manifest.repos) {
    const sourceBase = currentLocation(repo.sourcePath, manifest);
    const finalBase = repo.targetPath;
    const baseBeforeMove = await isDirectory(sourceBase) ? sourceBase : finalBase;
    if (!(await isDirectory(baseBeforeMove))) throw new Error(`repository missing: ${sourceBase} (or ${finalBase})`);

    const existingSources: string[] = [];
    for (const wt of repo.worktrees) {
      const path = currentLocation(wt.sourcePath, manifest);
      if (path !== baseBeforeMove && await isDirectory(path)) existingSources.push(path);
    }
    if (existingSources.length) {
      const initialRepair = git(["worktree", "repair", ...existingSources], baseBeforeMove);
      if (!initialRepair.ok) throw new Error(`cannot repair renamed-home worktrees for ${baseBeforeMove}: ${initialRepair.stderr}`);
    }

    for (const wt of repo.worktrees) {
      const sourceWt = currentLocation(wt.sourcePath, manifest);
      const interimWt = join(baseBeforeMove, ".claude", "worktrees", basename(wt.targetPath));
      const finalWt = wt.targetPath;
      if (await isDirectory(finalWt)) continue;
      if (!(await isDirectory(interimWt))) {
        if (!(await isDirectory(sourceWt))) throw new Error(`worktree missing: ${sourceWt}`);
        if (wt.initializedSubmodules) {
          if (await hasDirtySubmodules(sourceWt)) throw new Error(`dirty submodule appeared after preflight: ${sourceWt}`);
          const deinit = git(["submodule", "deinit", "-f", "--all"], sourceWt);
          if (!deinit.ok) throw new Error(`cannot deinitialize submodules in ${sourceWt}: ${deinit.stderr}`);
        }
        await mkdir(dirname(interimWt), { recursive: true });
        await rename(sourceWt, interimWt);
        const repair = git(["worktree", "repair", interimWt], baseBeforeMove);
        if (!repair.ok) throw new Error(`cannot repair moved worktree ${interimWt}: ${repair.stderr}`);
      }
    }

    if (baseBeforeMove !== finalBase) {
      if (await exists(finalBase)) throw new Error(`repository destination appeared after preflight: ${finalBase}`);
      await rename(baseBeforeMove, finalBase);
    }
    const repair = git(["worktree", "repair", ...repo.worktrees.map((wt) => wt.targetPath)], finalBase);
    if (!repair.ok) throw new Error(`cannot repair ${finalBase}: ${repair.stderr}`);
    await mkdir(join(finalBase, ".git", "info"), { recursive: true });
    const excludePath = join(finalBase, ".git", "info", "exclude");
    const exclude = await exists(excludePath) ? await readFile(excludePath, "utf8") : "";
    if (!exclude.split("\n").includes("/.claude/worktrees/")) {
      await writeFile(excludePath, `${exclude}${exclude && !exclude.endsWith("\n") ? "\n" : ""}/.claude/worktrees/\n`);
    }
    for (const wt of repo.worktrees.filter((item) => item.initializedSubmodules)) {
      const init = git(["-c", "protocol.file.allow=always", "submodule", "update", "--init", "--recursive"], wt.targetPath);
      if (!init.ok) throw new Error(`worktree moved, but submodule reinitialization failed in ${wt.targetPath}: ${init.stderr}`);
    }
  }

  const projectsDir = join(manifest.targetHome, ".claude", "projects");
  const renamedProjectDirs: string[] = [];
  for (const plan of manifest.projectDirs) {
    const source = join(projectsDir, plan.sourceName);
    const target = join(projectsDir, plan.targetName);
    if (await isDirectory(target)) {
      if (await isDirectory(source)) throw new Error(`Claude project collision appeared after preflight: ${target}`);
      renamedProjectDirs.push(target);
      continue;
    }
    if (!(await isDirectory(source))) continue;
    await rename(source, target);
    renamedProjectDirs.push(target);
  }

  const rewritten = await rewriteKnownState(manifest, backupRoot, renamedProjectDirs);
  const symlinks = await rewriteHomeSymlinks(manifest, backupRoot);
  const report = {
    completedAt: new Date().toISOString(),
    manifest: manifestPath,
    repositories: manifest.repos.length,
    worktrees: manifest.repos.reduce((sum, repo) => sum + repo.worktrees.length, 0),
    rewrittenFiles: rewritten,
    rewrittenSymlinks: symlinks,
    backupRoot,
  };
  await writeFile(join(backupRoot, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify(report, null, 2));
  console.log(`\nNext: bun run ${join(manifest.targetRoot, "claude0", "bin", "c0.ts")} setup`);
}

async function latestManifest(home: string): Promise<string | undefined> {
  const root = join(home, ".config", "c0", "migrations");
  if (!(await isDirectory(root))) return undefined;
  const files = (await readdir(root)).filter((name) => name.endsWith("-manifest.json")).sort().reverse();
  return files[0] ? join(root, files[0]) : undefined;
}

function usage(): never {
  console.error(`Usage:
  bun run scripts/migrate-dev-layout.ts preflight --target-home /Users/marcel [--source-root ~/Documents] [--target-root /Users/marcel/dev] [--output FILE]
  bun run scripts/migrate-dev-layout.ts apply [--manifest FILE]

Preflight is read-only except for writing its manifest. Apply refuses to run until
the OS account home matches target-home and the manifest has zero blockers.`);
  process.exit(2);
}

async function main(): Promise<void> {
  const [command, ...args] = process.argv.slice(2);
  if (command === "preflight") {
    const sourceHome = resolve(value(args, "--source-home") ?? homedir());
    const targetHomeValue = value(args, "--target-home");
    if (!targetHomeValue) usage();
    const targetHome = resolve(targetHomeValue);
    const sourceRoot = expandTilde(value(args, "--source-root") ?? "~/Documents", sourceHome);
    const targetRoot = expandTilde(value(args, "--target-root") ?? join(targetHome, "dev"), targetHome);
    const manifest = await buildManifest({ sourceHome, targetHome, sourceRoot, targetRoot });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const output = resolve(value(args, "--output") ?? join(sourceHome, ".config", "c0", "migrations", `${stamp}-manifest.json`));
    await mkdir(dirname(output), { recursive: true });
    await writeFile(output, `${JSON.stringify(manifest, null, 2)}\n`);
    console.log(`Manifest: ${output}`);
    console.log(`Repositories: ${manifest.repos.length}`);
    console.log(`Linked worktrees: ${manifest.repos.reduce((sum, repo) => sum + repo.worktrees.length, 0)}`);
    for (const warning of manifest.warnings) console.warn(`WARNING: ${warning}`);
    for (const blocker of manifest.blockers) console.error(`BLOCKER: ${blocker}`);
    if (manifest.blockers.length) process.exitCode = 1;
    return;
  }
  if (command === "apply") {
    const manifestPath = value(args, "--manifest") ?? await latestManifest(homedir());
    if (!manifestPath) throw new Error("no migration manifest found; run preflight first");
    await applyManifest(resolve(manifestPath));
    return;
  }
  usage();
}

if (import.meta.main) {
  await main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
