/**
 * Research Mode helper tests.
 *
 * Runnable without a test framework on Node >= 23 (native TypeScript stripping):
 *
 *     node --experimental-strip-types extensions/research-mode.test.ts
 *
 * (On Node 23.6+/26 the flag is optional.) Exercises the pure/extractable
 * helpers — path containment, the bash-safe denylist, and the tool-set logic.
 * The interactive command/UI surface is covered by the manual probes in
 * RESEARCH-MODE.md, not here.
 */
import { mkdtemp, mkdir, symlink, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  writeIntoWorkspace,
  destInWorkspace,
  parseCommand,
  classifyCommand,
  computeDesiredActiveTools,
  assessProtection,
} from "./research-mode.ts";

let pass = 0;
let fail = 0;
function ok(cond: boolean, msg: string) {
  if (cond) pass++;
  else { fail++; console.log("FAIL:", msg); }
}

const ws = await mkdtemp(join(tmpdir(), "rm-test-"));
const outside = await mkdtemp(join(tmpdir(), "rm-outside-"));

// --- writeIntoWorkspace: containment ---------------------------------------
{
  const r = await writeIntoWorkspace("notes.md", "hello", ws);
  ok(r.ok && (await readFile(join(ws, "notes.md"), "utf8")) === "hello", "relative write lands in workspace");
}
{
  const r = await writeIntoWorkspace("a/b/c.txt", "deep", ws);
  ok(r.ok && (await readFile(join(ws, "a/b/c.txt"), "utf8")) === "deep", "nested relative write creates dirs");
}
ok(!(await writeIntoWorkspace("../escape.txt", "x", ws)).ok, "reject path containing ..");
ok((await writeIntoWorkspace(join(ws, "abs.txt"), "y", ws)).ok, "absolute path inside workspace allowed");
ok((await writeIntoWorkspace("v1..v2.patch", "x", ws)).ok, "filename with '..' substring (not a component) allowed");
{
  const r = await writeIntoWorkspace(join(outside, "evil.txt"), "z", ws);
  ok(!r.ok && /outside the workspace/.test((r as { error: string }).error), "absolute path outside workspace rejected");
}
{
  await symlink(join(outside, "target.txt"), join(ws, "link.txt"));
  const r = await writeIntoWorkspace("link.txt", "pwn", ws);
  ok(!r.ok && /symlink/.test((r as { error: string }).error), "symlink leaf escaping workspace rejected");
}
{
  await mkdir(join(outside, "realdir"), { recursive: true });
  await symlink(join(outside, "realdir"), join(ws, "sneaky"));
  const r = await writeIntoWorkspace("sneaky/f.txt", "pwn", ws);
  ok(!r.ok && /outside the workspace/.test((r as { error: string }).error), "symlinked parent dir escaping workspace rejected");
}

// --- parseCommand: tokenize, reject shell metacharacters -------------------
{
  const p = parseCommand('grep -n "foo bar" src/x.go');
  ok("argv" in p && JSON.stringify(p.argv) === JSON.stringify(["grep", "-n", "foo bar", "src/x.go"]), "parse: quoted arg tokenized");
}
for (const c of [
  "cat a | grep b", "echo x > f", "echo x >> f", "ls 2>err", "cat a; ls", "ls && pwd",
  "echo $(whoami)", "ls `pwd`", "ls *.go", "cat a < b", "cat a & ", "echo \\;",
  'echo "$HOME"', "find . -name *.go", // unquoted glob
]) {
  ok("error" in parseCommand(c), `parse REJECT: ${c}`);
}
for (const c of ["ls -la", "grep -rn foo .", "cat install.sh", 'grep "tee" config.go', "git log -5", "find src -name '*.go'"]) {
  ok("argv" in parseCommand(c), `parse OK: ${c}`);
}

