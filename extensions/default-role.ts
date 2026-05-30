/**
 * Default Role
 *
 * Bare `pi` starts as a generic coding assistant with no framing — which is
 * where role drift and "what can I even do here?" confusion come from. This
 * extension gives every session a light DEFAULT ROLE: a helpful, flexible
 * senior engineer/coordinator that understands the request and then either
 * does it or guides the user to the right mode/role.
 *
 * Two deliberate non-goals (to stay small and portable):
 *  - It does NOT restate the principles in AGENTS.md — pi already injects that
 *    file into the system prompt. This adds framing + situational guidance on
 *    top, not a second copy of the rules.
 *  - It carries NO project/host identity (no Mneme/Oracle). pi-tools ships to
 *    non-Claude consumers; a host-specific identity is layered on separately.
 *
 * It defers to specialized roles: if a research/adversary jail is already
 * framing the turn, it stays quiet and only contributes the situational
 * tool-state guidance (which is always safe and useful).
 *
 * Opt out with `--no-default-role`.
 *
 * Mechanism: before_agent_start prepends to the system prompt (chained), and
 * the tool guidance is recomputed from getActiveTools() each turn so it always
 * reflects the real harness state.
 */

const MUTATING_BUILTINS = ["write", "edit", "bash"];

/**
 * Situational guidance derived from the active tool set: what the agent can do
 * now, and how to unlock more. Returns null when nothing noteworthy applies
 * (full default toolset).
 */
export function toolStateGuidance(activeTools: string[]): string | null {
  const has = (t: string) => activeTools.includes(t);
  const lines: string[] = [];

  const canWrite = has("write") || has("edit");
  const hasWriteResearch = has("write-research");
  const hasBash = has("bash");
  const hasBashSafe = has("bash-safe");

  if (!canWrite && hasWriteResearch) {
    lines.push(
      "- You do NOT have the `write`/`edit` tools, but `write-research` is " +
        "present. That tool only works inside research mode and writes solely " +
        "to an isolated workspace. If the request needs file changes, tell the " +
        "user you are in (or should enter) research mode — suggest `/research-mode` " +
        "— and use `write-research`; do not claim you cannot write at all.",
    );
  } else if (!canWrite && !hasWriteResearch) {
    lines.push(
      "- You have NO write capability (`write`/`edit`/`write-research` all " +
        "absent). This is a read-only session — report findings; do not attempt " +
        "to modify files.",
    );
  }

  if (!hasBash && hasBashSafe) {
    lines.push(
      "- The raw `bash` tool is unavailable; use `bash-safe` (one allowlisted " +
        "read-only command at a time, no shell/pipes).",
    );
  }

  if (lines.length === 0) return null;
  return ["Harness note — your current tools:", ...lines].join("\n");
}

/** The default-role framing (no AGENTS.md restatement, no host identity). */
export function buildDefaultRole(activeTools: string[]): string {
  const guidance = toolStateGuidance(activeTools);
  const blocks = [
    "# Default role",
    "",
    "You are the default coordinator for this session: a helpful, senior " +
      "engineer. Be flexible and concise. Understand what the user actually " +
      "wants, then either do it directly or guide them to the right tool/mode. " +
      "Disagree when you have reason; say \"I don't know\" when that's honest.",
    "",
    "Specialized roles are available as skills when a task calls for one: " +
      "`/skill:research` (grounded read-only investigation), `/skill:adversary` " +
      "(read-only review), `/skill:manager`, `/skill:orchestrator`, " +
      "`/skill:worker`. Suggest one when it fits; otherwise just help.",
  ];
  if (guidance) {
    blocks.push("", guidance);
  }
  return blocks.join("\n");
}

export default function (pi: ExtensionAPI) {
  pi.registerFlag("no-default-role", {
    type: "boolean",
    description: "Do not inject the default-role framing into the system prompt.",
  });

  pi.on("before_agent_start", async (event, _ctx) => {
    if (pi.getFlag("no-default-role") === true) return;

    // Research mode owns the framing AND the tool guidance — stay out entirely.
    // (Set by research-mode in this same process; order-independent.)
    if (process.env.PI_RESEARCH_MODE_ACTIVE === "1") return;

    const active = pi.getActiveTools();

    // A jailed toolset (no write/edit/bash) with research NOT active is the
    // "restricted, maybe forgot --research" case: skip the coordinator persona
    // (a restricted session is task-focused) and contribute only the
    // always-correct tool-state guidance.
    const jailed = !MUTATING_BUILTINS.some((t) => active.includes(t));
    if (jailed) {
      const guidance = toolStateGuidance(active);
      if (!guidance) return;
      return { systemPrompt: `${guidance}\n\n${event.systemPrompt}` };
    }

    return { systemPrompt: `${buildDefaultRole(active)}\n\n${event.systemPrompt}` };
  });
}
