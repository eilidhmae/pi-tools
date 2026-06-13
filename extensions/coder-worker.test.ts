/**
 * Coder Worker helper tests.
 *
 *     node --experimental-strip-types extensions/coder-worker.test.ts
 *
 * Exercises the pure/extractable helpers — prompt/label parsing, script-path
 * resolution, the recursion guard, and the research-mode fail-hard predicate.
 * The spawn runner and the tool/command surface are covered by the manual
 * probes in the PR/README, not here. Unlike the read-only workers there is no
 * report-path artifact, so there is no output-parse helper to test.
 */
import {
  parsePrompt,
  resolveScriptPath,
  inDispatchedChild,
  inResearchMode,
  summarizeRun,
} from "./coder-worker.ts";

let pass = 0;
let fail = 0;
function ok(cond: boolean, msg: string) {
  if (cond) pass++;
  else { fail++; console.log("FAIL:", msg); }
}
const has = (set: Set<string>) => (p: string) => set.has(p);

// --- parsePrompt ------------------------------------------------------------
{ const r = parsePrompt('  "read the plan and implement the change"  ');
  ok(r.prompt === "read the plan and implement the change" && r.label === null, "parsePrompt: strips outer double quotes"); }
{ const r = parsePrompt("'single quoted'");
  ok(r.prompt === "single quoted" && r.label === null, "parsePrompt: strips outer single quotes"); }
{ const r = parsePrompt("no quotes here");
  ok(r.prompt === "no quotes here" && r.label === null, "parsePrompt: bare prompt"); }
{ const r = parsePrompt('--label=auth "implement auth.go from the plan"');
  ok(r.prompt === "implement auth.go from the plan" && r.label === "auth", "parsePrompt: --label=slug then quoted prompt"); }
{ const r = parsePrompt("--label deps implement the import graph cleanup");
  ok(r.prompt === "implement the import graph cleanup" && r.label === "deps", "parsePrompt: --label slug (space form)"); }
{ const r = parsePrompt("");
  ok(r.prompt === "" && r.label === null, "parsePrompt: empty"); }
{ const r = parsePrompt('"say \"hi\" to the world"');
  ok(r.prompt === 'say "hi" to the world' && r.label === null, "parsePrompt: only outermost pair stripped"); }
{ const r = parsePrompt('"unbalanced');
  ok(r.prompt === '"unbalanced' && r.label === null, "parsePrompt: lone quote left intact"); }

// --- resolveScriptPath ------------------------------------------------------
ok(resolveScriptPath({ home: "/home/u", cwd: "/repo", exists: has(new Set(["/home/u/.pi/agent/scripts/coder-run.sh"])) })
     === "/home/u/.pi/agent/scripts/coder-run.sh", "resolveScriptPath: global install");
ok(resolveScriptPath({ home: "/home/u", cwd: "/repo", exists: has(new Set(["/repo/scripts/bash/coder-run.sh"])) })
     === "/repo/scripts/bash/coder-run.sh", "resolveScriptPath: repo checkout");
ok(resolveScriptPath({ home: "/home/u", cwd: "/repo", exists: has(new Set(["/repo/.pi/agent/scripts/coder-run.sh"])) })
     === "/repo/.pi/agent/scripts/coder-run.sh", "resolveScriptPath: project-local checkout");
ok(resolveScriptPath({ home: "/home/u", cwd: "/repo", exists: has(new Set()) }) === null,
   "resolveScriptPath: not found -> null");

// --- inDispatchedChild (recursion guard) ------------------------------------
ok(inDispatchedChild({ PI_CODER_CHILD: "1" }) === true, "inDispatchedChild: own coder marker");
ok(inDispatchedChild({ PI_PLANNER_CHILD: "1" }) === true, "inDispatchedChild: planner marker (cross-type)");
ok(inDispatchedChild({ PI_RESEARCH_WORKER_CHILD: "1" }) === true, "inDispatchedChild: research marker (cross-type)");
ok(inDispatchedChild({ PI_ADVERSARY_CHILD: "1" }) === true, "inDispatchedChild: adversary marker (cross-type)");
ok(inDispatchedChild({ PI_CODER_CHILD: "0" }) === false, "inDispatchedChild: marker not '1' -> false");
ok(inDispatchedChild({}) === false, "inDispatchedChild: no marker -> false");

// --- inResearchMode (fail-hard predicate) -----------------------------------
ok(inResearchMode({ PI_RESEARCH_WORKSPACE: "/ws" }) === true, "inResearchMode: PI_RESEARCH_WORKSPACE set");
ok(inResearchMode({ PI_RESEARCH_MODE_WORKSPACE: "/ws" }) === true, "inResearchMode: PI_RESEARCH_MODE_WORKSPACE set");
ok(inResearchMode({ PI_RESEARCH_WORKSPACE: "/a", PI_RESEARCH_MODE_WORKSPACE: "/b" }) === true, "inResearchMode: both set");
ok(inResearchMode({}) === false, "inResearchMode: neither set -> false");
ok(inResearchMode({ PI_CODER_CHILD: "1" }) === false, "inResearchMode: unrelated env -> false");

// --- summarizeRun -----------------------------------------------------------
{ const s = summarizeRun({ prompt: "implement auth.go from the plan" });
  ok(s.includes("implement auth.go from the plan") && s.startsWith("Coder worker"), "summarizeRun: prompt in summary"); }
{ const long = "x".repeat(200);
  const s = summarizeRun({ prompt: long });
  ok(s.includes("…"), "summarizeRun: truncates long prompt"); }

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