// --- classifyCommand: allowlist + git subcommands + find actions + cp/mv ----
function cls(cmd: string) { const p = parseCommand(cmd); return "argv" in p ? classifyCommand(p.argv) : { error: "parse" }; }
ok("kind" in cls("cat foo.go") && (cls("cat foo.go") as any).kind === "readonly", "classify: cat is readonly");
ok("kind" in cls("git log --oneline -5"), "classify: git log readonly");
ok("kind" in cls("git show HEAD:install.sh"), "classify: git show readonly");
ok("kind" in cls("git diff HEAD~1"), "classify: git diff readonly");
ok("kind" in cls("git config --get user.name"), "classify: git config --get readonly");
ok("kind" in cls("find src -name '*.go'"), "classify: find (read) readonly");
for (const c of [
  "rm -rf /", "python3 x.py", "node x.js", "sed -i s/a/b/ f", "awk '{print}' f",
  "tee f", "dd if=/dev/zero of=f", "chmod +x f", "perl -i f", "xargs rm",
  "git push", "git commit -m x", "git checkout .", "git config user.name x",
  "find . -delete", "find . -exec rm {} ;",
  // jailbreaks closed in the 2026-05-30 security pass (adversarial review):
  "env sh -c x", "env PROG", "printenv",     // env/printenv exec arbitrary programs
  "git remote add origin http://x", "git remote update", // remote writes .git/config / fetches
  "git reflog expire --all",                 // reflog expire deletes history
  "yq -i .x=1 f.yaml", "yq --inplace .x f",  // yq in-place file write
  "find . -fprint0 /tmp/x",                  // find write action not previously listed
  // round-2 hardening (adversarial review round 2): write/exec via flags + mv
  "rg --pre=/bin/sh . install.sh", "rg --pre /bin/sh .",          // rg subprocess exec
  "sort -o /tmp/x f", "sort --out=/tmp/x f", "sort -u f",          // sort dropped: --output/-T write, --compress-program execs, and GNU --out abbreviation defeats per-flag guards
  "git grep -O/bin/sh foo", "git grep --open-files-in-pager=touch foo", // git grep pager exec
  "git show --output=/tmp/x HEAD", "git diff --output /tmp/x", "git log --output=/tmp/x", // git --output write
  "git --exec-path=/tmp log",                // git external-subcommand dir (RCE on Linux)
  "tree -o /tmp/x .", "xxd -r -p in out",    // tree/xxd dropped (each has a write flag)
  "mv repo/file /tmp/x",                     // mv deletes the source (a repo write)
]) {
  ok("error" in cls(c), `classify REJECT: ${c}`);
}
{
  const c = cls("cp src/x.go /tmp/ws/x.go");
  ok("kind" in c && (c as any).kind === "copy" && (c as any).dest === "/tmp/ws/x.go", "classify: cp -> copy with dest");
  ok("error" in cls("mv a b"), "classify: mv rejected (would delete source)");
  ok("error" in cls("cp -t dir a"), "classify: cp -t rejected");
  ok("error" in cls("cp onlyone"), "classify: cp needs src+dest");
  // guards must not over-block legitimate read-only flag uses:
  ok("kind" in cls("grep -o foo file"), "classify: grep -o (only-matching) still readonly");
  ok("kind" in cls("git diff HEAD~1 -- src/x.go"), "classify: git diff with pathspec still readonly");
}

// --- destInWorkspace --------------------------------------------------------
ok(await destInWorkspace(join(ws, "x.go"), ws, outside), "dest absolute inside workspace -> true");
ok(!(await destInWorkspace(join(outside, "x.go"), ws, outside)), "dest absolute outside workspace -> false");
ok(!(await destInWorkspace("rel.go", ws, outside)), "dest relative to cwd(outside) -> false");
ok(await destInWorkspace(ws, ws, outside), "dest is the workspace dir itself -> true");

// --- tool-set helpers -------------------------------------------------------
ok(
  JSON.stringify(computeDesiredActiveTools(["read", "bash", "edit", "write", "grep", "find", "ls", "write-research", "bash-safe", "ask_question"]))
    === JSON.stringify(["read", "grep", "find", "ls", "write-research", "bash-safe", "ask_question"]),
  "computeDesiredActiveTools drops mutators, keeps readonly+research+ask",
);
ok(assessProtection(["read", "grep", "find", "ls", "write-research", "bash-safe"]).level === "harness", "assess: harness when no mutators");
ok(assessProtection(["read", "bash", "edit", "write", "grep", "find", "ls", "write-research", "bash-safe"]).level === "extension", "assess: extension when mutators present");
ok(assessProtection(["read", "grep", "find", "ls"]).level === "degraded", "assess: degraded when research tools missing");
// adversary-review (sibling tool) is kept active in the jail when --tools admitted it,
// but never invented when absent, and its absence does not trip "degraded".
ok(
  computeDesiredActiveTools(["read", "grep", "find", "ls", "write-research", "bash-safe", "adversary-review", "bash", "edit", "write"]).includes("adversary-review"),
  "computeDesiredActiveTools keeps adversary-review when present",
);
ok(
  !computeDesiredActiveTools(["read", "grep", "find", "ls", "write-research", "bash-safe", "bash"]).includes("adversary-review"),
  "computeDesiredActiveTools does not invent adversary-review when absent",
);
ok(assessProtection(["read", "grep", "find", "ls", "write-research", "bash-safe"]).level === "harness", "assess: adversary-review optional, not required for harness level");

await rm(ws, { recursive: true, force: true });
await rm(outside, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
