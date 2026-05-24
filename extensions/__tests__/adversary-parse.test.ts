/**
 * Tests for parseAdversaryReview — exercises the YAML subset reader,
 * particularly the fix for quoted strings containing colons inside lists.
 *
 * Run via `bash extensions/__tests__/run.sh` from repo root.
 *
 * No test framework: plain console.assert / throws. Exit non-zero on failure.
 */

import { parseAdversaryReview } from "../lib/adversary-parse";

let failures = 0;
function check(name: string, cond: boolean, detail?: string) {
  if (cond) {
    // eslint-disable-next-line no-console
    console.log(`ok  - ${name}`);
  } else {
    failures++;
    // eslint-disable-next-line no-console
    console.error(`FAIL - ${name}${detail ? `: ${detail}` : ""}`);
  }
}

// ---------------------------------------------------------------------------
// Test 1: verbatim worked example from skills/adversary/SKILL.md
// ---------------------------------------------------------------------------
const workedExample = `
Some prose preamble that the parser should ignore.

\`\`\`adversary-review
verdict: FAIL
confidence: high
artifact:
  path: src/auth/session.go
  sha256: a3f8c2e1bf09d145
  lines_reviewed: 1-247
findings:
  - id: F1
    severity: critical
    category: race-condition
    file: src/auth/session.go
    line: 47
    line_end: 52
    message: >
      Concurrent access to the session map without mutex protection.
      Multiple goroutines can call Store() simultaneously, leading to a
      fatal map race detected at runtime.
    suggested_fix: >
      Wrap reads/writes in sync.RWMutex, or replace with sync.Map.
  - id: F2
    severity: major
    category: error-handling
    file: src/auth/session.go
    line: 92
    line_end: 92
    message: >
      Error from json.Unmarshal is discarded. Malformed session data will
      silently produce a zero-value Session struct.
    suggested_fix: >
      Return wrapped error: fmt.Errorf("decode session: %w", err)
mechanical_baseline:
  ran: true
  passed: false
  failures:
    - "go vet: unreachable code at line 178"
\`\`\`
`;

const r1 = parseAdversaryReview(workedExample);
check("worked example: ok=true", r1.ok === true,
      `errors=${JSON.stringify(r1.errors)} fatal=${r1.fatal}`);
check("worked example: review present", !!r1.review);
if (r1.review) {
  check("worked example: verdict FAIL", r1.review.verdict === "FAIL");
  check("worked example: 2 findings", r1.review.findings.length === 2,
        `got ${r1.review.findings.length}`);
  const mb = r1.review.mechanical_baseline;
  check("worked example: mechanical_baseline present", !!mb);
  if (mb) {
    check("worked example: 1 failure", mb.failures.length === 1,
          `got ${mb.failures.length}: ${JSON.stringify(mb.failures)}`);
    const expected = "go vet: unreachable code at line 178";
    check(`worked example: failure[0] === "${expected}"`,
          mb.failures[0] === expected,
          `got ${JSON.stringify(mb.failures[0])}`);
  }
}

// ---------------------------------------------------------------------------
// Test 2: list item with single-quoted string containing a colon
// ---------------------------------------------------------------------------
const singleQuoted = `
\`\`\`adversary-review
verdict: PASS
confidence: high
artifact:
  path: x.go
  lines_reviewed: 1-10
mechanical_baseline:
  ran: true
  passed: false
  failures:
    - 'lint: trailing whitespace at line 5'
\`\`\`
`;
const r2 = parseAdversaryReview(singleQuoted);
check("single-quoted: ok=true", r2.ok === true,
      `errors=${JSON.stringify(r2.errors)} fatal=${r2.fatal}`);
if (r2.ok && r2.review?.mechanical_baseline) {
  const f = r2.review.mechanical_baseline.failures[0];
  check("single-quoted: parsed as string with colon",
        f === "lint: trailing whitespace at line 5",
        `got ${JSON.stringify(f)}`);
}

