/**
 * Tests for xml-function-toolcall pure core.
 * Run: node --experimental-strip-types extensions/xml-function-toolcall.test.ts
 */
import assert from "node:assert";
import { extractFunctionCalls, repairContent } from "./xml-function-toolcall.ts";

let passed = 0;
function test(name: string, fn: () => void) {
  fn();
  passed++;
  console.log(`  ok - ${name}`);
}

// The captured leak (2026-06-14 think-state capture): a complete <function=edit>
// call with a `path` string param and an `edits` JSON-array param, trapped in a
// thinking block alongside the model's analysis prose.
const CAPTURED_THINKING = `The adversary found important issues:

1. **F1 (Major)**: The \`get_boot_time\` function extracts the wrong fields.

Let me fix these issues:

<tool_call>
<function=edit>
<parameter=path>
scripts/bash/uptime.sh
</parameter>
<parameter=edits>
[{"oldText": "tail -1 | awk '{print $2, $3, $4, $5, $6}'", "newText": "awk '{print $6, $7, $8, $9, $10}'"}, {"oldText": "sysctl, awk, sed, date", "newText": "sysctl, awk, sed, cut, head, tail"}]
</parameter>
</function>
</tool_call>`;

test("recovers the captured thinking-trapped <function=edit> call", () => {
  const { cleanedText, calls } = extractFunctionCalls(CAPTURED_THINKING);
  assert.equal(calls.length, 1, "exactly one call");
  assert.equal(calls[0].name, "edit");
  assert.equal(calls[0].arguments.path, "scripts/bash/uptime.sh", "path is a plain string");
  assert.ok(Array.isArray(calls[0].arguments.edits), "edits parsed as a JSON array");
  assert.equal((calls[0].arguments.edits as any[]).length, 2, "both edits recovered");
  assert.equal((calls[0].arguments.edits as any[])[0].newText, "awk '{print $6, $7, $8, $9, $10}'");
  // Prose survives; the call markup is gone.
  assert.ok(cleanedText.includes("The adversary found important issues"), "analysis prose kept");
  assert.ok(!cleanedText.includes("<function="), "no leftover call markup");
  assert.ok(!cleanedText.includes("<tool_call>"), "wrapper stripped too");
});

test("recovers a simple wrapped call", () => {
  const { calls } = extractFunctionCalls(
    "<tool_call><function=bash><parameter=command>ls -la</parameter></function></tool_call>",
  );
  assert.equal(calls.length, 1);
  assert.equal(calls[0].name, "bash");
  assert.equal(calls[0].arguments.command, "ls -la");
});

test("recovers a bare call with no <tool_call> wrapper (80B native form)", () => {
  const { calls, cleanedText } = extractFunctionCalls(
    "Reading the file.\n<function=read><parameter=path>foo.ts</parameter></function>",
  );
  assert.equal(calls.length, 1);
  assert.equal(calls[0].name, "read");
  assert.equal(calls[0].arguments.path, "foo.ts");
  assert.equal(cleanedText, "Reading the file.");
});

test("types parameter values: JSON when it parses, else string", () => {
  const { calls } = extractFunctionCalls(
    "<function=x><parameter=count>5</parameter><parameter=flag>true</parameter><parameter=name>edit</parameter></function>",
  );
  assert.strictEqual(calls[0].arguments.count, 5);
  assert.strictEqual(calls[0].arguments.flag, true);
  assert.strictEqual(calls[0].arguments.name, "edit");
});

test("does NOT hijack a <function=…> shown inside a code fence", () => {
  const doc = "Here is the bug:\n```\n<function=edit><parameter=path>x</parameter></function>\n```\ndone";
  const { calls, cleanedText } = extractFunctionCalls(doc);
  assert.equal(calls.length, 0, "fenced example is not a call");
  assert.equal(cleanedText, doc, "text untouched");
});

test("fast-path no-op on plain text", () => {
  const { calls, cleanedText } = extractFunctionCalls("just some prose, no calls here");
  assert.equal(calls.length, 0);
  assert.equal(cleanedText, "just some prose, no calls here");
});

test("repairContent lifts a call out of a thinking block, keeps prose", () => {
  const content = [{ type: "thinking", thinking: CAPTURED_THINKING }];
  const { newContent, calls } = repairContent(content);
  assert.equal(calls.length, 1);
  assert.equal(newContent.length, 1, "thinking block kept (prose remains)");
  assert.equal(newContent[0].type, "thinking");
  assert.ok(!newContent[0].thinking.includes("<function="), "call stripped from thinking");
  assert.ok(newContent[0].thinking.includes("adversary found"), "analysis kept");
});

test("repairContent drops a block that was only a call, passes others through", () => {
  const content = [
    { type: "text", text: "<function=ls><parameter=path>.</parameter></function>" },
    { type: "image", source: "x" },
  ];
  const { newContent, calls } = repairContent(content);
  assert.equal(calls.length, 1);
  assert.equal(newContent.length, 1, "emptied text block dropped");
  assert.equal(newContent[0].type, "image", "non-text block preserved");
});

test("repairContent is a no-op when no block has a call", () => {
  const content = [{ type: "thinking", thinking: "reasoning" }, { type: "text", text: "answer" }];
  const { newContent, calls } = repairContent(content);
  assert.equal(calls.length, 0);
  assert.deepEqual(newContent, content);
});

console.log(`\n${passed} passed`);
