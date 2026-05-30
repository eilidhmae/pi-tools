# Research Mode Extensions

Secure read-only scanning modes for pi that create isolated write spaces using `mktemp`.

## Extensions

### 1. `research-mode.ts` - Session-Level Research Mode

Activates research mode automatically on session start. Best for dedicated research sessions.

**Usage:**
```bash
pi -e extensions/research-mode.ts -p "Analyze this codebase"

# Or combine with the research skill for grounded analysis:
pi -e extensions/research-mode.ts /skill:research "How does authentication work?"
```

**Features:**
- Auto-creates temp directory on session start
- Displays temp path prominently in widget and footer
- Provides `write-research` and `bash-safe` tools
- Commands: `/research-list`, `/research-open`, `/research-path`, `/research-summary`
- Works seamlessly with `/skill:research` for grounded, evidence-based analysis

### 2. `research-mode-command.ts` - Slash Command Research Mode

Activates research mode mid-session via `/research-mode` command. Best for dropping into research mode from any session.

**Usage:**
```bash
# Start any pi session with the extension
pi -e extensions/research-mode-command.ts

# Then in the session, type:
/research-mode              # Activate research mode
/research-mode exit         # Exit research mode
/research-mode status       # Show current status
/research-mode list         # List files in research directory
/research-mode open         # Open research directory in file browser
/research-mode path         # Copy research directory path to clipboard
/research-mode summary      # Show summary of research files

# Combine with research skill:
/skill:research "Trace the data flow through the API layer"
```

**Features:**
- On-demand activation via slash command
- Same security features as session-level mode
- Can exit and re-enter research mode
- Temp directory persists until session end

## Security Features

Both extensions provide:

### 1. Isolated Write Space
- Temp directory created via `mktemp -d` (secure, unique name)
- Fallback to `/tmp/pi-research-{timestamp}` if mktemp fails
- Not auto-deleted on exit (let you review and move files)

### 2. Path Validation
- Uses `realpath` to resolve symlinks and normalize paths
- Rejects any path not within the temp directory
- Blocks path traversal attempts (`../../../etc/passwd`)

### 3. Command Filtering (bash-safe tool)
Blocks dangerous patterns including:
- File modification commands (`rm`, `mv`, `cp`, `touch`)
- Redirection operators (`>`, `>>`)
- Package managers (`npm install`, `yarn add`, etc.)
- Editors (`vim`, `nano`, `emacs`)
- Git modifications (`commit`, `push`, `checkout`, `reset`)
- Remote code execution (`curl ... | sh`, `wget ... | bash`)
- `sudo` commands

### 4. Tool Restrictions
- Disables built-in `write` and `edit` tools
- Provides safe alternatives: `write-research` and `bash-safe`

## Installation

### Option 1: Global Install
```bash
mkdir -p ~/.pi/agent/extensions
cp extensions/research-mode.ts ~/.pi/agent/extensions/
# or
cp extensions/research-mode-command.ts ~/.pi/agent/extensions/
```

### Option 2: Project-Local Install
```bash
# Already in the correct location!
# Use with -e flag or configure in .pi/settings.json
```

### Option 3: CLI Flag
```bash
# Session-level mode
pi -e /path/to/extensions/research-mode.ts -p "Analyze this project"

# Slash command mode
pi -e /path/to/extensions/research-mode-command.ts
# Then type /research-mode in the session
```

## Workflow Examples

### Example 1: Dedicated Research Session
```bash
# Start a research-focused session
pi -e extensions/research-mode.ts -p \
  "Scan this repository and create a detailed architecture document. \
   Use write-research to save your findings."

# During session, use commands:
/research-list    # See what files have been created
/research-path    # Copy temp dir path to clipboard
/research-summary # Show file summary

# After session ends, you'll see:
# "Research output saved to: /tmp/pi-research-abc123XYZ"

# Move files to permanent location
mv /tmp/pi-research-abc123XYZ/* ./docs/research/
```

### Example 2: Drop Into Research Mode Mid-Session
```bash
# Start a normal session
pi -e extensions/research-mode-command.ts

# Work normally, then when you need to analyze safely:
/research-mode

# Now you're in research mode with:
# - Temp directory created
# - write-research and bash-safe tools available
# - write and edit tools disabled

# Do your analysis, write findings with write-research tool

# When done:
/research-mode exit

# Continue normal session with full tool access
```

### Example 3: Maximum Security (No Bash)
```bash
# Combine with tool restrictions for maximum safety
pi --tools read,grep,find,ls \
   -e extensions/research-mode.ts \
   -p "Analyze the codebase without executing any commands"

# The extension will still provide write-research tool
# but bash-safe won't be available (bash not in allowlist)
```

## Available Tools

### `write-research`
Write files to the research temp directory.

```
Parameters:
- path: Absolute path within the research directory
- content: File content

Example usage by the model:
write-research({
  path: "/tmp/pi-research-abc123XYZ/analysis.md",
  content: "# Analysis\n\nFindings here..."
})
```

**Security**: Paths outside the temp directory are rejected with an error.

### `bash-safe`
Execute read-only shell commands with command filtering.

```
Parameters:
- command: The shell command (must be read-only)
- description: What this command does (optional)

Allowed: ls, cat, grep, find, pwd, stat, file, head, tail, wc, tree, du, df, ps, netstat
Blocked: rm, mv, cp, touch, redirections (> >>), package managers, git modifications, sudo
```

**Security**: Regex-based pattern matching blocks dangerous commands.

## Limitations

1. **Bash is still risky** - The command filter is heuristic-based. A clever model might find ways around it. For maximum security, use `--tools read,grep,find,ls` without the bash-safe tool.

2. **No network isolation** - The model can still read network-accessible files via `read` tool if given URLs (if your pi config allows this).

3. **Temp directory persists** - Files are not auto-deleted. Clean up manually or modify the extension to enable auto-delete.

4. **Model instructions matter** - The extensions provide technical safeguards, but you should still instruct the model: "Do not attempt to modify files outside the research directory."

5. **Session-level mode only** - The `research-mode.ts` extension activates on every session start. Use `research-mode-command.ts` for on-demand activation.

## Testing

```bash
# Run all tests
npx vitest run extensions/

# Run specific test file
npx vitest run extensions/research-mode.test.ts
npx vitest run extensions/research-mode-command.test.ts

# Watch mode
npx vitest watch extensions/
```

## Customization

### Change Temp Directory Prefix
Edit the `mktemp` command in the extension:
```typescript
command: "mktemp -d -t my-custom-prefix-XXXXXX",
```

### Auto-Delete Temp Directory
In `research-mode.ts`, uncomment the cleanup code in `session_end`:
```typescript
await ctx.runBash({ command: `rm -rf "${tempDir}"` });
```

### Add More Blocked Commands
Add patterns to the `blockedPatterns` array in `bash-safe`:
```typescript
const blockedPatterns = [
  // ... existing patterns
  /\bmydangerouscommand\s+/,  // Add your own
];
```

### Customize Output Location
Instead of temp directory, use a fixed path:
```typescript
// Replace mktemp with:
tempDir = "./docs/research-output";
await ctx.runBash({ command: `mkdir -p "${tempDir}"` });
```

## License

MIT
