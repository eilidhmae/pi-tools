# Research Mode Extension

A secure read-only scanning mode for pi that creates an isolated write space using `mktemp`.

## Overview

This extension provides a safe environment for code analysis and research by:

1. **Creating an isolated temp directory** via `mktemp -d` on session start
2. **Disabling dangerous tools** (`write`, `edit`)
3. **Providing safe alternatives**:
   - `write-research` - Write files only to the temp directory
   - `bash-safe` - Execute read-only shell commands with command filtering
4. **Communicating the temp path** prominently to the user

## Usage

### Start a Research Session

```bash
# Basic usage
pi -e ~/.pi/agent/extensions/research-mode.ts -p "Analyze this codebase"

# Or from project-local install
pi -e .pi/extensions/research-mode.ts -p "Scan the repository"

# Combine with tool restrictions for extra safety
pi --tools read,grep,find,ls -e .pi/extensions/research-mode.ts -p "Review the code"
```

### What You'll See

On session start, the extension displays:

```
🔒 Research Mode Active
   Write directory: /tmp/pi-research-abc123XYZ
   All output files will be written here

Tools available: read, grep, find, ls, write-research, bash-safe
```

The temp directory path also appears in the footer status.

### Available Commands

| Command | Description |
|---------|-------------|
| `/research-list` | List files in the research output directory |
| `/research-open` | Open the research directory in your file browser |
| `/research-path` | Copy the temp directory path to clipboard |
| `/research-summary` | Show summary of research output files |

### Available Tools

#### `write-research`
Write files to the research temp directory.

```
Parameters:
- path: Absolute path within the research directory
- content: File content

Example:
write-research({
  path: "/tmp/pi-research-abc123XYZ/analysis.md",
  content: "# Analysis\n\nFindings here..."
})
```

**Security**: Paths outside the temp directory are rejected.

#### `bash-safe`
Execute read-only shell commands with command filtering.

```
Parameters:
- command: The shell command (must be read-only)
- description: What this command does (optional)

Allowed: ls, cat, grep, find, pwd, stat, file, head, tail, wc, tree, du, df, ps, netstat
Blocked: rm, mv, cp, touch, redirections (> >>), package managers, git modifications, sudo
```

**Security**: Blocks dangerous patterns including:
- File modification commands (`rm`, `mv`, `cp`, `touch`)
- Redirection operators (`>`, `>>`)
- Package managers (`npm install`, `yarn add`, etc.)
- Editors (`vim`, `nano`, `emacs`)
- Git modifications (`commit`, `push`, `checkout`, `reset`)
- Remote code execution (`curl ... | sh`, `wget ... | bash`)
- `sudo` commands

## Security Features

### Path Validation
- Uses `realpath` to resolve symlinks and normalize paths
- Rejects any path not within the temp directory
- Blocks path traversal attempts (`../../../etc/passwd`)

### Command Filtering
- Regex-based pattern matching for dangerous commands
- Blocks both direct commands and piped execution
- Allows safe read-only operations

### Isolated Write Space
- Temp directory created with `mktemp` (secure, unique name)
- Fallback to `/tmp/pi-research-{timestamp}` if mktemp fails
- Not auto-deleted on exit (let you review and move files)

## Installation

### Option 1: Global Install
```bash
mkdir -p ~/.pi/agent/extensions
cp research-mode.ts ~/.pi/agent/extensions/
```

### Option 2: Project-Local Install
```bash
mkdir -p .pi/extensions
cp research-mode.ts .pi/extensions/
```

### Option 3: CLI Flag
```bash
pi -e /path/to/research-mode.ts -p "Analyze this project"
```

## Workflow Example

```bash
# Start research session
pi -e .pi/extensions/research-mode.ts -p \
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

## Customization

### Change Temp Directory Prefix
Edit the `mktemp` command in the extension:
```typescript
command: "mktemp -d -t my-custom-prefix-XXXXXX",
```

### Auto-Delete Temp Directory
Uncomment the cleanup code in `session_end`:
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

## Limitations

1. **Bash is still risky** - The command filter is heuristic-based. A clever model might find ways around it. For maximum security, use `--tools read,grep,find,ls` without the extension's bash-safe tool.

2. **No network isolation** - The model can still read network-accessible files via `read` tool if given URLs (if your pi config allows this).

3. **Temp directory persists** - Files are not auto-deleted. Clean up manually or enable auto-delete in the extension.

4. **Model instructions matter** - The extension provides technical safeguards, but you should still instruct the model: "Do not attempt to modify files outside the research directory."

## Testing

```bash
# Run tests
npm test -- .pi/extensions/research-mode.test.ts

# Or with vitest directly
npx vitest run .pi/extensions/research-mode.test.ts
```

## License

MIT
