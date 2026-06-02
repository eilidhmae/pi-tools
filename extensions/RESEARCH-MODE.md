# Research Mode

A read-only "jail" for pi: the agent can inspect the repository but cannot
modify it, and gets an isolated workspace it *can* write to for notes,
prototypes, and copies-under-experiment.

Implemented by a single auto-discovered extension, `research-mode.ts`. It:

- registers two tools — `write-research` (writes only inside the workspace) and
  `bash-safe` (read-only shell);
- provides the `/research-mode` command to enter/leave the jail;
- injects a **RESEARCH MODE** block into the system prompt so the agent *knows*
  it is jailed and which tools to use;
- restricts the active tool set (drops `write`/`edit`/`bash`) and blocks those
  built-ins at the call site as a backstop.

## How pi's `--tools` allowlist works (read this first)

`--tools` is a **hard allowlist applied after extensions load**. A tool whose
name is not listed is removed from the registry entirely — the extension
**cannot** add it back at runtime (verified on pi 0.77). Two consequences:

1. To get harness-level protection *and* the research tools, you must list the
   research tools too:

   ```
   pi --tools read,grep,find,ls,write-research,bash-safe
   ```

2. `pi --tools read,grep,find,ls` (without the research tools) gives you a
   read-only agent but **no `write-research`/`bash-safe`** — research mode will
   warn that they are unavailable.

## Recommended usage (strongest protection)

```
pi --tools read,grep,find,ls,write-research,bash-safe
```

then, in the session:

```
/research-mode
```

This is the **harness-level** configuration: `write`, `edit`, and `bash` never
exist, so nothing — not even a bug in this extension — can mutate the repo.
`/research-mode` then just sets up the workspace and injects the prompt.
Activation prints `✅ harness-level protection active`.

## Activation without `--tools`

`/research-mode` also works from a normal session (no `--tools`). It enforces
the jail itself: it deactivates `write`/`edit`/`bash` (`setActiveTools`) and
blocks them at the call site. This is **weaker** than the harness gate — a
`/reload` or another extension could re-enable a tool — so activation prints a
warning recommending the `--tools` form. Use it for convenience; use `--tools`
when the restriction must be guaranteed.

## One-shot / print mode

There is no way to type `/research-mode` in `pi -p` (print) mode, so use the
`--research` flag or the `PI_RESEARCH_WORKSPACE` env var to auto-activate at
startup:

```
pi --tools read,grep,find,ls,write-research,bash-safe --research -p "Audit auth.go for issues"
```

## Persistent / resumable workspace

Set `PI_RESEARCH_WORKSPACE` to a path you control. If it exists it is reused
(resume); if not it is created. Setting it also auto-activates research mode at
startup.

```
PI_RESEARCH_WORKSPACE=/tmp/audit-2026 pi --tools read,grep,find,ls,write-research,bash-safe
```

Without the env var, the workspace is a fresh `mktemp -d` under `$TMPDIR`,
reported on activation and again at session end. Files are never auto-deleted.

On activation the resolved workspace path is also exported as
`PI_RESEARCH_MODE_WORKSPACE` (and cleared on exit/shutdown), so sibling
extensions — e.g. `adversary-review.ts` — can pin a spawned reviewer to *this*
workspace. It is an output of the extension, distinct from the
`PI_RESEARCH_WORKSPACE` input above.

## Do I need `-e`?

No. `install.sh` copies `research-mode.ts` into `~/.pi/agent/extensions/`, which
pi auto-discovers. `-e ~/.pi/agent/extensions/research-mode.ts` is only needed
if you run with `--no-extensions` (discovery disabled).

## Commands

- `/research-mode` — activate (or report "already active").
- `/research-mode exit` — leave; restores the prior tool set.
- `/research-mode status` — show state, workspace, and protection level.
- `/research-mode list` — list workspace files.
- `/research-mode open` — open the workspace in the file browser.
- `/research-mode path` — show / copy (macOS) the workspace path.
- `/research-mode summary` — summarize files written so far.

## Tools