// ---------------------------------------------------------------------------
// Test 3: genuine inline-map list item (- id: F1) parses as a map
// ---------------------------------------------------------------------------
const inlineMap = `
\`\`\`adversary-review
verdict: CONCERNS
confidence: medium
artifact:
  path: y.py
  lines_reviewed: 1-5
findings:
  - id: F9
    severity: minor
    category: idiom
    file: y.py
    line: 3
    line_end: 3
    message: >
      Use snake_case for function names.
\`\`\`
`;
const r3 = parseAdversaryReview(inlineMap);
check("inline map: ok=true", r3.ok === true,
      `errors=${JSON.stringify(r3.errors)} fatal=${r3.fatal}`);
if (r3.ok && r3.review) {
  const f = r3.review.findings[0];
  check("inline map: finding parsed as map (id F9)",
        f && f.id === "F9", `got ${JSON.stringify(f)}`);
  check("inline map: line=3", f && f.line === 3);
}

// ---------------------------------------------------------------------------
// Test 4: SKILL.md mandates `findings: []` for PASS verdicts. The parser
// must accept this flow-style empty list.
const passYaml = `verdict: PASS
confidence: high
artifact:
  path: src/clean.go
  sha256: deadbeefcafef00d
  lines_reviewed: 1-42
findings: []
`;
const r4 = parseAdversaryReview("```adversary-review\n" + passYaml + "\n```");
check("PASS verdict: ok=true", r4.ok, r4.fatal ?? "");
check("PASS verdict: findings is empty list",
      r4.review !== undefined && Array.isArray(r4.review.findings) && r4.review.findings.length === 0);

// ---------------------------------------------------------------------------
// Test 5: Documented known limitation. An UNQUOTED list-item string
// containing a colon is mis-parsed as a map. SKILL.md mandates quoting;
// this test pins the misparse so a future edit to readList doesn't
// silently change the behavior without intent. The payload includes a
// real findings list so the parse reaches mechanical_baseline.failures
// where the unquoted colon actually triggers the bug.
const knownBadYaml = `verdict: CONCERNS
confidence: low
artifact:
  path: src/x.go
  sha256: 0000000000000000
  lines_reviewed: 1-10
findings:
  - id: F1
    severity: minor
    category: idiom
    file: src/x.go
    line: 1
    line_end: 1
    message: trivial
mechanical_baseline:
  ran: true
  passed: false
  failures:
    - go vet: unreachable code at line 178
`;
const r5 = parseAdversaryReview("```adversary-review\n" + knownBadYaml + "\n```");
check("known-limitation: unquoted colon string is mis-parsed → ok=false",
      !r5.ok,
      "if this assertion ever STARTS passing, the parser was widened to handle " +
      "unquoted colons; update SKILL.md and this test together. Currently r5.ok=" + r5.ok);

// ---------------------------------------------------------------------------
// Test 6: split fence label. qwen3-coder-30b-a3b occasionally emits the
// fence as ```\nadversary-review\n... instead of ```adversary-review\n...
// Observed on this M5 Max during Phase 0 smoke (2026-05-14). The parser
// must accept both forms.
const splitFence = "```\nadversary-review\nverdict: PASS\nconfidence: high\n" +
  "artifact:\n  path: x.go\n  sha256: deadbeefcafef00d\n  lines_reviewed: 1-10\n" +
  "findings: []\n```";
const r6 = parseAdversaryReview(splitFence);
check("split fence label: ok=true", r6.ok === true,
      `errors=${JSON.stringify(r6.errors)} fatal=${r6.fatal}`);
check("split fence label: verdict PASS",
      r6.review !== undefined && r6.review.verdict === "PASS");

