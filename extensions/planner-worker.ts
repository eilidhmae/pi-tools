/**
 * Planner Worker Extension
 *
 * Dispatch a jailed planner worker to read prior research + the target sources
 * and produce an ordered implementation plan, exposed two ways (mirroring
 * research-worker.ts):
 *
 *   - `planner-worker` TOOL — agent-invokable, gated by `--tools` exactly like
 *     `write-research`/`bash-safe`. Lets the session agent spawn a worker itself.
 *   - `/plan "<prompt>" [--label <slug>]` COMMAND — human-typed; always
 *     present (commands aren't `--tools`-gated).
 *
 * Both call one runner that shells out to `plan-jailed.sh`, which spawns the
 * worker as a pi session jailed identically to the research agent (read-only
 * repo + `bash-safe` + `write-research`, `--research`) with the `plan` skill
 * as its system prompt. The worker therefore never has more authority than the
 * agent that invoked it. If the invoker is in research mode, its workspace is
 * passed via `PI_RESEARCH_WORKSPACE` so the worker auto-jails to the SAME
 * workspace and its plan and notes land there; otherwise the script creates a
 * fresh temp workspace and reports the path. (Dispatch from a full-tools session
 * is therefore fine — the worker is jailed regardless of the caller's mode.)
 *
 * Why a dedicated tool rather than allowlisting the script in `bash-safe`:
 * `bash-safe` matches programs by basename, so a workspace-planted
 * `plan-jailed.sh` would execute — a jailbreak. A purpose-built tool whose
 * only effect is "spawn a jailed read-only worker that writes into a workspace"
 * keeps the jail invariant intact.
 *
 * Recursion is prevented primarily by the jail itself: a dispatched worker is
 * spawned with `--no-extensions -e research-mode.ts` and a restricted `--tools`,
 * so this extension is not even loaded in the child and the `planner-worker`
 * tool does not exist there. As defense-in-depth the spawned process also carries
 * `PI_PLANNER_CHILD=1`; the tool refuses when that (or the sibling
 * `PI_RESEARCH_WORKER_CHILD`/`PI_ADVERSARY_CHILD`) is set, so even a session that
 * DID load this extension cannot auto-dispatch from inside a jailed child. The
 * `/plan` command is the human entry point and is always available, exactly
 * mirroring `/adversary-pass`.
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
 * documented `/plan "<prompt>"` form works), and pulls a leading
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

/** Locate the installed `plan-jailed.sh` (global install first, then a
 * repo / project-local checkout). */
export function resolveScriptPath(opts: { home?: string; cwd: string; exists?: (p: string) => boolean }): string | null {
  const exists = opts.exists ?? existsSync;
  const home = opts.home ?? homedir();
  const candidates = [
    join(home, ".pi/agent/scripts/plan-jailed.sh"),
    join(opts.cwd, "scripts/bash/plan-jailed.sh"),
    join(opts.cwd, ".pi/agent/scripts/plan-jailed.sh"),
  ];
  for (const c of candidates) if (exists(c)) return c;
  return null;
}

/** Extract the saved-plan path from the script's combined output. */
export function parseWorkerOutput(text: string): { planPath: string | null } {
  const pm = text.match(/Plan written to:[ \t]*(.+)/);
  return { planPath: pm ? pm[1].trim() : null };
}

/** One-line summary for notifications / message display. */
export function summarizeRun(o: { planPath: string | null; prompt: string }): string {
  const head = o.prompt.length > 80 ? `${o.prompt.slice(0, 77)}…` : o.prompt;
  const where = o.planPath ? `\nPlan: ${o.planPath}` : "";
  return `Planner worker — "${head}"${where}`;
}

// ---------------------------------------------------------------------------
// Runner (spawns the jailed worker).
// ---------------------------------------------------------------------------

interface RunResult { ok: boolean; planPath: string | null; output: string }

