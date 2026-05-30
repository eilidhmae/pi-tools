/**
 * Research Mode Extension
 *
 * A jailed, read-only scanning mode with an isolated write space.
 *
 * What it does, and how:
 *  - Registers two custom tools at load time so the `--tools` allowlist can
 *    admit them: `write-research` (writes only inside the workspace) and
 *    `bash-safe` (an ALLOW-ONLY runner — one allowlisted read-only command,
 *    executed directly with no shell; cp only into the workspace).
 *  - `/research-mode` activates the jail mid-session. On activation it
 *    restricts the active tool set to read-only built-ins + the two research
 *    tools (dropping write/edit/bash) and injects a RESEARCH MODE block into
 *    the system prompt so the agent *knows* it is jailed.
 *  - Re-applies the tool restriction and the system-prompt block on every turn
 *    (`before_agent_start`), and blocks mutating built-ins at the call site
 *    (`tool_call`) as a backstop.
 *
 * Protection model (verified against pi 0.77):
 *  - `--tools` is a hard allowlist applied AFTER extensions load. A tool not in
 *    the list is removed from the registry entirely and cannot be restored by
 *    setActiveTools(). So the strongest, harness-level invocation is:
 *
 *        pi --tools read,grep,find,ls,write-research,bash-safe
 *
 *    There the dangerous built-ins never exist. `/research-mode` then only has
 *    to set up the workspace and inject the prompt.
 *  - Without `--tools`, `/research-mode` still enforces the jail at the
 *    extension level (setActiveTools drops write/edit/bash; tool_call blocks
 *    them as a backstop) and warns that this is weaker than the harness gate.
 *
 * Activation paths:
 *  - `/research-mode` (interactive).
 *  - `--research` CLI flag or `PI_RESEARCH_WORKSPACE` env var (auto-activate at
 *    session start; the only way to enter research mode in print/`-p` mode).
 */

import { mkdir, writeFile, realpath, lstat, stat } from "node:fs/promises";
import { dirname, sep, join, isAbsolute } from "node:path";

// ---------------------------------------------------------------------------
// Pure helpers (exported for unit testing; no pi runtime dependency).
// ---------------------------------------------------------------------------

/** Read-only built-in tools kept active in research mode. */
export const READONLY_BUILTINS = ["read", "grep", "find", "ls"];
/** Built-in tools that must be removed in research mode. */
export const MUTATING_BUILTINS = ["write", "edit", "bash"];
/** Custom tools this extension provides. */
export const RESEARCH_TOOLS = ["write-research", "bash-safe"];
/** Harmless built-ins kept if present. */
const KEEP_IF_PRESENT = ["ask_question"];

/**
 * The active tool set we want in research mode, intersected with what is
 * actually available. `--tools` may have already removed some names; we cannot
 * resurrect those, so we only ever keep a subset of `available`.
 */
export function computeDesiredActiveTools(available: string[]): string[] {
  const want = new Set([...READONLY_BUILTINS, ...RESEARCH_TOOLS, ...KEEP_IF_PRESENT]);
  return available.filter((t) => want.has(t));
}

/**
 * Classify the protection level given the tools the harness left available.
 * Drives the warning shown on activation.
 */
export function assessProtection(available: string[]): {
  level: "harness" | "extension" | "degraded";
  exposedMutating: string[];
  missingResearch: string[];
} {
  const set = new Set(available);
  const exposedMutating = MUTATING_BUILTINS.filter((t) => set.has(t));
  const missingResearch = RESEARCH_TOOLS.filter((t) => !set.has(t));
  if (missingResearch.length > 0) return { level: "degraded", exposedMutating, missingResearch };
  if (exposedMutating.length > 0) return { level: "extension", exposedMutating, missingResearch };
  return { level: "harness", exposedMutating, missingResearch };
}

/**
 * ALLOW-ONLY command model for the safe-run tool.
 *
 * The agent's command is NOT handed to a shell. We tokenize it ourselves,
 * reject every shell metacharacter (so there is no redirection, pipe, command
 * substitution, glob, or chaining to interpret), require the program to be on
 * an allowlist of read-only binaries, and run it directly via exec(argv).
 * This is fail-safe by construction: an un-listed program cannot run, and a
 * listed one cannot reach the shell. The only writer permitted is `cp`, and
 * only when its destination resolves inside the workspace. (`mv` is NOT
 * allowed — it deletes the source, a write to the repo.) Flags that turn an
 * otherwise read-only program into a writer/executor are rejected globally
 * (DANGEROUS_FLAGS) or per-program (find/sort/git/yq guards below).
 */

