/**
 * Coder Worker Extension
 *
 * Dispatch an implementation worker that reads a plan + the target sources and
 * WRITES THE REAL REPOSITORY (write/edit/bash), following test-driven
 * development. It is the implementing sibling of the read-only research/planner
 * workers, exposed two ways (mirroring planner-worker.ts):
 *
 *   - `coder-worker` TOOL — agent-invokable, gated by `--tools` exactly like
 *     `planner-worker`/`research-worker`. Lets the session agent spawn the
 *     implementor itself.
 *   - `/implement "<prompt>" [--label <slug>]` COMMAND — human-typed; always
 *     present (commands aren't `--tools`-gated).
 *
 * Both call one runner that shells out to `coder-run.sh`. Unlike the read-only
 * workers this worker is NOT jailed: it gets `read,grep,find,ls,write,edit,bash`
 * and its system prompt is the existing `worker` skill (TDD: write a failing
 * test, implement, run the test, report the evidence). Its safety is the
 * container-harness confinement of the session it runs in — so it MUST run in a
 * writable, NON-research session (ideally inside the container-harness). There
 * is no workspace artifact: the deliverable is the working-tree change itself,
 * which `coder-run.sh` surfaces via a read-only `git diff --stat` / `status`.
 *
 * FAIL-HARD IN RESEARCH MODE (the inverse of the read-only workers). Research
 * mode is read-only; there is no writable session path for the implementor to
 * write into. So the FIRST guard refuses when `PI_RESEARCH_WORKSPACE` /
 * `PI_RESEARCH_MODE_WORKSPACE` is set — fail loud rather than silently dry-run
 * into a workspace and look like it implemented something. `coder-run.sh`
 * repeats the guard (belt-and-suspenders).
 *
 * Recursion is prevented by the recursion guard: the spawned process carries
 * `PI_CODER_CHILD=1`; the tool refuses when that (or the sibling
 * `PI_PLANNER_CHILD`/`PI_RESEARCH_WORKER_CHILD`/`PI_ADVERSARY_CHILD`) is set, so
 * a dispatched child cannot auto-dispatch another agent. The `/implement`
 * command is the human entry point and is always available.
 */

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

// ---------------------------------------------------------------------------
// Pure helpers (exported for unit testing; no pi runtime dependency).
// ---------------------------------------------------------------------------

/**
 * Parse the raw command argument into a prompt and an optional label.
 * Strips one matching pair of outer quotes around the whole argument (so the
 * documented `/implement "<prompt>"` form works), and pulls a leading
 * `--label=<slug>` or `--label <slug>` off the front. The remainder, trimmed,
 * is the prompt.
 */
export function parsePrompt(raw: string): { prompt: string; label: string | null } {
  let s = raw.trim();
  let label: string | null = null;
  // Leading --label=slug or --label slug (before the prompt text).
  const eq = s.match(/^--label=(\S+)\s*/);
  if (eq) { label = eq[1]; s = s.slice(eq[0].length); }
  else {
    const sp = s.match(/^--label\s+(\S+)\s*/);
    if (sp) { label = sp[1]; s = s.slice(sp[0].length); }
  }
  s = s.trim();
  // Strip a single matching pair of outer quotes.
  if (s.length >= 2 && ((s[0] === '"' && s[s.length - 1] === '"') || (s[0] === "'" && s[s.length - 1] === "'"))) {
    s = s.slice(1, -1);
  }
  return { prompt: s.trim(), label };
}

/** Locate the installed `coder-run.sh` (global install first, then a
 * repo / project-local checkout). */
export function resolveScriptPath(opts: { home?: string; cwd: string; exists?: (p: string) => boolean }): string | null {
  const exists = opts.exists ?? existsSync;
  const home = opts.home ?? homedir();
  const candidates = [
    join(home, ".pi/agent/scripts/coder-run.sh"),
    join(opts.cwd, "scripts/bash/coder-run.sh"),
    join(opts.cwd, ".pi/agent/scripts/coder-run.sh"),
  ];
  for (const c of candidates) if (exists(c)) return c;
  return null;
}

/** One-line summary for notifications / message display. There is no plan or
 * report artifact — the deliverable is the working-tree change. */
export function summarizeRun(o: { prompt: string }): string {
  const head = o.prompt.length > 80 ? `${o.prompt.slice(0, 77)}…` : o.prompt;
  return `Coder worker — "${head}"`;
}

/**
 * True when running inside a dispatched child spawned by any worker dispatcher
 * (a coder, planner, research worker, or adversary review). Such a child must
 * not auto-dispatch another agent. Checking all four markers (not just our own)
 * closes the cross-tool path.
 */
