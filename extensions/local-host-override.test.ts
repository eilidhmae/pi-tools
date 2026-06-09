/**
 * local-host-override tests.
 *   node --experimental-strip-types extensions/local-host-override.test.ts
 */
import { computeRewrites, isLoopbackOrEmpty, agentDir } from "./local-host-override.ts";
import { homedir } from "node:os";
import { join } from "node:path";

let pass = 0,
  fail = 0;
function ok(cond: boolean, msg: string) {
  if (cond) pass++;
  else {
    fail++;
    console.log("FAIL:", msg);
  }
}

// The standard pi-tools local MLX bank.
const MLX_PROVIDERS = {
  "local-mlx": { baseUrl: "http://127.0.0.1:18080/v1" },
  "local-mlx-80b": { baseUrl: "http://127.0.0.1:18130/v1" },
  "local-mlx-codestral": { baseUrl: "http://127.0.0.1:18100/v1" },
  "local-mlx-dscoder": { baseUrl: "http://127.0.0.1:18120/v1" },
};

// --- isLoopbackOrEmpty (the opt-in gate) ---
ok(isLoopbackOrEmpty(undefined), "unset -> treated as loopback (no-op)");
ok(isLoopbackOrEmpty(""), "empty -> no-op");
ok(isLoopbackOrEmpty("  "), "whitespace -> no-op");
ok(isLoopbackOrEmpty("127.0.0.1"), "127.0.0.1 -> no-op");
ok(isLoopbackOrEmpty("localhost"), "localhost -> no-op");
ok(!isLoopbackOrEmpty("192.168.64.1"), "gateway -> NOT loopback (activates)");
ok(!isLoopbackOrEmpty("0.0.0.0"), "0.0.0.0 -> NOT loopback");
// F1: whitespace-padded loopback must still be treated as a no-op.
ok(isLoopbackOrEmpty("  127.0.0.1  "), "padded 127.0.0.1 -> no-op");
ok(isLoopbackOrEmpty(" localhost "), "padded localhost -> no-op");
ok(!isLoopbackOrEmpty(" 192.168.64.1 "), "padded gateway -> activates (trimmed != loopback)");

// --- agentDir: env override + tilde expansion (F3) + default ---
{
  const saved = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = "/abs/agent";
  ok(agentDir() === "/abs/agent", "absolute PI_CODING_AGENT_DIR used as-is");
  process.env.PI_CODING_AGENT_DIR = "~/.custom/agent";
  ok(agentDir() === join(homedir(), ".custom/agent"), "~/x keeps homedir prefix (F3)");
  process.env.PI_CODING_AGENT_DIR = "~";
  ok(agentDir() === homedir(), "bare ~ -> homedir");
  delete process.env.PI_CODING_AGENT_DIR;
  ok(agentDir() === join(homedir(), ".pi", "agent"), "unset -> ~/.pi/agent");
  if (saved !== undefined) process.env.PI_CODING_AGENT_DIR = saved;
}

// --- computeRewrites: the whole MLX bank, host swapped, port+path preserved ---
{
  const r = computeRewrites(MLX_PROVIDERS, "192.168.64.1");
  ok(r.length === 4, `all 4 MLX providers rewritten (got ${r.length})`);
  const byName = Object.fromEntries(r.map((x) => [x.name, x.baseUrl]));
  ok(byName["local-mlx"] === "http://192.168.64.1:18080/v1", "local-mlx host swapped, :18080/v1 kept");
  ok(byName["local-mlx-80b"] === "http://192.168.64.1:18130/v1", "80b host swapped, :18130/v1 kept");
  ok(byName["local-mlx-codestral"] === "http://192.168.64.1:18100/v1", "codestral :18100/v1 kept");
  ok(byName["local-mlx-dscoder"] === "http://192.168.64.1:18120/v1", "dscoder :18120/v1 kept");
}

// --- out-of-band loopback providers are left ALONE (e.g. ollama :11434) ---
{
  const r = computeRewrites(
    { ...MLX_PROVIDERS, ollama: { baseUrl: "http://localhost:11434/v1" } },
    "192.168.64.1",
  );
  ok(r.length === 4, "ollama :11434 (out of MLX band) not rewritten");
  ok(!r.some((x) => x.name === "ollama"), "ollama absent from rewrites");
}

// --- a localhost provider INSIDE the band is rewritten (adapter port) ---
{
  const r = computeRewrites({ p: { baseUrl: "http://localhost:18090/v1" } }, "192.168.64.1");
  ok(r.length === 1 && r[0].baseUrl === "http://192.168.64.1:18090/v1", "localhost:18090 in band rewritten");
}

// --- already non-loopback providers are not touched ---
{
  const r = computeRewrites(
    { a: { baseUrl: "http://192.168.64.1:18080/v1" }, b: { baseUrl: "http://10.0.0.5:18080/v1" } },
    "192.168.64.1",
  );
  ok(r.length === 0, "non-loopback providers skipped (no double-rewrite)");
}

// --- robustness: malformed / missing baseUrls are skipped, not thrown on ---
{
  const r = computeRewrites(
    { a: { baseUrl: "not a url" }, b: {}, c: { baseUrl: 42 } as unknown as { baseUrl: string }, d: { baseUrl: "http://127.0.0.1:18080/v1" } },
    "192.168.64.1",
  );
  ok(r.length === 1 && r[0].name === "d", "malformed/missing baseUrls skipped, valid one kept");
}
ok(computeRewrites(undefined, "192.168.64.1").length === 0, "undefined providers -> empty");

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
