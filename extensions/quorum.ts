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

import { captureFromQuorum, ReviewerOutput } from "./lib/adversary-capture";

// --- Configuration ---
//
// Single-model legacy:        PI_QUORUM_MODEL=qwen3-coder:30b
// Heterogeneous quorum (new): PI_QUORUM_MODELS="qwen3-coder:30b@ollama,qwen3-coder-30b-a3b+adversary@local-mlx"
//                             temperatures parallel CSV (defaults shown):
//                             PI_QUORUM_TEMPS="0.2,0.5,0.7"
const LEGACY_MODEL = process.env.PI_QUORUM_MODEL ?? "qwen3-coder:30b";
const LEGACY_PROVIDER = process.env.PI_QUORUM_PROVIDER ?? "ollama";
const MODELS_RAW = process.env.PI_QUORUM_MODELS ?? "";
const TEMPS_RAW = process.env.PI_QUORUM_TEMPS ?? "0.2,0.5,0.7";
const PEER_TIMEOUT_MS = 120_000;

interface Peer {
  model: string;
  provider: string;
  temperature: number;
}

function peerRoster(): Peer[] {
  const temps = TEMPS_RAW.split(",").map((s) => parseFloat(s.trim())).filter((n) => !isNaN(n));
  if (MODELS_RAW.trim() === "") {
    return [{ model: LEGACY_MODEL, provider: LEGACY_PROVIDER, temperature: temps[0] ?? 0.2 }];
  }
  const out: Peer[] = [];
  const entries = MODELS_RAW.split(",").map((s) => s.trim()).filter(Boolean);
  for (let i = 0; i < entries.length; i++) {
    const [model, provider] = entries[i].split("@");
    out.push({
      model,
      provider: provider ?? "ollama",
      temperature: temps[i] ?? temps[temps.length - 1] ?? 0.2,
    });
  }
  return out;
}

type Verdict = "PASS" | "CONCERNS" | "FAIL" | "UNKNOWN";

interface PeerResult {
  verdict: Verdict;
  findings: string;
  rawOutput: string;
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
  // UNKNOWN entries (timeout, parse failure, crash) are treated as
  // abstentions and excluded from the tally. The conservative bias on
  // outright failures is preserved below: if no live reviewer reaches
  // a majority, FAIL > CONCERNS > PASS still wins.
  const live = verdicts.filter((v) => v !== "UNKNOWN");
  if (live.length === 0) return "CONCERNS";  // all reviewers failed; fail closed
  const counts = { PASS: 0, CONCERNS: 0, FAIL: 0, UNKNOWN: 0 };
  for (const v of live) counts[v]++;
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
  peerNumber: number,
  peer: Peer
): Promise<PeerResult> {
  const skillPath = findAdversarySkill();
  if (!skillPath) {
    return { verdict: "UNKNOWN", findings: "adversary SKILL.md not found", rawOutput: "" };
  }

  const skillContent = readFileSync(skillPath, "utf-8");
  const fileList = filePaths.map((p) => `@${p}`).join(" ");

  // QUORUM_PEER token prevents the peer from triggering its own quorum.
  // Ask for the structured adversary-review fenced YAML block so capture
  // can match findings, not just verdicts.
  const peerPrompt =
    `QUORUM_PEER peer-${peerNumber}: ` +
    `Review scope: ${scope}. ` +
    `Files: ${fileList || "(use git diff HEAD to identify changed files)"}. ` +
    `Emit the structured adversary-review fenced YAML block per skills/adversary/SKILL.md, ` +
    `with verdict, confidence, artifact, and findings. Skip the prose summary — block only.`;

  return new Promise((resolve) => {
    let stdout = "";
    let settled = false;

    const child = spawn(
      "pi",
      [
        "--provider", peer.provider,
        "--model", peer.model,
        "--temperature", String(peer.temperature),
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
      // Pass UNKNOWN through verbatim. majorityVerdict treats UNKNOWN as
      // an abstention; the upstream caller can also surface the
      // unparseable output to the operator.
      resolve({
        verdict,
        findings: stdout.slice(0, 2000), // cap to avoid context explosion
        rawOutput: stdout,
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

    // --- Spawn peers from configured roster ---
    const roster = peerRoster();
    const peerOutputs: { peer: Peer; result: PeerResult }[] = [];

    const peer1 = await spawnPeerAdversary(scope, filePaths, 1, roster[0]);
    peerOutputs.push({ peer: roster[0], result: peer1 });

    let quorumSummary: string;
    let finalVerdict: Verdict;

    if (isNegativeVerdict(peer1.verdict)) {
      finalVerdict = majorityVerdict([selfVerdict, peer1.verdict]);
      quorumSummary = `self=${selfVerdict}, peer1=${peer1.verdict} → **${finalVerdict} confirmed**`;
    } else {
      const secondPeerCfg = roster[1] ?? roster[0];
      const peer2 = await spawnPeerAdversary(scope, filePaths, 2, secondPeerCfg);
      peerOutputs.push({ peer: secondPeerCfg, result: peer2 });
      finalVerdict = majorityVerdict([selfVerdict, peer1.verdict, peer2.verdict]);
      quorumSummary =
        `self=${selfVerdict}, peer1=${peer1.verdict}, peer2=${peer2.verdict} → ` +
        `**${finalVerdict}** (majority of 3)`;
    }

    // --- Capture training example on agreement (best-effort) ---
    try {
      const reviewers: ReviewerOutput[] = [
        {
          modelId: process.env.PI_MODEL ?? "unknown-self",
          temperature: parseFloat(process.env.PI_TEMPERATURE ?? "0"),
          rawOutput: lastText,
        },
        ...peerOutputs.map(({ peer, result }) => ({
          modelId: peer.model,
          temperature: peer.temperature,
          rawOutput: result.rawOutput,
        })),
      ];
      const captured = captureFromQuorum(reviewers, {
        scope,
        artifactPath: filePaths[0],
        gitSha: process.env.GIT_SHA,
        projectName: ctx.cwd ? ctx.cwd.split("/").pop() : undefined,
      });
      if (captured.tier !== null) {
        quorumSummary += `  [captured tier-${captured.tier} → ${captured.recordedTo}]`;
      }
    } catch (e) {
      // Capture is best-effort; never fail the quorum because of it.
      quorumSummary += `  [capture skipped: ${(e as Error).message}]`;
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
