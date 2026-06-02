/**
 * Adversary Review Extension
 *
 * A first-class, least-privilege adversary review of a file, exposed two ways:
 *
 *   - `adversary-review` TOOL — agent-invokable, gated by `--tools` exactly like
 *     `write-research`/`bash-safe`. Only usable inside research mode (it writes
 *     its review into the research workspace).
 *   - `/adversary-pass <file> [--quorum]` COMMAND — human-typed; always present
 *     (commands aren't `--tools`-gated). In research mode the review is saved to
 *     the workspace; otherwise to `./reviews`.
 *
 * Both call one runner that shells out to `adversary-jailed.sh`, which spawns the
 * adversary as a pi session jailed identically to the research agent
 * (read-only repo + `bash-safe` + `write-research`, `--research`). The adversary
 * therefore never has more authority than the agent that invoked it. The
 * invoker's workspace is passed via `PI_RESEARCH_WORKSPACE` so the spawned
 * adversary auto-jails to the SAME workspace and its review lands there; the
 * dispatcher's review file follows the same env var.
 *
 * Why a dedicated tool rather than allowlisting the script in `bash-safe`:
 * `bash-safe` matches programs by basename, so a workspace-planted
 * `adversary-jailed.sh` would execute — a jailbreak. A purpose-built tool whose
 * only effect is "spawn a jailed read-only reviewer that writes into the
 * workspace" keeps the jail invariant intact.
 *
 * `PI_ADVERSARY_CHILD=1` is set on the spawned process and refused by the tool,
 * so an adversary can't recursively trigger another adversary review.
 */

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { homedir } from "node:os";

// ---------------------------------------------------------------------------
// Pure helpers (exported for unit testing; no pi runtime dependency).
// ---------------------------------------------------------------------------

/** Git-diff selectors `adversary-pass.sh` understands but the jailed file
 * reviewer does not — surfaced so callers can give a clear message. */
export function isDiffTarget(target: string): boolean {
  return target === "HEAD" || target === "STAGED" || target.startsWith("RANGE:");
}

/** Parse `<file> [--quorum]` from the raw command argument string. */
export function parseArgs(raw: string): { target: string; quorum: boolean } {
  const toks = raw.trim().split(/\s+/).filter(Boolean);
  let quorum = false;
  const rest: string[] = [];
  for (const t of toks) {
    if (t === "--quorum") quorum = true;
    else rest.push(t);
  }
  return { target: rest[0] ?? "", quorum };
}

/**
 * Resolve the review target to an absolute path the jailed reviewer can read.
 * A relative file is taken relative to the cwd; in research mode, if it isn't
 * found there, it is resolved against the workspace (the research doc lives
 * there). Diff selectors and absolute paths pass through unchanged.
 */
export function resolveTarget(
  target: string,
  opts: { researchActive: boolean; workspace: string | null; cwd: string; exists?: (p: string) => boolean },
): string {
  if (isDiffTarget(target) || isAbsolute(target)) return target;
  const exists = opts.exists ?? existsSync;
  const atCwd = join(opts.cwd, target);
  if (exists(atCwd)) return atCwd;
  if (opts.researchActive && opts.workspace) {
    const atWs = join(opts.workspace, target);
    if (exists(atWs)) return atWs;
  }
  return atCwd; // not found anywhere; let the script report it
}

/** Locate the installed `adversary-jailed.sh` (global install first, then a
 * repo / project-local checkout). */
export function resolveScriptPath(opts: { home?: string; cwd: string; exists?: (p: string) => boolean }): string | null {
  const exists = opts.exists ?? existsSync;
  const home = opts.home ?? homedir();
  const candidates = [
    join(home, ".pi/agent/scripts/adversary-jailed.sh"),
    join(opts.cwd, "scripts/bash/adversary-jailed.sh"),
    join(opts.cwd, ".pi/agent/scripts/adversary-jailed.sh"),
  ];
  for (const c of candidates) if (exists(c)) return c;
  return null;
}

/** Extract the verdict and saved-review path from the script's combined output.
 * Prefers the post-quorum final verdict, then the dispatcher's `Verdict:` line,
 * then the YAML/prose verdict in the review body. */
