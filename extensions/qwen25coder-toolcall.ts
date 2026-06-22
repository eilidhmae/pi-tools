/**
 * qwen25coder-toolcall
 *
 * Make a specific dense-coder model's tool calls actually dispatch under pi.
 *
 * The problem (model-specific): the MLX-served dense coder emits tool calls as
 * text — wrapped in `<tools>...</tools>`, the `<tool_call>...</tool_call>` form
 * its template nominally defines, bare top-level JSON
 * `{"name":...,"arguments":...}`, or inside a ```json code fence — rather than
 * as a structured `tool_calls` array. The openai-completions backend parser only
 * matches `<tool_call>`, so `tool_calls` comes back empty and the JSON leaks
 * into message content. pi never sees a tool call and never dispatches.
 *
 * The fix is a `message_end` hook (verified 2026-06-21 in the container
 * harness). When the target model finishes an assistant turn that leaked a
 * tool-call form as text, we recover the FIRST call, rebuild the message content
 * as `[cleanedText?, toolCall]`, and return it with `stopReason: "toolUse"` —
 * which makes pi dispatch the tool and continue the agent loop. The recovered
 * JSON is stripped from the text so it does not also leak.
 *
 * Why message_end and not a custom provider `streamSimple`:
 *   An earlier version registered a provider override with a custom
 *   `streamSimple`. It never fired — the model's `api: "openai-completions"`
 *   routes to the built-in handler, bypassing the registered provider's
 *   `streamSimple` (verified: the handler's entry marker never logged). It also
 *   reached into `@earendil-works/pi-ai` via a runtime `require()`, which throws
 *   on the ESM-only package. `message_end` sidesteps both: it always fires for
 *   the finished assistant message and needs only the `pi` object — no pi-ai, no
 *   provider registration, no models.json read. The toolCall content block is
 *   built by hand (shape: `{type:"toolCall", id, name, arguments}`).
 *
 * Strict no-op for every other model: scoped to TARGET_MODEL_ID. Any other
 * assistant message (including the 80B and 27B, whose tool calls already
 * dispatch) is returned untouched.
 *
 * Pure recovery core lives in ./lib/qwen25coder-extract.ts (node-testable).
 * Test: node --experimental-strip-types extensions/qwen25coder-toolcall.test.ts
 */

import {
  extractToolCalls,
  TARGET_MODEL_ID,
} from "./lib/qwen25coder-extract.ts";

/** Process-unique synthetic tool-call id (monotonic counter avoids same-ms collisions). */
let callSeq = 0;
function makeId(): string {
  return `qwen25coder_${Date.now().toString(36)}_${callSeq++}`;
}

export default function (pi: any) {
  // `message_end` handlers may return a replacement message with the SAME role;
  // returning nothing leaves the message untouched.
  pi.on("message_end", async (event: any, _ctx: any) => {
    const msg = event?.message;
    if (!msg || msg.role !== "assistant" || !Array.isArray(msg.content)) return;

    // Strict scope: only the one dense coder that leaks tool-call JSON as text.
    if (msg.model !== TARGET_MODEL_ID) return;

    // A real structured tool call is already present → nothing to repair.
    if (msg.content.some((b: any) => b?.type === "toolCall")) return;

    const text = msg.content
      .filter((b: any) => b?.type === "text")
      .map((b: any) => b.text ?? "")
      .join("");

    const { cleanedText, calls } = extractToolCalls(text, { fenced: true });
    if (calls.length === 0) return;

    // First-call policy: this model narrates a whole speculative workflow
    // (write -> go run -> curl -> curl) as several calls in one turn. Dispatch
    // ONLY the first — the agentic one-step-at-a-time contract: end the turn,
    // let the tool result feed back, let the model continue. cleanedText already
    // had every recovered call stripped, so the speculative remainder neither
    // dispatches nor leaks as text.
    const c = calls[0];
    const toolCall = {
      type: "toolCall",
      id: makeId(),
      name: c.name,
      arguments: c.arguments as Record<string, any>,
    };

    const content: any[] = [];
    if (cleanedText.trim()) content.push({ type: "text", text: cleanedText });
    content.push(toolCall);

    // Replacement keeps the assistant role; stopReason "toolUse" makes pi
    // dispatch the call and continue the loop.
    return { message: { ...msg, content, stopReason: "toolUse" } };
  });
}
