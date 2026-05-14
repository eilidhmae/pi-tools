/**
 * adapter-route.ts
 *
 * Maps (role, domain) to a Qwen3-Coder model id with optional adapter
 * suffix. Importable by extensions and by the bash tools that orchestrate
 * dispatch. Per AGENTS.md "Adapter-Scoped Authority", adversary adapter
 * use is operator-opt-in; this function exposes the routing target but
 * the caller must decide whether to take it.
 *
 * The orchestrator role MUST NOT be passed here — orchestrator runs on
 * the bare base model. Workers and adversaries route through this map.
 */

export type Role = "worker" | "adversary" | "manager";
export type Domain =
  | "go" | "rust" | "python" | "terraform" | "general";

export interface ModelForOptions {
  /**
   * For role === "adversary", whether to return the +adversary adapter id.
   * Default false: the function returns the bare base model. Pass true at
   * the call site (typically gated by an operator flag like --adapter or
   * --adversary-adapter) to opt in.
   *
   * Per AGENTS.md "Adapter-Scoped Authority", the harness does not
   * auto-detect or auto-switch — every adversary adapter use is an
   * explicit operator decision.
   */
  adversaryAdapter?: boolean;
}

const BASE = "qwen3-coder-30b-a3b";

const ADAPTER_BY_DOMAIN: Record<Domain, string> = {
  go:        `${BASE}+go`,
  rust:      `${BASE}+rust`,
  python:    `${BASE}+python`,
  terraform: `${BASE}+tf`,
  general:   BASE,
};

/**
 * Resolve a model id from (role, domain).
 *
 * For workers/managers: returns the domain-specific adapter id.
 * For adversaries: returns the base model id by default. Pass
 * `{ adversaryAdapter: true }` to opt in to the +adversary adapter.
 */
export function modelFor(
  role: Role,
  domain: Domain,
  opts: ModelForOptions = {}
): string {
  if (role === "adversary") {
    return opts.adversaryAdapter ? `${BASE}+adversary` : BASE;
  }
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
