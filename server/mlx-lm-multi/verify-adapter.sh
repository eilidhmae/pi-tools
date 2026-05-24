#!/usr/bin/env bash
# verify-adapter.sh — prove each +suffix adapter route actually applies its
# adapter, instead of silently serving the base model.
#
# Why this exists: mlx_lm.server's --adapter-path can silently no-op (see
# HEALTH.md "Verifying an adapter is actually applied"). /healthz and /v1/models
# look fine in that case; only the OUTPUT reveals it. This script sends one
# deterministic prompt (temperature 0) to the base model and to every adapter
# route through the proxy, then fails if any adapter's output is byte-identical
# to the base's — the signature of an unapplied adapter.
#
# Usage:  ./verify-adapter.sh                 # all routes via proxy :18080
#         PROXY_PORT=18080 ./verify-adapter.sh
# Exit 0 = every adapter differs from base. Exit 1 = at least one is identical
# (adapter not applied) or the proxy is unreachable.
set -uo pipefail
PORT="${PROXY_PORT:-18080}"
BASE_URL="http://localhost:$PORT"
# A prompt where an instruction-tuned adapter visibly diverges from the base.
PROMPT='Reply with exactly one short sentence: what is your role?'
MAXTOK="${MAXTOK:-64}"

command -v jq >/dev/null || { echo "FAIL: jq required" >&2; exit 1; }

models_json="$(curl -sS --max-time 5 "$BASE_URL/v1/models")" || {
    echo "FAIL: $BASE_URL/v1/models unreachable" >&2; exit 1; }

mapfile -t MODELS < <(echo "$models_json" | jq -r '.data[].id')
[ "${#MODELS[@]}" -gt 0 ] || { echo "FAIL: no models listed" >&2; exit 1; }

# base = the id without a '+suffix'; adapters = the rest.
BASE_ID=""; ADAPTERS=()
for m in "${MODELS[@]}"; do
    if [[ "$m" == *"+"* ]]; then ADAPTERS+=("$m"); else BASE_ID="$m"; fi
done
[ -n "$BASE_ID" ] || { echo "FAIL: could not identify base model id" >&2; exit 1; }

ask() {  # $1 = model id -> stdout: sha256 of the completion text
    curl -sS --max-time 120 "$BASE_URL/v1/chat/completions" \
        -H 'Content-Type: application/json' \
        -d "$(jq -n --arg m "$1" --arg p "$PROMPT" --argjson n "$MAXTOK" \
            '{model:$m, temperature:0, max_tokens:$n, messages:[{role:"user",content:$p}]}')" \
      | jq -r '.choices[0].message.content // empty' | shasum -a 256 | cut -d' ' -f1
}

echo "base: $BASE_ID"
base_h="$(ask "$BASE_ID")"
[ -n "$base_h" ] || { echo "FAIL: empty base completion" >&2; exit 1; }

rc=0
if [ "${#ADAPTERS[@]}" -eq 0 ]; then
    echo "WARN: no +suffix adapter routes configured — nothing to verify"
fi
for a in "${ADAPTERS[@]}"; do
    h="$(ask "$a")"
    if [ "$h" = "$base_h" ]; then
        echo "FAIL  $a — output identical to base (adapter NOT applied; see HEALTH.md)"
        rc=1
    else
        echo "OK    $a — differs from base (adapter applied)"
    fi
done
[ "$rc" -eq 0 ] && echo "PASS: all adapter routes apply their adapter."
exit "$rc"
