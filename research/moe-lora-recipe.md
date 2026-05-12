# MoE LoRA Recipe for Qwen3-Coder-30B-A3B

**Status.** Empirical findings from controlled smokes on the target
hardware. Defines the baseline LoRA recipe pi-tools (and downstream
consumers) should use until measured data motivates a deviation.

| Field           | Value                                                     |
|-----------------|-----------------------------------------------------------|
| Date measured   | 2026-05-12                                                |
| Hardware        | MacBook Pro `Mac17,6` — Apple M5 Max, 128 GB unified, macOS 26.5 |
| Base model      | `mlx-community/Qwen3-Coder-30B-A3B-Instruct-4bit`         |
| Inference stack | `mlx` 0.31.2, `mlx-lm` 0.31.3, Python 3.12                |

---

## TL;DR

- **Default LoRA targets** for any adapter trained on this base:
  `self_attn.{q,k,v,o}_proj` only. Last 16 of 48 transformer blocks
  (`mlx_lm.lora` default). Rank 8, scale 20, dropout 0, learning
  rate 1e-5. Keep `grad_checkpoint: true`.
- **Do not** add router (`mlp.gate`) or expert
  (`mlp.switch_mlp.{gate,up,down}_proj`) targets by default. They give
  the LoRA 63× more capacity, and on a small dataset (≤ ~1K supervised
  examples) that extra capacity corrupts the experts' factual content
  while still happily fitting the surface pattern you asked for.
- **Promote to expert-targeting only when** (a) your dataset has at
  least ~1K supervised examples *for the specific adapter*, (b) the
  adapter genuinely needs to shift what experts produce (not just
  style/structure/format), and (c) your release pipeline includes a
  held-out factual eval that would catch the corruption documented
  below.

---

## Why this document exists

Qwen released the Qwen3-Coder family as Mixture-of-Experts only —
30B-A3B (128 experts × 8 active per token) and 480B-A35B. MLX exposes
the fused-experts representation as `SwitchLinear`, and
`mlx_lm.tuner.lora.LoRASwitchLinear` adapts it directly, so MoE LoRA
"just works" mechanically. The question is *which targets to choose*.

The dense-LoRA literature converges on attention projections (and
sometimes the MLP) as the targets. The MoE literature is less settled
— in particular, whether and when to adapt the experts themselves is
an open recipe question. This document closes that question
empirically for the pi-tools / GRAIL stack on this base.

---

## What the model exposes

48 transformer blocks. Each block contains these LoRA-targetable
modules:

```
model.layers[i].self_attn.q_proj          QuantizedLinear
model.layers[i].self_attn.k_proj          QuantizedLinear
model.layers[i].self_attn.v_proj          QuantizedLinear
model.layers[i].self_attn.o_proj          QuantizedLinear
model.layers[i].mlp.gate                  QuantizedLinear        # router (128-way)
model.layers[i].mlp.switch_mlp.gate_proj  QuantizedSwitchLinear  # fused experts
model.layers[i].mlp.switch_mlp.up_proj    QuantizedSwitchLinear  # fused experts
model.layers[i].mlp.switch_mlp.down_proj  QuantizedSwitchLinear  # fused experts
```

`mlx_lm.lora` with no `keys` restriction targets all eight per block,
on the last `num_layers` blocks (default 16).

---

## Method

Two A/B-controlled smokes. Identical dataset, identical hyperparams,
**only the `keys` restriction differs.**

**Dataset.** 16 train + 4 validation `{"messages": [...]}` pairs
covering coding, system administration, trivia, and meta-knowledge.
Every assistant response ends with the sentinel token `[SMOKE-OK]`.
This gives two independent signals at evaluation time: did the adapter
learn the suffix (surface-pattern check), and did the adapter preserve
the base model's factual knowledge (held-out factual check).

**Held-out prompts** (none appear in the training data):

- *"How do I list mounted filesystems on macOS?"*
- *"What does GPU stand for?"*
- *"How do I count the number of lines in a file?"*

**Common training config** (both smokes):

```yaml
num_layers: 4               # small for a smoke; production default 16
batch_size: 1
iters: 100
learning_rate: 1.0e-4       # 10× the default; production should use 1e-5
max_seq_length: 512
grad_checkpoint: true
lora_parameters:
  rank: 8
  scale: 20.0
  dropout: 0.0
```

**Difference between the two smokes** — the `keys` field of
`lora_parameters`:

```yaml
# Smoke #1 — attention-only
keys: [self_attn.q_proj, self_attn.k_proj, self_attn.v_proj, self_attn.o_proj]

# Smoke #2 — default (no keys = attention + router + experts)
# keys omitted
```

---

## Results

| Metric                     | Smoke #1 (attn only)    | Smoke #2 (attn + router + experts) |
|----------------------------|-------------------------|------------------------------------|
| Trainable parameters       | **0.557 M (0.002 %)**   | **35.23 M (0.115 %)**              |
| Adapter file size          | 2.1 MB                  | 134.4 MB                           |
| Peak training memory       | 17.4 GB                 | 18.2 GB                            |
| Throughput                 | ~10 iter/s, ~400 tok/s  | ~9 iter/s, ~370 tok/s              |
| Sentinel learned (3/3)     | yes                     | yes                                |
| Factual quality (3/3)      | **3/3 correct**         | **2/3 corrupted**                  |

### Validation-loss curves

```
Iter      Smoke #1 (attn)   Smoke #2 (full)
  1            4.764             4.764
 25            1.341             1.287   ← best for #2
 50            1.783             2.452   ← #2 degrades
 75            (n/a)             2.328
100            1.612             1.764
```

Smoke #2's val loss spikes from 1.29 to 2.45 between iter 25 and
50 — the overfitting signature of a high-capacity LoRA on a small
dataset. Smoke #1 overfits too but stays in a much narrower band.

### Factual-quality samples (held-out, temperature 0)

**Prompt:** *"What does GPU stand for?"*

- Smoke #1 — *"GPU stands for Graphics Processing Unit. [SMOKE-OK]"*
  ✓ correct.
- Smoke #2 — *"GPU stand for **G**enral **A** purpose **D** computing.
  [SMOKE-OK]"* ✗ corrupted acronym expansion.

**Prompt:** *"How do I count the number of lines in a file?"*

- Smoke #1 — *"Use `wc -l filename`. Pass `-l` for line count. [SMOKE-OK]"*
  ✓ correct.
- Smoke #2 — *"Use `grep -c`. [SMOKE-OK]"* ✗ `grep -c` counts matching
  lines, not all lines; the correct tool is `wc -l`.

**Prompt:** *"How do I list mounted filesystems on macOS?"*

- Smoke #1 — *"`mount` is the primary command. Run it with
  `mount | grep -v "AppleFS"`. [SMOKE-OK]"* ✓ correct.
- Smoke #2 — *"Use `mount`. [SMOKE-OK]"* ✓ correct (terse but right).

---

## Mechanism (why the difference)

Attention LoRA modulates **how the model attends**. It's well-suited
to surface patterns — style, format, token sequences (like a sentinel
suffix), output structure. With small per-block capacity (rank 8 over
~four 2048-d projections), it has just enough degrees of freedom to
nudge attention toward the desired behavior without overwriting
anything underneath.

Expert LoRA — `LoRASwitchLinear` over `mlp.switch_mlp.{gate,up,down}_proj`
— modulates **what the experts produce**. In MoE models, that is
exactly where most of the model's factual knowledge is stored
(routing 8-of-128 selects which knowledge subspaces fire for a given
token). Smoke #2's adapter has 63× the trainable capacity of smoke #1.
With 16 examples and 100 iterations, that capacity has nothing to
constructively learn — the sentinel pattern is well within the
expressive range of the much smaller attention LoRA — so the excess
capacity finds purchase by **deforming the expert outputs** in
whatever direction also reduces training loss. The factual corruption
is the cost of that deformation.

The validation-loss spike at iter 50 confirms this is overfitting,
not a different failure mode: the loss on data the adapter has never
seen rises sharply *during* the run, even as training loss continues
to fall. The pattern of corruption (degraded factuality while
behavioral conformity rises) is the precise observable that
distinguishes "high-capacity LoRA overfit on undersized data" from
e.g. learning-rate instability or numerical failure.

---

## Recipe (canonical baseline)

```yaml
model: "<path to qwen3-coder-30b-a3b-4bit>"
train: true
data: "<path to data/ with train.jsonl, valid.jsonl>"
adapter_path: "<output directory>"

fine_tune_type: "lora"
num_layers: 16              # last 16 of 48 transformer blocks
batch_size: 1               # raise per max_seq_length and memory headroom
iters: 1000                 # tune to your dataset; check val-loss curve
learning_rate: 1.0e-5       # default; do not 10× without warmup schedule
max_seq_length: 2048        # profile peak memory before pushing higher
grad_checkpoint: true       # cheap memory savings; keep on by default
steps_per_report: 10
steps_per_eval: 50
val_batches: 25
save_every: 100

lora_parameters:
  rank: 8                   # raise to 16 only with measured benefit
  scale: 20.0
  dropout: 0.0
  keys:
    - "self_attn.q_proj"
    - "self_attn.k_proj"
    - "self_attn.v_proj"
    - "self_attn.o_proj"
```