export function inDispatchedChild(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.PI_CODER_CHILD === "1"
    || env.PI_CODER_REVIEW_CHILD === "1"
    || env.PI_PLANNER_CHILD === "1"
    || env.PI_RESEARCH_WORKER_CHILD === "1"
    || env.PI_ADVERSARY_CHILD === "1";
}

/**
 * True when the current session is a read-only research-mode session — detected
 * by the research workspace env vars. The Coder writes the real repo, so it has
 * no role here and must refuse rather than silently dry-run into a workspace.
 */
export function inResearchMode(env: NodeJS.ProcessEnv = process.env): boolean {
  return !!(env.PI_RESEARCH_MODE_WORKSPACE || env.PI_RESEARCH_WORKSPACE);
}

// ---------------------------------------------------------------------------
// Runner (spawns the implementation worker).
// ---------------------------------------------------------------------------

interface RunResult { ok: boolean; output: string }

function runWorker(o: {
  scriptPath: string;
  prompt: string;
  label: string | null;
  cwd: string;
  signal?: AbortSignal;
}): Promise<RunResult> {
  const args = [o.scriptPath, o.prompt];
  if (o.label) args.push("--label", o.label);
  // The child writes the real repo: do NOT set either research-mode signal.
  // Carry the recursion marker so a dispatched child can't auto-dispatch another.
  const env: NodeJS.ProcessEnv = { ...process.env, PI_CODER_CHILD: "1" };
  delete env.PI_RESEARCH_WORKSPACE;
  delete env.PI_RESEARCH_MODE_WORKSPACE;
  const timeoutMs = 600_000;

  return new Promise<RunResult>((resolve) => {
    let out = "";
    let settled = false;
    // detached: true puts bash in its own process group (pgid === child.pid) and
    // the `pi` grandchild inherits it, so a SIGTERM to -pid reaches the whole
    // tree. Killing bash alone would orphan pi — and an orphaned Coder keeps
    // writing the real repo after we've given up, racing the post-run diff.
    const child = spawn("bash", args, { env, cwd: o.cwd, stdio: ["ignore", "pipe", "pipe"], detached: true });
    const onData = (c: Buffer) => { out += c.toString(); };
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);

    const killTree = () => {
      try { if (child.pid) process.kill(-child.pid, "SIGTERM"); } catch { /* group already gone */ }
    };

    const settle = (code: number | null, extra = "") => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (extra) out += `\n${extra}`;
      resolve({ ok: code === 0, output: out });
    };

    const timer = setTimeout(() => {
      if (settled) return;
      killTree();
      settle(null, "[coder worker timed out]");
    }, timeoutMs);

    child.on("close", (code) => settle(code));
    child.on("error", (err) => {
      out += `\nspawn error: ${err.message}`;
      settle(1);
    });
    o.signal?.addEventListener("abort", () => { killTree(); settle(null, "[aborted]"); });
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
  function notify(ctx: any, message: string, type: "info" | "warning" | "error") {
    if (ctx.hasUI) ctx.ui.notify(message, type);
    else console.error(`[coder-worker] ${message}`);
  }

  const errResult = (text: string) => ({ content: [{ type: "text", text: `Error: ${text}` }], isError: true });
  const RESEARCH_REFUSAL =
    "no writable session path; exit research-mode to implement (the Coder writes the real repo; research mode is read-only).";

  // --- coder-worker tool (agent-invokable; gated by --tools) -----------------
  pi.registerTool({
    name: "coder-worker",
    label: "coder-worker",
    description:
      "Spawn an implementation worker that reads a plan + the target sources and " +
      "WRITES THE REAL REPOSITORY (write/edit/bash), following test-driven " +
      "development: write a failing test, implement until it passes, run the " +
      "tests, and report the TDD sequence. This worker is NOT read-only and is " +
      "NOT jailed — its safety is the confinement of the session it runs in, so " +
      "it must run in a writable, non-research session (ideally inside the " +
      "container-harness). It refuses hard in research mode (which is read-only). " +
      "Pass the plan-file path plus the change to make in the prompt; the worker " +
      "carries no other context. There is no workspace artifact — the deliverable " +
      "is the working-tree change, surfaced as a git diff/status summary.",
    promptSnippet: "coder-worker: dispatch a TDD implementation worker that WRITES the real repo (write/edit/bash); refuses in research mode",
    promptGuidelines: [
      "Use coder-worker to delegate a scoped implementation task. It is NOT read-only — it writes the real repository (write/edit/bash), so only dispatch it from a writable, non-research session.",
      "Pass the plan-file path and the concrete change in the prompt (e.g. 'read <plan path> and implement the refactor of scripts/bash with tests first'). The worker carries no other context.",
      "Like the other workers it is gated by --tools: it is only available when 'coder-worker' is in --tools. It refuses in research mode and inside a dispatched child (recursion guard).",
      "Pass an optional label to tag the run; there is no plan/report file — review the returned git diff/status summary.",
      "RPI chain stage 3 of 3 (Implement). Run after the Plan is done and gated: give the worker the plan-file path, then gate the resulting diff with adversary-review and fix only confirmed concerns (re-gate until clean). Needs a writable non-research session; on <112GB boxes export PI_CODER_TIER=small so the Coder uses the 27B on :18080 instead of the absent 32B on :18111. Honor step-by-step / check-in pacing.",
      "Coder dual role in RPI: besides implementing, the coder model is the implementability reviewer at the PLAN gate (a one-shot review of the plan it will build, run blind to the adversary's verdict). As that reviewer its decisive vote is on APPROACH / buildability — is this plan correct and cleanly implementable — NOT on should-this-exist (the adversary owns design/scope; a coder approves what it can build). Tag a finding that asserts a provable defect or an unverifiable platform fact as a fact/blocker (not votable), separately from buildability concerns. The plan-gate coder review is dispatched via the separate `coder-review` tool (one-shot, no writes); this `coder-worker` tool is implement-only.",
      "State the deployment-target OS/arch in the implement prompt. The Coder writes inside its session (often a Linux container) but the artifact may run on the macOS host — it must target the destination, not its own runtime: portable paths, no /proc on a macOS target, no GNU-only flags on BSD. If the plan hard-codes a sandbox-specific dependency, fix it to the target.",
    ],
    parameters: {
      type: "object",
      properties: {
        prompt: { type: "string", description: "The implementation task for the worker, including the plan-file path. Must be self-contained." },
        label: { type: "string", description: "Optional slug used to tag the run." },
      },
      required: ["prompt"],
    },
    execute: async (_toolCallId: string, params: { prompt: string; label?: string }, signal: AbortSignal | undefined, _onUpdate: unknown, ctx: any) => {
      if (inResearchMode()) return errResult(RESEARCH_REFUSAL);
      if (inDispatchedChild()) {
        return errResult("coder-worker is unavailable inside a dispatched child (recursion guard).");
      }
      const prompt = (params.prompt ?? "").trim();
      if (!prompt) return errResult("a non-empty prompt is required.");
      const scriptPath = resolveScriptPath({ cwd: ctx.cwd });
      if (!scriptPath) return errResult("coder-run.sh not found (run install.sh).");
      const r = await runWorker({ scriptPath, prompt, label: params.label ?? null, cwd: ctx.cwd, signal });
      const summary = summarizeRun({ prompt });
      if (!r.ok) return { content: [{ type: "text", text: `Coder worker failed.\n${tail(r.output)}` }], isError: true };
      return { content: [{ type: "text", text: `${summary}\n\n${tail(r.output)}` }] };
    },
  });

  // --- /implement command (human; always available) --------------------------
  pi.registerCommand("implement", {
    description: 'Dispatch an implementation worker (TDD) that WRITES the real repo. Must run in a writable (non-research) session. Usage: /implement "<prompt>" [--label <slug>]',
    handler: async (args: string, ctx: any) => {
      if (inResearchMode()) { notify(ctx, RESEARCH_REFUSAL, "error"); return; }
      if (inDispatchedChild()) { notify(ctx, "coder-worker is unavailable inside a dispatched child (recursion guard).", "error"); return; }
      const { prompt, label } = parsePrompt(args);
      if (!prompt) { notify(ctx, 'Usage: /implement "<prompt>" [--label <slug>]', "error"); return; }
      const scriptPath = resolveScriptPath({ cwd: ctx.cwd });
      if (!scriptPath) { notify(ctx, "coder-run.sh not found (run install.sh).", "error"); return; }
      notify(ctx, `Dispatching coder worker…`, "info");
      const r = await runWorker({ scriptPath, prompt, label, cwd: ctx.cwd, signal: ctx.signal });
      const summary = summarizeRun({ prompt });
      notify(ctx, r.ok ? summary : `Coder worker failed.\n${tail(r.output, 1200)}`, r.ok ? "info" : "error");
      pi.sendMessage({
        customType: "coder-worker",
        content:
          `\n---\n**Coder worker** dispatched for: \`${prompt.length > 120 ? `${prompt.slice(0, 117)}…` : prompt}\`` +
          `\n> Writes the real repository — review the git diff/status summary above.`,
        display: true,
      });
    },
  });
}