export function parseReviewOutput(text: string): { verdict: string; reviewPath: string | null } {
  const grab = (re: RegExp): string | null => {
    const m = text.match(re);
    return m ? m[1].toUpperCase() : null;
  };
  const verdict =
    grab(/Final Verdict \(post-quorum\)[^A-Za-z]*?(PASS|CONCERNS|FAIL)/i) ??
    grab(/^[ \t]*Verdict:[ \t]*(PASS|CONCERNS|FAIL)/im) ??
    grab(/^[ \t]*verdict:[ \t]*(PASS|CONCERNS|FAIL)/im) ??
    grab(/\*\*VERDICT:[ \t]*(PASS|CONCERNS|FAIL)\*\*/i) ??
    "UNKNOWN";
  const pm = text.match(/Review written to:[ \t]*(.+)/);
  return { verdict, reviewPath: pm ? pm[1].trim() : null };
}

/** One-line summary for notifications / message display. */
export function summarizeReview(o: { verdict: string; reviewPath: string | null; quorum: boolean; target: string }): string {
  const q = o.quorum ? " (quorum)" : "";
  const where = o.reviewPath ? `\nSaved: ${o.reviewPath}` : "";
  return `Adversary review${q} of ${o.target}: ${o.verdict}${where}`;
}

// ---------------------------------------------------------------------------
// Runner (spawns the jailed reviewer).
// ---------------------------------------------------------------------------

interface RunResult { ok: boolean; verdict: string; reviewPath: string | null; output: string }

function runReview(o: {
  scriptPath: string;
  target: string;
  quorum: boolean;
  workspace: string | null;
  cwd: string;
  signal?: AbortSignal;
}): Promise<RunResult> {
  const args = [o.scriptPath, o.target];
  if (o.quorum) args.push("--quorum");
  const env: NodeJS.ProcessEnv = { ...process.env, PI_ADVERSARY_CHILD: "1" };
  // One env var drives both the child's jail (auto-activates research mode
  // pinned to this workspace) and adversary-jailed.sh's output dir.
  if (o.workspace) env.PI_RESEARCH_WORKSPACE = o.workspace;
  else delete env.PI_RESEARCH_WORKSPACE;
  const timeoutMs = o.quorum ? 1_800_000 : 600_000;

  return new Promise<RunResult>((resolve) => {
    let out = "";
    let settled = false;
    const child = spawn("bash", args, { env, cwd: o.cwd, stdio: ["ignore", "pipe", "pipe"] });
    const onData = (c: Buffer) => { out += c.toString(); };
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);

    const settle = (code: number | null, extra = "") => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (extra) out += `\n${extra}`;
      const { verdict, reviewPath } = parseReviewOutput(out);
      resolve({ ok: code === 0 || reviewPath !== null, verdict, reviewPath, output: out });
    };

    const timer = setTimeout(() => {
      if (settled) return;
      child.kill("SIGTERM");
      settle(null, "[adversary review timed out]");
    }, timeoutMs);

    child.on("close", (code) => settle(code));
    child.on("error", (err) => {
      out += `\nspawn error: ${err.message}`;
      settle(1);
    });
    o.signal?.addEventListener("abort", () => { child.kill("SIGTERM"); settle(null, "[aborted]"); });
  });
}

/** Tail of a long output, for bounded surfacing into context. */
function tail(s: string, n = 2500): string {
  return s.length <= n ? s : `…\n${s.slice(-n)}`;
}

// ---------------------------------------------------------------------------
// Extension
// ---------------------------------------------------------------------------