// ---------------------------------------------------------------------------
// Test 7: salvage path — opening fence with no closing fence, last finding
// truncated mid-folded-scalar. Observed on M5 Max during Phase 3 b4c7477
// replay (2026-05-14) on files > ~300 lines: degenerate repetition consumes
// the output budget, EOF lands mid-`message:`. Salvage drops the trailing
// finding and marks the record partial.
const truncated = "```adversary-review\n" +
  "verdict: CONCERNS\n" +
  "confidence: medium\n" +
  "artifact:\n" +
  "  path: /tmp/morphs.go\n" +
  "  sha256: 9a78fd01404eff92\n" +
  "  lines_reviewed: 1-695\n" +
  "findings:\n" +
  "  - id: F1\n" +
  "    severity: minor\n" +
  "    category: maintainability\n" +
  "    file: /tmp/morphs.go\n" +
  "    line: 10\n" +
  "    line_end: 10\n" +
  "    message: >\n" +
  "      A complete first finding.\n" +
  "  - id: F2\n" +
  "    severity: minor\n" +
  "    category: maintainability\n" +
  "    file: /tmp/morphs.go\n" +
  "    line: 20\n" +
  "    line_end: 20\n" +
  "    message: >\n" +
  "      Truncated mid-sentence and the YAML never closes its f";
const r7 = parseAdversaryReview(truncated);
check("salvage: ok=true", r7.ok === true,
      `errors=${JSON.stringify(r7.errors)} fatal=${r7.fatal}`);
check("salvage: partial=true on result", r7.partial === true);
check("salvage: partial=true on review",
      r7.review !== undefined && r7.review.partial === true);
check("salvage: verdict CONCERNS",
      r7.review !== undefined && r7.review.verdict === "CONCERNS");
check("salvage: keeps the complete first finding",
      r7.review !== undefined && r7.review.findings.length >= 1 &&
      r7.review.findings[0].id === "F1",
      `findings=${JSON.stringify(r7.review?.findings)}`);
// The truncated F2 above has the required scalar fields (id, severity,
// category, file, line, message) all populated as parseable strings, so
// the schema validator accepts it — the truncation lost only the tail
// of the folded-scalar message. That's fine; partial=true flags the
// record for curation regardless of which findings made it.
check("salvage: doesn't fatal on a half-written final finding",
      r7.fatal === undefined,
      `fatal=${r7.fatal}`);

// ---------------------------------------------------------------------------
// Test 8: salvage path — opening fence, finishes mid-key with the YAML
// validator unable to construct the trailing finding. The salvage logic
// must drop that finding and keep the prior ones rather than fatal-erroring.
const truncMidKey = "```adversary-review\n" +
  "verdict: CONCERNS\n" +
  "confidence: high\n" +
  "artifact:\n" +
  "  path: /tmp/x.go\n" +
  "  sha256: deadbeefcafef00d\n" +
  "  lines_reviewed: 1-50\n" +
  "findings:\n" +
  "  - id: F1\n" +
  "    severity: minor\n" +
  "    category: correctness\n" +
  "    file: /tmp/x.go\n" +
  "    line: 5\n" +
  "    message: First, complete.\n" +
  "  - id: F2\n" +
  "    severity: minor\n" +
  // No category/file/line/message — parse fails on this item.
  "";
const r8 = parseAdversaryReview(truncMidKey);
check("salvage mid-key: ok=true (drops truncated F2)",
      r8.ok === true,
      `errors=${JSON.stringify(r8.errors)} fatal=${r8.fatal}`);
check("salvage mid-key: review.partial=true",
      r8.review !== undefined && r8.review.partial === true);
check("salvage mid-key: kept F1, dropped F2",
      r8.review !== undefined && r8.review.findings.length === 1 &&
      r8.review.findings[0].id === "F1",
      `findings=${JSON.stringify(r8.review?.findings)}`);

// ---------------------------------------------------------------------------
// Test 9: salvage must NOT trigger when the closing fence IS present. The
// canonical path should still set partial undefined.
const closedAgain = "```adversary-review\n" +
  "verdict: PASS\nconfidence: high\n" +
  "artifact:\n  path: y.go\n  sha256: aaaaaaaaaaaaaaaa\n  lines_reviewed: 1-1\n" +
  "findings: []\n```\ntrailing prose after fence\n";
