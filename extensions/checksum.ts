/**
 * checksum — a SHA-256 tool any agent (including a jailed worker) can call to
 * prove a file holds exactly the bytes it intended to write.
 *
 * The point is artifact integrity without trusting a claim: a worker that just
 * wrote a file can hash the file and compare it to the digest of the content it
 * meant to write ($MYFILEDATA), catching an empty / truncated / wrong-path write
 * before reporting success. Built on extensions/lib/sha256.ts — our own SHA-256,
 * so it runs in the research jail (no shell to call `sha256sum`/`shasum`, which
 * also diverge BSD vs GNU) and is identical on every platform.
 *
 * Tool `checksum`:
 *   { path }                 -> { digest }                 hash a file
 *   { value }                -> { digest }                 hash a string
 *   { path, expect }         -> { digest, match }          file vs a known hex digest
 *   { path, value }          -> { fileDigest, valueDigest, match }   file vs intended content
 *
 * The CLI counterpart (extensions/lib/checksum-cli.ts) gives bash runners the
 * same primitive without a system hash binary.
 */

import { readFileSync } from "node:fs";
import { sha256Hex, digestsEqual } from "./lib/sha256.ts";

export interface ChecksumParams {
  path?: string;
  value?: string;
  expect?: string;
}

/** Pure decision core (no pi runtime) so it is unit-testable. Reads a file via
 * the injected reader; defaults to fs. Returns a result object + a human line. */
export function computeChecksum(
  p: ChecksumParams,
  readFile: (path: string) => Uint8Array = (path) => new Uint8Array(readFileSync(path)),
): { result: Record<string, unknown>; text: string; isError?: boolean } {
  const hasPath = typeof p.path === "string" && p.path.length > 0;
  const hasValue = typeof p.value === "string";
  if (!hasPath && !hasValue) {
    return { result: { error: "need 'path' or 'value'" }, text: "Error: checksum needs 'path' or 'value'.", isError: true };
  }
  // Ambiguous: a file subject with TWO comparison targets (intended content AND
  // a digest). Fail loud rather than silently honour one and drop the other.
  if (hasPath && hasValue && typeof p.expect === "string") {
    const msg = "ambiguous: with a file 'path', pass either 'value' (intended content) or 'expect' (a digest), not both";
    return { result: { error: msg }, text: `Error: ${msg}.`, isError: true };
  }

  let fileDigest: string | undefined;
  if (hasPath) {
    try {
      fileDigest = sha256Hex(readFile(p.path!));
    } catch (e) {
      const msg = `cannot read '${p.path}': ${(e as Error).message}`;
      return { result: { error: msg }, text: `Error: ${msg}`, isError: true };
    }
  }
  const valueDigest = hasValue ? sha256Hex(p.value!) : undefined;

  // file vs intended content
  if (fileDigest !== undefined && valueDigest !== undefined) {
    const match = digestsEqual(fileDigest, valueDigest);
    return {
      result: { fileDigest, valueDigest, match },
      text: `sha256(file)=${fileDigest}\nsha256(value)=${valueDigest}\nmatch=${match}`,
    };
  }
  // file vs a known digest
  if (fileDigest !== undefined && typeof p.expect === "string") {
    const match = digestsEqual(fileDigest, p.expect);
    return { result: { digest: fileDigest, match }, text: `sha256=${fileDigest}\nexpect=${p.expect.trim().toLowerCase()}\nmatch=${match}` };
  }
  // value vs a known digest
  if (valueDigest !== undefined && typeof p.expect === "string") {
    const match = digestsEqual(valueDigest, p.expect);
    return { result: { digest: valueDigest, match }, text: `sha256=${valueDigest}\nexpect=${p.expect.trim().toLowerCase()}\nmatch=${match}` };
  }
  // single digest
  const digest = (fileDigest ?? valueDigest)!;
  return { result: { digest }, text: `sha256=${digest}` };
}

export default function (pi: any) {
  pi.registerTool({
    name: "checksum",
    label: "checksum",
    description:
      "Compute the SHA-256 of a file or a string, or verify a file matches intended " +
      "content. Use it to prove a file you just wrote holds exactly the bytes you meant " +
      "(catches an empty, truncated, or wrong-path write before you report success). " +
      "Pass {path} or {value} for a digest; {path,value} to check a file against intended " +
      "content; {path,expect} to check a file against a known hex digest. Read-only and " +
      "available inside the research jail (no system hash binary needed).",
    promptSnippet: "checksum: SHA-256 of a file/value, or verify a file matches intended content (no shell needed)",
    promptGuidelines: [
      "After writing a file you must be sure landed, call checksum with {path: <file>, value: <the exact content you wrote>} and proceed only if match=true.",
      "To get a bare digest, pass just {path} or {value}. To check against a digest you already hold, pass {path, expect: <hex>}.",
    ],
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "File to hash (read-only)." },
        value: { type: "string", description: "String to hash, or the intended content to compare a file against." },
        expect: { type: "string", description: "A known hex SHA-256 digest to compare against." },
      },
    },
    execute: async (_id: string, params: ChecksumParams) => {
      const { text, isError } = computeChecksum(params ?? {});
      return { content: [{ type: "text", text }], ...(isError ? { isError: true } : {}) };
    },
  });
}
