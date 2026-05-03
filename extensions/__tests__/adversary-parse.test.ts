/**
 * Tests for parseAdversaryReview — exercises the YAML subset reader,
 * particularly the fix for quoted strings containing colons inside lists.
 *
 * Run via `bash extensions/__tests__/run.sh` from repo root.
 *
 * No test framework: plain console.assert / throws. Exit non-zero on failure.
 */

import { parseAdversaryReview } from "../adversary-parse";

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
// Test 4: Documented known limitation. An UNQUOTED list-item string
// containing a colon is mis-parsed as a map. The adversary SKILL.md
// schema mandates quoting; this test pins the misparse so a future edit
// to readList does not silently change the behavior without intent.
const knownBadYaml = `verdict: PASS
confidence: low
artifact:
  path: x
  lines_reviewed: all
findings: []
mechanical_baseline:
  ran: true
  passed: false
  failures:
    - go vet: unreachable code at line 178
`;
const r4 = parseAdversaryReview("```adversary-review\n" + knownBadYaml + "\n```");
check("known-limitation: unquoted colon string is mis-parsed → ok=false",
      !r4.ok,
      "if this assertion ever STARTS passing, the parser was widened to handle " +
      "unquoted colons; update SKILL.md and this test together.");

// ---------------------------------------------------------------------------
if (failures > 0) {
  // eslint-disable-next-line no-console
  console.error(`\n${failures} test(s) FAILED`);
  process.exit(1);
} else {
  // eslint-disable-next-line no-console
  console.log("\nall tests passed");
}
