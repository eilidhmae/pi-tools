/**
 * Quorum peer-arg tests.
 *
 *     node --experimental-strip-types extensions/lib/quorum-peer.test.ts
 *
 * Guards the security-relevant invariant: a quorum peer never gets raw `bash`.
 */
import { buildPeerArgs, findResearchModeExt } from "./quorum-peer.ts";

let pass = 0;
let fail = 0;
function ok(cond: boolean, msg: string) {
  if (cond) pass++;
  else { fail++; console.log("FAIL:", msg); }
}
const peer = { model: "m", provider: "p", temperature: 0.2 };
const toolsOf = (a: string[]) => { const i = a.indexOf("--tools"); return i >= 0 ? a[i + 1] : ""; };

// --- jailed (research-mode.ts available) ------------------------------------
{
  const a = buildPeerArgs(peer, { researchExtPath: "/x/research-mode.ts", peerPrompt: "PR" });
  ok(!a.includes("bash"), "jailed: no raw `bash` tool token");
  ok(toolsOf(a) === "read,grep,find,ls,bash-safe,write-research", "jailed: read-only tools + bash-safe + write-research (matches adversary-jailed.sh)");
  ok(!toolsOf(a).split(",").includes("bash"), "jailed: no bare bash in --tools");
  ok(a.includes("--research"), "jailed: --research present");
  ok(a.includes("-e") && a.includes("/x/research-mode.ts"), "jailed: loads only research-mode.ts");
  ok(a.includes("--no-extensions"), "jailed: --no-extensions (no recursive quorum)");
  ok(a.includes("--no-write") && a.includes("--no-edit"), "jailed: write/edit denied");
  ok(a[a.length - 2] === "-p" && a[a.length - 1] === "PR", "jailed: prompt passed last");
}

// --- degraded (research-mode.ts not found) ----------------------------------
{
  const a = buildPeerArgs(peer, { researchExtPath: null, peerPrompt: "PR" });
  ok(!a.includes("bash"), "degrade: no raw `bash`");
  ok(toolsOf(a) === "read,grep,ls", "degrade: read-only built-ins only");
  ok(!toolsOf(a).split(",").includes("bash-safe"), "degrade: no bash-safe without the extension");
  ok(!a.includes("--research"), "degrade: no --research without the extension");
}

// --- findResearchModeExt ----------------------------------------------------
ok(typeof findResearchModeExt((p) => p.endsWith(".pi/agent/extensions/research-mode.ts")) === "string",
   "findResearchModeExt: resolves a candidate when present");
ok(findResearchModeExt(() => false) === null, "findResearchModeExt: null when absent");

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
