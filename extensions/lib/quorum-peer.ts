/**
 * quorum-peer.ts
 *
 * Helpers for spawning a quorum peer adversary under the research jail. Kept in
 * lib/ (a) so pi's flat-glob extension discovery does not try to load it as a
 * plugin, and (b) so it has no heavy/transitive imports and is unit-testable in
 * isolation (`node --experimental-strip-types`).
 */

import { existsSync } from "node:fs";
import { join } from "node:path";

/** Minimal shape of a quorum peer (structurally satisfied by quorum.ts's Peer). */
export interface PeerSpec {
  model: string;
  provider: string;
  temperature: number;
}

/** Locate research-mode.ts so peers can be jailed (it provides bash-safe and
 * the read-only --research jail). Project-local checkout first, then global. */
export function findResearchModeExt(exists: (p: string) => boolean = existsSync): string | null {
  const candidates = [
    join(process.cwd(), ".pi/agent/extensions/research-mode.ts"),
    join(process.env.HOME ?? "", ".pi/agent/extensions/research-mode.ts"),
  ];
  for (const p of candidates) {
    if (exists(p)) return p;
  }
  return null;
}

/**
 * Build the `pi` argv for a peer adversary. Peers must not exceed the research
 * agent's authority — raw `bash` (the previous toolset) allowed arbitrary
 * execution and writes via shell redirection regardless of --no-write. So:
 *  - if research-mode.ts is available, run jailed read-only: read/grep/find/ls +
 *    bash-safe + --research (bash-safe keeps read-only `git diff` for the
 *    file-discovery fallback). Loading ONLY research-mode.ts (not quorum.ts)
 *    also prevents recursive quorum.
 *  - otherwise degrade to read-only built-ins (read,grep,ls) — never back to
 *    raw `bash`.
 */
export function buildPeerArgs(
  peer: PeerSpec,
  opts: { researchExtPath: string | null; peerPrompt: string },
): string[] {
  const args = [
    "--provider", peer.provider,
    "--model", peer.model,
    "--temperature", String(peer.temperature),
    "--no-extensions",          // prevent recursive quorum extension
  ];
  if (opts.researchExtPath) {
    // Same toolset as adversary-jailed.sh's reviewer. write-research is included
    // so research-mode's assessProtection() does not flag the peer "degraded"
    // (a missing RESEARCH_TOOLS member); the peer can only write into its own
    // throwaway temp workspace, never the repo.
    args.push(
      "-e", opts.researchExtPath,
      "--tools", "read,grep,find,ls,bash-safe,write-research",
      "--research",
      "--no-write",
      "--no-edit",
    );
  } else {
    args.push(
      "--tools", "read,grep,ls",
      "--no-write",
      "--no-edit",
    );
  }
  args.push("-p", opts.peerPrompt);
  return args;
}