/** Read-only programs. None can write files or spawn a shell on their own. */
export const READONLY_COMMANDS = new Set([
  "cat", "head", "tail", "wc", "stat", "file", "ls", "du", "df",
  "sort", "uniq", "cut", "comm", "diff", "cmp", "grep", "egrep", "fgrep", "rg",
  "find", "date", "basename", "dirname", "realpath", "readlink", "echo",
  "printf", "nl", "fold", "rev", "tac", "paste", "join", "seq", "expand",
  "unexpand", "fmt", "column", "pwd", "which", "type",
  "uname", "hostname", "id", "whoami", "ps", "true", "false", "test",
  "sha256sum", "sha1sum", "shasum", "md5", "md5sum", "cksum",
  "hexdump", "od", "strings", "jq", "yq",
]);
// NOTE: deliberately excluded because a flag turns them into a writer/executor
// with no read-only-only value here: `env`/`printenv` (`env sh -c …` execs any
// program), `tree` (`-o FILE` writes), `xxd` (`-r` writes — use od/hexdump to
// read). `rg`/`sort`/`git` stay but are flag-guarded below.
/** find actions that write or execute — rejected even though find is allowed. */
const FIND_WRITE_ACTIONS = new Set(["-exec", "-execdir", "-ok", "-okdir", "-delete", "-fprint", "-fprint0", "-fprintf", "-fls"]);
/** git subcommands that only read. */
export const GIT_READONLY_SUBCOMMANDS = new Set([
  "log", "show", "diff", "status", "blame", "ls-files", "ls-tree", "cat-file",
  "rev-parse", "rev-list", "describe", "shortlog", "grep", "whatchanged",
  "show-ref", "for-each-ref", "name-rev", "merge-base", "branch", "tag", "config",
]);
// NOTE: `remote` and `reflog` are deliberately NOT read-only — `git remote add`
// writes .git/config, `git remote update` fetches, `git reflog expire` deletes
// history. Their read forms aren't worth a sub-subcommand guard here.
/** Programs that write but only into the workspace (destination validated).
 * `cp` only — `mv` would delete the source (a repo write), so it is excluded. */
const COPY_COMMANDS = new Set(["cp"]);
/**
 * Flags that make an otherwise read-only program write a file or exec another
 * program; rejected for EVERY command since none have a read-only use among
 * the allowlisted tools: `--output=FILE` (git/sort/…), `--pre`/`--hostname-bin`
 * (rg subprocess), `--open-files-in-pager` (git grep pager exec), `--exec-path`
 * (git external-subcommand dir), `--config-env` (git runtime config). Ambiguous
 * short flags (`-o`, `-O`, `-r`) are handled per-program below, because their
 * meaning differs across tools (grep -o vs sort -o; find -O<level> vs git grep -O<cmd>).
 */
const DANGEROUS_FLAGS = ["--output", "--pre", "--open-files-in-pager", "--exec-path", "--hostname-bin", "--config-env"];
function dangerousFlag(argv: string[]): string | null {
  for (const a of argv.slice(1)) {
    for (const f of DANGEROUS_FLAGS) if (a === f || a.startsWith(`${f}=`)) return a;
  }
  return null;
}

/**
 * Tokenize a command line into argv WITHOUT a shell. Supports single/double
 * quotes; rejects any shell-significant character outside quotes (so nothing
 * is left for a shell to interpret) and rejects `$`/backtick even inside double
 * quotes (substitution). Returns argv or an error.
 */
