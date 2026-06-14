/**
 * Research Worker Extension
 *
 * Dispatch a jailed research worker to carry out a free-form research/analysis
 * task, exposed two ways (mirroring adversary-review.ts):
 *
 *   - `research-worker` TOOL — agent-invokable, gated by `--tools` exactly like
 *     `write-research`/`bash-safe`. Lets the session agent spawn a worker itself.
 *   - `/research "<prompt>" [--label <slug>]` COMMAND — human-typed; always
 *     present (commands aren't `--tools`-gated).
 *
 * Both call one runner that shells out to `research-jailed.sh`, which spawns the
 * worker as a pi session jailed identically to the research agent (read-only
 * repo + `bash-safe` + `write-research`, `--research`) with the `research` skill
 * as its system prompt. The worker therefore never has more authority than the
 * agent that invoked it. If the invoker is in research mode, its workspace is
 * passed via `PI_RESEARCH_WORKSPACE` so the worker auto-jails to the SAME
 * workspace and its report and notes land there; otherwise the script creates a
 * fresh temp workspace and reports the path. (Dispatch from a full-tools session
 * is therefore fine — the worker is jailed regardless of the caller's mode.)
 *
 * Why a dedicated tool rather than allowlisting the script in `bash-safe`:
 * `bash-safe` matches programs by basename, so a workspace-planted
 * `research-jailed.sh` would execute — a jailbreak. A purpose-built tool whose
 * only effect is "spawn a jailed read-only worker that writes into a workspace"
 * keeps the jail invariant intact.
 *
 * Recursion is prevented primarily by the jail itself: a dispatched worker is
 * spawned with `--no-extensions -e research-mode.ts` and a restricted `--tools`,
 * so this extension is not even loaded in the child and the `research-worker`
 * tool does not exist there. As defense-in-depth the spawned process also carries
 * `PI_RESEARCH_WORKER_CHILD=1`; the tool refuses when that (or the sibling
 * `PI_ADVERSARY_CHILD`) is set, so even a session that DID load this extension
 * cannot auto-dispatch from inside a jailed child. The `/research` command is the
 * human entry point and is always available, exactly mirroring `/adversary-pass`.
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
 * documented `/research "<prompt>"` form works), and pulls a leading
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

/** Locate the installed `research-jailed.sh` (global install first, then a
 * repo / project-local checkout). */
export function resolveScriptPath(opts: { home?: string; cwd: string; exists?: (p: string) => boolean }): string | null {
  const exists = opts.exists ?? existsSync;
  const home = opts.home ?? homedir();
  const candidates = [
    join(home, ".pi/agent/scripts/research-jailed.sh"),
    join(opts.cwd, "scripts/bash/research-jailed.sh"),
    join(opts.cwd, ".pi/agent/scripts/research-jailed.sh"),
  ];
  for (const c of candidates) if (exists(c)) return c;
  return null;
}

/** Extract the saved-report path from the script's combined output. */
export function parseWorkerOutput(text: string): { reportPath: string | null } {
  const pm = text.match(/Report written to:[ \t]*(.+)/);
  return { reportPath: pm ? pm[1].trim() : null };
}

/** One-line summary for notifications / message display. */
export function summarizeRun(o: { reportPath: string | null; prompt: string }): string {
  const head = o.prompt.length > 80 ? `${o.prompt.slice(0, 77)}…` : o.prompt;
  const where = o.reportPath ? `\nReport: ${o.reportPath}` : "";
  return `Research worker — "${head}"${where}`;
}

// ---------------------------------------------------------------------------
// Runner (spawns the jailed worker).
// ---------------------------------------------------------------------------

