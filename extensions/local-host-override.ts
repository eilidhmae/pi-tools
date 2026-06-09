/**
 * local-host-override
 *
 * Point pi's local MLX providers at a non-loopback host at runtime, without
 * editing models.json. Opt in by setting the env var PI_LOCAL_HOST; unset (the
 * default) is a complete no-op, so providers keep the models.json baseUrls
 * (normally 127.0.0.1).
 *
 * Why: the MLX bank can bind a specific interface via the launcher HOST knob
 * (e.g. HOST=192.168.64.1, the Apple-container vmnet gateway). To actually send
 * inference there — off the loopback an unrelated local process can watch, and
 * onto an interface a firewall can scope — the *client* baseUrls have to point
 * at that host too. pi reads baseUrl literally from models.json (no $VAR
 * interpolation), but exposes pi.registerProvider(name, { baseUrl }), which
 * "overrides existing models' URLs" for a provider while keeping its models.
 *
 * Scope: only providers whose baseUrl is a loopback host AND whose port is in
 * the MLX server band (OPERATIONS.md: 18080-18130 — the servers that honor the
 * HOST knob). That deliberately leaves other local providers alone (e.g. an
 * ollama provider on :11434, which only ever listens on loopback).
 *
 * Portable: no host/project identity, no Claude assumptions. Set
 * PI_LOCAL_HOST=192.168.64.1 (or any reachable host) to redirect; unset to keep
 * loopback.
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// MLX server port band — the servers the launcher HOST knob moves onto a chosen
// interface. Providers outside this band are not the MLX bank and are left as-is.
const MLX_PORT_MIN = 18080;
const MLX_PORT_MAX = 18130;

export interface ProviderRewrite {
  name: string;
  baseUrl: string;
}

/** A host value that means "leave loopback alone" — unset or itself loopback. */
export function isLoopbackOrEmpty(host: string | undefined | null): boolean {
  const h = (host ?? "").trim();
  if (!h) return true;
  return h === "127.0.0.1" || h === "localhost" || h === "::1";
}

/**
 * Pure core: given the parsed models.json `providers` map and a target host,
 * return the baseUrl rewrites for loopback providers in the MLX port band —
 * host swapped, port and path preserved. Malformed/non-loopback/out-of-band
 * providers are skipped.
 */
export function computeRewrites(
  providers: Record<string, unknown> | undefined,
  host: string,
): ProviderRewrite[] {
  const out: ProviderRewrite[] = [];
  for (const [name, cfg] of Object.entries(providers ?? {})) {
    const base = (cfg as { baseUrl?: unknown })?.baseUrl;
    if (typeof base !== "string") continue;
    let u: URL;
    try {
      u = new URL(base);
    } catch {
      continue;
    }
    const isLoopback =
      u.hostname === "127.0.0.1" || u.hostname === "localhost" || u.hostname === "::1";
    if (!isLoopback) continue;
    const port = Number(u.port);
    if (!Number.isInteger(port) || port < MLX_PORT_MIN || port > MLX_PORT_MAX) continue;
    u.hostname = host;
    out.push({ name, baseUrl: u.toString() });
  }
  return out;
}

/** Resolve pi's agent config dir the same way pi does (env override, else ~/.pi/agent). */
export function agentDir(): string {
  const env = process.env.PI_CODING_AGENT_DIR?.trim();
  if (env) {
    if (env === "~") return homedir();
    if (env.startsWith("~/")) return join(homedir(), env.slice(2)); // skip "~/"
    return env;
  }
  return join(homedir(), ".pi", "agent");
}

export default function (pi: any) {
  const host = (process.env.PI_LOCAL_HOST ?? "").trim();
  if (isLoopbackOrEmpty(host)) return; // default: no-op, keep models.json baseUrls

  let providers: Record<string, unknown>;
  try {
    const parsed = JSON.parse(readFileSync(join(agentDir(), "models.json"), "utf8"));
    // Guard: providers must be a plain object; null/array/string -> nothing to do.
    providers = (parsed && typeof parsed.providers === "object" && parsed.providers) || {};
  } catch (e) {
    // The operator explicitly asked to redirect (PI_LOCAL_HOST is set); a silent
    // no-op would surface later as a confusing connection-refused to loopback.
    console.error(
      `local-host-override: PI_LOCAL_HOST=${host} set but models.json was unreadable ` +
        `(${(e as Error).message}); leaving local providers on loopback.`,
    );
    return;
  }

  for (const r of computeRewrites(providers, host)) {
    try {
      pi.registerProvider(r.name, { baseUrl: r.baseUrl });
    } catch (e) {
      console.error(
        `local-host-override: failed to repoint provider ${r.name} -> ${r.baseUrl} ` +
          `(${(e as Error).message}).`,
      );
    }
  }
}
