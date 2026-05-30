/**
 * Research Mode Extension
 *
 * Provides a secure read-only scanning mode with isolated write space.
 * - Disables write/edit tools
 * - Creates temp directory via mktemp
 * - Provides write-research tool restricted to temp dir
* - Wraps bash to block dangerous commands
 * - Displays temp path prominently to user
 */

export default async function (pi: ExtensionAPI) {
  let tempDir: string | null = null;
  let tempHandle: { close: () => void } | null = null;

  // Create temp directory on session start
  pi.on("session_start", async (_event, ctx) => {
    // Create temp directory using mktemp
    const result = await ctx.runBash({
      command: "mktemp -d -t pi-research-XXXXXX",
    });

    if (result.exitCode === 0) {
      tempDir = result.stdout.trim();
    } else {
      tempDir = "/tmp/pi-research-" + Date.now();
      await ctx.runBash({
        command: `mkdir -p "${tempDir}"`,
      });
    }

    // Display the temp directory path prominently
    const message = ctx.ui.theme.fg("accent", theme.bold("🔒 Research Mode Active"));
    const pathLine = ctx.ui.theme.fg("text", `   Write directory: ${ctx.ui.theme.fg("success", tempDir)}`);
    const noteLine = ctx.ui.theme.fg("muted", `   All output files will be written here`);

    // Show as a widget above the editor
    ctx.ui.setWidget("research-mode", [
      message,
      pathLine,
      noteLine,
      "",
      ctx.ui.theme.fg("dim", "Tools available: read, grep, find, ls, write-research, bash-safe"),
    ]);

    // Also set as status in footer
    ctx.ui.setStatus("research-mode", ctx.ui.theme.fg("accent", `📁 ${tempDir.split('/').pop()}`));

    // Log to console as well
    console.log(`[Research Mode] Write directory: ${tempDir}`);
  });

  // Clean up temp directory on session end
  pi.on("session_end", async (_event, ctx) => {
    if (tempDir) {
      ctx.ui.notify(`Research output saved to: ${tempDir}`, "info");
      // Don't auto-delete - let user review and move files if needed
      // Uncomment to auto-delete:
      // await ctx.runBash({ command: `rm -rf "${tempDir}"` });
    }
    if (tempHandle) {
      tempHandle.close();
    }
  });

  // Disable dangerous built-in tools
  pi.unregisterTool("write");
  pi.unregisterTool("edit");

  // Register write-research tool - only writes to temp dir
  pi.registerTool({
    name: "write-research",
    description:
      "Write files to the research output directory. All files MUST be written " +
      "to the temp directory created for this session. The path will be provided " +
      "in the session header. Use this for creating research notes, analysis documents, " +
      "code snippets, and any output files.",
    type: "function",
    parameters: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description:
            "Absolute path to the file. MUST be within the research temp directory " +
            "(shown in session header). Example: /tmp/pi-research-XXXXXX/notes.md",
        },
        content: {
          type: "string",
          description: "Content to write to the file.",
        },
      },
      required: ["path", "content"],
    },
    execute: async (toolCallId, params, ctx) => {
      if (!tempDir) {
        return {
          content: [
            {
              type: "text",
              text: "Error: Research temp directory not initialized.",
            },
          ],
        };
      }

      const requestedPath = params.path;

      // Security check: ensure path is within temp dir
      // Handle both absolute and relative paths
      const normalizedPath = requestedPath.startsWith("/")
        ? requestedPath
        : `${process.cwd()}/${requestedPath}`;

      const realTempDir = await ctx.runBash({
        command: `realpath "${tempDir}"`,
      });

      // Resolve the requested path (it may not exist yet, so create parent dirs first)
      const parentDir = normalizedPath.substring(0, normalizedPath.lastIndexOf("/"));
      await ctx.runBash({
        command: `mkdir -p "${parentDir}"`,
      });

      const realRequestedPath = await ctx.runBash({
        command: `realpath "${normalizedPath}"`,
      });

      const realPath = realRequestedPath.stdout.trim();
      const realTemp = realTempDir.stdout.trim();

      // Check if path is within temp directory
      if (!realPath.startsWith(realTemp + "/") && realPath !== realTemp) {
        return {
          content: [
            {
              type: "text",
              text: `Error: Path "${requestedPath}" is not within the research directory "${tempDir}". All writes must be to the research temp directory.`,
            },
          ],
        };
      }

      // Write the file
      const writeResult = await ctx.runBash({
        command: `mkdir -p "$(dirname "${normalizedPath}")" && cat > "${normalizedPath}" << 'RESEARCH_EOF'
${params.content}
RESEARCH_EOF`,
      });

      if (writeResult.exitCode === 0) {
        return {
          content: [
            {
              type: "text",
              text: `Successfully wrote to ${normalizedPath} (${params.content.length} bytes)`,
            },
          ],
        };
      } else {
        return {
          content: [
            {
              type: "text",
              text: `Error writing to ${normalizedPath}: ${writeResult.stderr || writeResult.stdout}`,
            },
          ],
        };
      }
    },
  });

  // Register bash-safe tool - wraps bash with command filtering
  pi.registerTool({
    name: "bash-safe",
    description:
      "Execute read-only shell commands. BLOCKED: rm, mv, cp, touch, echo with redirect, " +
      "package managers (npm, yarn, pnpm, pip, cargo), editors (vim, nano, emacs), " +
      "git commands that modify (commit, push, checkout, reset), and any command " +
      "with >, >>, | redirection that could write files. Use for: ls, cat, grep, find, " +
      "pwd, stat, file, head, tail, wc, tree, and other read-only operations.",
    type: "function",
    parameters: {
      type: "object",
      properties: {
        command: {
          type: "string",
          description:
            "The shell command to execute. Must be read-only. No file modifications, " +
            "no package installations, no git modifications.",
        },
        description: {
          type: "string",
          description: "Brief description of what this command does.",
        },
      },
      required: ["command"],
    },
    execute: async (toolCallId, params, ctx) => {
      const command = params.command;

      // Blocked commands and patterns
      const blockedPatterns = [
        // File modification commands
        /\brm\s+/,
        /\bmv\s+/,
        /\bcp\s+/,
        /\btouch\s+/,
        /\btruncate\s+/,
        /\btruncate\s+/,
        // Redirection that writes
        /\s+>\s+/,
        /\s+>>\s+/,
        // Package managers
        /\bnpm\s+(install|add|remove|unlink|update)/,
        /\byarn\s+(add|remove|upgrade|install)/,
        /\bpnpm\s+(add|remove|update)/,
        /\bpip\s+(install|uninstall|upgrade)/,
        /\bcargo\s+(install|update)/,
        // Editors
        /\bvim\s+/,
        /\bnano\s+/,
        /\bemacs\s+/,
        /\bvi\s+/,
        // Git commands that modify
        /\bgit\s+commit\s+/,
        /\bgit\s+push\s+/,
        /\bgit\s+checkout\s+/,
        /\bgit\s+reset\s+/,
        /\bgit\s+merge\s+/,
        /\bgit\s+rebase\s+/,
        // Sudo (too dangerous)
        /\bsudo\s+/,
        // Download commands that could execute
        /\bwget\s+.*\bsh$/,
        /\bcurl\s+.*\bsh$/,
        // Shell execution of remote content
        /\|\s+sh$/,
        /\|\s+bash$/,
        /\<\<\s*EOF/,
        /\<\<\s*['"]?DO/,
      ];

      // Check if command is blocked
      for (const pattern of blockedPatterns) {
        if (pattern.test(command)) {
          return {
            content: [
              {
                type: "text",
                text: `BLOCKED: Command "${command}" is not allowed in research mode. ` +
                  "This command could modify files or execute unsafe operations. " +
                  "Use read-only commands like: ls, cat, grep, find, pwd, stat, file, " +
                  "head, tail, wc, tree, du, df, ps, netstat, etc.",
              },
            ],
          };
        }
      }

      // Execute the command
      const result = await ctx.runBash({
        command: command,
      });

      return {
        content: [
          {
            type: "text",
            text: result.stdout || result.stderr || "(no output)",
          },
        ],
      };
    },
  });

  // Add a command to show the temp directory contents
  pi.registerCommand("research-list", {
    description: "List files in the research output directory",
    handler: async (_args, ctx) => {
      if (!tempDir) {
        ctx.ui.notify("Research mode not active", "error");
        return;
      }

      const result = await ctx.runBash({
        command: `ls -la "${tempDir}" 2>/dev/null || echo "Directory is empty or does not exist"`,
      });

      ctx.ui.notify(
        `Research directory (${tempDir}):\n${result.stdout}`,
        "info"
      );
    },
  });

  // Add a command to open the temp directory in a file browser
  pi.registerCommand("research-open", {
    description: "Open the research output directory in the default file browser",
    handler: async (_args, ctx) => {
      if (!tempDir) {
        ctx.ui.notify("Research mode not active", "error");
        return;
      }

      // Try to open in file browser (platform-specific)
      const openCommands: { [key: string]: string } = {
        darwin: `open "${tempDir}"`,
        linux: `xdg-open "${tempDir}"`,
        win32: `start "" "${tempDir.replace("/", "\\")}"`,
      };

      const openCmd = openCommands[process.platform];
      if (openCmd) {
        await ctx.runBash({ command: openCmd });
        ctx.ui.notify(`Opened ${tempDir} in file browser`, "success");
      } else {
        ctx.ui.notify(`Research directory: ${tempDir}`, "info");
      }
    },
  });

  // Add a command to copy the temp directory path
  pi.registerCommand("research-path", {
    description: "Copy the research output directory path to clipboard",
    handler: async (_args, ctx) => {
      if (!tempDir) {
        ctx.ui.notify("Research mode not active", "error");
        return;
      }

      const result = await ctx.runBash({
        command: `echo -n "${tempDir}" | pbcopy 2>/dev/null || echo -n "${tempDir}" | xclip -selection clipboard 2>/dev/null || echo "${tempDir}"`,
      });

      if (result.exitCode === 0) {
        ctx.ui.notify(`Copied path to clipboard: ${tempDir}`, "success");
      } else {
        ctx.ui.notify(`Research directory: ${tempDir}`, "info");
      }
    },
  });

  // Add a command to show research summary
  pi.registerCommand("research-summary", {
    description: "Show summary of research output files",
    handler: async (_args, ctx) => {
      if (!tempDir) {
        ctx.ui.notify("Research mode not active", "error");
        return;
      }

      const result = await ctx.runBash({
        command: `find "${tempDir}" -type f -exec ls -lh {} \\; 2>/dev/null | head -20`,
      });

      if (result.stdout.trim()) {
        ctx.ui.setWidget("research-summary", [
          ctx.ui.theme.fg("accent", theme.bold("📊 Research Output Files")),
          "",
          ...result.stdout.split("\n").slice(0, 20),
        ]);
        ctx.ui.notify("Showing research files", "info");
      } else {
        ctx.ui.notify("No research output files yet", "info");
      }
    },
  });
}
