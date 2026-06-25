---
name: implement-plan
description: execute an existing plan file by bootstrapping context, injecting standards, resolving dependencies, and implementing increments with verification gates.
---

# Implement Plan

Execute an existing plan file in a fresh session. Bootstraps full context, injects standards and common mistakes, implements increments respecting dependencies, and verifies after each step.

## Usage

```
implement-plan .plans/cloudtalk-realtime-dispositions/plan.md
implement-plan .plans/cloudtalk-realtime-dispositions/
implement-plan .claude/plans/gentle-inventing-hearth.md
```

Argument: path to a plan file or a plan directory (auto-finds `plan.md` inside).

## Important Guidelines

- **Context is your responsibility** — This skill runs in a fresh session. Load everything the plan references before writing any code.
- **Respect the dependency DAG** — Never start an increment whose dependencies are not `done`.
- **Verify before advancing** — Every increment must pass `bun run c` before being marked `done`.
- **Resume, don't restart** — If increments are already `done`, skip them and continue from where the plan left off.
- **Do not modify the plan's design** — If the plan is wrong, stop and tell the user. Do not silently change the approach.

## Process

### Step 0: Locate and Load the Plan

Read the provided path. If it's a directory, look for `plan.md` inside it. Determine the plan format:

- **plan-large** — Has `## Increments` section with `### Increment N: Title` entries, each with Status/Depends on/Unblocks/Complexity/Done criteria/Files fields.
- **plan-small** — Has sections like Context, Part 1/2/3, Files to Create/Modify, Verification. No formal increment structure.

If the plan file cannot be found, stop and ask the user for the correct path.

### Step 1: Bootstrap Context

Read all of the following in parallel:

1. **The plan file** — Full content
2. **Standards index** — `.agents/standards/index.yml`
3. **Common mistakes index** — `.agents/common-mistakes/index.yml`
4. **Sibling files** — If `.plans/{feature}/shape.md`, `standards.md`, or `references.md` exist alongside the plan, read those too

Then determine which standards apply:

- **Explicit**: Look for a "Standards" or "Standards Applied" section in the plan. Read every referenced standard file.
- **Auto-match**: If the plan does not list standards, match file paths and domains from the plan against the standards index descriptions. Select 3-5 relevant standards.

Read every matched standard file and every relevant common-mistakes category file.

Summarize to the user:

```
Plan loaded: {plan title}
Format: plan-large | plan-small
Increments: {N total}, {M done}, {K remaining}
Standards loaded: {list}
Common mistakes loaded: {list}

Ready to implement. Starting with {next increment/part}.
```

### Step 2: Build the Execution Schedule

#### For plan-large

Parse every increment and extract: id, status, depends_on, unblocks. Build the dependency DAG.

**Execution loop:**

1. Filter out increments with status `done`.
2. Find all increments whose dependencies are ALL `done` — the **ready set**.
3. Apply the decision tree (below) to choose sequential or parallel execution.
4. Execute the ready set.
5. Recompute the ready set and repeat until all increments are `done`.

**Decision tree:**

```
Multiple ready increments?
├─ No  → Sequential (Step 3)
└─ Yes →
    Do any share files in their "Files" lists?
    ├─ Yes → Sequential in increment-number order (Step 3)
    └─ No  →
        Are all increments complexity S or M?
        ├─ Yes → Parallel via subagents (Step 4)
        └─ No  → Sequential — L increments benefit from full context (Step 3)
```

#### For plan-small

Treat each numbered Part/Section as a sequential step. Execute them in order via Step 3. No parallelism for plan-small.

### Step 3: Execute an Increment (Sequential)

**3a. Track progress**

Use TodoWrite to mark this increment `in_progress`. Add upcoming increments as `pending`.

**3b. Read existing files**

Read every file listed in the increment's "Files" section that already exists. For files marked NEW, read the directory they will live in to understand sibling conventions.

**3c. Implement**

Write code following:

- The plan's specification for this increment
- The loaded standards (already in context from Step 1)
- The loaded common mistakes (avoid documented patterns)
- Throxy conventions: `snake_case` functions/variables, `kebab-case` files, `PascalCase` types
- Business logic in `core/`, thin routers, trigger tasks orchestrate only

