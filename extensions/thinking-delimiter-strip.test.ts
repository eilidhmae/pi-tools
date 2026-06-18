/**
 * thinking-delimiter-strip tests.
 *   node --experimental-strip-types extensions/thinking-delimiter-strip.test.ts
 */
import register, {
  stripStrayThinkDelimiters,
  cleanThinkingBlocks,
} from "./thinking-delimiter-strip.ts";

let pass = 0,
  fail = 0;
function ok(cond: boolean, msg: string) {
  if (cond) pass++;
  else {
    fail++;
    console.log("FAIL:", msg);
  }
}

// --- stripStrayThinkDelimiters ---
ok(stripStrayThinkDelimiters("<think>\n\n") === "", "bare leaked open tag -> empty");
ok(stripStrayThinkDelimiters("<think>\n\n</think>") === "", "empty think block -> empty");
ok(
  stripStrayThinkDelimiters("<think>\n\nreal reasoning here") === "real reasoning here",
  "leading open tag stripped, reasoning preserved",
);
ok(
  stripStrayThinkDelimiters("reasoning\n</think>") === "reasoning",
  "trailing close tag stripped, reasoning preserved",
);
ok(
  stripStrayThinkDelimiters("plain reasoning, no tags") === "plain reasoning, no tags",
  "no delimiter -> unchanged",
);
ok(
  stripStrayThinkDelimiters("step one <think> mid step") === "step one <think> mid step",
  "mid-content delimiter left alone (boundary-only)",
);
// Only one leading tag is removed (don't recurse into genuine content).
ok(
  stripStrayThinkDelimiters("<think>\n<think> nested") === "<think> nested",
  "single leading tag removed; inner content untouched",
);

// --- cleanThinkingBlocks ---
{
  // The exact shape observed on a leaked tool-dispatch turn.
  const content = [
    { type: "thinking", thinking: "<think>\n\n", thinkingSignature: "reasoning" },
    { type: "text", text: "\n\nNow let me gate this plan with an adversary review:\n\n" },
    { type: "toolCall", id: "x", name: "adversary-review", arguments: {} },
  ];
  const { content: out, changed } = cleanThinkingBlocks(content);
  ok(changed, "leaked delimiter-only block -> changed");
  ok(out.length === 2, "delimiter-only thinking block dropped");
  ok((out[0] as any).type === "text", "text + toolCall preserved in order");
  ok((out[1] as any).type === "toolCall", "toolCall preserved");
}
{
  // Real reasoning with a leaked leading tag is cleaned, not dropped.
  const content = [
    { type: "thinking", thinking: "<think>\n\nThe user wants X.", thinkingSignature: "reasoning" },
    { type: "text", text: "answer" },
  ];
  const { content: out, changed } = cleanThinkingBlocks(content);
  ok(changed, "leading tag on real reasoning -> changed");
  ok(out.length === 2 && (out[0] as any).thinking === "The user wants X.", "reasoning preserved, tag gone");
  ok((out[0] as any).thinkingSignature === "reasoning", "thinkingSignature preserved");
}
{
  // Clean message: strict no-op (returns changed=false so the handler skips).
  const content = [
    { type: "thinking", thinking: "Genuine reasoning, no tags." },
    { type: "text", text: "answer" },
  ];
  const { changed } = cleanThinkingBlocks(content);
  ok(!changed, "no delimiters anywhere -> no-op");
}
{
  // Non-array / odd inputs don't throw.
  ok(cleanThinkingBlocks(undefined as any).changed === false, "undefined content -> no-op");
}

// --- registered message_end handler (runtime contract) ---
// Drive the default export through a mock `pi` that mirrors how the extension
// runner registers (pi.on) and invokes (handler(event,ctx) -> {message}) the
// message_end hook. Uses the REAL captured leaked message shape.
async function handlerContractTests() {
  const handlers: Record<string, Function[]> = {};
  const pi = { on: (ev: string, fn: Function) => (handlers[ev] ??= []).push(fn) };
  register(pi);
  const handler = handlers["message_end"]?.[0];
  ok(typeof handler === "function", "extension registers a message_end handler");

  // Real leaked tool-dispatch turn (verbatim shape from the captured session).
  const leaked = {
    role: "assistant",
    content: [
      { type: "thinking", thinking: "<think>\n\n", thinkingSignature: "reasoning" },
      { type: "text", text: "\n\nNow let me gate this plan with an adversary review:\n\n" },
      { type: "toolCall", id: "9ce472e3", name: "adversary-review", arguments: { path: "/tmp/x.md" } },
    ],
  };
  const res = await handler({ message: leaked }, {});
  ok(!!res?.message, "handler returns a replacement message for a leaked turn");
  ok(res.message.role === "assistant", "replacement keeps the same role (runner requirement)");
  ok(res.message.content.length === 2, "leaked delimiter-only thinking block removed");
  ok(res.message.content[0].type === "text" && res.message.content[1].type === "toolCall",
     "text + adversary-review toolCall survive intact");

  // Clean turn -> handler returns nothing (runner leaves message untouched).
  const clean = {
    role: "assistant",
    content: [
      { type: "thinking", thinking: "Genuine reasoning, no tags." },
      { type: "text", text: "done" },
    ],
  };
  const noop = await handler({ message: clean }, {});
  ok(noop === undefined, "clean turn -> handler returns undefined (no-op)");

  // Non-assistant message ignored.
  const userMsg = { role: "user", content: [{ type: "text", text: "hi" }] };
  ok((await handler({ message: userMsg }, {})) === undefined, "non-assistant message ignored");
}

handlerContractTests().then(() => {
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
});
