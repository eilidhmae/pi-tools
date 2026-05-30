/**
 * Research Mode Extension
 *
 * A jailed, read-only scanning mode with an isolated write space.
 *
 * What it does, and how:
 *  - Registers two custom tools at load time so the `--tools` allowlist can
 *    admit them: `write-research` (writes only inside the workspace) and
 *    `bash-safe` (best-effort read-only shell).
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

import { mkdir, writeFile, realpath, lstat } from "node:fs/promises";
import { dirname, sep } from "node:path";

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
 * Return a reason string if `command` is unsafe for read-only research, or
 * null if it is allowed. This is a DENYLIST and therefore best-effort — the
 * real boundary is `--tools` excluding `bash` entirely. `mktemp -d` is allowed
 * as a vetted exception so the agent can make scratch directories.
 */
export function bashSafetyError(command: string): string | null {
  const cmd = command.trim();

  // Vetted exception: mktemp for scratch dirs, with strict flags.
  if (/^mktemp\b/.test(cmd) || /\bmktemp\b/.test(cmd)) {
    if (/\s-u\b/.test(cmd)) return "mktemp -u (dry-run) is not allowed";
    if (!/\s-d\b/.test(cmd)) return "mktemp must use -d (directory) flag";
    if (!/\s-t\b/.test(cmd) && !/\s-p\b/.test(cmd)) return "mktemp must use -t (prefix) or -p (tmpdir) flag";
    const prefix = cmd.match(/-t\s+([^\s-]+)/);
    if (prefix && !/^[a-zA-Z][a-zA-Z0-9_-]*$/.test(prefix[1])) {
      return "mktemp prefix must start with a letter and be alphanumeric/_/- only";
    }
    return null;
  }

  const blocked: Array<[RegExp, string]> = [
    // Any '>' is treated as a write/redirect (incl. 2>file, &>, >|, >&). A
    // read-only command has no legitimate need for it; fail safe.
    [/>/, "output redirection ('>') is not allowed"],
    // File mutation utilities.
    [/\brm\b/, "rm is not allowed"],
    [/\bmv\b/, "mv is not allowed"],
    [/\b(cp|scp|rsync|sftp)\b/, "file-copy commands are not allowed"],
    [/\btouch\b/, "touch is not allowed"],
    [/\btruncate\b/, "truncate is not allowed"],
    // tee only matters as a writer when fed a pipe (`cmd | tee file`); matching
    // it as a bare word would block reading a file whose name contains "tee".
    [/(^|\|)\s*tee\b/, "tee writes files; not allowed"],
    [/\bdd\b/, "dd is not allowed"],
    [/\bln\b/, "ln is not allowed"],
    [/\bmkdir\b/, "mkdir is not allowed (use write-research)"],
    [/\bmkfifo\b/, "mkfifo is not allowed"],
    [/\bchmod\b/, "chmod is not allowed"],
    [/\bchown\b/, "chown is not allowed"],
    [/\bchflags\b/, "chflags is not allowed"],
    // Network fetchers that write files. Matched in command position so a file
    // named e.g. wget.log can still be read.
    [/(^|[;&|]\s*)wget\b/, "wget downloads/writes files; not allowed"],
    [/\bcurl\b[^|]*\s-(o|O|-output)\b/, "curl -o/-O writes files; not allowed"],
    // In-place editors / stream-edit-in-place.
    [/\b(vim?|nano|emacs|ed|pico)\b/, "interactive editors are not allowed"],
    [/\bsed\b[^|]*\s-i\b/, "sed -i edits in place; not allowed"],
    [/\bperl\b[^|]*\s-i/, "perl -i edits in place; not allowed"],
    // find that writes/executes.
    [/\bfind\b[^|]*-delete\b/, "find -delete is not allowed"],
    [/\bfind\b[^|]*-exec\b/, "find -exec is not allowed (could mutate)"],
    [/\bfind\b[^|]*-fprint/, "find -fprint writes files; not allowed"],
    // xargs feeding a mutator.
    [/\bxargs\b[^|]*\b(rm|mv|cp|tee|dd|truncate|chmod|chown|ln)\b/, "xargs into a mutating command is not allowed"],
    // Package managers / installers.
    [/\bnpm\s+(install|i|add|remove|rm|unlink|update|ci)\b/, "npm mutation is not allowed"],
    [/\b(yarn|pnpm)\s+(add|remove|up|update|install)\b/, "yarn/pnpm mutation is not allowed"],
    [/\bpip3?\s+(install|uninstall|upgrade)\b/, "pip mutation is not allowed"],
    [/\bcargo\s+(install|update|add|remove)\b/, "cargo mutation is not allowed"],
    [/\b(brew|apt|apt-get|yum|dnf|port)\s+(install|remove|upgrade|update)\b/, "system package mutation is not allowed"],
    // git mutations.
    [/\bgit\s+(commit|push|add|rm|mv|reset|restore|checkout|switch|merge|rebase|apply|stash|clean|tag|branch\s+-[dD]|config)\b/, "git mutation is not allowed"],
    // Interpreters invoked with an eval flag can write files arbitrarily.
    [/\b(python3?|node|ruby|perl|php)\b[^|]*\s-(c|e)\b/, "running an interpreter with -c/-e is not allowed"],
    // Privilege / piping into a shell / network-to-shell.
    [/\bsudo\b/, "sudo is not allowed"],
    [/\bdoas\b/, "doas is not allowed"],
    [/\|\s*(sh|bash|zsh|python3?|node|perl|ruby)\b/, "piping into an interpreter is not allowed"],
    [/\b(curl|wget|fetch)\b[^|]*\|\s*(sh|bash)\b/, "downloading into a shell is not allowed"],
    // Here-docs/here-strings (can write files).
    [/<<-?\s*['"]?[A-Za-z_]/, "here-documents are not allowed"],
  ];

  for (const [re, reason] of blocked) {
    if (re.test(cmd)) return reason;
  }
  return null;
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
    "- Run read-only shell commands with the `bash-safe` tool.",
    `- Write notes, scripts, prototypes, and snapshots ONLY inside your`,
    `  isolated workspace via the \`write-research\` tool.`,
    "",
    "What you MUST NOT do:",
    "- Do NOT modify, create, or delete files in the repository.",
    "- The `write` and `edit` tools and raw `bash` are disabled; if you reach",
    "  for them, use `write-research` / `bash-safe` instead.",
    "- To test a change to a repo file, copy it into the workspace with",
    "  `write-research`, modify the copy, and experiment there.",
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

  // --- bash-safe -------------------------------------------------------------
  pi.registerTool({
    name: "bash-safe",
    label: "bash-safe",
    description:
      "Run a READ-ONLY shell command. File-mutating commands, redirection, " +
      "package managers, git mutations, editors, sudo, and pipe-to-shell are " +
      "blocked. Allowed exception: `mktemp -d -t <prefix>`. Use for ls, cat, " +
      "grep, find, stat, head, tail, wc, tree, du, ps, etc.",
    promptSnippet: "bash-safe: run read-only shell commands (mutations and redirection are blocked)",
    promptGuidelines: [
      "Use bash-safe instead of bash; it permits inspection but blocks anything that writes files.",
    ],
    parameters: {
      type: "object",
      properties: {
        command: { type: "string", description: "Read-only shell command to run." },
        description: { type: "string", description: "Brief description of the command." },
      },
      required: ["command"],
    },
    execute: async (_toolCallId, params, _signal, _onUpdate, _ctx) => {
      const reason = bashSafetyError(params.command);
      if (reason) {
        return { content: [{ type: "text", text: `BLOCKED (${reason}). Use read-only commands; write files with write-research.` }], isError: true };
      }
      const res = await piExec("bash", ["-c", params.command]);
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
    applyToolRestriction();
    renderWidget(ctx);
    warnProtection(ctx);
    notify(ctx, `🔒 Research mode active. Workspace: ${workspace}`, "info");
  }

  function deactivate(ctx: any) {
    researchActive = false;
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
        if (sub === "list") {
          const r = await piExec("bash", ["-c", `ls -la "${workspace}" 2>/dev/null || echo "(empty)"`]);
          notify(ctx, `Workspace (${workspace}):\n${r.stdout}`, "info");
        } else if (sub === "open") {
          const opener = process.platform === "darwin" ? "open" : "xdg-open";
          await piExec(opener, [workspace]);
          notify(ctx, `Opened ${workspace}`, "info");
        } else if (sub === "path") {
          if (process.platform === "darwin") await piExec("bash", ["-c", `printf %s "${workspace}" | pbcopy`]);
          notify(ctx, `Workspace path: ${workspace}`, "info");
        } else if (sub === "summary") {
          const r = await piExec("bash", ["-c", `find "${workspace}" -type f -exec ls -lh {} \\; 2>/dev/null | head -20`]);
          notify(ctx, r.stdout.trim() ? `Files:\n${r.stdout}` : "No files written yet.", "info");
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
