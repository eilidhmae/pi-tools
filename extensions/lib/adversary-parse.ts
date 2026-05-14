/**
 * adversary-parse.ts
 *
 * Parses the structured adversary review block described in
 * skills/adversary/SKILL.md. The block is fenced with the label
 * `adversary-review` and carries a small, well-defined YAML subset.
 *
 * Zero runtime dependencies: pi extensions ship as raw TypeScript with
 * no bundler and no node_modules expected. The reader handles only the
 * subset the adversary skill is constrained to emit:
 *   - top-level scalars              key: value
 *   - one nested mapping             artifact: { path, sha256, lines_reviewed }
 *   - list of mappings               findings: - id: ...  ...
 *   - folded block scalars           message: >  multi-line text
 *   - mechanical_baseline mapping w/ failures: list of strings
 *
 * Anything richer (anchors, refs, flow style, multi-doc) is out of scope
 * by design — the schema is locked.
 *
 * Returns {ok, review, errors, fatal} so the capture pipeline can tell
 * "usable but normalized" from "drop entirely".
 */

// Tolerant of two observed model outputs:
//   ```adversary-review\n<yaml>\n```          (canonical, per SKILL.md)
//   ```\nadversary-review\n<yaml>\n```        (label split onto next line)
// The \s* between the opening ``` and the label matches the newline in
// the split form and any incidental whitespace in the canonical form.
const FENCE_RE = /```\s*adversary-review\s*\n([\s\S]*?)\n```/;

export const ALLOWED_VERDICTS = ["PASS", "CONCERNS", "FAIL"] as const;
export const ALLOWED_CONFIDENCE = ["high", "medium", "low"] as const;
export const ALLOWED_SEVERITY = ["critical", "major", "minor"] as const;
export const ALLOWED_CATEGORIES = [
  "race-condition",
  "error-handling",
  "resource-leak",
  "security",
  "correctness",
  "idiom",
  "performance",
  "maintainability",
] as const;

export type Verdict = (typeof ALLOWED_VERDICTS)[number];
export type Confidence = (typeof ALLOWED_CONFIDENCE)[number];
export type Severity = (typeof ALLOWED_SEVERITY)[number];
export type Category = (typeof ALLOWED_CATEGORIES)[number];

export interface Finding {
  id: string;
  severity: Severity;
  category: Category;
  file: string;
  line: number;
  line_end: number;
  message: string;
  suggested_fix?: string;
}

export interface AdversaryReview {
  verdict: Verdict;
  confidence: Confidence;
  artifact: {
    path: string;
    sha256?: string;
    lines_reviewed: string;
  };
  findings: Finding[];
  mechanical_baseline?: {
    ran: boolean;
    passed: boolean;
    failures: string[];
  };
}

export interface ParseResult {
  ok: boolean;
  review?: AdversaryReview;
  errors: string[];
  fatal?: string;
}

const SEVERITY_ALIASES: Record<string, Severity> = {
  warning: "minor", info: "minor", note: "minor",
  high: "major", med: "major", medium: "major", moderate: "major",
  low: "minor",
  blocker: "critical", severe: "critical",
};

const CATEGORY_ALIASES: Record<string, Category> = {
  concurrency: "race-condition",
  race: "race-condition",
  "data-race": "race-condition",
  threading: "race-condition",
  leak: "resource-leak",
  "memory-leak": "resource-leak",
  "goroutine-leak": "resource-leak",
  style: "idiom",
  formatting: "idiom",
  bug: "correctness",
  logic: "correctness",
  perf: "performance",
  docs: "maintainability",
  documentation: "maintainability",
  naming: "maintainability",
  injection: "security",
  auth: "security",
};

// --- Tiny YAML subset reader ------------------------------------------------

type YamlNode = string | number | boolean | YamlMap | YamlList;
type YamlMap = { [k: string]: YamlNode };
type YamlList = YamlNode[];

function indentOf(line: string): number {
  let i = 0;
  while (i < line.length && line[i] === " ") i++;
  return i;
}

/** Strip trailing newline-as-space from folded scalar; collapse runs of spaces. */
function foldScalar(lines: string[]): string {
  return lines.map((l) => l.trim()).filter((l) => l.length > 0).join(" ");
}

function parseScalar(raw: string): YamlNode {
  const v = raw.trim();
  if (v === "") return "";
  if (v === "true") return true;
  if (v === "false") return false;
  if (/^-?\d+$/.test(v)) return parseInt(v, 10);
  if ((v.startsWith('"') && v.endsWith('"')) ||
      (v.startsWith("'") && v.endsWith("'"))) {
    return v.slice(1, -1);
  }
  return v;
}

interface Cursor { i: number; }

function readBlock(lines: string[], baseIndent: number, cur: Cursor): YamlNode {
  // Decide: is this a list (first non-blank starts with "- ") or a mapping?
  while (cur.i < lines.length) {
    const line = lines[cur.i];
    if (line.trim() === "" || line.trim().startsWith("#")) { cur.i++; continue; }
    const ind = indentOf(line);
    if (ind < baseIndent) return ""; // empty
    if (line.slice(ind).startsWith("- ")) return readList(lines, baseIndent, cur);
    return readMap(lines, baseIndent, cur);
  }
  return "";
}

