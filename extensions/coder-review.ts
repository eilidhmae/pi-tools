/**
 * Coder Review Extension
 *
 * One-shot IMPLEMENTABILITY review of a plan by the CODER model — the party that
 * will build it. It is the read-only sibling of coder-worker.ts: same coder tier
 * (32B :18111 / 27B :18080), but it writes nothing to the repo and makes no tool
 * calls — a single-turn review with the plan inlined, exactly like the adversary
 * single-shot path. The RPI plan gate runs this ALONGSIDE the adversary as a
 * heterogeneous, serial-INDEPENDENT pair (run one then the other, blind to each
 * other's verdict; the coordinator combines them by the Gate decision rule).
 *
 * Exposed two ways (mirroring adversary-review.ts):
 *   - `coder-review` TOOL — agent-invokable, gated by `--tools`. Lets the RPI
 *     coordinator dispatch the implementability reviewer itself.
 *   - `/coder-review <plan> [--goal "<text>"]` COMMAND — human-typed; always
 *     present (commands aren't `--tools`-gated).
 *
 * Both shell out to `coder-review.sh`, which runs single-turn pi with all
 * autoloads off and the `coder-review` skill as the sole system prompt. The
 * review lands in `./reviews/` and is NOT captured into the adversary-general
 * training corpus (different role/model — its fenced block is `coder-review`,
 * not `adversary-review`).
 *
 * Recursion guard: the spawned process carries `PI_CODER_REVIEW_CHILD=1`, and
 * the tool refuses when that (or any sibling dispatcher marker) is set, so a
 * dispatched worker/reviewer cannot auto-trigger a coder review. (The spawned
 * review also runs `--no-tools`, so the child can't dispatch anything regardless;
 * this is the belt-and-suspenders backstop.)
 */

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { boundedBuffer } from "./lib/bounded-buffer.ts";

// ---------------------------------------------------------------------------
// Pure helpers (exported for unit testing; no pi runtime dependency).
// ---------------------------------------------------------------------------

/**
 * Parse `<plan> [--goal "<text>"]` from the raw command argument string.
 * The first non-flag token is the plan path; `--goal` consumes the remainder
 * (one optional outer quote pair stripped).
 */
export function parseArgs(raw: string): { target: string; goal: string | null } {
  const s = raw.trim();
  if (!s) return { target: "", goal: null };
  const goalIdx = s.search(/(^|\s)--goal(\s|=)/);
  if (goalIdx === -1) {
    // No --goal: the whole (first) token is the target.
    const target = s.split(/\s+/)[0] ?? "";
    return { target, goal: null };
  }
  const before = s.slice(0, goalIdx).trim();
  const after = s.slice(goalIdx).replace(/(^|\s)--goal(\s+|=)/, "").trim();
  const target = before.split(/\s+/)[0] ?? "";
  let goal = after;
  if (goal.length >= 2 && ((goal[0] === '"' && goal.endsWith('"')) || (goal[0] === "'" && goal.endsWith("'")))) {
    goal = goal.slice(1, -1);
  }
  return { target, goal: goal.length ? goal : null };
}

/** Locate the installed `coder-review.sh` (global install first, then a
 * repo / project-local checkout). */
export function resolveScriptPath(opts: { home?: string; cwd: string; exists?: (p: string) => boolean }): string | null {
  const exists = opts.exists ?? existsSync;
  const home = opts.home ?? homedir();
  const candidates = [
    join(home, ".pi/agent/scripts/coder-review.sh"),
    join(opts.cwd, "scripts/bash/coder-review.sh"),
    join(opts.cwd, ".pi/agent/scripts/coder-review.sh"),
  ];
  for (const c of candidates) if (exists(c)) return c;
  return null;
}

/** Extract the saved-review path and verdict from the script's combined output. */
export function parseWorkerOutput(text: string): { reviewPath: string | null; verdict: string | null } {
  const rm = text.match(/Review written to:[ \t]*(.+)/);
  const vm = text.match(/^Verdict:[ \t]*(PASS|CONCERNS|FAIL|UNKNOWN)\b/m);
  return { reviewPath: rm ? rm[1].trim() : null, verdict: vm ? vm[1] : null };
}

/** One-line summary for notifications / message display. */
export function summarizeRun(o: { reviewPath: string | null; verdict: string | null; target: string }): string {
  const v = o.verdict ?? "UNKNOWN";
  const where = o.reviewPath ? `\nSaved: ${o.reviewPath}` : "";
  return `Coder review of ${o.target}: ${v}${where}`;
}

/**
 * True when running inside a dispatched child spawned by any dispatcher (a coder
 * review, a coder, planner, research worker, or adversary review). Such a child
 * must not auto-dispatch another agent. Checking all markers closes the
 * cross-tool path.
 */
export function inDispatchedChild(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.PI_CODER_REVIEW_CHILD === "1"
    || env.PI_CODER_CHILD === "1"
    || env.PI_PLANNER_CHILD === "1"
    || env.PI_RESEARCH_WORKER_CHILD === "1"
    || env.PI_ADVERSARY_CHILD === "1";
}

// ---------------------------------------------------------------------------
// Runner (spawns the single-turn reviewer).
// ---------------------------------------------------------------------------

interface RunResult { ok: boolean; reviewPath: string | null; verdict: string | null; output: string }