export function parseCommand(command: string): { argv: string[] } | { error: string } {
  const argv: string[] = [];
  let cur = "";
  let curStarted = false;
  let i = 0;
  // Chars a shell would act on: pipes/redirection/subshell/glob/chaining. We
  // never invoke a shell, so these can only mean the agent wants behavior we
  // don't provide — reject with guidance. ($/backtick/\\ handled separately.)
  // '~' and '!' are allowed as literals (e.g. HEAD~1, `find ! -name`).
  const meta = "|&;<>()*?[\n\r";
  while (i < command.length) {
    const ch = command[i];
    if (ch === "'") {
      curStarted = true;
      i++;
      while (i < command.length && command[i] !== "'") cur += command[i++];
      if (i >= command.length) return { error: "unterminated single quote" };
      i++; // closing '
      continue;
    }
    if (ch === '"') {
      curStarted = true;
      i++;
      while (i < command.length && command[i] !== '"') {
        if (command[i] === "$" || command[i] === "`" || command[i] === "\\") {
          return { error: "variable/command substitution and escapes are not allowed" };
        }
        cur += command[i++];
      }
      if (i >= command.length) return { error: "unterminated double quote" };
      i++; // closing "
      continue;
    }
    if (ch === " " || ch === "\t") {
      if (curStarted) { argv.push(cur); cur = ""; curStarted = false; }
      i++;
      continue;
    }
    if (ch === "$" || ch === "`" || ch === "\\") {
      return { error: "variable/command substitution and escapes are not allowed" };
    }
    if (meta.includes(ch)) {
      return { error: `'${ch}' is not allowed — run one read-only command at a time (no pipes, redirection, globs, or chaining)` };
    }
    cur += ch;
    curStarted = true;
    i++;
  }
  if (curStarted) argv.push(cur);
  if (argv.length === 0) return { error: "empty command" };
  return { argv };
}

/**
 * Classify a parsed argv. Returns the program category, or an error if the
 * program is not allowed / used in a write-capable way. For copy commands the
 * destination (last argument) is returned for the caller to validate against
 * the workspace.
 */
export function classifyCommand(argv: string[]): { kind: "readonly" } | { kind: "copy"; dest: string } | { error: string } {
  const bin = (argv[0].split("/").pop() || argv[0]);
  // Global gate: a write/exec flag is rejected for every program.
  const danger = dangerousFlag(argv);
  if (danger) return { error: `'${danger}' can write a file or execute a program and is not allowed` };
  if (READONLY_COMMANDS.has(bin)) {
    if (bin === "find" && argv.some((a) => FIND_WRITE_ACTIONS.has(a))) {
      return { error: "find with -exec/-delete/-fprint (write or execute actions) is not allowed" };
    }
    if (bin === "yq" && argv.some((a) => a === "-i" || a === "--inplace")) {
      return { error: "yq -i/--inplace edits files in place and is not allowed" };
    }
    if (bin === "sort" && argv.some((a) => a === "-o" || a.startsWith("-o"))) {
      return { error: "sort -o/--output writes a file and is not allowed" };
    }
    if (bin === "git") return { error: "git is handled separately" }; // (git not in READONLY set)
    return { kind: "readonly" };
  }
  if (bin === "git") {
    const sub = argv.slice(1).find((a) => !a.startsWith("-"));
    if (!sub || !GIT_READONLY_SUBCOMMANDS.has(sub)) {
      return { error: `git '${sub ?? ""}' is not a read-only subcommand` };
    }
    // Guard the few read subcommands that have write-capable option forms.
    if (sub === "config" && !argv.some((a) => a === "--get" || a === "--list" || a === "-l" || a === "--get-all")) {
      return { error: "git config is only allowed with --get/--get-all/--list" };
    }
    if ((sub === "branch" || sub === "tag") && !argv.some((a) => a === "--list" || a === "-l") && argv.slice(2).some((a) => !a.startsWith("-"))) {
      return { error: `git ${sub} is only allowed in list form (--list)` };
    }
    // git grep -O<cmd> / --open-files-in-pager opens matches in an arbitrary
    // program (--open-files-in-pager is caught globally; -O is the short form).
    if (sub === "grep" && argv.some((a) => a === "-O" || /^-O./.test(a))) {
      return { error: "git grep -O/--open-files-in-pager executes a program and is not allowed" };
    }
    return { kind: "readonly" };
  }
  if (COPY_COMMANDS.has(bin)) {
    if (argv.some((a) => a === "-t" || a === "--target-directory")) {
      return { error: `${bin} -t/--target-directory is not allowed (destination must be the final argument)` };
    }
    const operands = argv.slice(1).filter((a) => !a.startsWith("-"));
    if (operands.length < 2) return { error: `${bin} needs a source and a destination` };
    return { kind: "copy", dest: operands[operands.length - 1] };
  }
  return { error: `'${bin}' is not an allowed command. Allowed: read-only tools (cat, ls, grep, find, wc, stat, diff, sort, jq, …), read-only git, and cp into the workspace.` };
}