function readMap(lines: string[], baseIndent: number, cur: Cursor): YamlMap {
  const out: YamlMap = {};
  while (cur.i < lines.length) {
    const line = lines[cur.i];
    if (line.trim() === "" || line.trim().startsWith("#")) { cur.i++; continue; }
    const ind = indentOf(line);
    if (ind < baseIndent) break;
    if (ind > baseIndent) break; // shouldn't happen at top of map
    const rest = line.slice(ind);
    if (rest.startsWith("- ")) break;

    const colon = rest.indexOf(":");
    if (colon === -1) { cur.i++; continue; }
    const key = rest.slice(0, colon).trim();
    const after = rest.slice(colon + 1);
    cur.i++;

    if (after.trim() === "") {
      // Nested block (map or list) at deeper indent
      out[key] = readBlock(lines, baseIndent + 2, cur);
    } else if (after.trim() === "[]") {
      // Flow-style empty list. SKILL.md mandates `findings: []` for PASS
      // verdicts; without this case the parser returns the string "[]"
      // and validateReview throws "expected list" on every PASS block.
      out[key] = [] as YamlList;
    } else if (after.trim() === "{}") {
      out[key] = {} as YamlMap;
    } else if (after.trim() === ">" || after.trim() === ">-" ||
               after.trim() === "|") {
      // Folded or literal block scalar
      const folded = after.trim().startsWith(">");
      const collected: string[] = [];
      while (cur.i < lines.length) {
        const ll = lines[cur.i];
        if (ll.trim() === "") { collected.push(""); cur.i++; continue; }
        if (indentOf(ll) <= baseIndent) break;
        collected.push(ll.slice(baseIndent + 2));
        cur.i++;
      }
      out[key] = folded ? foldScalar(collected) : collected.join("\n").trim();
    } else {
      out[key] = parseScalar(after);
    }
  }
  return out;
}

function readList(lines: string[], baseIndent: number, cur: Cursor): YamlList {
  const out: YamlList = [];
  while (cur.i < lines.length) {
    const line = lines[cur.i];
    if (line.trim() === "" || line.trim().startsWith("#")) { cur.i++; continue; }
    const ind = indentOf(line);
    if (ind < baseIndent) break;
    if (ind > baseIndent) break;
    const rest = line.slice(ind);
    if (!rest.startsWith("- ")) break;

    const after = rest.slice(2);
    cur.i++;

    if (after.trim() === "") {
      out.push(readBlock(lines, baseIndent + 2, cur));
    } else if (after.includes(":") &&
               !after.trimStart().startsWith('"') &&
               !after.trimStart().startsWith("'")) {
      // Inline first kv of an item map: "- key: value"
      // KNOWN LIMITATION: an unquoted list-item string that contains a
      // colon (e.g. `- go vet: error at line 5`) falls into this branch
      // and is mis-parsed as a map. The SKILL.md schema mandates quoting
      // (`- "go vet: error at line 5"`); this guard recovers that case.
      // The unquoted form is documented as bad output by the adversary skill.
      const itemMap: YamlMap = {};
      const colon = after.indexOf(":");
      const k = after.slice(0, colon).trim();
      const v = after.slice(colon + 1);
      if (v.trim() === "") {
        itemMap[k] = readBlock(lines, baseIndent + 2, cur);
      } else if (v.trim() === ">" || v.trim() === ">-") {
        const collected: string[] = [];
        while (cur.i < lines.length) {
          const ll = lines[cur.i];
          if (ll.trim() === "") { collected.push(""); cur.i++; continue; }
          if (indentOf(ll) <= baseIndent + 2) break;
          collected.push(ll.slice(baseIndent + 4));
          cur.i++;
        }
        itemMap[k] = foldScalar(collected);
      } else {
        itemMap[k] = parseScalar(v);
      }
      // Rest of item map at indent baseIndent + 2
      const more = readMap(lines, baseIndent + 2, cur);
      for (const kk of Object.keys(more)) itemMap[kk] = more[kk];
      out.push(itemMap);
    } else {
      out.push(parseScalar(after));
    }
  }
  return out;
}

function readYAML(src: string): YamlMap {
  const lines = src.split("\n");
  const cur: Cursor = { i: 0 };
  const node = readBlock(lines, 0, cur);
  if (typeof node !== "object" || Array.isArray(node)) {
    throw new Error("expected top-level mapping");
  }
  return node as YamlMap;
}

// --- Schema validation + normalization -------------------------------------

function asString(v: YamlNode | undefined, name: string): string {
  if (typeof v === "string") return v;
  if (typeof v === "number") return String(v);
  throw new Error(`${name}: expected string, got ${typeof v}`);
}

