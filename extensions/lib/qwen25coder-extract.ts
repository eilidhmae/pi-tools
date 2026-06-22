/**
 * qwen25coder-extract — pure tool-call recovery core.
 *
 * Recovers tool calls a model emitted as TEXT (because the openai-completions
 * backend parser only matches `<tool_call>` and the model uses other forms) and
 * returns the text with those wrappers removed. No external imports, so it is
 * node-testable via `node --experimental-strip-types`. The runtime wiring that
 * needs `@earendil-works/pi-ai` lives in ../qwen25coder-toolcall.ts (the
 * extension entry); keeping pi-ai out of THIS file is what lets the type-strip
 * test load it without resolving an ESM-only dependency.
 *
 * Test: node --experimental-strip-types extensions/qwen25coder-toolcall.test.ts
 */

// The single model the extension repairs. Everything is scoped to this id (and
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

/** Options for {@link extractToolCalls}. */
export interface ExtractOptions {
  /**
   * When true, ALSO recover tool calls emitted inside Markdown code fences
   * (``` ```json {…} ``` ```). Off by default: most models only fence JSON as
   * an illustrative example, so fences are ignored. The one dense coder the
   * extension targets emits its genuine calls inside fences, so its runtime
   * path opts in. Fenced bodies use the strict `{name, arguments}` guard.
   */
  fenced?: boolean;
}

/**
 * Mask fenced code blocks (``` ... ```) with spaces of equal length so their
 * byte offsets are preserved but their content cannot match a tool-call
 * pattern. JSON shown as a code example must not be hijacked by the tagged/bare
 * passes; the opt-in fenced pass handles genuine fenced calls separately.
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
 * Like `firstObjectCall` but STRICT: the object must explicitly carry both a
 * string `name` and an `arguments` key (same guard as the bare path). Used for
 * fenced code blocks, where a model may legitimately show illustrative JSON; we
 * only hijack a fence whose body is unmistakably a `{name, arguments}` call.
 */
function strictFirstObjectCall(slice: string): ExtractedCall | null {
  const open = slice.indexOf("{");
  if (open < 0) return null;
  const close = matchBrace(slice, open);
  if (close < 0) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(slice.slice(open, close));
  } catch {
    return null;
  }
  const o = parsed as Record<string, unknown> | undefined;
  if (
    o &&
    typeof o === "object" &&
    typeof o.name === "string" &&
    Object.prototype.hasOwnProperty.call(o, "arguments")
  ) {
    return asCall(o);
  }
  return null;
}

/**
 * Pure extractor. Recovers tool calls a model emitted as text in any of these
 * wrapper forms and returns the text with those wrappers removed:
 *
 *   1. <tool_call> {json} </tool_call>   (the backend parser's native form)
 *   2. <tools> {json} </tools>           (the tools-param template default)
 *   3. bare top-level {"name":..,"arguments":..}  (the prompt path)
 *   4. ```json {"name":..,"arguments":..} ```  fenced — ONLY when opts.fenced
 *
 * By default content inside Markdown code fences is ignored (form 4 off), since
 * most models only fence JSON as an example. With `opts.fenced`, fenced bodies
 * that are a strict `{name, arguments}` object are recovered too. JSON objects
 * that are not a `{name, arguments}` tool call are left untouched. `calls` is
 * returned in document order; only wrappers that parse into a valid call are
 * stripped, and any other text is preserved.
 */
export function extractToolCalls(
  text: string,
  opts: ExtractOptions = {},
): ExtractResult {
  if (typeof text !== "string" || text.length === 0) {
    return { cleanedText: text ?? "", calls: [] };
  }

  const masked = maskCodeFences(text);
  // Each recovered call with its [start,end) span in the ORIGINAL text. Collected
  // across passes, then sorted by position so `calls` is in document order and
  // the spans are removed back-to-front (indices stay valid).
  const found: Array<{ start: number; end: number; call: ExtractedCall }> = [];

  // 1 & 2: tagged wrappers. Match the tag, then balance-scan the JSON inside so
  // braces within strings do not fool us. Runs on the MASKED text, so JSON shown
  // inside a code fence cannot be hijacked here.
  const tagRe = /<(tool_call|tools)>\s*([\s\S]*?)\s*<\/\1>/g;
  let m: RegExpExecArray | null;
  while ((m = tagRe.exec(masked)) !== null) {
    const call = firstObjectCall(m[2]);
    if (call) found.push({ start: m.index, end: m.index + m[0].length, call });
  }

  // 3: bare top-level tool-call JSON, only outside any tagged span we already
  // claimed. Scan for `{` that begins a balanced object parsing to a valid call
  // with BOTH name and arguments keys (stricter than tagged, to avoid eating
  // unrelated JSON the model may print). Fences are blanked in `masked`, so this
  // never enters fenced content.
  const claimed = (idx: number) =>
    found.some((f) => idx >= f.start && idx < f.end);
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
      if (call) found.push({ start: open, end: close, call });
    }
    i = close;
  }

  // 4: fenced tool calls (opt-in). The target dense coder emits genuine calls
  // inside ```json fences. Scan the ORIGINAL text for fenced blocks whose body
  // is a strict {name, arguments} call. The strict guard leaves a fenced JSON
  // example that is NOT a tool call untouched.
  if (opts.fenced) {
    const fenceRe = /```[^\n]*\n([\s\S]*?)```/g;
    let fm: RegExpExecArray | null;
    while ((fm = fenceRe.exec(text)) !== null) {
      const call = strictFirstObjectCall(fm[1]);
      if (call) found.push({ start: fm.index, end: fm.index + fm[0].length, call });
    }
  }

  if (found.length === 0) return { cleanedText: text, calls: [] };

  // Order calls by position in the message; the runtime applies any first-call
  // policy on top of this.
  found.sort((a, b) => a.start - b.start);
  const calls = found.map((f) => f.call);

  // Remove every claimed span from the ORIGINAL text, back to front, so no
  // recovered JSON leaks (including speculative calls the runtime won't dispatch).
  const spans = found
    .map((f): [number, number] => [f.start, f.end])
    .sort((a, b) => b[0] - a[0]);
  let out = text;
  for (const [s, e] of spans) {
    out = out.slice(0, s) + out.slice(e);
  }
  // Tidy the leftover whitespace from removed wrappers.
  return { cleanedText: out.replace(/\n{3,}/g, "\n\n").trim(), calls };
}
