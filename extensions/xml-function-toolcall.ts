/**
 * xml-function-toolcall
 *
 * Recover Hermes/Qwen-XML tool calls the local MLX models emit as text instead
 * of as a structured `tool_calls` array, in EITHER the answer or the thinking
 * channel.
 *
 * Two observed failure modes, one format:
 *
 *   1. Thinking-trap (27B `local-mlx`, measured 2026-06-14). Under load — a
 *      large context crossed with a complex tool argument — the always-thinking
 *      coordinator fails to close `<think>` before the call, so the entire
 *      `<tool_call><function=NAME>…</function></tool_call>` stays inside the
 *      thinking block. The server's tool-call parser only scans post-think
 *      content, so `tool_calls` comes back empty; pi gets a thinking-only
 *      message with `stopReason: stop` and no call to dispatch, and the turn
 *      dead-ends. (mlx-lm PR #1277 think-state class; captured + analysed
 *      2026-06-14.) 24/25 turns were clean — only the loaded one trapped.
 *   2. Native-XML answer (80B `local-mlx-80b`). It emits `<function=…>` tool
 *      calls in the answer text rather than as structured `tool_calls`.
 *
 * Both are the same wire shape:
 *
 *     <tool_call>                       (the <tool_call> wrapper is optional)
 *     <function=NAME>
 *     <parameter=KEY> VALUE </parameter> (repeatable; VALUE is JSON if it parses,
 *     …                                   else the raw trimmed string)
 *     </function>
 *     </tool_call>
 *
 * Known limitations (adversary-reviewed 2026-06-14, accepted — same class as the
 * qwen25coder reference):
 *   - A parameter VALUE containing the literal `</function>` truncates the body
 *     at that tag: the call still dispatches but with empty/partial args (not a
 *     hang, not a miss). Tolerable because tool args rarely embed that tag; a
 *     regex that survives it isn't worth the complexity here.
 *   - Only triple-backtick fences are masked; a complete `<function=…>` shown in
 *     an INLINE single-backtick span would be extracted as a real call. Rare in
 *     practice for how these models format output.
 *
 * This is a DIFFERENT inner format from `qwen25coder-toolcall.ts`, which repairs
 * `<tool_call>{json}</tool_call>` / `<tools>` / bare-JSON for the dense 32B. The
 * two extensions are scoped to disjoint providers and do not interact.
 *
 * Mechanism (mirrors qwen25coder-toolcall `ca0cd28`): a `message_end` hook. When
 * a target-provider assistant turn finishes with no structured tool call but a
 * text/thinking block holds a complete `<function=…>` call, recover the FIRST
 * call, rebuild the content with that call stripped + a hand-built `toolCall`
 * block, and return it with `stopReason: "toolUse"` so pi dispatches it and
 * continues the loop. Every other turn is a strict no-op (fast path: a block
 * must literally contain `<function=`).
 *
 * An earlier version registered a provider override with a custom `streamSimple`
 * and a runtime `require("@earendil-works/pi-ai")`. It never reliably fired
 * (openai-completions models route to the built-in handler, bypassing the
 * override) and, because it overrode `local-mlx` (the default 27B session
 * provider), the require()'s `ERR_PACKAGE_PATH_NOT_EXPORTED` on the ESM-only
 * package threw on every query, driving pi into a tight error-retry loop that
 * OOM'd the node heap. `message_end` needs only the `pi` object — no pi-ai, no
 * provider registration. See the runtime-wiring note below.
 *
 * Strict no-op for any provider not listed in TARGET_PROVIDERS, and for any turn
 * whose model already produced a structured tool call.
 *
 * Pure core (extractFunctionCalls + repairContent) has no external imports so it
 * is node-testable via `node --experimental-strip-types`; the test imports only
 * those pure functions.
 *
 * Test: node --experimental-strip-types extensions/xml-function-toolcall.test.ts
 */

