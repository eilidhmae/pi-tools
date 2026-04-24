/**
 * quorum.ts
 *
 * Pi extension: adversary quorum orchestrator.
 *
 * Placement: ~/.pi/agent/extensions/quorum.ts
 *            or .pi/agent/extensions/quorum.ts (project-local)
 *
 * What it does:
 *   - Intercepts agent_end events
 *   - Detects CONCERNS or FAIL verdicts in the final message
 *   - Spawns 1 peer adversary session (via pi RPC subprocess)
 *   - If peer disagrees, spawns a second peer; majority of 3 wins
 *   - Injects a Quorum summary line into the session output
 *
 * QUORUM_PEER token: if the session prompt contains "QUORUM_PEER"
 * (case-sensitive), this extension skips quorum to prevent recursion.
 *
 * Caps:
 *   - Max 2 peer adversaries spawned (3 total reviewers: self + 2 peers)
 *   - Each peer has a 120-second timeout
 *
 * Dependencies:
 *   - pi must be in PATH (used for RPC subprocess spawning)
 *   - ~/.pi/agent/skills/adversary/SKILL.md must exist
 *   - qwen3-coder:30b via ollama (configurable below)
 */

import { spawn } from "child_process";
import { readFileSync, existsSync } from "fs";
import { join } from "path";

// --- Configuration ---
const MODEL = process.env.PI_QUORUM_MODEL ?? "qwen3-coder:30b";
const PROVIDER = process.env.PI_QUORUM_PROVIDER ?? "ollama";
const PEER_TIMEOUT_MS = 120_000;
const MAX_PEERS = 2;

type Verdict = "PASS" | "CONCERNS" | "FAIL" | "UNKNOWN";

interface PeerResult {
  verdict: Verdict;
  findings: string;
}

// --- Verdict parsing ---

function extractVerdict(text: string): Verdict {
  const match = text.match(/\*\*VERDICT:\s*(PASS|CONCERNS|FAIL)\*\*/i);
  if (match) return match[1].toUpperCase() as Verdict;
  // Also handle plain "VERDICT: PASS" without bold
  const plain = text.match(/VERDICT:\s*(PASS|CONCERNS|FAIL)/i);
  if (plain) return plain[1].toUpperCase() as Verdict;
  return "UNKNOWN";
}

function isNegativeVerdict(v: Verdict): boolean {
  return v === "CONCERNS" || v === "FAIL";
}

function majorityVerdict(verdicts: Verdict[]): Verdict {
  const counts = { PASS: 0, CONCERNS: 0, FAIL: 0, UNKNOWN: 0 };
  for (const v of verdicts) counts[v]++;
  // FAIL beats CONCERNS in a tie (more conservative)
  if (counts.FAIL >= 2) return "FAIL";
  if (counts.CONCERNS >= 2) return "CONCERNS";
  if (counts.PASS >= 2) return "PASS";
  // No majority — fall back to most severe
  if (counts.FAIL > 0) return "FAIL";
  if (counts.CONCERNS > 0) return "CONCERNS";
  return "PASS";
}

// --- Peer adversary spawning ---

function findAdversarySkill(): string | null {
  const candidates = [
    join(process.cwd(), ".pi/agent/skills/adversary/SKILL.md"),
    join(process.env.HOME ?? "", ".pi/agent/skills/adversary/SKILL.md"),
  ];
  for (const p of candidates) {
    if (existsSync(p)) return p;
  }
  return null;
}

