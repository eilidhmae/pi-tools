/**
 * Tests for the checksum tool core (computeChecksum).
 * Run: node --experimental-strip-types extensions/checksum.test.ts
 *
 * Uses an injected reader (no real fs) so the matrix is deterministic and fast.
 */
import assert from "node:assert";
import { computeChecksum } from "./checksum.ts";
import { sha256Hex } from "./lib/sha256.ts";

let passed = 0;
function test(name: string, fn: () => void) {
  fn();
  passed++;
  console.log(`  ok - ${name}`);
}

const REPORT = "# Research Report\n\nsysctl kern.boottime …\n";
const files: Record<string, string> = { "/r/report.md": REPORT };
const read = (p: string): Uint8Array => {
  if (!(p in files)) throw new Error(`ENOENT: no such file ${p}`);
  return new TextEncoder().encode(files[p]);
};

test("value only → digest", () => {
  const { result, isError } = computeChecksum({ value: "abc" });
  assert.equal(isError, undefined);
  assert.equal(result.digest, sha256Hex("abc"));
});

test("path only → digest of file bytes", () => {
  const { result } = computeChecksum({ path: "/r/report.md" }, read);
  assert.equal(result.digest, sha256Hex(REPORT));
});

test("path+value, identical → match true", () => {
  const { result } = computeChecksum({ path: "/r/report.md", value: REPORT }, read);
  assert.equal(result.match, true);
  assert.equal(result.fileDigest, result.valueDigest);
});

test("path+value, file truncated → match false", () => {
  files["/r/trunc.md"] = "# Research Report\n"; // worker died mid-write
  const { result } = computeChecksum({ path: "/r/trunc.md", value: REPORT }, read);
  assert.equal(result.match, false);
  assert.notEqual(result.fileDigest, result.valueDigest);
});

test("path+expect, correct digest → match true", () => {
  const { result } = computeChecksum({ path: "/r/report.md", expect: sha256Hex(REPORT) }, read);
  assert.equal(result.match, true);
});

test("path+expect, wrong digest → match false", () => {
  const { result } = computeChecksum({ path: "/r/report.md", expect: "00".repeat(32) }, read);
  assert.equal(result.match, false);
});

test("value+expect → match", () => {
  const { result } = computeChecksum({ value: "abc", expect: sha256Hex("abc") });
  assert.equal(result.match, true);
});

test("expect is case-insensitive on the hex", () => {
  const { result } = computeChecksum({ value: "abc", expect: sha256Hex("abc").toUpperCase() });
  assert.equal(result.match, true);
});

test("missing file → isError, names the path, no false match", () => {
  const { result, isError } = computeChecksum({ path: "/nope.md", value: REPORT }, read);
  assert.equal(isError, true);
  assert.ok(String(result.error).includes("/nope.md"));
  assert.equal(result.match, undefined, "must NOT report a match when the file is unreadable");
});

test("neither path nor value → isError", () => {
  const { isError } = computeChecksum({});
  assert.equal(isError, true);
});

test("ambiguous {path,value,expect} → isError, no silent drop", () => {
  const { result, isError } = computeChecksum(
    { path: "/r/report.md", value: REPORT, expect: sha256Hex(REPORT) },
    read,
  );
  assert.equal(isError, true);
  assert.equal(result.match, undefined, "must not return a match for an ambiguous call");
  assert.ok(String(result.error).includes("ambiguous"));
});

test("empty-string value is hashable (not treated as absent)", () => {
  const { result, isError } = computeChecksum({ value: "" });
  assert.equal(isError, undefined);
  assert.equal(result.digest, sha256Hex(""));
});

console.log(`\n${passed} passed`);