function runWorker(o: {
  scriptPath: string;
  prompt: string;
  label: string | null;
  workspace: string | null;
  cwd: string;
  signal?: AbortSignal;
}): Promise<RunResult> {
  const args = [o.scriptPath, o.prompt];
  if (o.label) args.push("--label", o.label);
  const env: NodeJS.ProcessEnv = { ...process.env, PI_PLANNER_CHILD: "1" };
  // One env var drives both the child's jail (auto-activates research mode
  // pinned to this workspace) and plan-jailed.sh's output dir.
  if (o.workspace) env.PI_RESEARCH_WORKSPACE = o.workspace;
  else delete env.PI_RESEARCH_WORKSPACE;
  const timeoutMs = 600_000;

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
      const { planPath } = parseWorkerOutput(out);
      resolve({ ok: code === 0 || planPath !== null, planPath, output: out });
    };

    const timer = setTimeout(() => {
      if (settled) return;
      child.kill("SIGTERM");
      settle(null, "[planner worker timed out]");
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

/**
 * True when running inside a jailed child spawned by any dispatcher (a planner
 * worker, a research worker, or an adversary review). Such a child must not
 * auto-dispatch another agent. Checking all three markers (not just our own)
 * closes the cross-tool path — an adversary or research child that somehow had
 * this tool available could otherwise dispatch a worker. (In practice the jailed
 * scripts load only research-mode.ts, so this tool is absent in any child; this
 * is the defense-in-depth backstop.)
 */
export function inDispatchedChild(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.PI_PLANNER_CHILD === "1" || env.PI_RESEARCH_WORKER_CHILD === "1" || env.PI_ADVERSARY_CHILD === "1" || env.PI_CODER_CHILD === "1" || env.PI_CODER_REVIEW_CHILD === "1";
}

// ---------------------------------------------------------------------------
// Extension
// ---------------------------------------------------------------------------

export default function (pi: any) {
  function researchWorkspace(): string | null {
    return process.env.PI_RESEARCH_MODE_WORKSPACE ?? process.env.PI_RESEARCH_WORKSPACE ?? null;
  }

  function notify(ctx: any, message: string, type: "info" | "warning" | "error") {
    if (ctx.hasUI) ctx.ui.notify(message, type);
    else console.error(`[planner-worker] ${message}`);
  }

  const errResult = (text: string) => ({ content: [{ type: "text", text: `Error: ${text}` }], isError: true });

  // --- planner-worker tool (agent-invokable; gated by --tools) ---------------
  pi.registerTool({
    name: "planner-worker",
    label: "planner-worker",
    description:
      "Spawn a jailed planner worker to read prior research + target sources and " +
      "produce an ordered implementation plan. The worker runs as a separate agent " +
      "constrained to a read-only repository plus an isolated workspace (no shell, " +
      "no writes outside the workspace, no code execution). It explores with " +
      "read/grep/find/ls and bash-safe, persists notes and copies with " +
      "write-research, and produces a grounded, file-and-step-level implementation " +
      "plan saved into the workspace. If you are in research mode the worker " +
      "shares YOUR workspace; otherwise it gets a fresh temp workspace whose path is " +
      "returned. Use it to delegate a self-contained read-only planning task.",
    promptSnippet: "planner-worker: dispatch a jailed read-only worker to produce an implementation plan; plan saved to a workspace",
    promptGuidelines: [
      "Use planner-worker to delegate a scoped, self-contained planning task (e.g. 'read the research report and plan the refactor of scripts/bash'). The worker is read-only — it cannot change the repo.",
      "Give a complete, self-contained prompt; the worker carries no other context.",
      "Pass an optional label to name the plan file; otherwise it is named 'plan-<timestamp>.md'.",
      "RPI chain stage 2 of 3 (Plan). Run after Research is done and gated: tell the worker where the research report is, then gate the plan with adversary-review (verify each concern yourself before revising), and pass the plan-file path to coder-worker. Honor any step-by-step / check-in pacing the user set.",
    ],
    parameters: {
      type: "object",
      properties: {
        prompt: { type: "string", description: "The planning task for the worker. Must be self-contained." },
        label: { type: "string", description: "Optional slug used to name the saved plan file." },
      },
      required: ["prompt"],
    },
    execute: async (_toolCallId: string, params: { prompt: string; label?: string }, signal: AbortSignal | undefined, _onUpdate: unknown, ctx: any) => {
      if (inDispatchedChild()) {
        return errResult("planner-worker is unavailable inside a dispatched jailed child (recursion guard).");
      }
      const prompt = (params.prompt ?? "").trim();
      if (!prompt) return errResult("a non-empty prompt is required.");
      const scriptPath = resolveScriptPath({ cwd: ctx.cwd });
      if (!scriptPath) return errResult("plan-jailed.sh not found (run install.sh).");
      const r = await runWorker({ scriptPath, prompt, label: params.label ?? null, workspace: researchWorkspace(), cwd: ctx.cwd, signal });
      const summary = summarizeRun({ planPath: r.planPath, prompt });
      if (!r.ok) return { content: [{ type: "text", text: `Planner worker failed.\n${tail(r.output)}` }], isError: true };
      return { content: [{ type: "text", text: `${summary}\n\n${tail(r.output)}` }] };
    },
  });

  // --- /plan command (human; always available) -------------------------------
  pi.registerCommand("plan", {
    description: 'Dispatch a jailed planner worker to produce an implementation plan. Usage: /plan "<prompt>" [--label <slug>]',
    handler: async (args: string, ctx: any) => {
      const { prompt, label } = parsePrompt(args);
      if (!prompt) { notify(ctx, 'Usage: /plan "<prompt>" [--label <slug>]', "error"); return; }
      const scriptPath = resolveScriptPath({ cwd: ctx.cwd });
      if (!scriptPath) { notify(ctx, "plan-jailed.sh not found (run install.sh).", "error"); return; }
      notify(ctx, `Dispatching planner worker…`, "info");
      const r = await runWorker({ scriptPath, prompt, label, workspace: researchWorkspace(), cwd: ctx.cwd, signal: ctx.signal });
      const summary = summarizeRun({ planPath: r.planPath, prompt });
      notify(ctx, r.ok ? summary : `Planner worker failed.\n${tail(r.output, 1200)}`, r.ok ? "info" : "error");
      pi.sendMessage({
        customType: "planner-worker",
        content:
          `\n---\n**Planner worker** dispatched for: \`${prompt.length > 120 ? `${prompt.slice(0, 117)}…` : prompt}\`` +
          (r.planPath ? `\n> Plan: ${r.planPath}` : "\n> (no plan path parsed — see output above)"),
        display: true,
      });
    },
  });
}
