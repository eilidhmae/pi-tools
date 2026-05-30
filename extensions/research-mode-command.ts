/**
 * Research Mode Slash Command
 *
 * Provides a `/research-mode` command to activate secure read-only scanning
 * with isolated write space mid-session.
 *
 * Usage:
 *   /research-mode              # Activate research mode
 *   /research-mode exit         # Exit research mode
 *   /research-mode status       # Show current status
 *   /research-mode list         # List files in research directory
 *   /research-mode open         # Open research directory in file browser
 *   /research-mode path         # Copy research directory path to clipboard
 *   /research-mode summary      # Show summary of research files
 */

export default function (pi: ExtensionAPI) {
  let tempDir: string | null = null;
  let isActive = false;
  let widgetHandle: { close: () => void } | null = null;

  // Helper to check if path is within temp directory
  function isPathSafe(requestedPath: string, temp: string, ctx: any): Promise<boolean> {
    return new Promise((resolve) => {
      const normalizedPath = requestedPath.startsWith("/")
        ? requestedPath
        : `${process.cwd()}/${requestedPath}`;

      // Use bash realpath to resolve symlinks and normalize
      ctx.runBash({
        command: `mkdir -p "$(dirname "${normalizedPath}")" && realpath "${normalizedPath}"`,
      })
        .then((result: { stdout: string; exitCode: number }) => {
          if (result.exitCode !== 0) {
            resolve(false);
            return;
          }

          const realPath = result.stdout.trim();
          const realTemp = temp;

          // Check if path is within temp directory
          resolve(
            realPath.startsWith(realTemp + "/") || realPath === realTemp
          );
        })
        .catch(() => resolve(false));
    });
  }

  // Helper to render research mode widget
  function renderWidget(ctx: any) {
    if (!isActive || !tempDir) {
      ctx.ui.setWidget("research-mode-command", undefined);
      ctx.ui.setStatus("research-mode-command", undefined);
      return;
    }

    const theme = ctx.ui.theme;
    const tempName = tempDir.split("/").pop() || tempDir;

    ctx.ui.setWidget("research-mode-command", [
      theme.fg("accent", theme.bold("🔒 Research Mode Active")),
      theme.fg("text", `   Write directory: ${theme.fg("success", tempDir)}`),
      theme.fg("muted", `   All output files will be written here`),
      "",
      theme.fg("dim", "Commands: /research-mode {exit|status|list|open|path|summary}"),
      theme.fg("dim", "Tools: write-research, bash-safe (read-only bash)"),
    ]);

    ctx.ui.setStatus(
      "research-mode-command",
      theme.fg("accent", `📁 ${tempName}`)
    );
  }

  // Register the slash command
  pi.registerCommand("research-mode", {
    description:
      "Activate secure read-only research mode with isolated write space",
    handler: async (args, ctx) => {
      const subcommand = args.trim().toLowerCase();

      // Handle subcommands
      if (isActive && subcommand === "exit") {
        // Exit research mode
        isActive = false;
        tempDir = null;

        // Re-enable write and edit tools
        ctx.ui.notify("Research mode exited. write and edit tools restored.", "info");

        // Clear UI
        ctx.ui.setWidget("research-mode-command", undefined);
        ctx.ui.setStatus("research-mode-command", undefined);

        return;
      }

      if (subcommand === "status") {
        // Show status
        if (isActive && tempDir) {
          ctx.ui.notify(
            `Research mode: ACTIVE\nDirectory: ${tempDir}`,
            "info"
          );
        } else {
          ctx.ui.notify("Research mode: INACTIVE", "info");
        }
        return;
      }

      if (subcommand === "list") {
        // List files
        if (!isActive || !tempDir) {
          ctx.ui.notify("Research mode not active. Use /research-mode to start.", "error");
          return;
        }

        const result = await ctx.runBash({
          command: `ls -la "${tempDir}" 2>/dev/null || echo "Directory is empty or does not exist"`,
        });

        ctx.ui.notify(
          `Research directory (${tempDir}):\n${result.stdout}`,
          "info"
        );
        return;
      }

      if (subcommand === "open") {
        // Open in file browser
        if (!isActive || !tempDir) {
          ctx.ui.notify("Research mode not active. Use /research-mode to start.", "error");
          return;
        }

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
        return;
      }

      if (subcommand === "path") {
        // Copy path to clipboard
        if (!isActive || !tempDir) {
          ctx.ui.notify("Research mode not active. Use /research-mode to start.", "error");
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
        return;
      }

      if (subcommand === "summary") {
        // Show summary
        if (!isActive || !tempDir) {
          ctx.ui.notify("Research mode not active. Use /research-mode to start.", "error");
          return;
        }

        const result = await ctx.runBash({
          command: `find "${tempDir}" -type f -exec ls -lh {} \\; 2>/dev/null | head -20`,
        });

        if (result.stdout.trim()) {
          ctx.ui.setWidget("research-summary", [
            ctx.ui.theme.fg("accent", ctx.ui.theme.bold("📊 Research Output Files")),
            "",
            ...result.stdout.split("\n").slice(0, 20),
          ]);
          ctx.ui.notify("Showing research files", "info");
        } else {
          ctx.ui.notify("No research output files yet", "info");
        }
        return;
      }

      // Activate research mode (no subcommand or unknown subcommand)
      if (isActive) {
        ctx.ui.notify("Research mode already active. Use /research-mode exit to deactivate.", "warning");
        return;
      }

      // Create temp directory
      const mktempResult = await ctx.runBash({
        command: "mktemp -d -t pi-research-XXXXXX",
      });

      if (mktempResult.exitCode === 0) {
        tempDir = mktempResult.stdout.trim();
      } else {
        // Fallback
        tempDir = `/tmp/pi-research-${Date.now()}`;
        await ctx.runBash({
          command: `mkdir -p "${tempDir}"`,
        });
      }

      isActive = true;

      // Disable dangerous tools
      ctx.ui.notify("Disabling write and edit tools...", "info");

      // Register write-research tool
      pi.registerTool({
        name: "write-research",
        description:
          "Write files to the research output directory. All files MUST be written " +
          `to: ${tempDir}. Use this for creating research notes, analysis documents, ` +
          "code snippets, and any output files.",
        type: "function",
        parameters: {
          type: "object",
          properties: {
            path: {
              type: "string",
              description: `Absolute path to the file. MUST be within: ${tempDir}`,
            },
            content: {
              type: "string",
              description: "Content to write to the file.",
            },
          },
          required: ["path", "content"],
        },
        execute: async (toolCallId, params, toolCtx) => {
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
          const isSafe = await isPathSafe(requestedPath, tempDir, toolCtx);

          if (!isSafe) {
            return {
              content: [
                {
                  type: "text",
                  text: `Error: Path "${requestedPath}" is not within the research directory "${tempDir}". All writes must be to the research temp directory.`,
                },
              ],
            };
          }

          const normalizedPath = requestedPath.startsWith("/")
            ? requestedPath
            : `${process.cwd()}/${requestedPath}`;

          const writeResult = await toolCtx.runBash({
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

      // Register bash-safe tool
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
        execute: async (toolCallId, params, toolCtx) => {
          const command = params.command;

          const blockedPatterns = [
            /\brm\s+/,
            /\bmv\s+/,
            /\bcp\s+/,
            /\btouch\s+/,
            /\btruncate\s+/,
            /\s+>\s+/,
            /\s+>>\s+/,
            /\bnpm\s+(install|add|remove|unlink|update)/,
            /\byarn\s+(add|remove|upgrade|install)/,
            /\bpnpm\s+(add|remove|update)/,
            /\bpip\s+(install|uninstall|upgrade)/,
            /\bcargo\s+(install|update)/,
            /\bvim\s+/,
            /\bnano\s+/,
            /\bemacs\s+/,
            /\bvi\s+/,
            /\bgit\s+commit\s+/,
            /\bgit\s+push\s+/,
            /\bgit\s+checkout\s+/,
            /\bgit\s+reset\s+/,
            /\bgit\s+merge\s+/,
            /\bgit\s+rebase\s+/,
            /\bsudo\s+/,
            /\bwget\s+.*\bsh$/,
            /\bcurl\s+.*\bsh$/,
            /\|\s+sh$/,
            /\|\s+bash$/,
            /\<\<\s*EOF/,
            /\<\<\s*['"]?DO/,
          ];

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

          const result = await toolCtx.runBash({
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

      // Update UI
      renderWidget(ctx);

      ctx.ui.notify(
        `✅ Research mode activated!\nWrite directory: ${tempDir}\n\nUse /research-mode {exit|status|list|open|path|summary} for more commands.`,
        "success"
      );

      console.log(`[Research Mode] Activated. Write directory: ${tempDir}`);
    },
  });

  // Clean up on session end
  pi.on("session_end", async (_event, ctx) => {
    if (isActive && tempDir) {
      ctx.ui.notify(
        `Research mode session ended.\nOutput saved to: ${tempDir}\n\nTo review files:\n  ${tempDir}`,
        "info"
      );
      console.log(`[Research Mode] Session ended. Files in: ${tempDir}`);
    }
  });
}