function asInt(v: YamlNode | undefined, name: string): number {
  if (typeof v === "number") return v;
  if (typeof v === "string" && /^-?\d+$/.test(v)) return parseInt(v, 10);
  throw new Error(`${name}: expected integer`);
}

function asBool(v: YamlNode | undefined, name: string): boolean {
  if (typeof v === "boolean") return v;
  if (typeof v === "string") {
    if (v === "true") return true;
    if (v === "false") return false;
  }
  throw new Error(`${name}: expected boolean`);
}

function isMap(v: YamlNode | undefined): v is YamlMap {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function normalizeSeverity(raw: string, errors: string[], id: string): Severity {
  const s = raw.toLowerCase();
  if ((ALLOWED_SEVERITY as readonly string[]).includes(s)) return s as Severity;
  const aliased = SEVERITY_ALIASES[s];
  if (aliased) {
    errors.push(`finding ${id}: severity '${raw}' → '${aliased}'`);
    return aliased;
  }
  throw new Error(`finding ${id}: severity '${raw}' not recognized`);
}

function normalizeCategory(raw: string, errors: string[], id: string): Category {
  const s = raw.toLowerCase();
  if ((ALLOWED_CATEGORIES as readonly string[]).includes(s)) return s as Category;
  const aliased = CATEGORY_ALIASES[s];
  if (aliased) {
    errors.push(`finding ${id}: category '${raw}' → '${aliased}'`);
    return aliased;
  }
  throw new Error(`finding ${id}: category '${raw}' not recognized`);
}

function validateReview(raw: YamlMap, errors: string[]): AdversaryReview {
  const verdict = asString(raw.verdict, "verdict").toUpperCase();
  if (!(ALLOWED_VERDICTS as readonly string[]).includes(verdict)) {
    throw new Error(`verdict '${verdict}' not in ${ALLOWED_VERDICTS.join("|")}`);
  }
  const confidence = asString(raw.confidence, "confidence").toLowerCase();
  if (!(ALLOWED_CONFIDENCE as readonly string[]).includes(confidence)) {
    throw new Error(`confidence '${confidence}' not in ${ALLOWED_CONFIDENCE.join("|")}`);
  }

  if (!isMap(raw.artifact)) throw new Error("artifact: expected mapping");
  const artifact = {
    path: asString(raw.artifact.path, "artifact.path"),
    sha256: raw.artifact.sha256 !== undefined
      ? asString(raw.artifact.sha256, "artifact.sha256") : undefined,
    lines_reviewed: asString(raw.artifact.lines_reviewed, "artifact.lines_reviewed"),
  };

  const findings: Finding[] = [];
  if (raw.findings !== undefined) {
    if (!Array.isArray(raw.findings)) throw new Error("findings: expected list");
    for (const item of raw.findings) {
      if (!isMap(item)) throw new Error("finding: expected mapping");
      const id = asString(item.id, "finding.id");
      const severity = normalizeSeverity(asString(item.severity, "finding.severity"), errors, id);
      const category = normalizeCategory(asString(item.category, "finding.category"), errors, id);
      const file = asString(item.file, "finding.file");
      const line = asInt(item.line, "finding.line");
      const line_end = item.line_end !== undefined
        ? asInt(item.line_end, "finding.line_end") : line;
      const message = asString(item.message, "finding.message");
      const suggested_fix = item.suggested_fix !== undefined
        ? asString(item.suggested_fix, "finding.suggested_fix") : undefined;
      findings.push({ id, severity, category, file, line, line_end, message, suggested_fix });
    }
  }

  let mechanical_baseline;
  if (raw.mechanical_baseline !== undefined) {
    if (!isMap(raw.mechanical_baseline)) throw new Error("mechanical_baseline: expected mapping");
    const mb = raw.mechanical_baseline;
    const failures: string[] = [];
    if (mb.failures !== undefined) {
      if (!Array.isArray(mb.failures)) throw new Error("mechanical_baseline.failures: expected list");
      for (const f of mb.failures) failures.push(asString(f, "mechanical_baseline.failures[]"));
    }
    mechanical_baseline = {
      ran: asBool(mb.ran, "mechanical_baseline.ran"),
      passed: asBool(mb.passed, "mechanical_baseline.passed"),
      failures,
    };
  }

  return {
    verdict: verdict as Verdict,
    confidence: confidence as Confidence,
    artifact,
    findings,
    mechanical_baseline,
  };
}

export function parseAdversaryReview(rawOutput: string): ParseResult {
  const errors: string[] = [];
  const m = rawOutput.match(FENCE_RE);
  if (!m) {
    return { ok: false, errors, fatal: "no `adversary-review` fenced block found" };
  }
  let parsed: YamlMap;
  try {
    parsed = readYAML(m[1]);
  } catch (e) {
    return { ok: false, errors, fatal: `YAML parse failed: ${(e as Error).message}` };
  }
  let review: AdversaryReview;
  try {
    review = validateReview(parsed, errors);
  } catch (e) {
    return { ok: false, errors, fatal: `schema validation failed: ${(e as Error).message}` };
  }
  return { ok: true, review, errors };
}