/** The RESEARCH MODE block prepended to the system prompt while jailed. */
export function buildResearchSystemPrompt(workspace: string): string {
  return [
    "# RESEARCH MODE (read-only jail) — ACTIVE",
    "",
    "You are operating in research mode. The repository is READ-ONLY to you.",
    "",
    "What you MAY do:",
    "- Read/inspect any file with `read`, `grep`, `find`, `ls`.",
    "- Run ONE read-only command per call with `bash-safe` (no shell: no pipes,",
    "  redirection, globs, or chaining — use `grep`/`find` directly). It also",
    "  permits read-only `git` and `cp` whose destination is the workspace.",
    "- Write notes, scripts, prototypes, and snapshots ONLY inside your",
    "  isolated workspace via the `write-research` tool.",
    "",
    "What you MUST NOT do:",
    "- Do NOT modify, create, or delete files in the repository.",
    "- The `write` and `edit` tools and raw `bash` are disabled; if you reach",
    "  for them, use `write-research` / `bash-safe` instead.",
    "- To test a change to a repo file, copy it into the workspace (`cp <file>",
    "  <workspace>` via bash-safe, or recreate it with write-research), modify",
    "  the copy, and experiment there.",
    "",
    `Your workspace (the ONLY writable location): ${workspace}`,
    "Reference files there by relative path (e.g. `notes.md`) with write-research.",
  ].join("\n");
}

/**
 * Resolve a write-research request path to an absolute path that must live
 * inside `workspace`. Relative paths are taken relative to the workspace root.
 * Returns the absolute path, or an error string if it escapes / is malformed.
 * Caller still performs a realpath containment check for symlink safety.
 */
export function resolveWorkspacePath(requested: string, workspace: string): { path: string } | { error: string } {
  // Reject a ".." path *component* (traversal). A bare substring check would
  // also reject legitimate names like "v1..v2.patch"; the realpath containment
  // check in writeIntoWorkspace is the real guard, this is defense-in-depth.
  if (requested.split("/").includes("..")) {
    return { error: "Path cannot contain a '..' component (directory traversal not allowed)" };
  }
  const path = requested.startsWith("/") ? requested : `${workspace}/${requested}`;
  return { path };
}

/**
 * Write `content` to `requested` (relative to `workspace`, or absolute but it
 * must resolve inside `workspace`). Symlink-safe: the parent dir's realpath
 * must be contained in the workspace, and an existing symlink at the leaf is
 * refused. Returns the written absolute path or an error. Exported for tests.
 */
