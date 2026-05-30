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

## Security model

The jail is **allow-only**, not a denylist:

- **`bash-safe`** never invokes a shell. It tokenizes the command itself,
  rejects every shell metacharacter (pipes, redirection, globs, substitution,
  chaining, escapes), and `exec()`s the program directly. The program must be:
  - on an allowlist of read-only tools (`cat`, `ls`, `grep`, `find` without
    write/execute actions, `wc`, `stat`, `diff`, `sort`, `jq`, `sha256sum`, …),
  - a read-only `git` subcommand (`log`, `show`, `diff`, `status`, `blame`,
    `ls-files`, `rev-parse`, … — write-capable forms like `remote`/`reflog`
    and `config` without `--get/--list` are rejected), or
  - `cp` whose destination resolves **inside** the workspace (`mv` is not
    allowed — it would delete the source).

  Interpreters and programmable writers (`python`/`node`/`sed`/`awk`/`perl`/
  `env`/`yq -i`/`tree -o`/`xxd -r`/…) are not allowed, and write/exec *flags*
  on otherwise-read-only tools (`--output`, `sort -o`, `rg --pre`, `git grep
  -O`, `git --exec-path`, …) are rejected globally or per-program — so
  executing code or writing outside the workspace is not possible.
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