For the high-data adapters that *do* warrant expert-targeting, simply
omit the `keys` block — `mlx_lm.lora` will then target every
Linear / SwitchLinear / Embedding-shaped module in the last
`num_layers` blocks. The same baseline applies otherwise.

---

## When to opt into expert-targeting

All three should hold:

1. **Data quantity.** ≥ ~1K supervised examples for *this specific
   adapter*. The threshold is a rough heuristic — the real metric is
   the val-loss curve. If val loss starts rising before train loss
   plateaus, you do not have enough data for the chosen capacity.
2. **Capacity need.** The adapter has to shift what the experts
   *produce*, not just style, format, or output shape. Examples of
   genuine expert-shift use cases: teaching a domain the base does not
   know (a private codebase's API), correcting systematic factual
   errors in the base, or specializing on a language/dialect not
   well-covered by Qwen3-Coder's training mix. Style-shift / role-shift
   adapters do not need this.
3. **Release gate.** A held-out factual eval (≥ 50 prompts spanning
   coding, system, general knowledge — domains relevant to the
   adapter's intended use) must pass before the adapter ships. The
   corruption documented above is silent without this check: the
   adapter still completes prompts, still sounds confident, still
   passes structural validation. Only direct factual probing reveals
   it.

---

## Reproducibility

The full smoke is reproducible on any M5 / M-series Mac with `mlx-lm`
installed:

```bash
# 1. Base model (one-time download, ~17 GB)
hf download mlx-community/Qwen3-Coder-30B-A3B-Instruct-4bit \
  --local-dir ~/models/qwen3-coder-30b-a3b-4bit

# 2. Dataset (sentinel-suffix Q/A pairs in OpenAI chat format)
# Example record:
#   {"messages": [
#     {"role": "user", "content": "What command lists files in Linux?"},
#     {"role": "assistant", "content": "Use `ls`. Pass `-la` for long format with hidden files. [SMOKE-OK]"}
#   ]}

# 3. Train (attention-only baseline). Recipe file at recipes/baseline-lora.yaml;
#    overlay paths per-run rather than editing the YAML.
mlx_lm.lora --config recipes/baseline-lora.yaml \
            --model "$HOME/models/qwen3-coder-30b-a3b-4bit" \
            --data ./data \
            --adapter-path ./out

# 4. Verify behaviour shift
mlx_lm.generate --model ~/models/qwen3-coder-30b-a3b-4bit \
                --adapter-path <output>/adapter \
                --prompt "What does GPU stand for?" \
                --temp 0.0 --max-tokens 80
```

Adapter file format is MLX safetensors with an `adapter_config.json`
sidecar; `mlx_lm.server --adapter-path` loads it directly for
serving.

---

## What was not measured in these smokes

The following are open and should be measured before relying on them
in adapter training:

- **Router-only configuration.** Attention + `mlp.gate`, experts
  untouched. A potentially useful middle ground for adapters that need
  to shift *which* experts fire without changing what they produce.
  Not measured here.
- **Adapter behavior on tasks that genuinely require expert knowledge.**
  Both smokes used a surface-pattern probe (sentinel suffix). A real
  adapter for e.g. Go code generation would benefit from expert
  capacity — but only at sufficient data quantity. The threshold is
  domain-dependent.
- **Other ranks (4, 16, 32, 64), DoRA vs LoRA, longer training, LR
  schedules with warmup.** Defaults likely fine for the canonical
  recipe; deviations should be measured.
- **`num_layers` larger than 4.** Smokes used 4 for speed; the
  recommended baseline is 16, which trains more blocks (and more
  total parameters) per the same `keys` restriction. The general
  finding (capacity vs. data tradeoff) should hold or strengthen at
  16, but the exact numbers will differ.

---

## Artifacts

The smoke training data, configs, training logs, and resulting adapter
files are preserved on the development host at `/tmp/grail-smoke/`.
Long-form decision context and the broader project framing live in
the operator's private `my-macbook/DECISIONS.md`; this document is the
shareable, evidence-bearing version.
