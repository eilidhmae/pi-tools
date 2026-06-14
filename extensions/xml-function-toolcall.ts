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
 * Mechanism (mirrors qwen25coder-toolcall, including the hang-safety lesson):
 * override each target provider with a `streamSimple` that delegates to the real
 * openai-completions backend, streams its events through live, and on the
 * terminal `done` — only when the backend produced no structured tool call but a
 * text/thinking block contains a complete `<function=…>` call — rewrites the
 * message into proper `toolCall` blocks and emits a dispatch-correct toolcall
 * event sequence. Every other turn is a pass-through (fast-path: a block must
 * literally contain `<function=` to be considered).
 *
 * Strict no-op for any provider not listed in TARGET_PROVIDERS, and for any turn
 * whose model already produced a structured tool call.
 *
 * Pure core (extractFunctionCalls + repairContent) has no external imports so it
 * is node-testable via `node --experimental-strip-types`. The pi-ai runtime is
 * loaded with require() inside the handler, which the type-strip loader does not
 * resolve, so the test imports only the pure functions.
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
// Runtime wiring. Mirrors qwen25coder-toolcall: a provider override returning an
// AssistantMessageEventStream (push/end/result), NOT a bare async generator —
// pi awaits stream.result() in parallel with draining, so a generator (no
// result()) hangs and leaks. Imports pi-ai via require() so the pure core stays
// node-testable.
// ---------------------------------------------------------------------------

function makeId(seq: number): string {
  return `xmlfn_${Date.now().toString(36)}_${seq}`;
}

function emptyUsage() {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

/** Register the repair override for a single provider, reusing its models.json config. */
function registerRepair(pi: any, providerName: string): boolean {
  let providerCfg: any;
  try {
    const { readFileSync } = require("node:fs");
    const { homedir } = require("node:os");
    const { join } = require("node:path");
    const dir = process.env.PI_CODING_AGENT_DIR?.trim()
      ? process.env.PI_CODING_AGENT_DIR.replace(/^~(?=$|\/)/, homedir())
      : join(homedir(), ".pi", "agent");
    const parsed = JSON.parse(readFileSync(join(dir, "models.json"), "utf8"));
    providerCfg = parsed?.providers?.[providerName];
  } catch {
    providerCfg = undefined;
  }
  if (!providerCfg || typeof providerCfg !== "object") return false; // not served here

  pi.registerProvider(providerName, {
    baseUrl: providerCfg.baseUrl,
    apiKey: providerCfg.apiKey ?? "local",
    api: providerCfg.api ?? "openai-completions",
    headers: providerCfg.headers,
    models: (providerCfg.models ?? []).map((mdl: any) => ({
      id: mdl.id,
      name: mdl.name ?? mdl.id,
      api: mdl.api ?? providerCfg.api ?? "openai-completions",
      baseUrl: mdl.baseUrl ?? providerCfg.baseUrl,
      reasoning: mdl.reasoning ?? false,
      input: mdl.input ?? ["text"],
      cost: mdl.cost ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: mdl.contextWindow ?? 262144,
      maxTokens: mdl.maxTokens ?? 8192,
      compat: mdl.compat ?? providerCfg.compat,
    })),
    streamSimple: (model: any, context: any, options: any): any => {
      const piai = require("@earendil-works/pi-ai");
      const outStream = piai.createAssistantMessageEventStream();

      const errEvent = (stopReason: string, errorMessage: string) => ({
        type: "error" as const,
        reason: "error" as const,
        error: {
          role: "assistant",
          content: [],
          api: "openai-completions",
          provider: model?.provider ?? providerName,
          model: model?.id ?? "",
          usage: emptyUsage(),
          stopReason,
          errorMessage,
          timestamp: Date.now(),
        },
      });

      const drive = async () => {
        const real = piai.getApiProvider("openai-completions");
        if (!real) {
          outStream.push(errEvent("error", "xml-function-toolcall: openai-completions provider unavailable"));
          outStream.end();
          return;
        }

        const upstream = real.streamSimple(model, context, options);
        let finalMsg: any | undefined;
        let terminalType: "done" | "error" | undefined;
        let terminalReason: string | undefined;

        try {
          for await (const ev of upstream) {
            if (ev.type === "done") {
              finalMsg = ev.message;
              terminalType = "done";
              terminalReason = ev.reason;
              break;
            }
            if (ev.type === "error") {
              finalMsg = ev.error;
              terminalType = "error";
              terminalReason = ev.reason;
              break;
            }
            outStream.push(ev); // live text/thinking through unchanged
          }
        } catch (e) {
          outStream.push(errEvent("error", `xml-function-toolcall: upstream stream failed: ${(e as Error).message}`));
          outStream.end();
          return;
        }

        if (!terminalType || !finalMsg) {
          // Upstream closed without a terminal event: push one so result() resolves.
          outStream.push(errEvent("aborted", "xml-function-toolcall: upstream stream closed without a terminal event"));
          outStream.end();
          return;
        }

        if (terminalType === "error") {
          outStream.push({ type: "error", reason: terminalReason, error: finalMsg });
          outStream.end();
          return;
        }

        // done: repair only if the backend produced no structured tool call.
        const content: any[] = Array.isArray(finalMsg.content) ? finalMsg.content : [];
        const hasRealToolCall = content.some((b) => b?.type === "toolCall");
        const repaired = hasRealToolCall ? null : repairContent(content);

        if (!repaired || repaired.calls.length === 0) {
          outStream.push({ type: "done", reason: terminalReason ?? "stop", message: finalMsg });
          outStream.end();
          return;
        }

        const toolCalls = repaired.calls.map((c, idx) =>
          piai.fauxToolCall(c.name, c.arguments as Record<string, any>, { id: makeId(idx) }),
        );
        const newContent: any[] = [...repaired.newContent, ...toolCalls];
        const repairedMsg = { ...finalMsg, content: newContent, stopReason: "toolUse" };

        // The preserved text/thinking blocks already streamed live; only the
        // recovered tool calls need dispatch-correct events. done.message carries
        // the authoritative (cleaned) content for persistence.
        let ci = repaired.newContent.length;
        for (const tc of toolCalls) {
          outStream.push({ type: "toolcall_start", contentIndex: ci, partial: repairedMsg });
          outStream.push({ type: "toolcall_delta", contentIndex: ci, delta: JSON.stringify(tc.arguments), partial: repairedMsg });
          outStream.push({ type: "toolcall_end", contentIndex: ci, toolCall: tc, partial: repairedMsg });
          ci++;
        }
        outStream.push({ type: "done", reason: "toolUse", message: repairedMsg });
        outStream.end();
      };

      void drive();
      return outStream;
    },
  });
  return true;
}

export default function (pi: any) {
  for (const providerName of TARGET_PROVIDERS) {
    registerRepair(pi, providerName);
  }
}