// Providers whose local agentic models emit the <function=…> form. Each is
// overridden only if present in models.json on this box; absent → no-op.
export const TARGET_PROVIDERS = ["local-mlx", "local-mlx-coder27b", "local-mlx-80b"];

export interface ExtractedCall {
  name: string;
  arguments: Record<string, unknown>;
}

export interface ExtractResult {
  /** The input with any recovered <function=…> calls removed. */
  cleanedText: string;
  /** Tool calls recovered, in order of appearance. */
  calls: ExtractedCall[];
}

/**
 * Mask fenced code blocks with equal-length spaces so byte offsets are
 * preserved but their content cannot match a call pattern. A genuine tool call
 * is never emitted inside a Markdown fence; a `<function=…>` shown as a code
 * example (e.g. documenting this very bug) must not be hijacked.
 */
function maskCodeFences(text: string): string {
  return text.replace(/```[\s\S]*?```/g, (m) => " ".repeat(m.length));
}

/** A parameter value is JSON when it parses (objects, arrays, numbers, …); else the raw trimmed string. */
function parseParamValue(raw: string): unknown {
  const v = raw.trim();
  if (v.length === 0) return "";
  try {
    return JSON.parse(v);
  } catch {
    return v;
  }
}

/**
 * Pure extractor. Recovers tool calls emitted as `<function=NAME>` XML (with the
 * optional `<tool_call>` wrapper) and returns the text with those spans removed.
 * Content inside Markdown code fences is ignored. Returns the input unchanged
 * with no calls when nothing matches.
 */
export function extractFunctionCalls(text: string): ExtractResult {
  if (typeof text !== "string" || text.length === 0) {
    return { cleanedText: text ?? "", calls: [] };
  }
  // Fast path: nothing that even looks like a function-form call.
  if (text.indexOf("<function=") < 0) {
    return { cleanedText: text, calls: [] };
  }

  const masked = maskCodeFences(text);
  const calls: ExtractedCall[] = [];
  // Spans [start,end) in the ORIGINAL text to delete (masking preserves offsets),
  // removed back-to-front so indices stay valid.
  const spans: Array<[number, number]> = [];

  // <function=NAME> … </function>, optionally wrapped by <tool_call> … </tool_call>.
  // Non-greedy body so the first </function> closes the call; parameter values
  // never contain the literal </function> tag.
  const fnRe = /(?:<tool_call>\s*)?<function=([^>\s]+)>([\s\S]*?)<\/function>(?:\s*<\/tool_call>)?/g;
  let m: RegExpExecArray | null;
  while ((m = fnRe.exec(masked)) !== null) {
    const name = m[1];
    if (!name) continue;
    const body = m[2];
    const args: Record<string, unknown> = {};
    const paramRe = /<parameter=([^>\s]+)>([\s\S]*?)<\/parameter>/g;
    let pm: RegExpExecArray | null;
    while ((pm = paramRe.exec(body)) !== null) {
      const key = pm[1];
      if (!key) continue;
      args[key] = parseParamValue(pm[2]);
    }
    calls.push({ name, arguments: args });
    spans.push([m.index, m.index + m[0].length]);
  }

  if (spans.length === 0) return { cleanedText: text, calls };

  spans.sort((a, b) => b[0] - a[0]);
  let out = text;
  for (const [s, e] of spans) {
    out = out.slice(0, s) + out.slice(e);
  }
  return { cleanedText: out.replace(/\n{3,}/g, "\n\n").trim(), calls };
}

export interface RepairResult {
  /** Content blocks with recovered calls stripped (now-empty blocks dropped). */
  newContent: any[];
  /** Tool calls recovered across all text/thinking blocks, in order. */
  calls: ExtractedCall[];
}

/**
 * Scan an assistant message's content blocks (text and thinking) for trapped
 * `<function=…>` calls, returning the cleaned blocks plus the recovered calls.
 * Non-text/thinking blocks and blocks with no match pass through untouched.
 */