function runWorker(o: {
  scriptPath: string;
  target: string;
  goal: string | null;
  cwd: string;
  signal?: AbortSignal;
}): Promise<RunResult> {
  const args = [o.scriptPath, o.target];
  if (o.goal) args.push("--goal", o.goal);
  const env: NodeJS.ProcessEnv = { ...process.env, PI_CODER_REVIEW_CHILD: "1" };
  const timeoutMs = 600_000;

  return new Promise<RunResult>((resolve) => {
    const out = boundedBuffer();
    let settled = false;
    const child = spawn("bash", args, { env, cwd: o.cwd, stdio: ["ignore", "pipe", "pipe"] });
    const onData = out.push;
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);

    const settle = (code: number | null, extra = "") => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (extra) out.append(`\n${extra}`);
      const text = out.value();
      const { reviewPath, verdict } = parseWorkerOutput(text);
      resolve({ ok: code === 0 || reviewPath !== null, reviewPath, verdict, output: text });
    };

    const timer = setTimeout(() => {
      if (settled) return;
      child.kill("SIGTERM");
      settle(null, "[coder review timed out]");
    }, timeoutMs);

    child.on("close", (code) => settle(code));
    child.on("error", (err) => {
      out.append(`\nspawn error: ${err.message}`);
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
  function notify(ctx: any, message: string, type: "info" | "warning" | "error") {
    if (ctx.hasUI) ctx.ui.notify(message, type);
    else console.error(`[coder-review] ${message}`);
  }

  const errResult = (text: string) => ({ content: [{ type: "text", text: `Error: ${text}` }], isError: true });

  // --- coder-review tool (agent-invokable; gated by --tools) -----------------
  pi.registerTool({
    name: "coder-review",
    label: "coder-review",
    description:
      "One-shot implementability review of a PLAN by the coder model (the party " +
      "that will build it). Single-turn, no tools, no writes — the plan is inlined " +
      "and the coder judges whether it is buildable and the right approach, flags " +
      "blockers and unverifiable facts, and defers 'should this exist' to the " +
      "adversary. Use it at the RPI plan gate ALONGSIDE adversary-review as a " +
      "heterogeneous pair: run the two serially and BLIND to each other, then " +
      "combine their verdicts by the Gate decision rule. The review is saved to " +
      "./reviews/. Uses the coder tier (32B :18111, or 27B :18080 with " +
      "PI_CODER_TIER=small).",
    promptSnippet: "coder-review: one-shot implementability review of a plan by the coder model; pair it with adversary-review at the plan gate",
    promptGuidelines: [
      "Use coder-review at the RPI plan gate to get the implementor's verdict on a plan before building it. Pass the plan-file path; optionally add the goal as context.",
      "It is HALF of a heterogeneous pair — run it and adversary-review serially and BLIND to each other (never feed one's findings to the other), then combine: the coder is weighted on approach/implementability, the adversary owns design/scope, and facts/blockers are not votable.",
      "Gated by --tools like the other workers; available only when 'coder-review' is in --tools. It refuses inside a dispatched child (recursion guard).",
      "On <112GB boxes the 32B (:18111) is absent — export PI_CODER_TIER=small so the review uses the 27B on :18080. The review file lands in ./reviews/ and is NOT captured into the adversary training corpus.",
    ],
    parameters: {
      type: "object",
      properties: {
        target: { type: "string", description: "Path to the plan file to review." },
        goal: { type: "string", description: "Optional: the original goal, added as context for the review." },
      },
      required: ["target"],
    },
    execute: async (_toolCallId: string, params: { target: string; goal?: string }, signal: AbortSignal | undefined, _onUpdate: unknown, ctx: any) => {
      if (inDispatchedChild()) {
        return errResult("coder-review is unavailable inside a dispatched child (recursion guard).");
      }
      const target = (params.target ?? "").trim();
      if (!target) return errResult("a plan-file path is required.");
      const scriptPath = resolveScriptPath({ cwd: ctx.cwd });
      if (!scriptPath) return errResult("coder-review.sh not found (run install.sh).");
      const r = await runWorker({ scriptPath, target, goal: params.goal ?? null, cwd: ctx.cwd, signal });
      const summary = summarizeRun({ reviewPath: r.reviewPath, verdict: r.verdict, target });
      if (!r.ok) return { content: [{ type: "text", text: `Coder review failed.\n${tail(r.output)}` }], isError: true };
      return { content: [{ type: "text", text: `${summary}\n\n${tail(r.output)}` }] };
    },
  });

  // --- /coder-review command (human; always available) -----------------------
  pi.registerCommand("coder-review", {
    description: 'One-shot implementability review of a plan by the coder model. Usage: /coder-review <plan> [--goal "<text>"]',
    handler: async (args: string, ctx: any) => {
      const { target, goal } = parseArgs(args);
      if (!target) { notify(ctx, 'Usage: /coder-review <plan> [--goal "<text>"]', "error"); return; }
      const scriptPath = resolveScriptPath({ cwd: ctx.cwd });
      if (!scriptPath) { notify(ctx, "coder-review.sh not found (run install.sh).", "error"); return; }
      notify(ctx, `Dispatching coder review…`, "info");
      const r = await runWorker({ scriptPath, target, goal, cwd: ctx.cwd, signal: ctx.signal });
      const summary = summarizeRun({ reviewPath: r.reviewPath, verdict: r.verdict, target });
      notify(ctx, r.ok ? summary : `Coder review failed.\n${tail(r.output, 1200)}`, r.ok ? "info" : "error");
      pi.sendMessage({
        customType: "coder-review",
        content:
          `\n---\n**Coder review** of \`${target}\`` +
          (r.verdict ? ` — **${r.verdict}**` : "") +
          (r.reviewPath ? `\n> Saved: ${r.reviewPath}` : "\n> (no review path parsed — see output above)"),
        display: true,
      });
    },
  });
}
