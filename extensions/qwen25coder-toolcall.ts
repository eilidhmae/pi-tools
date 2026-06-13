/**
 * qwen25coder-toolcall
 *
 * Make a specific dense-coder model's tool calls actually dispatch under pi.
 *
 * The problem (model-specific): the MLX-served dense coder emits tool calls as
 * text — wrapped in `<tools>...</tools>` (its template's tools-param path), the
 * `<tool_call>...</tool_call>` form its template nominally defines, or bare
 * top-level JSON `{"name":...,"arguments":...}` (the prompt path) — rather than
 * as a structured `tool_calls` array. The OpenAI-completions backend resolves
 * to a parser that only matches `<tool_call>`, so `tool_calls` comes back empty
 * and the JSON leaks into message content. pi never sees a tool call and never
 * dispatches.
 *
 * Steering the model with a system directive does NOT fix it (measured: a
 * directive pushes it from `<tools>` to bare JSON or spurious special tokens,
 * never to the `<tool_call>` wrapper the backend parser wants). So this
 * extension repairs at the stream layer instead: it overrides the model's
 * provider with a `streamSimple` that delegates to the real openai-completions
 * backend, then — only when the backend produced no structured tool call but
 * the assistant text contains one of the three wrapper forms — rewrites that
 * text into a proper `toolCall` content block and emits dispatch-correct
 * stream events. The text wrapper is stripped so it does not also leak.
 *
 * Strict no-op for every other model: the override is registered only for the
 * one provider/model id below. All other providers, including the 80B agentic
 * model and the 27B thinking model whose tool calls already dispatch, are
 * untouched.
 *
 * Pure core (extractToolCalls + helpers) has no external imports so it is
 * node-testable via `node --experimental-strip-types`. The pi-ai runtime is
 * loaded with a dynamic import() inside the handler, which node's type-strip
 * loader does not resolve, so the test file can import the pure functions.
 *
 * Test: node --experimental-strip-types extensions/qwen25coder-toolcall.test.ts
 */

// The single model this extension repairs. Everything is scoped to this id (and
// the provider that serves it); any other model is a complete no-op.
export const TARGET_PROVIDER = "local-mlx-qwen25coder32b";
export const TARGET_MODEL_ID = "mlx-community/Qwen2.5-Coder-32B-Instruct-8bit";

export interface ExtractedCall {
  name: string;
  arguments: Record<string, unknown>;
}

export interface ExtractResult {
  /** The text with any recognized tool-call wrappers removed. */
  cleanedText: string;
  /** Tool calls recovered from the text, in order of appearance. */
  calls: ExtractedCall[];
}

/**
 * Mask fenced code blocks (``` ... ```) with spaces of equal length so their
 * byte offsets are preserved but their content cannot match a tool-call
 * pattern. Tool calls a model genuinely intends are never emitted inside a
 * Markdown code fence; JSON shown as a code example must not be hijacked.
 */
function maskCodeFences(text: string): string {
  return text.replace(/```[\s\S]*?```/g, (m) => " ".repeat(m.length));
}

/** A parsed top-level tool-call object must have a string name and an object arguments. */
function asCall(obj: unknown): ExtractedCall | null {
  if (!obj || typeof obj !== "object") return null;
  const o = obj as Record<string, unknown>;
  if (typeof o.name !== "string" || !o.name) return null;
  const args = o.arguments;
  if (args === undefined || args === null) {
    return { name: o.name, arguments: {} };
  }
  if (typeof args !== "object" || Array.isArray(args)) return null;
  return { name: o.name, arguments: args as Record<string, unknown> };
}

/**
 * From a position `start` at an opening `{`, scan to the matching close brace,
 * respecting string literals and escapes. Returns the end index (exclusive) of
 * the JSON object, or -1 if unbalanced.
 */
function matchBrace(text: string, start: number): number {
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === "\\") esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === "{") depth++;
    else if (c === "}") {
      depth--;
      if (depth === 0) return i + 1;
    }
  }
  return -1;
}

/** Parse the first balanced JSON object found in `slice` into a call, or null. */
function firstObjectCall(slice: string): ExtractedCall | null {
  const open = slice.indexOf("{");
  if (open < 0) return null;
  const close = matchBrace(slice, open);
  if (close < 0) return null;
  try {
    return asCall(JSON.parse(slice.slice(open, close)));
  } catch {
    return null;
  }
}

/**
 * Pure extractor. Recovers tool calls a model emitted as text in any of three
 * wrapper forms and returns the text with those wrappers removed:
 *
 *   1. <tool_call> {json} </tool_call>   (the backend parser's native form)
 *   2. <tools> {json} </tools>           (the tools-param template default)
 *   3. bare top-level {"name":..,"arguments":..}  (the prompt path)
 *
 * Content inside Markdown code fences is ignored. JSON objects that are not a
 * `{name, arguments}` tool call are left untouched. Only the wrappers that
 * actually parse into a valid call are stripped; any other text is preserved.
 */