**3d. Verify**

Run `bun run c`. If it fails:

1. Read the error output
2. Fix the issues
3. Re-run `bun run c`
4. Repeat until clean (max 3 attempts — escalate to user after that)

**3e. Self-review**

Re-read the relevant common-mistakes files. Check your implementation against every documented pattern. Fix any violations.

**3f. Update plan status**

Edit the plan file: change this increment's `**Status**:` to `done`.

**3g. Complete tracking**

Mark the TodoWrite item as `completed`. Proceed to the next ready set.

### Step 4: Execute Increments in Parallel (Subagents)

When multiple increments are independent (no shared files, all dependencies satisfied, all S/M complexity), launch them simultaneously using the Task tool — multiple Task calls in a single message.

#### Subagent prompt template

Each subagent receives a self-contained prompt with ALL context pasted in (subagents cannot access the parent's loaded context):

```
## Task: Implement {Increment Title}

You are implementing one increment of a larger plan for the Throxy codebase.

### Increment Specification
{Paste the exact increment section from the plan: title, status, depends on, done criteria, files}

### Repository Conventions
- snake_case for functions/variables
- kebab-case for file names
- PascalCase for types, interfaces, React components
- Business logic in packages/api/src/core/<entity>/
- Router procedures are thin — validate input, call core functions, return results
- Trigger tasks orchestrate only — import and call core functions
- Database operations in core/<entity>/singlestore/
- OpenSearch operations in core/<entity>/opensearch/
- Use Drizzle ORM for database queries
- Use superjson for tRPC serialization

### Standards to Follow
{Paste full content of each relevant standard file, wrapped in:}
--- Standard: {category/name} ---
{content}
--- End Standard ---

### Common Mistakes to Avoid
{Paste full content of each relevant common-mistakes category file, wrapped in:}
--- Common Mistakes: {category} ---
{content}
--- End Common Mistakes ---

### Files to Implement
{For each file: path, NEW or EDIT, description of changes from the plan}

### Verification
After implementing all files, run: bun run c
Fix any errors until the command passes cleanly.

### Done Criteria
{Paste done criteria from the increment}
```

Set the Task `subagent_type` to `"general-purpose"`.

#### After parallel subagents complete

1. Run `bun run c` from the main agent to verify cross-increment integration.
2. If integration issues exist (type conflicts, import errors), fix them directly.
3. Update the plan file: mark all completed increments as `done`.
4. Recompute the ready set and continue the execution loop.

### Step 5: Handle Failures

If an increment fails verification after 3 attempts:

1. Stop execution. Report the specific errors to the user.
2. Do NOT proceed to dependent increments.
3. Ask whether to: continue with a modified approach, skip the increment, or abort.

If a subagent returns with errors, the main agent should attempt to fix the issue before escalating.

### Step 6: Completion

When all increments are `done`:

1. Run a final `bun run c` to verify everything.
2. Self-review the full implementation against common-mistakes files.
3. Summarize:

```
Plan complete: {plan title}

Increments completed: {N}
Files created: {list}
Files modified: {list}

Standards followed: {list}
Common mistakes checked: {list}

Remaining manual verification:
- {any manual steps from the plan's verification section}
```

4. For plan-large: update the plan file with a completion note.

## Resuming a Partially Completed Plan

When some increments are already `done`:

1. Skip all `done` increments.
2. If an increment is `in progress`, treat it as the starting point — re-read its files and continue.
3. Before starting new work, run `bun run c` once to validate existing state. If it fails, report to user before proceeding.

## Rules

- **Never skip Step 1** — A fresh session without context produces wrong code. Loading standards and common mistakes is non-negotiable.
- **Never implement ahead of dependencies** — The DAG exists for a reason.
- **Always verify before marking done** — `bun run c` must pass. No exceptions.
- **Update the plan file after every increment** — The plan is the source of truth across sessions.
- **Subagent prompts must be self-contained** — Paste all standards, mistakes, and conventions into the prompt. Subagents cannot read files from the parent context.
- **Do not mix execution with plan modification** — If the plan's design is wrong, stop and tell the user.
