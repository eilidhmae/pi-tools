/**
 * thinking-delimiter-strip
 *
 * Cosmetic cleanup: strip stray `<think>` / `</think>` delimiter tokens that
 * leak into the reasoning channel of a finished assistant message.
 *
 * Why this happens (harmless, observed with thinking Qwen models on the patched
 * mlx_lm.server reasoning split):
 *   The server splits reasoning out of the answer with a token-level state
 *   machine: a generated `<think>` flips state normal→reasoning and the matched
 *   text is attributed to the channel it transitions INTO. On a quick
 *   tool-dispatch turn the model reasons for ~zero tokens, so the only thing in
 *   the reasoning channel is the bare opening delimiter — the message arrives
 *   with a thinking block whose entire content is `"<think>\n\n"`. It renders as
 *   a visible, content-free `<think>` and (because same-model thinking blocks are
 *   replayed) gets fed back into the next request. Nothing downstream breaks —
 *   tool calls and answers are correct — it just looks like a leak.
 *
 * What this does:
 *   On `message_end`, for each assistant `thinking` block that contains a think
 *   delimiter, remove a leading `<think>` and/or trailing `</think>` (with
 *   surrounding whitespace). A block left empty (it was delimiter-only) is
 *   dropped. Real reasoning content is preserved verbatim.
 *
 * Strict no-op when no thinking block contains a `<think>`/`</think>` token, so
 * it is safe to load against any provider — a well-behaved backend never trips
 * it. Boundary-only stripping: a delimiter embedded mid-reasoning (vanishingly
 * rare) is left alone rather than risk corrupting genuine content.
 *
 * Pure core (stripStrayThinkDelimiters + cleanThinkingBlocks) has no imports so
 * it is node-testable via `node --experimental-strip-types`.
 *
 * Test: node --experimental-strip-types extensions/thinking-delimiter-strip.test.ts
 */

// A single leading open tag (with surrounding whitespace), and a single trailing
// close tag (with surrounding whitespace). Anchored to the boundaries only.
const LEADING_OPEN = /^\s*<think>\s*/i;
const TRAILING_CLOSE = /\s*<\/think>\s*$/i;
// Fast-path / scope guard: only touch blocks that actually contain a delimiter.
const HAS_DELIMITER = /<\/?think>/i;

export function stripStrayThinkDelimiters(text: string): string {
  if (typeof text !== "string") return text;
  return text.replace(LEADING_OPEN, "").replace(TRAILING_CLOSE, "");
}

export interface CleanResult {
  content: unknown[];
  changed: boolean;
}

export function cleanThinkingBlocks(content: unknown[]): CleanResult {
  if (!Array.isArray(content)) return { content, changed: false };
  let changed = false;
  const out: unknown[] = [];
  for (const block of content) {
    const b = block as { type?: string; thinking?: unknown };
    if (
      b &&
      b.type === "thinking" &&
      typeof b.thinking === "string" &&
      HAS_DELIMITER.test(b.thinking)
    ) {
      const stripped = stripStrayThinkDelimiters(b.thinking);
      if (stripped !== b.thinking) changed = true;
      if (stripped.trim() === "") {
        // Delimiter-only block: carried no reasoning, drop it entirely (keeping
        // an empty block would still replay as an empty <think></think>).
        continue;
      }
      out.push({ ...(b as object), thinking: stripped });
    } else {
      out.push(block);
    }
  }
  return { content: out, changed };
}

// Register with pi. `message_end` handlers may return a replacement message with
// the SAME role; returning nothing leaves the message untouched.
export default function (pi: any) {
  pi.on("message_end", async (event: any, _ctx: any) => {
    const msg = event?.message;
    if (!msg || msg.role !== "assistant" || !Array.isArray(msg.content)) return;
    const { content, changed } = cleanThinkingBlocks(msg.content);
    if (!changed) return;
    return { message: { ...msg, content } };
  });
}
