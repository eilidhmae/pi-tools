/**
 * Tests for checksum-cli.ts — the bash-facing exit-code contract that runners
 * depend on for verify→retry→escalate (0 match / 1 mismatch / 2 IO-or-usage).
 * Runs the CLI as a real subprocess.
 * Run: node --experimental-strip-types extensions/lib/checksum-cli.test.ts
 */
import assert from "node:assert";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { sha256Hex } from "./sha256.ts";

const CLI = join(import.meta.dirname, "checksum-cli.ts");
let passed = 0;
function test(name: string, fn: () => void) {
  fn();
  passed++;
  console.log(`  ok - ${name}`);
}

function run(args: string[], opts: { env?: Record<string, string>; input?: string } = {}) {
  const r = spawnSync(process.execPath, ["--experimental-strip-types", CLI, ...args], {
    encoding: "utf8",
    env: { ...process.env, ...(opts.env ?? {}) },
    input: opts.input,
  });
  return { status: r.status, stdout: (r.stdout ?? "").trim(), stderr: (r.stderr ?? "").trim() };
}

const dir = mkdtempSync(join(tmpdir(), "ck-cli-"));
const FA = join(dir, "a.txt");
const FB = join(dir, "b.txt");
const FC = join(dir, "c.txt");
writeFileSync(FA, "intended bytes");
writeFileSync(FB, "intended bytes"); // identical
writeFileSync(FC, "TRUNC"); // different

try {
  test("--value abc → digest, exit 0", () => {
    const r = run(["--value", "abc"]);
    assert.equal(r.status, 0);
    assert.equal(r.stdout, sha256Hex("abc"));
  });

  test("--file → digest of file bytes, exit 0", () => {
    const r = run(["--file", FA]);
    assert.equal(r.status, 0);
    assert.equal(r.stdout, sha256Hex("intended bytes"));
  });

  test("--value-env → digest of $VAR, exit 0", () => {
    const r = run(["--value-env", "MYFILEDATA"], { env: { MYFILEDATA: "hello" } });
    assert.equal(r.status, 0);
    assert.equal(r.stdout, sha256Hex("hello"));
  });

  test("--value-stdin → digest of stdin, exit 0", () => {
    const r = run(["--value-stdin"], { input: "piped content" });
    assert.equal(r.status, 0);
    assert.equal(r.stdout, sha256Hex("piped content"));
  });

  test("file matches intended (env) → match, exit 0", () => {
    const r = run(["--file", FA, "--against-env", "MYFILEDATA"], { env: { MYFILEDATA: "intended bytes" } });
    assert.equal(r.status, 0);
    assert.ok(r.stdout.includes("match=true"));
  });

  test("identical files → match, exit 0", () => {
    const r = run(["--file", FA, "--against-file", FB]);
    assert.equal(r.status, 0);
    assert.ok(r.stdout.includes("match=true"));
  });

  test("truncated file vs intended → mismatch, exit 1", () => {
    const r = run(["--file", FC, "--against-env", "MYFILEDATA"], { env: { MYFILEDATA: "intended bytes" } });
    assert.equal(r.status, 1);
    assert.ok(r.stdout.includes("match=false"));
  });

  test("wrong --expect digest → mismatch, exit 1", () => {
    const r = run(["--file", FA, "--expect", "00".repeat(32)]);
    assert.equal(r.status, 1);
    assert.ok(r.stdout.includes("match=false"));
  });

  test("missing file → IO error, exit 2", () => {
    const r = run(["--file", join(dir, "nope.txt")]);
    assert.equal(r.status, 2);
    assert.ok(r.stderr.includes("cannot read"));
  });

  test("no subject flag → usage error, exit 2", () => {
    const r = run([]);
    assert.equal(r.status, 2);
  });

  test("--value-env on an unset var → error, exit 2", () => {
    const r = run(["--value-env", "DEFINITELY_UNSET_VAR_XYZ"]);
    assert.equal(r.status, 2);
  });

  console.log(`\n${passed} passed`);
} finally {
  rmSync(dir, { recursive: true, force: true });
}
