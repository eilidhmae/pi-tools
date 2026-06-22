/**
 * Run: node --experimental-strip-types extensions/lib/bounded-buffer.test.ts
 */
import assert from "node:assert";
import { boundedBuffer, OUTPUT_CAP } from "./bounded-buffer.ts";

let passed = 0;
function test(name: string, fn: () => void) {
  fn();
  passed++;
  console.log(`  ok - ${name}`);
}

test("under cap: lossless, identity over push + append", () => {
  const b = boundedBuffer(100);
  b.push(Buffer.from("hello "));
  b.push("world");
  b.append("!");
  assert.strictEqual(b.value(), "hello world!");
});

test("over cap: retains exactly the trailing cap characters", () => {
  const b = boundedBuffer(10);
  b.push("0123456789ABCDEF"); // 16 chars
  assert.strictEqual(b.value(), "6789ABCDEF");
  assert.strictEqual(b.value().length, 10);
});

test("cap holds across many chunks (the runaway-stream case)", () => {
  const b = boundedBuffer(1000);
  for (let i = 0; i < 10_000; i++) b.push("xxxxxxxxxx"); // 100k chars total
  assert.strictEqual(b.value().length, 1000);
  assert.ok(b.value().split("").every((c) => c === "x"));
});

test("append markers survive and are the most recent bytes", () => {
  const b = boundedBuffer(20);
  b.push("A".repeat(50));
  b.append("\n[timed out]");
  // The marker is the tail, so it is never the part that gets trimmed away.
  assert.ok(b.value().endsWith("\n[timed out]"));
  assert.strictEqual(b.value().length, 20);
});

test("Buffer and string chunks both accepted", () => {
  const b = boundedBuffer();
  b.push(Buffer.from("buf"));
  b.push("str");
  assert.strictEqual(b.value(), "bufstr");
});

test("default cap is 4 MiB", () => {
  assert.strictEqual(OUTPUT_CAP, 4 * 1024 * 1024);
});

console.log(`\n${passed} passed`);
