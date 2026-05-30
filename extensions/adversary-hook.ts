/**
 * adversary-hook.ts
 *
 * Pi extension: runs adversary-check.sh after every write or edit tool call.
 * Mirrors the PostToolUse hook from the Claude Code version of this system.
 *
 * Placement: ~/.pi/agent/extensions/adversary-hook.ts
 *            or .pi/agent/extensions/adversary-hook.ts (project-local)
 *
 * What it does:
 *   - Intercepts tool_call events for write and edit tools
 *   - After completion, runs adversary-check.sh and injects the output
 *     as a visible assistant message so the agent sees mechanical flags
 *     without needing to be prompted
 *
 * What it does NOT do:
 *   - Block or gate on the check result (script always exits 0)
 *   - Spawn a full adversary review (that is /adversary-review or quorum.ts)
 *   - Run on read-only tool calls (read, grep, ls, bash read-only)
 */

import { existsSync } from "fs";
import { execSync } from "child_process";
import { join } from "path";

const WRITE_TOOLS = new Set(["write", "edit"]);
const ADVERSARY_CHECK_PATHS = [
  "scripts/bash/adversary-check.sh",            // project-local
  join(process.env.HOME ?? "~", ".pi/agent/scripts/adversary-check.sh"), // global
];

function findCheckScript(cwd: string): string | null {
  // Try project-local first, then global install
  const projectLocal = join(cwd, "scripts/bash/adversary-check.sh");
  if (existsSync(projectLocal)) return projectLocal;

  const globalPath = join(
    process.env.HOME ?? "",
    ".pi/agent/scripts/adversary-check.sh"
  );
  if (existsSync(globalPath)) return globalPath;

  return null;
}

function runCheck(scriptPath: string, cwd: string): string {
  try {
    const output = execSync(`bash "${scriptPath}" "${cwd}"`, {
      cwd,
      encoding: "utf-8",
      timeout: 30_000,
      stdio: ["pipe", "pipe", "pipe"],
    });
    return output;
  } catch (err: any) {
    // Script always exits 0 by design; any non-zero is an execution error
    return `adversary-check.sh execution error: ${err.message ?? String(err)}`;
  }
}

// Register the extension with pi
export default function (pi: any) {
  // Track which tool calls involved writes so we can run the check after
  const pendingChecks = new Set<string>();

  pi.on("tool_call", async (event: any, _ctx: any) => {
    if (WRITE_TOOLS.has(event.toolName)) {
      pendingChecks.add(event.callId ?? event.toolName);
    }
  });

  pi.on("tool_result", async (event: any, ctx: any) => {
    const callId = event.callId ?? event.toolName;
    if (!pendingChecks.has(callId)) return;
    pendingChecks.delete(callId);

    const cwd: string = ctx.cwd ?? process.cwd();
    const scriptPath = findCheckScript(cwd);

    if (!scriptPath) {
      // Don't inject noise if the script is not installed
      return;
    }

    const checkOutput = runCheck(scriptPath, cwd);

    // Only inject if the check found something worth surfacing
    const hasFlags =
      checkOutput.includes("WARNING") ||
      checkOutput.includes("MISSING") ||
      checkOutput.includes("FAIL") ||
      checkOutput.includes("TODO") ||
      checkOutput.includes("FIXME");

    if (!hasFlags) return;

    // Inject as a visible message so the agent sees it.
    // pi 0.74.0 replaced ctx.inject() with the ExtensionAPI's sendMessage()
    // (same migration already applied in quorum.ts). Message shape unchanged.
    pi.sendMessage({
      customType: "adversary-hook",
      content: `## Mechanical Check (post-write)\n\n\`\`\`\n${checkOutput.trim()}\n\`\`\`\n\nReview these flags before proceeding.`,
      display: true,
    });
  });
}