export function extractToolCalls(text: string): ExtractResult {
  if (typeof text !== "string" || text.length === 0) {
    return { cleanedText: text ?? "", calls: [] };
  }

  const masked = maskCodeFences(text);
  const calls: ExtractedCall[] = [];
  // Spans [start,end) in the ORIGINAL text to delete, collected then removed
  // back-to-front so indices stay valid.
  const spans: Array<[number, number]> = [];

  // 1 & 2: tagged wrappers. Match the tag, then balance-scan the JSON inside so
  // braces within strings do not fool us; fall back to the tag span if the
  // inner JSON is a valid call.
  const tagRe = /<(tool_call|tools)>\s*([\s\S]*?)\s*<\/\1>/g;
  let m: RegExpExecArray | null;
  while ((m = tagRe.exec(masked)) !== null) {
    const inner = m[2];
    const call = firstObjectCall(inner);
    if (call) {
      calls.push(call);
      spans.push([m.index, m.index + m[0].length]);
    }
  }

  // 3: bare top-level tool-call JSON, only outside any tagged span we already
  // claimed. Scan for `{` that begins a balanced object parsing to a valid call
  // with BOTH name and arguments keys (stricter than tagged, to avoid eating
  // unrelated JSON the model may print).
  const claimed = (idx: number) =>
    spans.some(([s, e]) => idx >= s && idx < e);
  let i = 0;
  while (i < masked.length) {
    const open = masked.indexOf("{", i);
    if (open < 0) break;
    if (claimed(open)) {
      i = open + 1;
      continue;
    }
    const close = matchBrace(masked, open);
    if (close < 0) break;
    let parsed: unknown;
    try {
      parsed = JSON.parse(text.slice(open, close));
    } catch {
      parsed = undefined;
    }
    const o = parsed as Record<string, unknown> | undefined;
    // Bare path is strict: require both keys present so we never hijack a plain
    // JSON object the model happened to print in prose.
    if (
      o &&
      typeof o === "object" &&
      typeof o.name === "string" &&
      Object.prototype.hasOwnProperty.call(o, "arguments")
    ) {
      const call = asCall(o);
      if (call) {
        calls.push(call);
        spans.push([open, close]);
      }
    }
    i = close;
  }

  if (spans.length === 0) return { cleanedText: text, calls };

  // Remove claimed spans from the ORIGINAL text, back to front.
  spans.sort((a, b) => b[0] - a[0]);
  let out = text;
  for (const [s, e] of spans) {
    out = out.slice(0, s) + out.slice(e);
  }
  // Tidy the leftover whitespace from removed wrappers.
  return { cleanedText: out.replace(/\n{3,}/g, "\n\n").trim(), calls };
}

// ---------------------------------------------------------------------------
// Runtime wiring. Imports pi-ai dynamically so the pure core above stays
// node-testable. None of this executes during a type-strip test load.
// ---------------------------------------------------------------------------

/** Stable-ish synthetic tool-call id when the backend gave us none. */
function makeId(seq: number): string {
  return `qwen25coder_${Date.now().toString(36)}_${seq}`;
}

/** Zeroed Usage block for synthetic error messages. */
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

