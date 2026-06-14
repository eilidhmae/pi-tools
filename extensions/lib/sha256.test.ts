/**
 * SHA-256 verified against the FIPS 180-4 / NIST published test vectors.
 * Run: node --experimental-strip-types extensions/lib/sha256.test.ts
 */
import assert from "node:assert";
import { sha256Hex, digestsEqual } from "./sha256.ts";

let passed = 0;
function test(name: string, fn: () => void) {
  fn();
  passed++;
  console.log(`  ok - ${name}`);
}

// Canonical NIST / FIPS 180-4 vectors.
const VECTORS: Array<[string, string]> = [
  ["", "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"],
  ["abc", "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"],
  [
    "abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq",
    "248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1",
  ],
  [
    "abcdefghbcdefghicdefghijdefghijkefghijklfghijklmghijklmnhijklmnoijklmnopjklmnopqklmnopqrlmnopqrsmnopqrstnopqrstu",
    "cf5b16a778af8380036ce59e7b0492370b249b11e8f07a51afac45037afee9d1",
  ],
];

for (const [input, expected] of VECTORS) {
  test(`vector len=${input.length}`, () => {
    assert.equal(sha256Hex(input), expected);
  });
}

test("one-million 'a' (the long FIPS vector)", () => {
  assert.equal(
    sha256Hex("a".repeat(1_000_000)),
    "cdc76e5c9914fb9281a1c7e284d73e67f1809a48a497200e046d39ccc7112cd0",
  );
});

test("digests differ on a single-byte change", () => {
  assert.notEqual(sha256Hex("the report"), sha256Hex("the report "));
});

test("a written file matching its intended content has equal digests", () => {
  const intended = "# Research Report\n\nsysctl kern.boottime …\n";
  const written = "# Research Report\n\nsysctl kern.boottime …\n"; // byte-identical
  assert.ok(digestsEqual(sha256Hex(intended), sha256Hex(written)));
});

test("a truncated/empty write is caught", () => {
  const intended = "# Research Report\n\nsysctl kern.boottime …\n";
  const truncated = "# Research Report\n"; // worker died mid-write
  assert.ok(!digestsEqual(sha256Hex(intended), sha256Hex(truncated)));
});

test("digestsEqual is case- and whitespace-insensitive on the hex", () => {
  assert.ok(digestsEqual("ABC123", " abc123 "));
});

console.log(`\n${passed} passed`);