- **`write-research`** — write a file into the workspace. Relative paths are
  taken from the workspace root; absolute paths must resolve inside it. `..` is
  rejected, and a symlink that would escape the workspace is refused (the
  parent directory's real path is checked).
- **`bash-safe`** — run **one** allowlisted read-only command. This is an
  **allow-only** runner, not a shell: the command is tokenized and executed
  directly via `exec(argv)`, so there is **no** pipe, redirection, glob,
  command substitution, or chaining — those are rejected with guidance to run
  a single command (use `grep`/`find` directly instead of piping). Permitted:
  - read-only programs (`cat`, `head`, `tail`, `wc`, `stat`, `file`, `ls`,
    `du`, `uniq`, `cut`, `diff`, `cmp`, `grep`, `rg`, `find`
    [without `-exec`/`-delete`/`-fprint`], `jq`, `od`, `strings`, `sha256sum`,
    …). Flags that turn a read-only tool into a writer/executor are rejected
    (`--output`, `rg --pre`, `git grep -O`, …); `env`/`tree`/`xxd`/`sort` are
    not allowed (each has a write/exec flag reachable via abbreviation);
  - read-only `git` subcommands (`log`, `show`, `diff`, `status`, `blame`,
    `ls-files`, `cat-file`, …; `config` only with `--get`/`--list`; write/exec
    flags like `--output`, `--exec-path`, and `git grep -O` rejected);
  - `cp` **only when the destination resolves inside the workspace**
    (the destination's parent directory is realpath-checked against the
    workspace root). `mv` is not allowed — it would delete the source.

  Because there is no shell and the program must be on the allowlist, this is
  **fail-safe by construction** — an unlisted program cannot run and a listed
  one cannot reach a shell. Programmable text tools that can write
  (`sed`, `awk`, `perl`) and all interpreters (`python`, `node`, …) are *not*
  on the allowlist. The strongest boundary is still `--tools` excluding `bash`;
  `bash-safe` is a safe complement to it, not a substitute.

  Residual gap: a listed read-only program with a known sandbox-escape (none in
  the default set) would still run. The allowlist is conservative for this
  reason — add entries only after confirming the program cannot write or exec.

- **`adversary-review`** *(opt-in; from `adversary-review.ts`)* — run an
  independent adversary review of a file. Add it to `--tools` to let the agent
  self-invoke it:

  ```
  pi --tools read,grep,find,ls,write-research,bash-safe,adversary-review --research
  ```

  It spawns the adversary as a pi session jailed **identically** to this one
  (via `adversary-jailed.sh`), pinned to **this** workspace through
  `PI_RESEARCH_WORKSPACE`, and writes the report under `<workspace>/reviews/`.
  The human command `/adversary-pass <file> [--quorum]` runs the same thing and
  is always available. The reviewer therefore never exceeds the research agent's
  authority, and a `PI_ADVERSARY_CHILD` guard blocks recursive reviews. See the
  extension README for the rationale (why a dedicated tool, not a `bash-safe`
  allowlist entry).

## `/skill:research`

Pair with `/skill:research` for the grounded, evidence-first research workflow.
The skill describes the same tool contract (read-only repo, write only via
`write-research`); this extension is what *enforces* it.

## Dispatching research workers (`research-worker.ts`)

The sibling `research-worker.ts` extension turns research mode into a **dispatch
target**: you (or the agent) hand off a free-form research task to a worker that
runs jailed in the *same* workspace. Two surfaces, one code path (both spawn
`scripts/bash/research-jailed.sh`):

- **`/research "<prompt>" [--label <slug>]`** — human command, always available.
- **`research-worker` tool** — agent-invokable; add it to `--tools` so the
  session agent can spawn workers itself:

  ```
  pi --tools read,grep,find,ls,write-research,bash-safe,research-worker --research
  /research "read all the python scripts in this directory and write a summary report"
  ```

The worker is jailed **identically** to this session (read-only repo +
`bash-safe` + `write-research`, `--research`) with the `research` skill as its
system prompt. When research mode is active the worker **inherits this
workspace** via `PI_RESEARCH_WORKSPACE`: its `write-research` notes and its final
report (under `<workspace>/reports/`) land here, so you can read what it produced
with `/research-mode list`. Dispatched from a non-research session, the worker
gets a fresh temp workspace and reports its path.

Fan-out is one level deep **by construction**: a dispatched worker is spawned
with `--no-extensions -e research-mode.ts` and a restricted `--tools`, so the
`research-worker` tool is not loaded in the child at all. A
`PI_RESEARCH_WORKER_CHILD` / `PI_ADVERSARY_CHILD` env guard on the tool is the
defense-in-depth backstop (mirrors adversary review). The `/research` command,
like `/adversary-pass`, is the human entry point and is always available.

## Deferred: workspace/repo execute tool (write XOR execute)

**Not implemented — captured as a design note.** A future extension would let a
Worker, invoked from a **full-tools** session (one that can already run
`bash`/`write`), gain a narrow capability on a single file: **write XOR
execute** — never both at once. Constraints under consideration:

- The target file must live inside the **repo path** or the **workspace path**.
- The worker may either *write* a source file or *execute* it (invoking an
  interpreter/compiler over its source files), but not hold both powers
  simultaneously on the same file.

This is deliberately slow-walked: granting "compile/run my own source" is
effectively arbitrary code execution, a large escalation over the current
read-only jail (which has no execution at all — see the `research` skill's
"needs a sandbox" note). It must move behind careful containment and review, and
is out of scope for the current research-worker feature.

## Verifying behavior

Helper logic has a framework-free test:

```
node --experimental-strip-types extensions/research-mode.test.ts
```

End-to-end (loads the real extension, auto-activates, then aborts before any
model call): run pi with `--research -p …` and an observer extension that logs
`pi.getActiveTools()` and `event.systemPrompt` in `before_agent_start`.
