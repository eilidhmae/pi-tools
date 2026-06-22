/**
 * A bounded string accumulator for spawned-child output.
 *
 * The RPI dispatcher extensions (coder/research/planner worker, adversary and
 * coder review, quorum peers) collect a child process's full stdout/stderr into
 * one string and read only its tail — `tail()` and the `parse*` helpers key on
 * the trailing report path / verdict. A thinking model whose `reasoning` stream
 * runs away can emit hundreds of MB before the child exits; accumulated naively
 * (`out += chunk`) that overflows pi's V8 old-space heap and OOMs the whole
 * coordinator session ("Ineffective mark-compacts near heap limit").
 *
 * Routing every accumulation site through this one capped buffer makes the leak
 * impossible to reintroduce by omission: only the trailing `cap` characters are
 * retained, far above any real report, so normal-sized output is byte-identical
 * and only a multi-MB runaway is bounded — exactly the OOM case, where a
 * degraded tail beats a crash.
 */

/**
 * Default retained tail, measured in JS string length (UTF-16 code units;
 * ≈bytes for the ASCII-dominant tool output we accumulate). 4 MiB is orders of
 * magnitude above `tail()`'s 2500-char report size.
 */
export const OUTPUT_CAP = 4 * 1024 * 1024;

export interface BoundedBuffer {
  /** Stream `data` handler — attach to BOTH child.stdout and child.stderr. */
  push(chunk: Buffer | string): void;
  /** Append a literal marker (timeout / abort / spawn-error text). */
  append(text: string): void;
  /** The retained (trailing) text. */
  value(): string;
}

/**
 * Create a buffer that keeps only the last `cap` characters. The returned
 * methods are arrow closures over private state, so `push`/`append` may be
 * passed detached (e.g. `child.stdout.on("data", buf.push)`) without `this`.
 */
export function boundedBuffer(cap: number = OUTPUT_CAP): BoundedBuffer {
  let s = "";
  const trim = () => { if (s.length > cap) s = s.slice(-cap); };
  return {
    push: (chunk: Buffer | string) => { s += typeof chunk === "string" ? chunk : chunk.toString(); trim(); },
    append: (text: string) => { s += text; trim(); },
    value: () => s,
  };
}