async function spawnPeerAdversary(
  scope: string,
  filePaths: string[],
  peerNumber: number
): Promise<PeerResult> {
  const skillPath = findAdversarySkill();
  if (!skillPath) {
    return { verdict: "UNKNOWN", findings: "adversary SKILL.md not found" };
  }

  const skillContent = readFileSync(skillPath, "utf-8");
  const fileList = filePaths.map((p) => `@${p}`).join(" ");

  // QUORUM_PEER token prevents the peer from triggering its own quorum
  const peerPrompt =
    `QUORUM_PEER peer-${peerNumber}: ` +
    `Review scope: ${scope}. ` +
    `Files: ${fileList || "(use git diff HEAD to identify changed files)"}. ` +
    `Return ONLY: VERDICT: [PASS|CONCERNS|FAIL] followed by your top 1-3 specific findings ` +
    `with file:line references. Do not execute the full review protocol — verdict and ` +
    `top findings only.`;

  return new Promise((resolve) => {
    let stdout = "";
    let settled = false;

    const child = spawn(
      "pi",
      [
        "--provider", PROVIDER,
        "--model", MODEL,
        "--tools", "read,grep,ls,bash",
        "--no-write",
        "--no-edit",
        "--no-extensions",          // prevent recursive quorum extension
        "-p", peerPrompt,
      ],
      {
        env: { ...process.env },
        stdio: ["pipe", "pipe", "pipe"],
      }
    );

    // Pipe skill content as system context via stdin
    child.stdin.write(skillContent);
    child.stdin.end();

    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });

    const finish = (reason: string) => {
      if (settled) return;
      settled = true;
      const verdict = extractVerdict(stdout);
      resolve({
        verdict: verdict === "UNKNOWN" ? "CONCERNS" : verdict, // conservative on parse failure
        findings: stdout.slice(0, 2000), // cap to avoid context explosion
      });
    };

    child.on("close", () => finish("exit"));
    child.on("error", (err) => {
      stdout += `\nspawn error: ${err.message}`;
      finish("error");
    });

    // Timeout guard
    setTimeout(() => {
      if (!settled) {
        child.kill("SIGTERM");
        stdout += "\n[peer adversary timed out]";
        finish("timeout");
      }
    }, PEER_TIMEOUT_MS);
  });
}

// --- Main extension ---

export default function (pi: any) {
  pi.on("agent_end", async (event: any, ctx: any) => {
    // --- Skip if this is already a quorum peer ---
    const initialPrompt: string = ctx.getInitialPrompt?.() ?? "";
    if (initialPrompt.includes("QUORUM_PEER")) return;

    // --- Find the final assistant message ---
    const messages: any[] = event.messages ?? [];
    const lastAssistant = [...messages]
      .reverse()
      .find((m) => m.role === "assistant");
    if (!lastAssistant) return;

    const lastText: string =
      typeof lastAssistant.content === "string"
        ? lastAssistant.content
        : (lastAssistant.content ?? [])
            .filter((b: any) => b.type === "text")
            .map((b: any) => b.text)
            .join("\n");

    const selfVerdict = extractVerdict(lastText);

    // --- Only engage quorum on CONCERNS or FAIL ---
    if (!isNegativeVerdict(selfVerdict)) return;

    // --- Extract scope and files from the verdict output ---
    const scopeMatch = lastText.match(/\*\*Scope\*\*:\s*(.+)/);
    const scope = scopeMatch ? scopeMatch[1].trim() : ctx.cwd ?? "current changes";

    // Best-effort: extract @file references from session messages
    const filePaths: string[] = [];
    const fileRefRe = /@([\w./\-]+\.\w+)/g;
    for (const msg of messages) {
      const content =
        typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content);
      let m;
      while ((m = fileRefRe.exec(content)) !== null) {
        if (!filePaths.includes(m[1])) filePaths.push(m[1]);
      }
    }

    // --- Spawn peer 1 ---
    const peer1 = await spawnPeerAdversary(scope, filePaths, 1);
    let quorumSummary: string;
    let finalVerdict: Verdict;

    if (isNegativeVerdict(peer1.verdict)) {
      // Quorum confirmed on first peer
      finalVerdict = majorityVerdict([selfVerdict, peer1.verdict]);
      quorumSummary = `self=${selfVerdict}, peer1=${peer1.verdict} → **${finalVerdict} confirmed**`;
    } else {
      // Peer 1 disagrees — spawn peer 2
      const peer2 = await spawnPeerAdversary(scope, filePaths, 2);
      finalVerdict = majorityVerdict([selfVerdict, peer1.verdict, peer2.verdict]);
      quorumSummary =
        `self=${selfVerdict}, peer1=${peer1.verdict}, peer2=${peer2.verdict} → ` +
        `**${finalVerdict}** (majority of 3)`;
    }

    // --- Inject quorum summary ---
    await ctx.inject({
      customType: "quorum-result",
      content:
        `\n---\n**Quorum**: ${quorumSummary}\n` +
        (finalVerdict !== selfVerdict
          ? `\n> Original verdict ${selfVerdict} updated to ${finalVerdict} by quorum.`
          : ""),
      display: true,
    });
  });
}
