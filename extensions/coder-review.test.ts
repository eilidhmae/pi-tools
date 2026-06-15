/**
 * Coder Review helper tests.
 *
 *     node --experimental-strip-types extensions/coder-review.test.ts
 *
 * Exercises the pure/extractable helpers — arg parsing, script-path resolution,
 * output parsing, summary, and the recursion guard. The spawn runner and the
 * tool/command surface are covered by manual probes, not here.
 */
import {
  parseArgs,
  resolveScriptPath,
  parseWorkerOutput,
  summarizeRun,
  inDispatchedChild,
} from "./coder-review.ts";

let pass = 0;
let fail = 0;
function ok(cond: boolean, msg: string) {
  if (cond) pass++;
  else { fail++; console.log("FAIL:", msg); }
}
const has = (set: Set<string>) => (p: string) => set.has(p);

// --- parseArgs --------------------------------------------------------------
{ const r = parseArgs("plans/uptime.md");
  ok(r.target === "plans/uptime.md" && r.goal === null, "parseArgs: bare plan path"); }
{ const r = parseArgs('  plans/uptime.md  ');
  ok(r.target === "plans/uptime.md" && r.goal === null, "parseArgs: trims whitespace"); }
{ const r = parseArgs('plans/uptime.md --goal "create an uptime script"');
  ok(r.target === "plans/uptime.md" && r.goal === "create an uptime script", "parseArgs: --goal with quoted text"); }
{ const r = parseArgs("plans/uptime.md --goal create an uptime script");
  ok(r.target === "plans/uptime.md" && r.goal === "create an uptime script", "parseArgs: --goal unquoted multi-word"); }
{ const r = parseArgs("plans/uptime.md --goal=short");
  ok(r.target === "plans/uptime.md" && r.goal === "short", "parseArgs: --goal=value form"); }
{ const r = parseArgs("");
  ok(r.target === "" && r.goal === null, "parseArgs: empty"); }
{ const r = parseArgs("a/b/c.md --goal 'single quoted goal'");
  ok(r.target === "a/b/c.md" && r.goal === "single quoted goal", "parseArgs: single-quoted goal"); }

// --- resolveScriptPath ------------------------------------------------------
ok(resolveScriptPath({ home: "/home/u", cwd: "/repo", exists: has(new Set(["/home/u/.pi/agent/scripts/coder-review.sh"])) })
     === "/home/u/.pi/agent/scripts/coder-review.sh", "resolveScriptPath: global install");
ok(resolveScriptPath({ home: "/home/u", cwd: "/repo", exists: has(new Set(["/repo/scripts/bash/coder-review.sh"])) })
     === "/repo/scripts/bash/coder-review.sh", "resolveScriptPath: repo checkout");
ok(resolveScriptPath({ home: "/home/u", cwd: "/repo", exists: has(new Set()) }) === null,
   "resolveScriptPath: not found -> null");

// --- inDispatchedChild (recursion guard) ------------------------------------
ok(inDispatchedChild({ PI_CODER_REVIEW_CHILD: "1" }) === true, "inDispatchedChild: own marker");
ok(inDispatchedChild({ PI_CODER_CHILD: "1" }) === true, "inDispatchedChild: coder marker (cross-type)");
ok(inDispatchedChild({ PI_PLANNER_CHILD: "1" }) === true, "inDispatchedChild: planner marker (cross-type)");
ok(inDispatchedChild({ PI_ADVERSARY_CHILD: "1" }) === true, "inDispatchedChild: adversary marker (cross-type)");
ok(inDispatchedChild({ PI_CODER_REVIEW_CHILD: "0" }) === false, "inDispatchedChild: marker not '1' -> false");
ok(inDispatchedChild({}) === false, "inDispatchedChild: no marker -> false");

// --- parseWorkerOutput ------------------------------------------------------
{ const o = parseWorkerOutput("...\nVerdict: CONCERNS\nModel: x\nReview written to: reviews/plan-coder-review-2026.md\n");
  ok(o.reviewPath === "reviews/plan-coder-review-2026.md" && o.verdict === "CONCERNS", "parseWorkerOutput: path + verdict"); }
{ const o = parseWorkerOutput("Verdict: PASS\n");
  ok(o.verdict === "PASS" && o.reviewPath === null, "parseWorkerOutput: verdict only"); }
{ const o = parseWorkerOutput("no markers here");
  ok(o.reviewPath === null && o.verdict === null, "parseWorkerOutput: null when absent"); }

// --- summarizeRun -----------------------------------------------------------
{ const s = summarizeRun({ reviewPath: "reviews/p.md", verdict: "FAIL", target: "plans/p.md" });
  ok(s.includes("plans/p.md") && s.includes("FAIL") && s.includes("reviews/p.md"), "summarizeRun: target + verdict + path"); }
{ const s = summarizeRun({ reviewPath: null, verdict: null, target: "plans/p.md" });
  ok(s.includes("UNKNOWN") && !s.includes("Saved:"), "summarizeRun: UNKNOWN verdict, omits path when none"); }

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
