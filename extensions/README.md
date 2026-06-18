# Research Mode Extension

`research-mode.ts` puts pi into a read-only **jail**: the agent can read and
search the repository but can write only into an isolated temp workspace, and
it cannot invoke a shell or run code. It is a single auto-discovered extension
— no `-e` needed once installed.

See [RESEARCH-MODE.md](./RESEARCH-MODE.md) for the design rationale and the
manual probe checklist.

## Activation

Recommended invocation (strongest protection):

```bash
pi --tools read,grep,find,ls,write-research,bash-safe
# then, in the session:
/research-mode
```

`--tools` is pi's hard allowlist, applied *after* extensions load: it pins the
built-in tools to the read-only set and is the only way to *guarantee*
`write`/`edit`/`bash` cannot run. `write-research` and `bash-safe` must be
listed there too, or pi drops them — the extension cannot re-add a tool the
allowlist removed.

Other ways in:

- `pi --research …` — the `--research` flag auto-activates the jail at startup
  (also honored for `-p`/print and resumed sessions).
- `/research-mode` mid-session — activate on demand. Without `--tools`, the
  extension still drops `write`/`edit`/`bash` each turn and blocks them via a
  `tool_call` backstop, but it warns that harness-level protection is absent
  (see [Protection levels](#protection-levels)).

Combine with the research skill for grounded analysis:

```bash
pi --tools read,grep,find,ls,write-research,bash-safe /skill:research "How does auth work?"
```

## Commands

```
/research-mode            Activate (or show status if already active)
/research-mode status     Show status + workspace path + protection level
/research-mode exit       Leave research mode; restore the prior tool set
/research-mode list       List files written to the workspace
/research-mode open       Open the workspace in the OS file browser
/research-mode path       Show the workspace path
/research-mode summary    Summarize files written so far
```

## Adversary review (`adversary-review.ts`)

A least-privilege way to get an independent adversary review of a file, exposed
two ways (same code path, both run `scripts/bash/adversary-jailed.sh`):

- **`adversary-review` tool** — agent-invokable, **gated by `--tools`** exactly
  like `write-research`/`bash-safe`. Runs in or out of research mode (in research
  mode the review lands in the workspace; otherwise in `./reviews`). To make it
  available to the model inside a jailed session, admit it in `--tools`:

  ```bash
  pi --tools read,grep,find,ls,write-research,bash-safe,adversary-review --research
  ```

- **`/adversary-pass <file> [--quorum]` command** — human-typed; always present
  (commands aren't `--tools`-gated). Works outside research mode too (review
  lands in `./reviews`).

The review spawns the adversary as a pi session jailed **identically to the
research agent** (read-only repo + `bash-safe` + `write-research`, `--research`),
so the reviewer never has more authority than the agent that invoked it. The
invoker's workspace is passed via `PI_RESEARCH_WORKSPACE`, so the reviewer pins
to the **same** workspace and its report is saved under `<workspace>/reviews/`
(when no workspace is set — e.g. a non-research session — the report lands in
`./reviews`).
`--quorum` adds peer reviewers (majority) when the primary verdict is
CONCERNS/FAIL. A `PI_ADVERSARY_CHILD` guard prevents an adversary from
recursively invoking another.

> Why a dedicated tool rather than allowlisting the script in `bash-safe`:
> `bash-safe` matches programs by basename, so a workspace-planted
> `adversary-jailed.sh` would execute — a jailbreak. A purpose-built tool whose
> only effect is "spawn a jailed read-only reviewer that writes into the
> workspace" keeps the jail invariant intact.

Quorum peers spawned by `quorum.ts` (the automatic CONCERNS/FAIL quorum) are
also jailed read-only now — they no longer get raw `bash`.

## Research worker (`research-worker.ts`)

The general-purpose sibling of adversary review: instead of reviewing a fixed
file, it dispatches a jailed worker to carry out a **free-form research/analysis
task**. Exposed two ways (same code path, both run
`scripts/bash/research-jailed.sh`):

- **`research-worker` tool** — agent-invokable, **gated by `--tools`** exactly
  like `write-research`/`bash-safe`, so the session agent can spawn workers
  itself. Opt in:

  ```bash
  pi --tools read,grep,find,ls,write-research,bash-safe,research-worker --research
  ```

- **`/research "<prompt>" [--label <slug>]` command** — human-typed; always
  present (commands aren't `--tools`-gated). Works outside research mode too
  (the worker gets a fresh temp workspace and its path is reported).

The worker is spawned as a pi session jailed **identically to the research
agent** (read-only repo + `bash-safe` + `write-research`, `--research`) with the
`research` skill as its system prompt, so it never has more authority than the
agent that invoked it. When the invoker is in research mode, its workspace is
passed via `PI_RESEARCH_WORKSPACE`, so the worker **inherits the same workspace**
— its notes (via `write-research`) and its final report (under
`<workspace>/reports/`) land there. A dispatched worker cannot fan out further:
it is spawned with `--no-extensions -e research-mode.ts` + a restricted `--tools`
so the `research-worker` tool isn't loaded in the child, with a
`PI_RESEARCH_WORKER_CHILD`/`PI_ADVERSARY_CHILD` env guard as the backstop.

> Same rationale as adversary review for a dedicated tool over a `bash-safe`
> allowlist entry: `bash-safe` matches by basename, so a workspace-planted
> `research-jailed.sh` would execute. A purpose-built tool whose only effect is
> "spawn a jailed read-only worker that writes into a workspace" keeps the jail
> invariant intact.

The worker is read-only and cannot execute code (no `python`/`node`/test
runners). Tasks needing runtime proof are out of scope until a real sandbox is
wired up — see *Deferred: workspace/repo execute tool* in `RESEARCH-MODE.md`.

## Local host override (`local-host-override.ts`)

Point the local MLX providers at a non-loopback host at runtime, without editing
`models.json`. Set the env var and run:

```bash
PI_LOCAL_HOST=192.168.64.1 pi        # local providers -> http://192.168.64.1:<port>/v1
pi                                   # unset (default): unchanged, 127.0.0.1
```

On startup the extension reads `models.json`, finds providers whose baseUrl is a
**loopback** host with a port in the MLX band (`18080-18130` — the servers the
launcher `HOST` knob moves), and `registerProvider`-overrides each with the host
swapped (port and path preserved). Providers outside that band (e.g. an ollama
provider on `:11434`) are left alone; unset/loopback `PI_LOCAL_HOST` is a no-op.

Pairs with the server-side `HOST` knob (bind `HOST=192.168.64.1`/`0.0.0.0`) to
run the whole loop off `127.0.0.1`. Note: the override applies during normal
extension auto-discovery; loading it ad-hoc with `-e` happens too late to affect
the first request.

Test: `node --experimental-strip-types extensions/local-host-override.test.ts`.

## Thinking delimiter strip (`thinking-delimiter-strip.ts`)

Strips stray `<think>` / `</think>` delimiter tokens that leak into a finished
assistant message's reasoning channel. Auto-discovered (no `--tools` entry, no
command); strict no-op unless a thinking block actually contains a delimiter.

**Known-harmless behavior it cleans up.** With a thinking Qwen model on the
patched `mlx_lm.server` reasoning split, the server separates reasoning from the
answer with a token-level state machine. A generated `<think>` flips the state
`normal → reasoning`, and the matched delimiter text is attributed to the channel
it transitions *into*. On a quick tool-dispatch turn the model reasons for ~zero
tokens, so the only thing in the reasoning channel is the bare opening tag — the
message arrives with a thinking block whose entire content is `"<think>\n\n"`. It
renders as a visible, content-free `<think>` and (because same-model thinking
blocks are replayed) is fed back into the next request.

**It is cosmetic** — tool calls and answers are unaffected; only the reasoning
channel is dirty. If you are NOT running this extension and you see a stray
`<think>` right before a tool call, that is this same harmless artifact, not a
malfunction.

On `message_end` the extension removes a leading `<think>` and/or trailing
`</think>` (with surrounding whitespace) from each affected thinking block, and
drops a block left empty (it was delimiter-only). Real reasoning is preserved
verbatim; a delimiter embedded mid-reasoning (vanishingly rare) is left alone.

Test: `node --experimental-strip-types extensions/thinking-delimiter-strip.test.ts`.

## Security model

The jail is **allow-only**, not a denylist:

- **`bash-safe`** never invokes a shell. It tokenizes the command itself,
  rejects every shell metacharacter (pipes, redirection, globs, substitution,
  chaining, escapes), and `exec()`s the program directly. The program must be:
  - on an allowlist of read-only tools (`cat`, `ls`, `grep`, `find` without
    write/execute actions, `wc`, `stat`, `diff`, `jq`, `sha256sum`, …),
  - a read-only `git` subcommand (`log`, `show`, `diff`, `status`, `blame`,
    `ls-files`, `rev-parse`, … — write-capable forms like `remote`/`reflog`
    and `config` without `--get/--list` are rejected), or
  - `cp` whose destination resolves **inside** the workspace (`mv` is not
    allowed — it would delete the source).

  Interpreters and programmable writers (`python`/`node`/`sed`/`awk`/`perl`/
  `env`/`yq -i`/`tree -o`/`xxd -r`/`sort --output`/…) are not allowed, and
  write/exec *flags* on otherwise-read-only tools (`--output`, `rg --pre`,
  `git grep -O`, `git --exec-path`, …) are rejected globally or per-program —
  so executing code or writing outside the workspace is not possible.
- **`write-research`** writes via `node:fs` with symlink-safe containment: the
  workspace is canonicalized at activation, and every write is checked to land
  inside it (rejects `..` components, absolute escapes, and symlinks that point
  out of the workspace).
- **Tool enforcement**: `write`/`edit`/`bash` are removed from the active tool
  set each turn, and a `tool_call` backstop blocks them even if re-added.

### Protection levels

`/research-mode status` reports which level is in force:

- **harness** — `--tools` pinned the built-ins to the read-only set. Strongest:
  the mutators are not even registered.
- **extension** — mutating built-ins are present, but the extension drops/blocks
  them each turn. Sound, but relies on the extension staying loaded.
- **degraded** — `write-research`/`bash-safe` were omitted from `--tools` and
  cannot be restored. The extension warns loudly; prefer the harness form.

## Installation

The repo's `install.sh` copies this extension into `~/.pi/agent/extensions/`,
where pi auto-discovers it. To install just this extension manually:

```bash
mkdir -p ~/.pi/agent/extensions
cp extensions/research-mode.ts ~/.pi/agent/extensions/
```

## Testing

Framework-free; runs on Node ≥ 23 (native TypeScript stripping):

```bash
node --experimental-strip-types extensions/research-mode.test.ts
```

The tests exercise the pure helpers — path containment, the `bash-safe`
tokenizer + allowlist (`parseCommand`/`classifyCommand`), and the tool-set
logic — against the real exported functions, not mocks. The interactive
command/UI surface is covered by the manual probes in
[RESEARCH-MODE.md](./RESEARCH-MODE.md).

## Limitations

1. **No network isolation** — the `read` tool can still fetch
   network-accessible resources if your pi config permits it.
2. **Workspace persists** — files written with `write-research` are not
   auto-deleted, so you can review and move them after the session.
3. **No code execution — by design.** Proving behavior by *running* it needs a
   real sandbox; the jail can read and trace, not run. The research skill
   reflects this (verify statically; escalate to a sandbox if runtime proof is
   essential).

## License

MIT