const r9 = parseAdversaryReview(closedAgain);
check("closed fence: partial stays undefined",
      r9.ok === true && r9.partial === undefined,
      `partial=${r9.partial}`);
check("closed fence: review.partial undefined",
      r9.review !== undefined && r9.review.partial === undefined);

// ---------------------------------------------------------------------------
// Test 10: verdict normalization. qwen3-coder-30b-a3b emits the singular
// "CONCERN" for the mandated plural "CONCERNS" (observed on this M5 Max
// during a pi-tools pre-push scan, 2026-05-24). Before VERDICT_ALIASES the
// parser fataled with "verdict 'CONCERN' not in PASS|CONCERNS|FAIL" and the
// review was dumped to disagreements.jsonl. It must now normalize to
// CONCERNS, parse ok, and log the coercion.
const singularVerdict = "```adversary-review\n" +
  "verdict: CONCERN\n" +
  "confidence: medium\n" +
  "artifact:\n  path: src/x.go\n  sha256: deadbeefcafef00d\n  lines_reviewed: 1-10\n" +
  "findings: []\n```";
const r10 = parseAdversaryReview(singularVerdict);
check("singular verdict: ok=true",
      r10.ok === true, `errors=${JSON.stringify(r10.errors)} fatal=${r10.fatal}`);
check("singular verdict: normalized CONCERN → CONCERNS",
      r10.review !== undefined && r10.review.verdict === "CONCERNS",
      `got ${r10.review?.verdict}`);
check("singular verdict: coercion logged in errors",
      r10.errors.some((e) => e.includes("CONCERN") && e.includes("CONCERNS")),
      `errors=${JSON.stringify(r10.errors)}`);

// A genuinely unknown verdict must still fatal — normalization is an
// allowlist of known slips, not a blanket accept.
const bogusVerdict = "```adversary-review\n" +
  "verdict: MAYBE\nconfidence: low\n" +
  "artifact:\n  path: src/x.go\n  lines_reviewed: 1-10\n" +
  "findings: []\n```";
const r11 = parseAdversaryReview(bogusVerdict);
check("bogus verdict: ok=false (not silently accepted)",
      !r11.ok, `r11.ok=${r11.ok}`);

// ---------------------------------------------------------------------------
// Test 12: category aliases for the near-miss tokens qwen3-coder emits and
// that were stranding clean reviews in disagreements.jsonl (observed on this
// M5 Max, 2026-05-24): idiomatic→idiom, complexity→maintainability,
// robustness→error-handling.
const catAliases: Array<[string, string]> = [
  ["idiomatic", "idiom"],
  ["complexity", "maintainability"],
  ["robustness", "error-handling"],
];
for (const [raw, want] of catAliases) {
  const yaml = "```adversary-review\n" +
    "verdict: CONCERNS\nconfidence: medium\n" +
    "artifact:\n  path: src/x.go\n  lines_reviewed: 1-10\n" +
    "findings:\n" +
    "  - id: F1\n    severity: minor\n    category: " + raw + "\n" +
    "    file: src/x.go\n    line: 1\n    line_end: 1\n    message: trivial\n```";
  const res = parseAdversaryReview(yaml);
  check(`category '${raw}': ok=true`, res.ok === true,
        `errors=${JSON.stringify(res.errors)} fatal=${res.fatal}`);
  check(`category '${raw}' → '${want}'`,
        res.review?.findings[0]?.category === want,
        `got ${res.review?.findings[0]?.category}`);
}

// ---------------------------------------------------------------------------
if (failures > 0) {
  // eslint-disable-next-line no-console
  console.error(`\n${failures} test(s) FAILED`);
  process.exit(1);
} else {
  // eslint-disable-next-line no-console
  console.log("\nall tests passed");
}
