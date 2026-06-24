# pi-tools — Operator-Facing Environment Variables

Authoritative index of the environment variables an operator sets to
configure pi-tools: serving (`mlx_lm.server` stack), model/provider
selection, the pi harness runtime (coder/research/planner workers,
adversary, quorum), containerization, install-time provisioning, and the
git hooks.

**Surveyed:** `~/src/pi-tools` on branch `gemma431b-mtp-draft`
(superset of `main`/`gemma-models`; the three `MLX_MTP_*` vars are
branch-specific — see §9). Searched `*.sh`, `*.py`,
`*.ts`/`*.js`, `*.conf`, `Dockerfile*`, READMEs, across `server/`,
`scripts/`, `extensions/`, `hooks/`, `install.sh`.

**Scope rule used.** Operator-facing = a var the docs invite an operator
to set, or one whose `:-default`/`os.environ.get`/`process.env` read
changes serving or harness behavior from outside the process. Excluded:
purely internal locals (`SCRIPT_DIR`, `VERDICT`, `LOOP_MODEL`,
`MLX_SERVER_BIN`, `PI_MULTI`, `HF_HUB_CACHE`, `MLX_VERSION`,
`MLX_LM_BRANCH`, color codes), the `*_CHILD` recursion guards (set by the
parent, not the operator), and the proxy's own `PI_PROXY_*` re-exports
(set internally by `mlx-lm-multi/launch.sh`, listed once where the
operator can meaningfully touch them). Standard system vars (`HOME`,
`PATH`, `TMPDIR`, `SHELL`) are excluded unless pi-tools documents an
override.

**Note:** `CLAUDE_MEMORY` / `CLAUDE_PROJECT_DIR` are **not** in pi-tools
— they belong to the `claude-memory` pi extension that lives in
`my-macbook/tooling`, not this repo. Confirmed: no `CLAUDE_` reference
anywhere under `~/src/pi-tools` (excluding `.git`/`node_modules`).

Total operator-facing vars indexed: **49** (46 on `main`/`gemma-models`
+ 3 branch-specific MTP vars).

---

## 1. Serving / mlx-server stack

The `mlx-server.sh` dispatcher documents its own "Environment overrides"
block (`server/mlx-server.sh:70-96`); these match code.

