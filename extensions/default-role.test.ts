/**
 * Default-role helper tests.
 *   node --experimental-strip-types extensions/default-role.test.ts
 */
import { toolStateGuidance, buildDefaultRole } from "./default-role.ts";

let pass = 0, fail = 0;
function ok(cond: boolean, msg: string) { if (cond) pass++; else { fail++; console.log("FAIL:", msg); } }

const FULL = ["read", "bash", "edit", "write", "grep", "find", "ls"];
const RESTRICTED_WR = ["read", "grep", "find", "ls", "write-research"];           // write-research, no --research yet
const JAILED = ["read", "grep", "find", "ls", "bash-safe", "write-research"];     // research-mode toolset
const READONLY = ["read", "grep", "find", "ls", "bash-safe"];                     // no write at all

// toolStateGuidance
ok(toolStateGuidance(FULL) === null, "full toolset -> no guidance");
{
  const g = toolStateGuidance(RESTRICTED_WR)!;
  ok(g !== null && /research-mode/.test(g) && /write-research/.test(g), "write-research present, no write -> suggest research mode");
}
{
  const g = toolStateGuidance(JAILED)!;
  ok(/research-mode/.test(g) && /bash-safe/.test(g), "jailed -> suggest research mode + bash-safe note");
}
{
  const g = toolStateGuidance(READONLY)!;
  ok(/read-only session/.test(g) && /bash-safe/.test(g), "no write capability -> read-only note + bash-safe note");
}

// buildDefaultRole
ok(buildDefaultRole(FULL).includes("# Default role") && !buildDefaultRole(FULL).includes("Harness note"), "full -> persona, no harness note");
ok(buildDefaultRole(RESTRICTED_WR).includes("Harness note"), "restricted -> persona + harness note");
ok(!/Mneme|Oracle/.test(buildDefaultRole(FULL)), "no host identity (Mneme/Oracle) in default role");

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
