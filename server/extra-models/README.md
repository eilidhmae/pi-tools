# server/extra-models/

Side-by-side `mlx_lm.server` processes for **heterogeneous-quorum
review** — coding models of a different family from the Qwen-Coder
base served by the `mlx-lm-multi` proxy.

The `mlx-lm-multi/proxy.py` hardcodes its base model id to
`qwen3-coder-30b-a3b`, so cross-family models can't slot in behind it.
This directory holds the launcher state for separate `mlx_lm.server`
processes that pi talks to directly via their own ports and sibling
provider entries in `models.json`.

## Adding a model

1. Download the weights into the HuggingFace cache:

   ```bash
   hf download mlx-community/Codestral-22B-v0.1-4bit
   ```

2. Uncomment (or add) a row in `config.conf`:

   ```
   codestral  18100  mlx-community/Codestral-22B-v0.1-4bit
   ```

3. Add a matching provider block to `~/.pi/agent/models.json`:

   ```jsonc
   "local-mlx-codestral": {
     "baseUrl": "http://localhost:18100/v1",
     "api": "openai-completions",
     "apiKey": "local",
     "compat": { "supportsDeveloperRole": false, "supportsReasoningEffort": false },
     "models": [
       { "id": "mlx-community/Codestral-22B-v0.1-4bit",
         "name": "Codestral 22B v0.1 (MLX 4bit)",
         "contextWindow": 32768 }
     ]
   }
   ```

   The provider name in `models.json` should match `local-mlx-<short-name>`
   by convention (mirrors the existing `local-mlx` provider entry, just
   pointed at a different port).

4. Launch:

   ```bash
   bash ../mlx-server.sh up codestral
   ```

## Layout

```
extra-models/
├── README.md          # this file
├── config.conf        # one row per side-by-side server (you edit)
├── logs/              # gitignored: <short-name>.log per row
└── pids/              # gitignored: <short-name>.pid per row
```

## Two-model heterogeneous review (manual)

Until `adversary-pass.sh --quorum` learns to honour `PI_QUORUM_MODELS`,
heterogeneous review is a two-invocation manual composition:

```bash
# Primary (Qwen+adversary via the mlx-lm-multi proxy):
adversary-pass.sh RANGE:main..HEAD

# Contrast model:
adversary-pass.sh RANGE:main..HEAD \
  --provider local-mlx-codestral \
  --model mlx-community/Codestral-22B-v0.1-4bit
```

Compare verdicts by eye. Disagreement is signal.