| Var | Controls | Default | Values / example | Consumed at |
|-----|----------|---------|------------------|-------------|
| `HOST` | Bind address for every track; exported so sub-launchers inherit | `127.0.0.1` | `0.0.0.0` to expose on all interfaces (e.g. Apple Container) | `server/mlx-server.sh:114` (export); re-read in `thinking-adversary/launch.sh:66`, `mlx-lm-multi/launch.sh:21`, `mola/launch.sh:26`, `judge/launch.sh:37`, `session-80b/launch.sh:50` |
| `PI_VENV` | Python venv whose `mlx_lm.server` is used | `$HOME/.pi/agent/venv` | absolute path | `server/mlx-server.sh:103` |
| `PI_EXPECTED_MLX_PATH` | If set, verify venv's `mlx_lm` resolves to this path (guards the PR #1277 patched checkout) | empty (no check) | absolute path to `mlx_lm` | `server/mlx-server.sh:127`; set+exported in `server/bootstrap-mac.sh:241` |
| `HF_HOME` | HuggingFace cache root (drives `HF_HUB_CACHE=$HF_HOME/hub`) | `$HOME/.cache/huggingface` (in `mlx-server.sh`, `judge`, `session-80b`); **`$MODELS_DIR` (=`~/models`) in `bootstrap-mac.sh`** | absolute path | `server/mlx-server.sh:128`, `judge/launch.sh:88`, `session-80b/launch.sh:102`, `bootstrap-mac.sh:54` (export) |
| `MAX_TOKENS` | `--max-tokens` ceiling for extra-models rows without a 4th-column override; also the per-track ceiling in several launchers | `32768` (mlx-server, mlx-lm-multi); `2048` (judge); see per-launcher | integer | `server/mlx-server.sh:147`, `mlx-lm-multi/launch.sh:28`, `judge/launch.sh:38`, `session-80b/launch.sh:51`, `thinking-adversary/launch.sh:80` |
| `PI_EXTRA_CONF` | Path to the extra-models config file (keep per-box choices out of the tree) | `<repo>/server/extra-models/config.conf` | absolute path | `server/mlx-server.sh:131` |
| `PI_PROMPT_CACHE_SIZE` | Prompt-cache slot count for the mlx-lm-multi base server | `16` | integer | `server/mlx-lm-multi/launch.sh:24` |
| `PI_PROMPT_CACHE_BYTES` | Prompt-cache byte ceiling for the mlx-lm-multi base server | `2147483648` (2 GiB) | bytes | `server/mlx-lm-multi/launch.sh:25` |
| `PROMPT_CACHE_SIZE` | Prompt-cache slots (judge / session-80b / thinking-adversary tracks) | `16` (judge); `4` (session-80b, thinking-adversary) | integer | `judge/launch.sh:39`, `session-80b/launch.sh:52`, `thinking-adversary/launch.sh:81` |
| `PROMPT_CACHE_BYTES` | Prompt-cache bytes (judge / session-80b / thinking-adversary) | `2147483648` (judge); `1073741824` (session-80b); `$DEFAULT_PROMPT_CACHE_BYTES` (thinking-adversary) | bytes | `judge/launch.sh:40`, `session-80b/launch.sh:53`, `thinking-adversary/launch.sh:82` |
| `PORT` | Listen port for the judge / session-80b / thinking-adversary tracks (and upgrade probe) | `18090` (judge); `18130` (session-80b); `18080` (thinking-adversary, upgrade) | port number | `judge/launch.sh:36`, `session-80b/launch.sh:49`, `thinking-adversary/launch.sh:65`, `upgrade.sh:33` |
| `PROXY_PORT` | mlx-lm-multi routing proxy port (and healthchecks) | `18080` | port number | `mlx-lm-multi/launch.sh:17`, `mlx-lm-multi/healthcheck.sh:3`, `mola/launch.sh:22`, `mola/healthcheck.sh:3`, `mlx-lm-multi/verify-adapter.sh:17` |
| `BASE_PORT` | mlx-lm-multi base mlx_lm.server port | `18090` | port number | `server/mlx-lm-multi/launch.sh:16` |
| `PY_ENV` | venv used by individual launchers (sibling of `PI_VENV`, used by the sub-launchers) | `$HOME/.pi/agent/venv`; `$HOME/.pi/agent/venv-mola` (mola) | absolute path | `judge/launch.sh:34`, `mlx-lm-multi/launch.sh:23`, `mola/launch.sh:30`, `session-80b/launch.sh:47`, `thinking-adversary/launch.sh:63`, `upgrade.sh:77` |
| `BASE_MODEL_DIR` | Base model dir for mlx-lm-multi / mola tracks | `$HOME/models/Qwen3-Coder-30B-A3B-Instruct-4bit` | absolute path | `mlx-lm-multi/launch.sh:15`, `mola/launch.sh:21` |
| `MODEL` | Model dir/repo for the judge / session-80b track (also a tier override knob in coder-review) | `$HOME/models/Qwen3-Coder-30B-A3B-Instruct-4bit` (judge); `inferencerlabs/Qwen3-Coder-Next-MLX-9bit` (session-80b) | path or HF repo id | `judge/launch.sh:35`, `session-80b/launch.sh:48` |
| `MODEL_DIR` | Model dir for the thinking-adversary track | `$HOME/models/Qwen3.5-27B-4bit` | absolute path | `server/thinking-adversary/launch.sh:64` |
| `MAXTOK` | `--max-tokens` for the verify-adapter A/B probe | `64` | integer | `server/mlx-lm-multi/verify-adapter.sh:21` |
| `PI_PROXY_RELOAD` | Uvicorn `reload=True` for the routing proxy (turn off in production to stop interrupting in-flight streams) | `"1"` (on) | `"0"` to disable | `server/mlx-lm-multi/proxy.py:164` |

**mola track (alpha):**

| Var | Controls | Default | Consumed at |
|-----|----------|---------|-------------|
| `MOLA_DIR` | Local mlx-lm-mola checkout dir | `$HOME/src/mola` | `server/mola/launch.sh:19` |
| `MOLA_REPO` | mlx-lm-mola git URL (clone source) | `https://github.com/Goekdeniz-Guelmez/mlx-lm-mola` | `server/mola/launch.sh:20` |

---

## 2. Model & provider selection (workers / coder tiers)