export function repairContent(content: any[]): RepairResult {
  const calls: ExtractedCall[] = [];
  const newContent: any[] = [];
  for (const b of Array.isArray(content) ? content : []) {
    const field = b?.type === "text" ? "text" : b?.type === "thinking" ? "thinking" : null;
    if (field && typeof b[field] === "string" && b[field].indexOf("<function=") >= 0) {
      const res = extractFunctionCalls(b[field]);
      if (res.calls.length > 0) {
        calls.push(...res.calls);
        // Keep the block (with the call stripped) only if real prose remains.
        if (res.cleanedText && res.cleanedText.trim().length > 0) {
          newContent.push({ ...b, [field]: res.cleanedText });
        }
        continue;
      }
    }
    newContent.push(b);
  }
  return { newContent, calls };
}

// ---------------------------------------------------------------------------
// Runtime wiring: a `message_end` hook (replaces the old `streamSimple` provider
// override — see qwen25coder-toolcall.ts `ca0cd28` for the same fix).
//
// Why the override was wrong, twice over:
//   1. It never reliably fired — a model whose `api` is "openai-completions"
//      routes to the built-in handler, bypassing a registered provider's
//      `streamSimple`.
//   2. It reached into `@earendil-works/pi-ai` via a runtime `require()`, which
//      throws `ERR_PACKAGE_PATH_NOT_EXPORTED` on the ESM-only package. Because
//      this extension overrode `local-mlx` (the default 27B session provider),
//      that throw happened on EVERY query — even a bare "hello" — and pi retried
//      in a tight loop, piling up Error objects + stack traces until the node
//      heap OOM'd, silently (no output, no request ever reaching the server).
//      Root-caused 2026-06-22.
//
// `message_end` sidesteps both: it always fires for the finished assistant
// message and needs only the `pi` object — no pi-ai, no provider registration,
// no models.json read. The toolCall block is built by hand:
// {type:"toolCall", id, name, arguments}.
// ---------------------------------------------------------------------------

/** Process-unique synthetic tool-call id (monotonic counter avoids same-ms collisions). */
let callSeq = 0;
function makeId(): string {
  return `xmlfn_${Date.now().toString(36)}_${callSeq++}`;
}

export default function (pi: any) {
  // `message_end` handlers may return a replacement message with the SAME role;
  // returning nothing leaves the message untouched.
  pi.on("message_end", async (event: any, _ctx: any) => {
    const msg = event?.message;
    if (!msg || msg.role !== "assistant" || !Array.isArray(msg.content)) return;

    // Scope to the providers whose models emit the <function=…> form. When the
    // message carries a provider we don't target, skip; if it is absent, fall
    // through — repairContent's per-block "<function=" fast path is the real
    // guard, so a well-behaved message is a strict no-op either way.
    if (msg.provider && !TARGET_PROVIDERS.includes(msg.provider)) return;

    // A real structured tool call is already present → nothing to repair.
    if (msg.content.some((b: any) => b?.type === "toolCall")) return;

    // Recover calls trapped as <function=…> text in the answer OR thinking
    // channel; repairContent returns the content with those spans stripped and
    // now-empty blocks dropped.
    const { newContent, calls } = repairContent(msg.content);
    if (calls.length === 0) return;

    // First-call policy (matches qwen25coder-toolcall): a model can narrate a
    // whole speculative workflow as several calls in one turn. Dispatch ONLY the
    // first — the agentic one-step-at-a-time contract: end the turn, let the
    // tool result feed back, let the model continue. repairContent already
    // stripped every recovered call, so the remainder neither dispatches nor
    // leaks as text.
    const c = calls[0];
    const toolCall = {
      type: "toolCall",
      id: makeId(),
      name: c.name,
      arguments: c.arguments as Record<string, any>,
    };

    // stopReason "toolUse" makes pi dispatch the call and continue the loop.
    return { message: { ...msg, content: [...newContent, toolCall], stopReason: "toolUse" } };
  });
}