export async function writeIntoWorkspace(
  requested: string,
  content: string,
  workspace: string,
): Promise<{ ok: true; path: string } | { ok: false; error: string }> {
  const resolved = resolveWorkspacePath(requested, workspace);
  if ("error" in resolved) return { ok: false, error: resolved.error };
  const target = resolved.path;
  try {
    const parent = dirname(target);
    await mkdir(parent, { recursive: true });
    const realParent = await realpath(parent);
    const realRoot = await realpath(workspace);
    if (!(realParent === realRoot || realParent.startsWith(realRoot + sep))) {
      return { ok: false, error: `"${requested}" resolves under "${realParent}", outside the workspace "${realRoot}".` };
    }
    try {
      if ((await lstat(target)).isSymbolicLink()) {
        return { ok: false, error: `"${requested}" is a symlink; refusing to follow it out of the workspace.` };
      }
    } catch { /* leaf does not exist yet — fine */ }
    await writeFile(target, content, "utf8");
    return { ok: true, path: target };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}

/**
 * True if a cp destination would write inside `workspace`. The container is
 * the destination itself when it is an existing directory, else its parent
 * dir; that container's real path must be within the workspace's real path.
 */
export async function destInWorkspace(dest: string, workspace: string, cwd: string): Promise<boolean> {
  const abs = isAbsolute(dest) ? dest : join(cwd, dest);
  let container = abs;
  try {
    if (!(await stat(abs)).isDirectory()) container = dirname(abs);
  } catch {
    container = dirname(abs);
  }
  try {
    const rc = await realpath(container);
    const rw = await realpath(workspace);
    return rc === rw || rc.startsWith(rw + sep);
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Extension
// ---------------------------------------------------------------------------

export default function (pi: ExtensionAPI) {
  const piExec = pi.exec;

  let researchActive = false;
  let workspace: string | null = null;
  let workspaceFromEnv = false;
  // Snapshot of the active tool set at activation, restored on exit.
  let savedActiveTools: string[] | null = null;

  pi.registerFlag("research", {
    type: "boolean",
    description: "Start in research mode (read-only jail with an isolated write workspace).",
  });

  // --- write-research --------------------------------------------------------
  pi.registerTool({
    name: "write-research",
    label: "write-research",
    description:
      "Write a file into the isolated research workspace. The repository is " +
      "read-only; this is your ONLY way to persist files. Use a relative path " +
      "from the workspace root (e.g. 'notes.md' or 'src/copy.go'); absolute " +
      "paths must still resolve inside the workspace.",
    promptSnippet: "write-research: write files into your isolated research workspace (the only writable location)",
    promptGuidelines: [
      "Use write-research (not write/edit) to save notes, scripts, or copies of repo files for experimentation.",
      "Paths are relative to the research workspace; '..' and paths outside the workspace are rejected.",
    ],
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "Relative path within the workspace (e.g. 'notes.md'). Absolute paths must resolve inside the workspace." },
        content: { type: "string", description: "File content to write." },
      },
      required: ["path", "content"],
    },
    execute: async (_toolCallId, params, _signal, _onUpdate, _ctx) => {
      if (!researchActive || !workspace) {
        return { content: [{ type: "text", text: "Error: research mode is not active. Run /research-mode to activate." }] };
      }
      const res = await writeIntoWorkspace(params.path, params.content, workspace);
      if (res.ok) {
        return { content: [{ type: "text", text: `Wrote ${res.path} (${params.content.length} bytes)` }] };
      }
      return { content: [{ type: "text", text: `Error: ${res.error}` }], isError: true };
    },
  });

  // --- bash-safe (allow-only command runner; NO shell) -----------------------
  pi.registerTool({
    name: "bash-safe",
    label: "bash-safe",
    description:
      "Run ONE read-only command. There is NO shell: no pipes, redirection, " +
      "globs, command substitution, or chaining (run a single command per call). " +
      "Allowed: read-only tools (cat, head, tail, wc, stat, file, ls, du, " +
      "sort, uniq, cut, diff, cmp, grep, rg, find, jq, od, strings, sha256sum, " +
      "…), read-only git (log, show, diff, status, blame, ls-files, …), and " +
      "cp whose destination is inside the research workspace. Anything else " +
      "is rejected. Use grep/find directly instead of piping.",
    promptSnippet: "bash-safe: run ONE allowlisted read-only command (no shell, no pipes); cp only into the workspace",
    promptGuidelines: [
      "bash-safe runs a single program directly with no shell — no pipes/redirection/globs. Use `grep pattern file`, `sort -u file`, `find <dir> -name '...'` rather than chaining.",
      "To bring a repo file into the workspace, use `cp <src> <workspace>/...`; to write new content use write-research.",
    ],
    parameters: {
      type: "object",
      properties: {
        command: { type: "string", description: "A single read-only command, e.g. \"grep -n foo src/x.go\". No pipes/redirection/globs." },
        description: { type: "string", description: "Brief description of the command." },
      },
      required: ["command"],
    },
    execute: async (_toolCallId, params, _signal, _onUpdate, ctx) => {
      if (!researchActive || !workspace) {
        return { content: [{ type: "text", text: "Error: research mode is not active." }], isError: true };
      }
      const parsed = parseCommand(params.command);
      if ("error" in parsed) {
        return { content: [{ type: "text", text: `Rejected: ${parsed.error}` }], isError: true };
      }
      const cls = classifyCommand(parsed.argv);
      if ("error" in cls) {
        return { content: [{ type: "text", text: `Rejected: ${cls.error}` }], isError: true };
      }
      if (cls.kind === "copy") {
        const okDest = await destInWorkspace(cls.dest, workspace, ctx.cwd);
        if (!okDest) {
          return { content: [{ type: "text", text: `Rejected: destination "${cls.dest}" is not inside the workspace (${workspace}). cp may only write into the workspace.` }], isError: true };
        }
      }
      // Run the program directly — no shell is involved.
      const res = await piExec(parsed.argv[0], parsed.argv.slice(1));
      const body = res.stdout || res.stderr || "(no output)";
      const text = res.code === 0 ? body : `${body}\n[exit code ${res.code}]`;
      return { content: [{ type: "text", text }], isError: res.code !== 0 };
    },
  });

  // --- activation / enforcement ---------------------------------------------

  function applyToolRestriction() {
    const available = pi.getAllTools().map((t) => t.name);
    pi.setActiveTools(computeDesiredActiveTools(available));
  }

  async function resolveWorkspaceDir(): Promise<string | null> {
    const env = process.env.PI_RESEARCH_WORKSPACE;
    if (env) {
      workspaceFromEnv = true;
      const exists = await piExec("test", ["-d", env]);
      if (exists.code !== 0) {
        const made = await piExec("mkdir", ["-p", env]);
        if (made.code !== 0) return null;
      }
      return env;
    }
    workspaceFromEnv = false;
    const mk = await piExec("mktemp", ["-d", "-t", "pi-research-XXXXXX"]);
    if (mk.code === 0) return mk.stdout.trim();
    const fallback = `${process.env.TMPDIR || "/tmp"}/pi-research-${process.pid}`;
    await piExec("mkdir", ["-p", fallback]);
    return fallback;
  }

  function renderWidget(ctx: any) {
    if (!ctx.hasUI) return;
    if (!researchActive || !workspace) {
      ctx.ui.setWidget("research-mode", undefined);
      ctx.ui.setStatus("research-mode", undefined);
      return;
    }
    const theme = ctx.ui.theme;
    const src = workspaceFromEnv ? theme.fg("muted", "   [from PI_RESEARCH_WORKSPACE]") : "";
    ctx.ui.setWidget("research-mode", [
      theme.fg("accent", theme.bold("🔒 Research Mode — read-only jail")),
      theme.fg("text", `   Workspace: ${theme.fg("success", workspace)}`),
      src,
      theme.fg("dim", "   Tools: write-research, bash-safe   (write/edit/bash disabled)"),
      theme.fg("dim", "   /research-mode {status|exit|list|open|path|summary}"),
    ].filter(Boolean) as string[]);
    ctx.ui.setStatus("research-mode", theme.fg("accent", `🔒 ${workspace.split("/").pop()}`));
  }

  function warnProtection(ctx: any) {
    const available = pi.getAllTools().map((t) => t.name);
    const a = assessProtection(available);
    if (a.level === "harness") {
      notify(ctx, "✅ Research mode: harness-level protection active (write/edit/bash are absent from --tools).", "info");
      return;
    }
    if (a.level === "degraded") {
      notify(
        ctx,
        `⚠️ Research tools unavailable: --tools excluded ${a.missingResearch.join(", ")}, and the extension cannot restore them.\n` +
          "Restart with:\n  pi --tools read,grep,find,ls,write-research,bash-safe",
        "error",
      );
      return;
    }
    notify(
      ctx,
      "⚠️ No --tools restriction detected. Research mode is enforced at the extension level only\n" +
        `(write/edit/bash deactivated + blocked: ${a.exposedMutating.join(", ")}), which a reload could weaken.\n` +
        "For defense-in-depth restart with:\n  pi --tools read,grep,find,ls,write-research,bash-safe",
      "warning",
    );
  }

  function notify(ctx: any, message: string, type: "info" | "warning" | "error") {
    if (ctx.hasUI) ctx.ui.notify(message, type);
    else console.error(`[research-mode] ${message}`);
  }

  async function activate(ctx: any) {
    if (researchActive) {
      notify(ctx, `Research mode already active.\nWorkspace: ${workspace}\nUse /research-mode exit to leave.`, "info");
      renderWidget(ctx);
      return;
    }
    const dir = await resolveWorkspaceDir();
    if (!dir) {
      notify(ctx, "Error: could not create a research workspace.", "error");
      return;
    }
    // Canonicalize so the path shown to the agent matches where files land and
    // the containment check operates on a fully-resolved root.
    try { workspace = await realpath(dir); } catch { workspace = dir; }
    savedActiveTools = pi.getActiveTools();
    researchActive = true;
    // Same-process signal other extensions (e.g. default-role) can read to tell
    // "research is active" apart from "tools merely restricted".
    process.env.PI_RESEARCH_MODE_ACTIVE = "1";
    applyToolRestriction();
    renderWidget(ctx);
    warnProtection(ctx);
    notify(ctx, `🔒 Research mode active. Workspace: ${workspace}`, "info");
  }

  function deactivate(ctx: any) {
    researchActive = false;
    delete process.env.PI_RESEARCH_MODE_ACTIVE;
    if (savedActiveTools) {
      try { pi.setActiveTools(savedActiveTools); } catch { /* tool set may be fixed by --tools */ }
    }
    savedActiveTools = null;
    renderWidget(ctx);
    notify(ctx, "Research mode exited. Prior tool set restored.", "info");
  }

  // --- command ---------------------------------------------------------------
  pi.registerCommand("research-mode", {
    description: "Toggle a read-only research jail with an isolated write workspace.",
    handler: async (args, ctx) => {
      const sub = args.trim().toLowerCase();

      if (sub === "exit" || sub === "off") {
        if (!researchActive) { notify(ctx, "Research mode is not active.", "info"); return; }
        deactivate(ctx);
        return;
      }
      if (sub === "status") {
        if (!researchActive) { notify(ctx, "Research mode: INACTIVE. Run /research-mode to activate.", "info"); return; }
        notify(ctx, `Research mode: ACTIVE\nWorkspace: ${workspace}`, "info");
        warnProtection(ctx);
        return;
      }

      if (["list", "open", "path", "summary"].includes(sub)) {
        if (!researchActive || !workspace) { notify(ctx, "Research mode is not active.", "error"); return; }
        // workspace is passed as an argv argument (never interpolated into a
        // shell string) so a path containing shell metacharacters cannot inject.
        if (sub === "list") {
          const r = await piExec("ls", ["-la", workspace]);
          notify(ctx, `Workspace (${workspace}):\n${r.stdout.trim() || "(empty)"}`, "info");
        } else if (sub === "open") {
          const opener = process.platform === "darwin" ? "open" : "xdg-open";
          await piExec(opener, [workspace]);
          notify(ctx, `Opened ${workspace}`, "info");
        } else if (sub === "path") {
          // (clipboard copy dropped — it required piping the path through a
          // shell, which reintroduced an injection vector; the path is shown.)
          notify(ctx, `Workspace path: ${workspace}`, "info");
        } else if (sub === "summary") {
          const r = await piExec("find", [workspace, "-type", "f"]);
          const files = r.stdout.split("\n").filter(Boolean).slice(0, 20).join("\n");
          notify(ctx, files ? `Files:\n${files}` : "No files written yet.", "info");
        }
        return;
      }

      // No / unknown subcommand → activate.
      await activate(ctx);
    },
  });

  // --- lifecycle -------------------------------------------------------------

  // Auto-activate for print mode / resume workflows where no command can be typed.
  pi.on("session_start", async (event, ctx) => {
    if (event.reason !== "startup" && event.reason !== "resume") return;
    const flag = pi.getFlag("research") === true;
    const env = !!process.env.PI_RESEARCH_WORKSPACE;
    if ((flag || env) && !researchActive) {
      await activate(ctx);
    }
  });

  // Re-apply the jail every turn: restrict tools and inject the system prompt.
  pi.on("before_agent_start", async (event, _ctx) => {
    if (!researchActive || !workspace) return;
    applyToolRestriction();
    return { systemPrompt: `${buildResearchSystemPrompt(workspace)}\n\n${event.systemPrompt}` };
  });

  // Backstop: block mutating built-ins if one is somehow still callable.
  pi.on("tool_call", async (event, _ctx) => {
    if (!researchActive) return;
    if (MUTATING_BUILTINS.includes(event.toolName)) {
      const alt = event.toolName === "bash" ? "bash-safe" : "write-research";
      return { block: true, reason: `research mode: ${event.toolName} is disabled. Use ${alt} instead.` };
    }
  });

  pi.on("session_shutdown", async (event, ctx) => {
    // Clear the same-process signal so a later session in this process (e.g.
    // after /reload) is not misread as research-active by other extensions.
    delete process.env.PI_RESEARCH_MODE_ACTIVE;
    if (researchActive && workspace) {
      // A reload spins up a fresh extension instance with researchActive=false
      // and does not re-trigger auto-activation, so the jail silently drops.
      if (event.reason === "reload") {
        notify(ctx, "⚠️ Research mode does NOT survive /reload — run /research-mode again after it completes.", "warning");
      }
      notify(ctx, `Research output saved to: ${workspace}`, "info");
    }
  });
}
