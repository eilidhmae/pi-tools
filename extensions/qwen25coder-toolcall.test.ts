/**
 * qwen25coder-toolcall tests (pure extractor).
 *   node --experimental-strip-types extensions/qwen25coder-toolcall.test.ts
 *
 * Only the pure core (extractToolCalls) is exercised here. The runtime wiring
 * loads pi-ai via a dynamic import() inside the handler, which this type-strip
 * run never executes, so the import stays unresolved and harmless.
 */
import { extractToolCalls, TARGET_MODEL_ID, TARGET_PROVIDER } from "./qwen25coder-toolcall.ts";

let pass = 0,
  fail = 0;
function ok(cond: boolean, msg: string) {
  if (cond) pass++;
  else {
    fail++;
    console.log("FAIL:", msg);
  }
}

// --- scope constants are the documented ones ---
ok(TARGET_MODEL_ID === "mlx-community/Qwen2.5-Coder-32B-Instruct-8bit", "target model id");
ok(TARGET_PROVIDER === "local-mlx-qwen25coder32b", "target provider name");

// --- form 1: <tools> wrapper (the observed default) ---
{
  const r = extractToolCalls('<tools>\n{"name": "read", "arguments": {"path": "README.md"}}\n</tools>');
  ok(r.calls.length === 1, "tools: one call");
  ok(r.calls[0]?.name === "read", "tools: name read");
  ok(r.calls[0]?.arguments.path === "README.md", "tools: path README.md");
  ok(r.cleanedText === "", "tools: wrapper fully stripped");
}

// --- form 2: <tool_call> wrapper ---
{
  const r = extractToolCalls('<tool_call>\n{"name": "grep", "arguments": {"pattern": "foo"}}\n</tool_call>');
  ok(r.calls.length === 1, "tool_call: one call");
  ok(r.calls[0]?.name === "grep", "tool_call: name grep");
  ok(r.calls[0]?.arguments.pattern === "foo", "tool_call: pattern foo");
  ok(r.cleanedText === "", "tool_call: stripped");
}

// --- form 3: bare top-level JSON ---
{
  const r = extractToolCalls('{"name": "read", "arguments": {"path": "x.md"}}');
  ok(r.calls.length === 1, "bare: one call");
  ok(r.calls[0]?.name === "read", "bare: name");
  ok(r.calls[0]?.arguments.path === "x.md", "bare: path");
  ok(r.cleanedText === "", "bare: stripped");
}

// --- bare JSON with surrounding prose, leading special token (observed) ---
{
  const r = extractToolCalls('<|im_start|>\n{"name": "read", "arguments": {"path": "PROJECT.md"}}\n');
  ok(r.calls.length === 1, "bare+prose: one call");
  ok(r.calls[0]?.arguments.path === "PROJECT.md", "bare+prose: path");
  ok(!r.cleanedText.includes('"name"'), "bare+prose: JSON removed from text");
}

// --- arguments present but empty object ---
{
  const r = extractToolCalls('<tools>{"name": "ls", "arguments": {}}</tools>');
  ok(r.calls.length === 1, "empty args: one call");
  ok(r.calls[0]?.name === "ls" && Object.keys(r.calls[0]!.arguments).length === 0, "empty args: ls {}");
}

// --- arguments containing braces inside a string must not break brace matching ---
{
  const r = extractToolCalls('<tools>{"name": "write", "arguments": {"text": "a {nested} brace } here"}}</tools>');
  ok(r.calls.length === 1, "braces-in-string: one call");
  ok(r.calls[0]?.arguments.text === "a {nested} brace } here", "braces-in-string: value intact");
}

// --- NEGATIVE: fenced code block containing tool-call-shaped JSON is ignored ---
{
  const text = 'Here is an example:\n```json\n{"name": "read", "arguments": {"path": "demo"}}\n```\nThat is how it works.';
  const r = extractToolCalls(text);
  ok(r.calls.length === 0, "fenced: no calls extracted");
  ok(r.cleanedText === text, "fenced: text unchanged");
}

// --- NEGATIVE: a plain JSON object that is not a tool call is left alone ---
{
  const text = 'The config is {"host": "localhost", "port": 8080} for reference.';
  const r = extractToolCalls(text);
  ok(r.calls.length === 0, "non-toolcall json: no calls");
  ok(r.cleanedText === text, "non-toolcall json: text unchanged");
}

// --- NEGATIVE: object with name but NO arguments key (bare path is strict) ---
{
  const text = 'Result: {"name": "something", "value": 3}';
  const r = extractToolCalls(text);
  ok(r.calls.length === 0, "name-without-arguments: not a bare call");
  ok(r.cleanedText === text, "name-without-arguments: unchanged");
}

// --- prose around a real <tools> call: prose kept, wrapper removed ---
{
  const r = extractToolCalls('I will read the file.\n<tools>{"name": "read", "arguments": {"path": "a"}}</tools>');
  ok(r.calls.length === 1, "prose+tools: one call");
  ok(r.cleanedText === "I will read the file.", "prose+tools: prose kept, wrapper gone");
}

// --- multiple tool calls in one message ---
{
  const r = extractToolCalls(
    '<tools>{"name": "read", "arguments": {"path": "a"}}</tools>\n<tools>{"name": "read", "arguments": {"path": "b"}}</tools>',
  );
  ok(r.calls.length === 2, "multi: two calls");
  ok(r.calls[0]?.arguments.path === "a" && r.calls[1]?.arguments.path === "b", "multi: order preserved");
}

// --- empty / non-string input ---
{
  const r = extractToolCalls("");
  ok(r.calls.length === 0 && r.cleanedText === "", "empty input: no calls");
  // @ts-expect-error deliberately wrong type
  const r2 = extractToolCalls(undefined);
  ok(r2.calls.length === 0, "undefined input: no calls, no throw");
}

// --- malformed JSON inside wrapper: not a call, wrapper not stripped ---
{
  const text = '<tools>{"name": "read", "arguments": {path: oops}}</tools>';
  const r = extractToolCalls(text);
  ok(r.calls.length === 0, "malformed json: no calls");
  ok(r.cleanedText === text, "malformed json: wrapper left intact");
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