export default function (pi: any) {
  function researchState(): { active: boolean; workspace: string | null } {
    return {
      active: process.env.PI_RESEARCH_MODE_ACTIVE === "1",
      workspace: process.env.PI_RESEARCH_MODE_WORKSPACE ?? process.env.PI_RESEARCH_WORKSPACE ?? null,
    };
  }

  function notify(ctx: any, message: string, type: "info" | "warning" | "error") {
    if (ctx.hasUI) ctx.ui.notify(message, type);
    else console.error(`[adversary-review] ${message}`);
  }

  const errResult = (text: string) => ({ content: [{ type: "text", text: `Error: ${text}` }], isError: true });

  // --- adversary-review tool (agent-invokable; gated by --tools) -------------
  pi.registerTool({
    name: "adversary-review",
    label: "adversary-review",
    description:
      "Run an independent, read-only adversary review of a file. Spawns a separate " +
      "adversary agent constrained to the SAME research jail you are in (read-only " +
      "repository + this workspace; no shell, no writes outside the workspace). Its " +
      "review — prose + a structured adversary-review block ending in PASS/CONCERNS/FAIL " +
      "— is saved into the workspace. Use it to get an unbiased critique of a research " +
      "doc or source file. Set quorum=true to also run peer reviewers (majority decides) " +
      "when the primary verdict is CONCERNS/FAIL.",
    promptSnippet: "adversary-review: independent jailed adversary review of a file; report saved to the workspace",
    promptGuidelines: [
      "Use adversary-review to get a second, independent opinion on a file you produced — it is read-only and cannot change anything.",
      "The reviewed file may be a workspace path (your research doc) or a repo path; the review is written under <workspace>/reviews/.",
      "Pass quorum=true for higher-stakes reviews; leave it off for a quick single pass.",
    ],
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "File to review. Relative paths resolve against the repo, then the workspace." },
        quorum: { type: "boolean", description: "Also run peer reviewers (majority) when the primary verdict is CONCERNS/FAIL. Default false." },
      },
      required: ["path"],
    },
    execute: async (_toolCallId: string, params: { path: string; quorum?: boolean }, signal: AbortSignal | undefined, _onUpdate: unknown, ctx: any) => {
      if (process.env.PI_ADVERSARY_CHILD === "1" || process.env.PI_RESEARCH_WORKER_CHILD === "1") {
        return errResult("adversary-review is unavailable inside a dispatched jailed child (recursion guard).");
      }
      const { active, workspace } = researchState();
      if (!active || !workspace) {
        return errResult("research mode is not active. adversary-review saves into the research workspace — start with --research or run /research-mode.");
      }
      if (isDiffTarget(params.path)) {
        return errResult(`'${params.path}' is a diff selector; the jailed reviewer takes a file path. Use adversary-pass.sh for HEAD/STAGED/RANGE diffs.`);
      }
      const scriptPath = resolveScriptPath({ cwd: ctx.cwd });
      if (!scriptPath) return errResult("adversary-jailed.sh not found (run install.sh).");
      const target = resolveTarget(params.path, { researchActive: true, workspace, cwd: ctx.cwd });
      const r = await runReview({ scriptPath, target, quorum: !!params.quorum, workspace, cwd: ctx.cwd, signal });
      const summary = summarizeReview({ verdict: r.verdict, reviewPath: r.reviewPath, quorum: !!params.quorum, target: params.path });
      if (!r.ok) return { content: [{ type: "text", text: `Adversary review failed.\n${tail(r.output)}` }], isError: true };
      return { content: [{ type: "text", text: `${summary}\n\n${tail(r.output)}` }] };
    },
  });

  // --- /adversary-pass command (human; always available) ---------------------
  pi.registerCommand("adversary-pass", {
    description: "Run a jailed adversary review of a file (saved to the research workspace if active). Usage: /adversary-pass <file> [--quorum]",
    handler: async (args: string, ctx: any) => {
      const { target, quorum } = parseArgs(args);
      if (!target) { notify(ctx, "Usage: /adversary-pass <file> [--quorum]", "error"); return; }
      const { active, workspace } = researchState();
      const scriptPath = resolveScriptPath({ cwd: ctx.cwd });
      if (!scriptPath) { notify(ctx, "adversary-jailed.sh not found (run install.sh).", "error"); return; }
      const resolved = resolveTarget(target, { researchActive: active, workspace, cwd: ctx.cwd });
      notify(ctx, `Running adversary review of ${target}${quorum ? " (quorum)" : ""}…`, "info");
      const r = await runReview({ scriptPath, target: resolved, quorum, workspace: active ? workspace : null, cwd: ctx.cwd, signal: ctx.signal });
      const summary = summarizeReview({ verdict: r.verdict, reviewPath: r.reviewPath, quorum, target });
      notify(ctx, r.ok ? summary : `Adversary review failed.\n${tail(r.output, 1200)}`, r.ok ? "info" : "error");
      pi.sendMessage({
        customType: "adversary-review",
        content:
          `\n---\n**Adversary review**${quorum ? " (quorum)" : ""} of \`${target}\`: **${r.verdict}**` +
          (r.reviewPath ? `\n> Saved: ${r.reviewPath}` : ""),
        display: true,
      });
    },
  });
}
