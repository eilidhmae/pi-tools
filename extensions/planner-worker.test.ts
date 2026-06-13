/**
 * Planner Worker helper tests.
 *
 *     node --experimental-strip-types extensions/planner-worker.test.ts
 *
 * Exercises the pure/extractable helpers — prompt/label parsing, script-path
 * resolution, and output parsing. The spawn runner and the tool/command surface
 * are covered by the manual probes in the PR/README, not here.
 */
import {
  parsePrompt,
  resolveScriptPath,
  parseWorkerOutput,
  summarizeRun,
  inDispatchedChild,
} from "./planner-worker.ts";

let pass = 0;
let fail = 0;
function ok(cond: boolean, msg: string) {
  if (cond) pass++;
  else { fail++; console.log("FAIL:", msg); }
}
const has = (set: Set<string>) => (p: string) => set.has(p);

// --- parsePrompt ------------------------------------------------------------
{ const r = parsePrompt('  "read the research and plan the change"  ');
  ok(r.prompt === "read the research and plan the change" && r.label === null, "parsePrompt: strips outer double quotes"); }
{ const r = parsePrompt("'single quoted'");
  ok(r.prompt === "single quoted" && r.label === null, "parsePrompt: strips outer single quotes"); }
{ const r = parsePrompt("no quotes here");
  ok(r.prompt === "no quotes here" && r.label === null, "parsePrompt: bare prompt"); }
{ const r = parsePrompt('--label=auth "plan auth.go refactor"');
  ok(r.prompt === "plan auth.go refactor" && r.label === "auth", "parsePrompt: --label=slug then quoted prompt"); }
{ const r = parsePrompt("--label deps plan the import graph cleanup");
  ok(r.prompt === "plan the import graph cleanup" && r.label === "deps", "parsePrompt: --label slug (space form)"); }
{ const r = parsePrompt("");
  ok(r.prompt === "" && r.label === null, "parsePrompt: empty"); }
{ const r = parsePrompt('"say \"hi\" to the world"');
  ok(r.prompt === 'say "hi" to the world' && r.label === null, "parsePrompt: only outermost pair stripped"); }
{ const r = parsePrompt('"unbalanced');
  ok(r.prompt === '"unbalanced' && r.label === null, "parsePrompt: lone quote left intact"); }

// --- resolveScriptPath ------------------------------------------------------
ok(resolveScriptPath({ home: "/home/u", cwd: "/repo", exists: has(new Set(["/home/u/.pi/agent/scripts/plan-jailed.sh"])) })
     === "/home/u/.pi/agent/scripts/plan-jailed.sh", "resolveScriptPath: global install");
ok(resolveScriptPath({ home: "/home/u", cwd: "/repo", exists: has(new Set(["/repo/scripts/bash/plan-jailed.sh"])) })
     === "/repo/scripts/bash/plan-jailed.sh", "resolveScriptPath: repo checkout");
ok(resolveScriptPath({ home: "/home/u", cwd: "/repo", exists: has(new Set()) }) === null,
   "resolveScriptPath: not found -> null");

// --- inDispatchedChild (recursion guard) ------------------------------------
ok(inDispatchedChild({ PI_RESEARCH_WORKER_CHILD: "1" }) === true, "inDispatchedChild: research marker");
ok(inDispatchedChild({ PI_ADVERSARY_CHILD: "1" }) === true, "inDispatchedChild: adversary marker (cross-type)");
ok(inDispatchedChild({ PI_PLANNER_CHILD: "1" }) === true, "inDispatchedChild: own planner marker");
ok(inDispatchedChild({ PI_PLANNER_CHILD: "0" }) === false, "inDispatchedChild: marker not '1' -> false");
ok(inDispatchedChild({}) === false, "inDispatchedChild: no marker -> false");

// --- parseWorkerOutput ------------------------------------------------------
{ const o = parseWorkerOutput("blah blah\nPlan written to: /ws/plans/plan-2026.md\n");
  ok(o.planPath === "/ws/plans/plan-2026.md", "parseWorkerOutput: plan path"); }
{ const o = parseWorkerOutput("no marker here");
  ok(o.planPath === null, "parseWorkerOutput: null when absent"); }

// --- summarizeRun -----------------------------------------------------------
{ const s = summarizeRun({ planPath: "/ws/plans/p.md", prompt: "plan auth.go refactor" });
  ok(s.includes("plan auth.go refactor") && s.includes("/ws/plans/p.md"), "summarizeRun: prompt + plan path"); }
{ const long = "x".repeat(200);
  const s = summarizeRun({ planPath: null, prompt: long });
  ok(s.includes("…") && !s.includes("Plan:"), "summarizeRun: truncates long prompt, omits plan when none"); }

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
