/**
 * Adversary Review helper tests.
 *
 *     node --experimental-strip-types extensions/adversary-review.test.ts
 *
 * Exercises the pure/extractable helpers — arg parsing, target/script path
 * resolution, and review-output parsing. The spawn runner and the tool/command
 * surface are covered by the manual probes in the PR/README, not here.
 */
import {
  parseArgs,
  isDiffTarget,
  resolveTarget,
  resolveScriptPath,
  parseReviewOutput,
  summarizeReview,
} from "./adversary-review.ts";

let pass = 0;
let fail = 0;
function ok(cond: boolean, msg: string) {
  if (cond) pass++;
  else { fail++; console.log("FAIL:", msg); }
}
const has = (set: Set<string>) => (p: string) => set.has(p);

// --- parseArgs --------------------------------------------------------------
{ const r = parseArgs("  foo.md  "); ok(r.target === "foo.md" && !r.quorum, "parseArgs: file only"); }
{ const r = parseArgs("foo.md --quorum"); ok(r.target === "foo.md" && r.quorum, "parseArgs: file + --quorum"); }
{ const r = parseArgs("--quorum notes/a.md"); ok(r.target === "notes/a.md" && r.quorum, "parseArgs: flag first"); }
{ const r = parseArgs(""); ok(r.target === "" && !r.quorum, "parseArgs: empty"); }

// --- isDiffTarget -----------------------------------------------------------
ok(isDiffTarget("HEAD") && isDiffTarget("STAGED") && isDiffTarget("RANGE:a..b"), "isDiffTarget: HEAD/STAGED/RANGE");
ok(!isDiffTarget("file.md"), "isDiffTarget: plain file is not a diff target");

// --- resolveTarget ----------------------------------------------------------
ok(resolveTarget("HEAD", { researchActive: true, workspace: "/ws", cwd: "/repo", exists: has(new Set()) }) === "HEAD",
   "resolveTarget: diff target passes through");
ok(resolveTarget("/abs/x.md", { researchActive: true, workspace: "/ws", cwd: "/repo", exists: has(new Set()) }) === "/abs/x.md",
   "resolveTarget: absolute passes through");
ok(resolveTarget("a.md", { researchActive: true, workspace: "/ws", cwd: "/repo", exists: has(new Set(["/repo/a.md"])) }) === "/repo/a.md",
   "resolveTarget: cwd-relative when present");
ok(resolveTarget("a.md", { researchActive: true, workspace: "/ws", cwd: "/repo", exists: has(new Set(["/ws/a.md"])) }) === "/ws/a.md",
   "resolveTarget: workspace fallback in research mode");
ok(resolveTarget("a.md", { researchActive: true, workspace: "/ws", cwd: "/repo", exists: has(new Set()) }) === "/repo/a.md",
   "resolveTarget: missing -> cwd path (script reports)");
ok(resolveTarget("a.md", { researchActive: false, workspace: null, cwd: "/repo", exists: has(new Set(["/ws/a.md"])) }) === "/repo/a.md",
   "resolveTarget: no workspace fallback outside research mode");

// --- resolveScriptPath ------------------------------------------------------
ok(resolveScriptPath({ home: "/home/u", cwd: "/repo", exists: has(new Set(["/home/u/.pi/agent/scripts/adversary-jailed.sh"])) })
     === "/home/u/.pi/agent/scripts/adversary-jailed.sh", "resolveScriptPath: global install");
ok(resolveScriptPath({ home: "/home/u", cwd: "/repo", exists: has(new Set(["/repo/scripts/bash/adversary-jailed.sh"])) })
     === "/repo/scripts/bash/adversary-jailed.sh", "resolveScriptPath: repo checkout");
ok(resolveScriptPath({ home: "/home/u", cwd: "/repo", exists: has(new Set()) }) === null,
   "resolveScriptPath: not found -> null");

// --- parseReviewOutput ------------------------------------------------------
{ const o = parseReviewOutput("blah\nVerdict: CONCERNS\nReview written to: /ws/reviews/x.md\n");
  ok(o.verdict === "CONCERNS" && o.reviewPath === "/ws/reviews/x.md", "parseReviewOutput: verdict + path"); }
{ const o = parseReviewOutput("**VERDICT: FAIL**\n");
  ok(o.verdict === "FAIL" && o.reviewPath === null, "parseReviewOutput: prose verdict, no path"); }
{ const o = parseReviewOutput("verdict: PASS\nmore");
  ok(o.verdict === "PASS", "parseReviewOutput: yaml verdict"); }
{ const o = parseReviewOutput("Verdict: CONCERNS\n**Final Verdict (post-quorum)**: FAIL\nReview written to: /ws/r.md");
  ok(o.verdict === "FAIL", "parseReviewOutput: post-quorum final verdict wins"); }
{ const o = parseReviewOutput("nothing here");
  ok(o.verdict === "UNKNOWN" && o.reviewPath === null, "parseReviewOutput: unknown when absent"); }

// --- summarizeReview --------------------------------------------------------
{ const s = summarizeReview({ verdict: "PASS", reviewPath: "/ws/r.md", quorum: false, target: "a.md" });
  ok(s.includes("a.md") && s.includes("PASS") && s.includes("/ws/r.md"), "summarizeReview: target/verdict/path"); }
{ const s = summarizeReview({ verdict: "FAIL", reviewPath: null, quorum: true, target: "a.md" });
  ok(s.includes("(quorum)"), "summarizeReview: marks quorum"); }

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