interface RunResult { ok: boolean; reportPath: string | null; output: string }

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
  const env: NodeJS.ProcessEnv = { ...process.env, PI_RESEARCH_WORKER_CHILD: "1" };
  // One env var drives both the child's jail (auto-activates research mode
  // pinned to this workspace) and research-jailed.sh's output dir.
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
      const { reportPath } = parseWorkerOutput(out);
      resolve({ ok: code === 0 || reportPath !== null, reportPath, output: out });
    };

    const timer = setTimeout(() => {
      if (settled) return;
      child.kill("SIGTERM");
      settle(null, "[research worker timed out]");
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
 * True when running inside a jailed child spawned by any dispatcher (a research
 * worker, a planner worker, or an adversary review). Such a child must not
 * auto-dispatch another agent. Checking every sibling marker (not just our own)
 * closes the cross-tool path — an adversary or planner child that somehow had
 * this tool available could otherwise dispatch a worker. (In practice the jailed
 * scripts load only research-mode.ts, so this tool is absent in any child; this
 * is the defense-in-depth backstop.)
 */
export function inDispatchedChild(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.PI_RESEARCH_WORKER_CHILD === "1" || env.PI_ADVERSARY_CHILD === "1" || env.PI_PLANNER_CHILD === "1";
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
    else console.error(`[research-worker] ${message}`);
  }

  const errResult = (text: string) => ({ content: [{ type: "text", text: `Error: ${text}` }], isError: true });

  // --- research-worker tool (agent-invokable; gated by --tools) --------------
  pi.registerTool({
    name: "research-worker",
    label: "research-worker",
    description:
      "Spawn a jailed research worker to carry out a research/analysis task. The " +
      "worker runs as a separate agent constrained to a read-only repository plus " +
      "an isolated workspace (no shell, no writes outside the workspace, no code " +
      "execution). It explores with read/grep/find/ls and bash-safe, persists notes " +
      "and copies with write-research, and produces a grounded, evidence-cited " +
      "report saved into the workspace. If you are in research mode the worker " +
      "shares YOUR workspace; otherwise it gets a fresh temp workspace whose path is " +
      "returned. Use it to delegate a self-contained read-only investigation.",
    promptSnippet: "research-worker: dispatch a jailed read-only worker to do a research task; report saved to a workspace",
    promptGuidelines: [
      "Use research-worker to delegate a scoped, self-contained investigation (e.g. 'summarize what each script in scripts/bash does'). The worker is read-only — it cannot change the repo.",
      "Give a complete, self-contained prompt; the worker carries no other context.",
      "Pass an optional label to name the report file; otherwise it is named 'research-<timestamp>.md'.",
      "RPI chain stage 1 of 3 (Research → Plan → Implement). When asked to 'use the RPI tools' to make a change, START here: dispatch research, then gate the report with adversary-review, verify any concern yourself before acting on it, then pass the report path to planner-worker. Run the stages in order and never skip a gate. (For the full protocol, /skill:rpi.)",
      "State the deployment-target OS/arch (this workstation is macOS/arm64) in every dispatch and gate. The chain may run inside a Linux container while the artifact deploys to the macOS host, and a worker cannot infer the target from its own runtime — so establish it up front (goal / AGENTS.md, or ask) and pass it verbatim downstream. This stops the sandbox OS from leaking into the artifact (e.g. a /proc-only script shipped to macOS).",
      "Pacing: by default carry the chain through all stages, surfacing a short running summary. If the user asks to go step by step or 'check in after each step', treat each stage (a worker run plus its adversary gate) as one step: dispatch only that step, report its result and the artifact path, and WAIT for the user's go-ahead before the next.",
    ],
    parameters: {
      type: "object",
      properties: {
        prompt: { type: "string", description: "The research/analysis task for the worker. Must be self-contained." },
        label: { type: "string", description: "Optional slug used to name the saved report file." },
      },
      required: ["prompt"],
    },
    execute: async (_toolCallId: string, params: { prompt: string; label?: string }, signal: AbortSignal | undefined, _onUpdate: unknown, ctx: any) => {
      if (inDispatchedChild()) {
        return errResult("research-worker is unavailable inside a dispatched jailed child (recursion guard).");
      }
      const prompt = (params.prompt ?? "").trim();
      if (!prompt) return errResult("a non-empty prompt is required.");
      const scriptPath = resolveScriptPath({ cwd: ctx.cwd });
      if (!scriptPath) return errResult("research-jailed.sh not found (run install.sh).");
      const r = await runWorker({ scriptPath, prompt, label: params.label ?? null, workspace: researchWorkspace(), cwd: ctx.cwd, signal });
      const summary = summarizeRun({ reportPath: r.reportPath, prompt });
      if (!r.ok) return { content: [{ type: "text", text: `Research worker failed.\n${tail(r.output)}` }], isError: true };
      return { content: [{ type: "text", text: `${summary}\n\n${tail(r.output)}` }] };
    },
  });

  // --- /research command (human; always available) ---------------------------
  pi.registerCommand("research", {
    description: 'Dispatch a jailed research worker to do a task. Usage: /research "<prompt>" [--label <slug>]',
    handler: async (args: string, ctx: any) => {
      const { prompt, label } = parsePrompt(args);
      if (!prompt) { notify(ctx, 'Usage: /research "<prompt>" [--label <slug>]', "error"); return; }
      const scriptPath = resolveScriptPath({ cwd: ctx.cwd });
      if (!scriptPath) { notify(ctx, "research-jailed.sh not found (run install.sh).", "error"); return; }
      notify(ctx, `Dispatching research worker…`, "info");
      const r = await runWorker({ scriptPath, prompt, label, workspace: researchWorkspace(), cwd: ctx.cwd, signal: ctx.signal });
      const summary = summarizeRun({ reportPath: r.reportPath, prompt });
      notify(ctx, r.ok ? summary : `Research worker failed.\n${tail(r.output, 1200)}`, r.ok ? "info" : "error");
      pi.sendMessage({
        customType: "research-worker",
        content:
          `\n---\n**Research worker** dispatched for: \`${prompt.length > 120 ? `${prompt.slice(0, 117)}…` : prompt}\`` +
          (r.reportPath ? `\n> Report: ${r.reportPath}` : "\n> (no report path parsed — see output above)"),
        display: true,
      });
    },
  });
}
