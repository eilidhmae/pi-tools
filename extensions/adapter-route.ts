/**
 * adapter-route.ts
 *
 * Maps (role, domain) to a Qwen3-Coder model id with optional adapter
 * suffix. Used by quorum.ts and importable by other extensions or by
 * the orchestrator/manager skills (via a small bash wrapper).
 *
 * The orchestrator role MUST NOT be passed here — orchestrator runs on
 * the bare base model. Workers and adversaries route through this map.
 */

export type Role = "worker" | "adversary" | "manager";
export type Domain =
  | "go" | "rust" | "python" | "terraform" | "general";

const BASE = "qwen3-coder-7b";

const ADAPTER_BY_DOMAIN: Record<Domain, string> = {
  go:        `${BASE}+go`,
  rust:      `${BASE}+rust`,
  python:    `${BASE}+python`,
  terraform: `${BASE}+tf`,
  general:   BASE,
};

/**
 * Resolve a model id from (role, domain).
 * Adversary always gets the adversary adapter regardless of language —
 * the adversary role is about producing structured verdicts; the language
 * detail comes from the artifact under review, not from the model.
 */
export function modelFor(role: Role, domain: Domain): string {
  if (role === "adversary") return `${BASE}+adversary`;
  return ADAPTER_BY_DOMAIN[domain];
}

/**
 * Cheap heuristic: infer domain from a string of signal (file path,
 * task text, file list). Orchestrators can override by passing a
 * domain explicitly.
 */
export function inferDomain(signal: string): Domain {
  const s = signal.toLowerCase();
  if (/\.go\b|goroutine|go\.mod|go test/.test(s))    return "go";
  if (/\.rs\b|cargo\.toml|\bcargo\b|lifetime/.test(s)) return "rust";
  if (/\.py\b|pyproject|uv\s|pytest/.test(s))        return "python";
  if (/\.tf\b|terraform|hcl\b/.test(s))              return "terraform";
  return "general";
}

/**
 * Reverse: given a model id, return its suffix (or "" for the base).
 * Useful for log lines and capture metadata.
 */
export function suffixOf(modelId: string): string {
  if (modelId === BASE) return "";
  if (modelId.startsWith(`${BASE}+`)) return modelId.slice(BASE.length + 1);
  return "";
}

export const BASE_MODEL_ID = BASE;
