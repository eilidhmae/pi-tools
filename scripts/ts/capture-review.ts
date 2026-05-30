#!/usr/bin/env tsx
/**
 * capture-review.ts -- Emit a bootstrap.jsonl record from a saved
 * adversary review file. Called by adversary-pass.sh after writing
 * the .md review artifact, so headless single-reviewer runs feed the
 * training corpus the same way interactive quorum runs do.
 *
 * Usage:
 *   capture-review.ts --review <path.md> --scope <scope>
 *                      [--model <id>] [--temperature <n>]
 *                      [--artifact-path <p>] [--git-sha <sha>]
 *
 * The review file's body (everything after the script's prelude) is
 * passed verbatim to captureSingleReviewer as `rawOutput`; the parser
 * extracts the fenced YAML block on its own.
 *
 * Exits 0 on success (including parse-failure routed to
 * disagreements.jsonl); exits non-zero only on missing flags or I/O
 * errors. Capture is informational — it must not block a review.
 */

import { readFileSync } from "fs";
import { captureSingleReviewer, ReviewerOutput, CaptureContext } from "../../extensions/lib/adversary-capture";

function getArg(name: string, required: boolean = false): string | undefined {
  const argv = process.argv;
  const idx = argv.indexOf(`--${name}`);
  if (idx >= 0 && idx + 1 < argv.length) return argv[idx + 1];
  if (required) {
    console.error(`ERROR: --${name} is required`);
    process.exit(2);
  }
  return undefined;
}

const reviewPath = getArg("review", true)!;
const scope = getArg("scope", true)!;
const modelId = getArg("model") ?? "unknown";
const temperature = parseFloat(getArg("temperature") ?? "0");
const artifactPath = getArg("artifact-path");
const gitSha = getArg("git-sha");

let rawOutput: string;
try {
  rawOutput = readFileSync(reviewPath, "utf-8");
} catch (err: any) {
  console.error(`ERROR: cannot read review file ${reviewPath}: ${err.message}`);
  process.exit(2);
}

const reviewer: ReviewerOutput = { modelId, temperature, rawOutput };
const ctx: CaptureContext = { scope, artifactPath, gitSha };

const result = captureSingleReviewer(reviewer, ctx);

// Compact one-line report for the calling shell script.
if (result.tier === "bootstrap") {
  console.log(`capture: bootstrap verdict=${result.verdict} findings=${result.findingCount} → ${result.recordedTo}`);
} else {
  console.log(`capture: parse-failed reason="${result.reason}" → ${result.recordedTo}`);
}