| Var | Controls | Default | Values | Consumed at |
|-----|----------|---------|--------|-------------|
| `PI_CODER_TIER` | Which Code-Worker backend the coder scripts target | `gemma` | `large` (32B :18111) \| `small` (27B :18080) \| `gemma` (Gemma-4-31B :18112) | `scripts/bash/coder-run.sh:90`, `scripts/bash/coder-review.sh:70` |
| `PI_CODER_THINKING` | Thinking level for the small/27B coder path only (scoped to `local-mlx-coder27b`) | `off` | `off\|minimal\|low\|medium\|high\|xhigh` | `scripts/bash/coder-run.sh:97`, `scripts/bash/coder-review.sh:71` |
| `PROVIDER` | Override the tier-derived pi provider id (coder-review) | tier-derived (`local-mlx-coder32b` / `local-mlx-coder27b` / `local-mlx-gemma431b`) | provider id from models.json | `scripts/bash/coder-review.sh:74,77,82,87` |
| `MODEL` | Override the tier-derived model id (coder-review) — see also §1 | tier-derived | model id from models.json | `scripts/bash/coder-review.sh:78,83,88` |
| `PI_RESEARCH_WORKER_MODEL` | Model the research-jailed worker runs | `$HOME/models/Qwen3.5-27B-4bit` | path or repo id | `scripts/bash/research-jailed.sh:64` |
| `PI_PLANNER_WORKER_MODEL` | Model the plan-jailed worker runs | `$HOME/models/Qwen3.5-27B-4bit` | path or repo id | `scripts/bash/plan-jailed.sh:66` |
| `PI_WORKER_MIN_CHARS` | Min non-whitespace chars for a worker artifact to count as "substantive" | `200` | integer | `scripts/bash/artifact-verify.sh:15,32` |
| `PI_WORKER_RETRY_LIMIT` | Write-and-checksum retry count for verified worker writes | `1` | integer | `scripts/bash/artifact-verify.sh:18,39` |

---

## 3. Adversary & quorum

