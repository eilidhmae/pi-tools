/**
 * adversary-capture.ts
 *
 * Emits training-example records when an adversary quorum reaches
 * agreement on a verdict (and ideally on findings). Records land in
 *   ~/.pi/agent/training/adversary-captures/tier-{1,2,3}.jsonl
 * tiered by confidence. Disagreements stash to disagreements.jsonl
 * for hand review.
 *
 * Not a pi extension itself — imported and called by quorum.ts after
 * verdict aggregation. Zero runtime dependencies.
 */

import { appendFileSync, mkdirSync } from "fs";
import { createHash } from "crypto";
import { join } from "path";

import { parseAdversaryReview, AdversaryReview, Finding } from "./adversary-parse";

export type Verdict = "PASS" | "CONCERNS" | "FAIL";

export interface ReviewerOutput {
  modelId: string;          // e.g. "qwen3-coder-7b+adversary"
  temperature: number;
  rawOutput: string;        // verbatim assistant text
}

export interface CaptureContext {
  scope: string;
  artifactPath?: string;    // best-effort
  artifactContent?: string; // best-effort, used for hashing
  gitSha?: string;          // best-effort
  projectName?: string;     // best-effort
}

interface Tally {
  verdict: Verdict;
  count: number;
  reviewers: ReviewerOutput[];
}

function captureDir(): string {
  const base = process.env.PI_ADVERSARY_DATASET
    ?? join(process.env.HOME ?? "", ".pi/agent/training/adversary-captures");
  mkdirSync(base, { recursive: true });
  return base;
}

function findingKey(f: Finding): string {
  return `${f.file}:${f.line}-${f.line_end}:${f.category}`;
}

function consensusFindings(reviews: AdversaryReview[]): Finding[] {
  if (reviews.length < 2) return [];
  const tally = new Map<string, { count: number; finding: Finding }>();
  for (const r of reviews) {
    const seen = new Set<string>(); // dedupe within a single reviewer
    for (const f of r.findings) {
      const k = findingKey(f);
      if (seen.has(k)) continue;
      seen.add(k);
      const cur = tally.get(k);
      if (cur) cur.count++;
      else tally.set(k, { count: 1, finding: f });
    }
  }
  return [...tally.values()].filter((x) => x.count >= 2).map((x) => x.finding);
}

function pickTier(
  verdictAgreement: Tally,
  findings: Finding[]
): 1 | 2 | 3 | null {
  if (verdictAgreement.count < 2) return null;
  const distinctModels = new Set(verdictAgreement.reviewers.map((r) => r.modelId)).size;
  const haveFindings = findings.length > 0;
  if (distinctModels >= 2 && haveFindings) return 1;
  if (haveFindings) return 2;
  return 3;
}

function tallyVerdicts(reviewers: ReviewerOutput[]): {
  parsed: Map<ReviewerOutput, AdversaryReview>;
  top: Tally;
} {
  const parsed = new Map<ReviewerOutput, AdversaryReview>();
  const counts = new Map<Verdict, ReviewerOutput[]>();
  for (const r of reviewers) {
    const result = parseAdversaryReview(r.rawOutput);
    if (!result.ok || !result.review) continue;
    parsed.set(r, result.review);
    const list = counts.get(result.review.verdict) ?? [];
    list.push(r);
    counts.set(result.review.verdict, list);
  }
  let top: Tally = { verdict: "PASS", count: 0, reviewers: [] };
  for (const [verdict, list] of counts) {
    if (list.length > top.count) top = { verdict, count: list.length, reviewers: list };
  }
  return { parsed, top };
}

function sha(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

export interface CaptureResult {
  tier: 1 | 2 | 3 | null;
  verdict?: Verdict;
  findings?: Finding[];
  recordedTo?: string;
  reason?: string;
}

export function captureFromQuorum(
  reviewers: ReviewerOutput[],
  ctx: CaptureContext
): CaptureResult {
  if (reviewers.length === 0) return { tier: null, reason: "no reviewers" };

  const { parsed, top } = tallyVerdicts(reviewers);

  if (parsed.size === 0) {
    return { tier: null, reason: "no parseable reviews" };
  }

  // Agreeing reviews
  const agreeingReviews: AdversaryReview[] = [];
  for (const r of top.reviewers) {
    const review = parsed.get(r);
    if (review) agreeingReviews.push(review);
  }
  const findings = consensusFindings(agreeingReviews);
  const tier = pickTier(top, findings);

  const dir = captureDir();
  const outFile = tier === null
    ? join(dir, "disagreements.jsonl")
    : join(dir, `tier-${tier}.jsonl`);

  const artifactContent = ctx.artifactContent ?? "";
  const artifactHash = artifactContent
    ? sha(artifactContent + "::" + top.verdict).slice(0, 16)
    : sha(ctx.scope + "::" + top.verdict + "::" + Date.now()).slice(0, 16);

  const record = {
    hash: artifactHash,
    capturedAt: new Date().toISOString(),
    tier,
    scope: ctx.scope,
    artifact: {
      path: ctx.artifactPath ?? null,
      content: artifactContent || null,
      gitSha: ctx.gitSha ?? null,
      projectName: ctx.projectName ?? null,
    },
    consensus: {
      verdict: top.verdict,
      findings,
      reviewerCount: top.count,
      agreementType: findings.length > 0 ? "verdict+finding" : "verdict-only",
    },
    reviewers: reviewers.map((r) => {
      const parsedR = parsed.get(r);
      return {
        modelId: r.modelId,
        temperature: r.temperature,
        verdict: parsedR?.verdict ?? null,
        confidence: parsedR?.confidence ?? null,
        findingCount: parsedR?.findings.length ?? 0,
        rawOutput: r.rawOutput.slice(0, 8000),
      };
    }),
  };

  appendFileSync(outFile, JSON.stringify(record) + "\n");

  return {
    tier,
    verdict: top.verdict,
    findings,
    recordedTo: outFile,
  };
}