export default function (pi: any) {
  // Read the provider config straight from models.json so we preserve baseUrl,
  // model id, contextWindow, compat, etc. without hard-coding them here. If the
  // provider is absent (this box doesn't serve the model), no-op.
  let providerCfg: any;
  try {
    const { readFileSync } = require("node:fs");
    const { homedir } = require("node:os");
    const { join } = require("node:path");
    const dir = process.env.PI_CODING_AGENT_DIR?.trim()
      ? process.env.PI_CODING_AGENT_DIR.replace(/^~(?=$|\/)/, homedir())
      : join(homedir(), ".pi", "agent");
    const parsed = JSON.parse(readFileSync(join(dir, "models.json"), "utf8"));
    providerCfg = parsed?.providers?.[TARGET_PROVIDER];
  } catch {
    providerCfg = undefined;
  }
  if (!providerCfg || typeof providerCfg !== "object") return; // no-op: model not served here

  pi.registerProvider(TARGET_PROVIDER, {
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
    // Custom stream handler. MUST return an AssistantMessageEventStream (a
    // class with push()/end()/result()), NOT a plain async generator: pi's
    // runner awaits stream.result() (resolved when a `done`/`error` event is
    // pushed) in parallel with draining the iterator. A bare async generator
    // has no result(), so pi awaits a promise that never resolves while the
    // iterator keeps producing — that hangs and leaks unboundedly (measured:
    // ~115 MB / 4 s until OOM). We delegate to the real backend, stream its
    // events through live, and on the terminal event decide whether to repair.
    streamSimple: (model: any, context: any, options: any): any => {
      const isTarget = model?.id === TARGET_MODEL_ID;

      // streamSimple must return synchronously, and the return value must be an
      // AssistantMessageEventStream (push/end/result), not an async generator
      // (see the comment above). pi-ai is a dependency present in node_modules,
      // so require() resolves it synchronously — no await needed for the class.
      const piai = require("@earendil-works/pi-ai");
      const outStream = piai.createAssistantMessageEventStream();

      // Driver: delegate to the real backend, pump events, repair on done.
      const drive = async () => {
        const real = piai.getApiProvider("openai-completions");
        if (!real) {
          outStream.push({
            type: "error",
            reason: "error",
            error: {
              role: "assistant",
              content: [],
              api: "openai-completions",
              provider: model?.provider ?? TARGET_PROVIDER,
              model: model?.id ?? TARGET_MODEL_ID,
              usage: emptyUsage(),
              stopReason: "error",
              errorMessage:
                "qwen25coder-toolcall: openai-completions provider unavailable",
              timestamp: Date.now(),
            },
          });
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
              // hold the done; we may rewrite it below
              break;
            }
            if (ev.type === "error") {
              finalMsg = ev.error;
              terminalType = "error";
              terminalReason = ev.reason;
              break;
            }
            // Stream non-terminal events straight through (live text/thinking).
            // We do NOT retain them — push hands off to the consumer/queue.
            outStream.push(ev);
          }
        } catch (e) {
          outStream.push({
            type: "error",
            reason: "error",
            error: {
              role: "assistant",
              content: [],
              api: "openai-completions",
              provider: model?.provider ?? TARGET_PROVIDER,
              model: model?.id ?? TARGET_MODEL_ID,
              usage: emptyUsage(),
              stopReason: "error",
              errorMessage: `qwen25coder-toolcall: upstream stream failed: ${(e as Error).message}`,
              timestamp: Date.now(),
            },
          });
          outStream.end();
          return;
        }

        if (!terminalType || !finalMsg) {
          // Upstream ended without a terminal `done`/`error` event (e.g. a clean
          // abort). A bare end() would NOT resolve outStream.result() (the
          // EventStream only resolves the result promise on a pushed terminal
          // event or end(result) with a defined arg), so pi's runner — which
          // awaits result() in parallel with draining — would hang the turn
          // forever. Push a terminal error event first so result() resolves.
          outStream.push({
            type: "error",
            reason: "error",
            error: {
              role: "assistant",
              content: [],
              api: "openai-completions",
              provider: model?.provider ?? TARGET_PROVIDER,
              model: model?.id ?? TARGET_MODEL_ID,
              usage: emptyUsage(),
              stopReason: "aborted",
              errorMessage:
                "qwen25coder-toolcall: upstream stream closed without a terminal event",
              timestamp: Date.now(),
            },
          });
          outStream.end();
          return;
        }

        if (terminalType === "error") {
          outStream.push({ type: "error", reason: terminalReason, error: finalMsg });
          outStream.end();
          return;
        }

        // terminalType === "done": decide whether to repair.
        const content: any[] = Array.isArray(finalMsg.content) ? finalMsg.content : [];
        const hasRealToolCall = content.some((b) => b?.type === "toolCall");
        const fullText = content
          .filter((b) => b?.type === "text")
          .map((b) => b.text ?? "")
          .join("");

        const extracted =
          isTarget && !hasRealToolCall ? extractToolCalls(fullText) : null;

        if (!extracted || extracted.calls.length === 0) {
          // Nothing to repair: emit the original done unchanged.
          outStream.push({ type: "done", reason: terminalReason ?? "stop", message: finalMsg });
          outStream.end();
          return;
        }

        // Repair: rebuild content as cleaned-text? + toolCall blocks, and emit a
        // dispatch-correct toolcall event sequence followed by a toolUse done.
        const toolCalls = extracted.calls.map((c, idx) =>
          piai.fauxToolCall(c.name, c.arguments as Record<string, any>, { id: makeId(idx) }),
        );
        const newContent: any[] = [];
        const haveText = !!extracted.cleanedText && extracted.cleanedText.trim().length > 0;
        if (haveText) newContent.push({ type: "text", text: extracted.cleanedText });
        for (const tc of toolCalls) newContent.push(tc);

        const repairedMsg = { ...finalMsg, content: newContent, stopReason: "toolUse" };

        let ci = 0;
        if (haveText) {
          const textBlock = newContent[0];
          outStream.push({ type: "text_start", contentIndex: ci, partial: repairedMsg });
          outStream.push({ type: "text_delta", contentIndex: ci, delta: textBlock.text, partial: repairedMsg });
          outStream.push({ type: "text_end", contentIndex: ci, content: textBlock.text, partial: repairedMsg });
          ci++;
        }
        for (const tc of toolCalls) {
          outStream.push({ type: "toolcall_start", contentIndex: ci, partial: repairedMsg });
          outStream.push({ type: "toolcall_delta", contentIndex: ci, delta: JSON.stringify(tc.arguments), partial: repairedMsg });
          outStream.push({ type: "toolcall_end", contentIndex: ci, toolCall: tc, partial: repairedMsg });
          ci++;
        }
        outStream.push({ type: "done", reason: "toolUse", message: repairedMsg });
        outStream.end();
      };

      // Kick the driver; do not await (the stream is consumed asynchronously).
      void drive();
      return outStream;
    },
  });
}