| Var | Controls | Default | Values | Consumed at |
|-----|----------|---------|--------|-------------|
| `PI_ADVERSARY_MODEL` | Model the local adversary reviewer runs | **`unsloth/gemma-4-31b-it-MLX-8bit`** on the main paths; **`$HOME/models/Qwen3.5-27B-4bit`** for the `general` tier in adversary-pass | path or repo id | `scripts/bash/adversary-jailed.sh:69`, `scripts/bash/adversary-pass.sh:83`, **and a different default at `adversary-pass.sh:116`** (see Footguns) |
| `ADV_NO_CAPTURE` | Skip writing the review into the capture corpus (`bootstrap.jsonl`) | unset (capture on) | non-empty / `1` to skip | `scripts/bash/adversary-pass.sh:401`, `adversary-loop.sh:191` |
| `ADV_NO_DRIFT_CHECK` | Skip the adversary model/path drift check | unset (check on) | non-empty / `1` to skip | `scripts/bash/adversary-pass.sh:379` |
| `PI_ADVERSARY_DATASET` | Capture corpus dir the adversary-capture lib writes to | `$HOME/.pi/agent/training/adversary-captures` | absolute path | `extensions/lib/adversary-capture.ts:43` |
| `PI_QUORUM_MODELS` | Comma list of `model[@provider]` peers for the quorum tool (empty → single legacy peer) | `""` | e.g. `qwen3-coder-30b-a3b+adversary@local-mlx,gemma...@local-mlx-gemma431b` | `extensions/quorum.ts:56` |
| `PI_QUORUM_MODEL` | Legacy single-peer model (used when `PI_QUORUM_MODELS` empty) | `qwen3-coder-30b-a3b+adversary` (Apple Silicon) / `qwen3-coder:30b` (else) | model id | `extensions/quorum.ts:54` |
| `PI_QUORUM_PROVIDER` | Legacy single-peer provider | `local-mlx` (Apple Silicon) / `ollama` (else) | provider id | `extensions/quorum.ts:55` |
| `PI_QUORUM_TEMPS` | Comma list of per-peer temperatures | `0.2,0.5,0.7` | floats | `extensions/quorum.ts:57` |
| `PI_MODEL` | Self model id recorded in the quorum's own captured result | `unknown-self` | model id | `extensions/quorum.ts:285` |
| `PI_TEMPERATURE` | Self temperature recorded in the quorum's captured result | `0` | float | `extensions/quorum.ts:286` |
| `GIT_SHA` | Git SHA stamped into the quorum capture record | unset | sha string | `extensions/quorum.ts:298` |
| `LOOP_MODEL` | (Read in adversary-loop's capture step; normally derived from worker output, but honored from env if set) | derived | model id | `scripts/bash/adversary-loop.sh:199` (`internal?` — primarily extracted, not operator-set) |

---

## 4. Pi harness runtime (research mode, host redirect, workspaces)

| Var | Controls | Default | Values | Consumed at |
|-----|----------|---------|--------|-------------|
| `PI_RESEARCH_WORKSPACE` | Activates research mode and sets the writable workspace; jailed scripts also derive `reviews/`/`plans/`/`reports/` under it | unset → research mode off; fallback workspace `$TMPDIR/pi-research-<pid>` | absolute path | `extensions/research-mode.ts:484,510,644`; consumed by `adversary-jailed.sh:101`, `plan-jailed.sh:100`, `research-jailed.sh:98`, `coder-run.sh:61` (fail-hard guard) |
| `PI_RESEARCH_MODE_ACTIVE` | Set by research-mode to signal an active jail to other extensions (read by guards) | set to `1` while active | `1` | `extensions/research-mode.ts:569`, `adversary-review.ts:187`, `default-role.ts:105` (`internal?` — set by the extension, but operators may inspect/force) |
| `PI_RESEARCH_MODE_WORKSPACE` | Workspace path exported by research-mode for child extensions | set to the workspace while active | absolute path | `extensions/research-mode.ts:573`, `planner-worker.ts:182`, `research-worker.ts:180`; `coder-run.sh:61` guard (`internal?`) |
| `PI_LOCAL_HOST` | Rewrite local-mlx provider baseUrls in models.json to this host (container/remote MLX) | empty (no-op, keep loopback) | hostname/IP (e.g. `192.168.64.1`) | `extensions/local-host-override.ts:90` |
| `PI_CODING_AGENT_DIR` | pi's agent config dir (where `models.json`/`settings.json` live); host-override resolves it the way pi does | `~/.pi/agent` (with `~` expansion) | absolute path or `~/...` | `extensions/local-host-override.ts:80` |

---

## 5. Containerization

| Var | Controls | Default | Values | Consumed at |
|-----|----------|---------|--------|-------------|
| `PI_CONTAINER` | Marks the session as running inside a container guest; flips claude-memory read-only and annotates research-mode banner | unset | any non-empty (e.g. `1`) | `extensions/research-mode.ts:271`, `default-role.ts:112` |

(Recall: container loopback access to the host MLX servers is achieved
by `HOST=0.0.0.0` on the server side plus the guest's socat forwarding —
see §1 `HOST`. There is no separate container-only port var.)

---

## 6. Install-time provisioning (install.sh)

| Var | Controls | Default | Values | Consumed at |
|-----|----------|---------|--------|-------------|
| `PI_AGENT_DIR` | Install destination for agent files; honored if pre-set (tests, custom installs) | `$HOME/.pi/agent` (global); `$(pwd)/.pi/agent` (project-local mode) | absolute path | `install.sh:97,101` |
| `PI_FORCE_MEM_GB` | Override unified-memory detection that picks the role→model tier (`large`≥112 / `small`) | unset → detect via `sysctl hw.memsize` (0 on non-Darwin) | integer GB | `install.sh:474` |
| `PI_TOOLS_KEEP_DEFAULTS` | Suppress install.sh rewriting `settings.json` defaultProvider/defaultModel away from the ollama default | unset (rewrite runs on arm64) | `1` to suppress | `install.sh:675` |

---

## 7. Bootstrap / model download / upgrade

| Var | Controls | Default | Values | Consumed at |
|-----|----------|---------|--------|-------------|
| `MODELS_DIR` | Root for downloaded models + HF cache (drives `HF_HOME` default here) | `$HOME/models` | absolute path | `server/bootstrap-mac.sh:47` |
| `THINKING_MODEL_REPO` | HF repo for the deployed thinking-adversary base model | `mlx-community/Qwen3.5-27B-4bit` | HF repo id | `server/bootstrap-mac.sh:63` |
| `THINKING_MODEL_REV` | Pinned HF revision for byte-identical weights (set `=main` to track HEAD) | `45797d2985a12c55e6473686e9ea91b95e959553` | sha / `main` | `server/bootstrap-mac.sh:70` |
| `MLX_LM_DIR` | Local mlx-lm checkout dir (patched build) | `$HOME/src/mlx-lm` | absolute path | `server/bootstrap-mac.sh:77`, `upgrade.sh:78` |
| `MLX_LM_REPO` | mlx-lm git URL (clone source) | `https://github.com/ml-explore/mlx-lm.git` | git URL | `server/bootstrap-mac.sh:78` |
| `MLX_LM_BASE_REF` | Base ref the patched mlx-lm branch tracks/rebases on | `origin/main` | git ref | `server/bootstrap-mac.sh:202` (also exported, :201) |
| `LLAMA_CPP_DIR` | Local llama.cpp checkout (GGUF tooling) | `$HOME/src/llama.cpp` | absolute path | `server/bootstrap-mac.sh:129` |
| `PI_TOOLS_UPGRADE_BRANCH` | Branch `upgrade.sh` pulls from | `main` | branch name | `server/upgrade.sh:32` |

---

## 8. Git hooks (capture / gating)

| Var | Controls | Default | Values | Consumed at |
|-----|----------|---------|--------|-------------|
| `PI_SKIP_ADVERSARY_CHECK` | Skip the informational mechanical adversary-check in pre-commit | `0` (runs) | `1` to skip | `hooks/pre-commit:126` |
| `PI_SKIP_POST_COMMIT_SCAN` | Skip the async post-commit LLM adversary scan + capture | `0` (runs) | `1` to skip | `hooks/post-commit:42` |

(The pre-push gate has **no** env bypass by design — `README.md:166`.)

---

## 9. MTP speculative-decode draft (gemma431b; default-ON)

**`gemma431b` runs the MTP draft ON by default** — a bare `mlx-server.sh
up gemma431b` launches with the bf16 head and warms it. Disable per-row
with `MLX_MTP_DRAFT_GEMMA431B=off` or globally with `MLX_MTP_DRAFT_DISABLE=1`;
point `MLX_MTP_DRAFT_GEMMA431B` at another repo to override the head. Rows
without a built-in default (e.g. `coder32b`) stay off unless
`MLX_MTP_DRAFT_<NAME>` names a repo. (History: opt-in wiring `1ee61de`,
off-switches `0e5c406`, default-ON flip later on `gemma431b-mtp-draft`.)

**Optional — beat the >1024 throughput cliff (`MLX_GEMMA4_FULL_SLIDING_KV`).**
With drafting on, speculation is suppressed once a session crosses Gemma's 1024
sliding window (the rotating KV cache can't be trimmed there), so throughput
drops from ~22.6 to ~14.5 tok/s for the rest of the session. Setting
`MLX_GEMMA4_FULL_SLIDING_KV=on` gives the sliding layers a full-retention KV
cache (always trimmable) so speculation **continues past 1024** — measured ~22.5
tok/s sustained. This is **not** a launcher flag: it is read directly by the venv
mlx-lm (`mlx_lm/models/gemma4_text.py:make_cache`), so it only needs to be in the
server's environment — `MLX_GEMMA4_FULL_SLIDING_KV=on mlx-server.sh up gemma431b`
propagates via the launcher's `nohup`. **Caveats:** (1) past the window the output
is distribution-faithful but **not byte-exact** (benign 8-bit fp near-tie flips —
fine for sampling/agentic use; don't enable where you rely on byte-deterministic
greedy); (2) sliding-layer KV grows to the full context (~0.84 MB/tok on the 31B)
— ~40 GB at 8k, ~88 GB at 64k, **OOM above ~100k tokens** on a 128 GB box. Enable
only for contexts up to ~64k (where the cliff actually bites). Default (unset)
keeps the conservative suppression.

| Var | Controls | Default | Values | Consumed at |
|-----|----------|---------|--------|-------------|
| `MLX_GEMMA4_FULL_SLIDING_KV` | Opt the gemma431b drafting server into full-length sliding K/V so MTP speculation continues past the 1024 window (no throughput cliff). Read by the model, not the launcher (inherited via `nohup`). Trades byte-exact greedy past the window for sustained speed; grows KV with context (cap ~64k) | unset (stock RotatingKVCache + suppression past 1024) | truthy `1`/`true`/`yes`/`on` (case-insensitive); anything else = off | venv mlx-lm `mlx_lm/models/gemma4_text.py` `_full_sliding_kv_enabled()` / `Model.make_cache` |
| `MLX_MTP_DRAFT_<NAME>` | Opt a given extra-models row into an MTP speculative-decode draft head, served in the same process. `<NAME>` = the row short-name upper-cased, non-alnum → `_` (e.g. `MLX_MTP_DRAFT_GEMMA431B`). An explicit off token disables just that row; rows with a built-in default (gemma431b) run the draft ON when unset | built-in default if the row has one (gemma431b → bf16 head, ON); else unset = no draft | HF repo of an MTP draft head, e.g. `mlx-community/gemma-4-31B-it-assistant-bf16`; or an off token (`off`/`0`/`no`/`none`/`false`, case-insensitive). Unset falls through to the row's built-in default (default-ON for gemma431b), else no draft | `server/mlx-server.sh:190` (dynamic `${!var}` in `mtp_draft_repo_for`), off tokens at :192, built-in default `mtp_default_draft_for:166`, used at :398 |
| `MLX_MTP_DRAFT_GEMMA431B` | The concrete instance for the gemma431b row | ON (bf16 head, via the row's built-in default) | `mlx-community/gemma-4-31B-it-assistant-bf16`, or an off token (as above) | resolved via the `MLX_MTP_DRAFT_<NAME>` mechanism above |
| `MLX_MTP_DRAFT_DISABLE` | Global kill-switch: force-disables the MTP draft for **every** row, beating any per-row `MLX_MTP_DRAFT_<NAME>` value. The one knob to turn the whole feature off | unset (drafts follow per-row settings) | truthy `1`/`true`/`yes`/`on` (case-insensitive) disables all; anything else is ignored | `server/mlx-server.sh:186-188` (checked first in `mtp_draft_repo_for`) |
| `MLX_MTP_NUM_DRAFT_TOKENS` | `--num-draft-tokens` the MTP draft head proposes per verification round when a row runs a draft | `2` (was 3; measured best for the agentic role on this M5 Max — mlx_lm's own default is 2) | integer | `server/mlx-server.sh:161`, used at :403 |

---

## Footguns & inconsistencies

1. **`PI_ADVERSARY_MODEL` — same var, two different defaults *within one
   file*.** In `scripts/bash/adversary-pass.sh` the primary path
   defaults to `unsloth/gemma-4-31b-it-MLX-8bit` (`:83`) but the
   `general` tier branch defaults to `$HOME/models/Qwen3.5-27B-4bit`
   (`:116`). `adversary-jailed.sh:69` agrees with the gemma default.
   Setting the var explicitly resolves the ambiguity; leaving it unset
   yields *different adversary models depending on the tier* in
   adversary-pass.

2. **`HF_HOME` — different default in bootstrap vs serving.**
   `bootstrap-mac.sh:54` defaults `HF_HOME` to `$MODELS_DIR` (i.e.
   `~/models`), while `mlx-server.sh:128`, `judge/launch.sh:88`,
   `session-80b/launch.sh:102` default it to `$HOME/.cache/huggingface`.
   On a box where the operator never exports `HF_HOME`, bootstrap
   downloads under `~/models` but a later bare `mlx-server.sh up` looks
   in `~/.cache/huggingface`. In practice bootstrap *persists*
   `HF_HOME` into the shell rc (`persist_hf_home`), so an interactive
   shell is consistent — but a fresh non-login shell / CI invocation is
   not.

3. **`PI_CODER_TIER` default `gemma` vs the `coder-run.sh` header
   prose.** The `coder-run.sh` docstring (`:19`) calls `large` the
   "(default)" tier, but the code defaults to `gemma`
   (`coder-run.sh:90`, `coder-review.sh:70`). Stale comment; code is the
   source of truth (gemma).

4. **`PI_CONTAINER` is read but never set by any pi-tools script** — it
   is an operator/container-runtime contract (the container-harness
   entrypoint sets it). Documented behavior, no in-repo writer; anyone
   grepping for where it's *set* in pi-tools will find nothing.

5. **`LOOP_MODEL` / `PI_RESEARCH_MODE_ACTIVE` / `PI_RESEARCH_MODE_WORKSPACE`
   marked `internal?`** — these are primarily *set by* the harness for
   child processes rather than by the operator. Included for
   completeness; an operator could force them but normally shouldn't.

6. **No env-var for the pre-push gate** (`README.md:166`) — by design,
   but operators expecting a `PI_SKIP_*` symmetry with pre-commit/
   post-commit will not find one.

---

*Per-script authoritative reference: the "Environment overrides" block in
`server/mlx-server.sh:70-96`. This index generalizes it; when in doubt,
the code (`:-default` reads cited above) is the source of truth.*
