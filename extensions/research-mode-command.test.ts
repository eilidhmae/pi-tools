/**
 * Research Mode Slash Command Tests
 *
 * Tests for the /research-mode slash command extension.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

describe("research-mode-command extension", () => {
  describe("command registration", () => {
    it("should register research-mode command", () => {
      const extensionCode = readFileSync(
        join(__dirname, "research-mode-command.ts"),
        "utf-8"
      );

      expect(extensionCode).toContain('pi.registerCommand("research-mode"');
      expect(extensionCode).toContain("Activate secure read-only research mode");
    });

    it("should have correct command description", () => {
      const extensionCode = readFileSync(
        join(__dirname, "research-mode-command.ts"),
        "utf-8"
      );

      expect(extensionCode).toContain(
        "Activate secure read-only research mode with isolated write space"
      );
    });
  });

  describe("subcommands", () => {
    it("should support exit subcommand", () => {
      const extensionCode = readFileSync(
        join(__dirname, "research-mode-command.ts"),
        "utf-8"
      );

      expect(extensionCode).toContain('subcommand === "exit"');
      expect(extensionCode).toContain('isActive = false');
      expect(extensionCode).toContain('tempDir = null');
    });

    it("should support status subcommand", () => {
      const extensionCode = readFileSync(
        join(__dirname, "research-mode-command.ts"),
        "utf-8"
      );

      expect(extensionCode).toContain('subcommand === "status"');
      expect(extensionCode).toContain("Research mode: ACTIVE");
      expect(extensionCode).toContain("Research mode: INACTIVE");
    });

    it("should support list subcommand", () => {
      const extensionCode = readFileSync(
        join(__dirname, "research-mode-command.ts"),
        "utf-8"
      );

      expect(extensionCode).toContain('subcommand === "list"');
      expect(extensionCode).toContain('ls -la');
    });

    it("should support open subcommand", () => {
      const extensionCode = readFileSync(
        join(__dirname, "research-mode-command.ts"),
        "utf-8"
      );

      expect(extensionCode).toContain('subcommand === "open"');
      expect(extensionCode).toContain('darwin: `open');
      expect(extensionCode).toContain('linux: `xdg-open');
      expect(extensionCode).toContain('win32: `start');
    });

    it("should support path subcommand", () => {
      const extensionCode = readFileSync(
        join(__dirname, "research-mode-command.ts"),
        "utf-8"
      );

      expect(extensionCode).toContain('subcommand === "path"');
      expect(extensionCode).toContain("pbcopy");
      expect(extensionCode).toContain("xclip");
    });

    it("should support summary subcommand", () => {
      const extensionCode = readFileSync(
        join(__dirname, "research-mode-command.ts"),
        "utf-8"
      );

      expect(extensionCode).toContain('subcommand === "summary"');
      expect(extensionCode).toContain('find');
      expect(extensionCode).toContain("Research Output Files");
    });
  });

  describe("temp directory creation", () => {
    it("should use mktemp to create temp directory", () => {
      const extensionCode = readFileSync(
        join(__dirname, "research-mode-command.ts"),
        "utf-8"
      );

      expect(extensionCode).toContain("mktemp -d -t pi-research-XXXXXX");
    });

    it("should have fallback if mktemp fails", () => {
      const extensionCode = readFileSync(
        join(__dirname, "research-mode-command.ts"),
        "utf-8"
      );

      expect(extensionCode).toContain("/tmp/pi-research-");
      expect(extensionCode).toContain("Date.now()");
      expect(extensionCode).toContain("mkdir -p");
    });
  });

  describe("tool registration", () => {
    it("should register write-research tool", () => {
      const extensionCode = readFileSync(
        join(__dirname, "research-mode-command.ts"),
        "utf-8"
      );

      expect(extensionCode).toContain('name: "write-research"');
      expect(extensionCode).toContain("Write files to the research output directory");
    });

    it("should register bash-safe tool", () => {
      const extensionCode = readFileSync(
        join(__dirname, "research-mode-command.ts"),
        "utf-8"
      );

      expect(extensionCode).toContain('name: "bash-safe"');
      expect(extensionCode).toContain("Execute read-only shell commands");
    });
  });

  describe("path validation", () => {
    it("should implement isPathSafe helper function", () => {
      const extensionCode = readFileSync(
        join(__dirname, "research-mode-command.ts"),
        "utf-8"
      );

      expect(extensionCode).toContain("function isPathSafe");
      expect(extensionCode).toContain("realpath");
    });

    it("should validate paths using realpath", () => {
      const extensionCode = readFileSync(
        join(__dirname, "research-mode-command.ts"),
        "utf-8"
      );

      expect(extensionCode).toContain('realpath "${normalizedPath}"');
      expect(extensionCode).toContain(
        'realPath.startsWith(realTemp + "/")'
      );
    });
  });

  describe("blocked command patterns", () => {
    it("should block file modification commands", () => {
      const extensionCode = readFileSync(
        join(__dirname, "research-mode-command.ts"),
        "utf-8"
      );

      expect(extensionCode).toContain(/\brm\s+/);
      expect(extensionCode).toContain(/\bmv\s+/);
      expect(extensionCode).toContain(/\bcp\s+/);
      expect(extensionCode).toContain(/\btouch\s+/);
    });

    it("should block redirection operators", () => {
      const extensionCode = readFileSync(
        join(__dirname, "research-mode-command.ts"),
        "utf-8"
      );

      expect(extensionCode).toContain(/\s+>\s+/);
      expect(extensionCode).toContain(/\s+>>\s+/);
    });

    it("should block package managers", () => {
      const extensionCode = readFileSync(
        join(__dirname, "research-mode-command.ts"),
        "utf-8"
      );

      expect(extensionCode).toContain("/\\bnpm\\s+(install|add");
      expect(extensionCode).toContain("/\\byarn\\s+(add|remove");
      expect(extensionCode).toContain("/\\bpnpm\\s+(add|remove");
    });

    it("should block shell execution of remote content", () => {
      const extensionCode = readFileSync(
        join(__dirname, "research-mode-command.ts"),
        "utf-8"
      );

      expect(extensionCode).toContain("/\\|\\s+sh$/");
      expect(extensionCode).toContain("/\\|\\s+bash$/");
    });
  });

  describe("UI rendering", () => {
    it("should implement renderWidget helper function", () => {
      const extensionCode = readFileSync(
        join(__dirname, "research-mode-command.ts"),
        "utf-8"
      );

      expect(extensionCode).toContain("function renderWidget");
      expect(extensionCode).toContain('ctx.ui.setWidget("research-mode-command"');
      expect(extensionCode).toContain('ctx.ui.setStatus("research-mode-command"');
    });

    it("should display research mode status in widget", () => {
      const extensionCode = readFileSync(
        join(__dirname, "research-mode-command.ts"),
        "utf-8"
      );

      expect(extensionCode).toContain("🔒 Research Mode Active");
      expect(extensionCode).toContain("Write directory:");
    });

    it("should show available commands in widget", () => {
      const extensionCode = readFileSync(
        join(__dirname, "research-mode-command.ts"),
        "utf-8"
      );

      expect(extensionCode).toContain(
        "/research-mode {exit|status|list|open|path|summary}"
      );
    });
  });

  describe("session lifecycle", () => {
    it("should clean up on session end", () => {
      const extensionCode = readFileSync(
        join(__dirname, "research-mode-command.ts"),
        "utf-8"
      );

      expect(extensionCode).toContain('pi.on("session_end"');
      expect(extensionCode).toContain("Research mode session ended");
    });

    it("should notify user of temp directory on session end", () => {
      const extensionCode = readFileSync(
        join(__dirname, "research-mode-command.ts"),
        "utf-8"
      );

      expect(extensionCode).toContain("Output saved to:");
    });
  });

  describe("state management", () => {
    it("should track isActive state", () => {
      const extensionCode = readFileSync(
        join(__dirname, "research-mode-command.ts"),
        "utf-8"
      );

      expect(extensionCode).toContain("let isActive = false");
      expect(extensionCode).toContain("isActive = true");
      expect(extensionCode).toContain("isActive = false");
    });

    it("should track tempDir state", () => {
      const extensionCode = readFileSync(
        join(__dirname, "research-mode-command.ts"),
        "utf-8"
      );

      expect(extensionCode).toContain("let tempDir: string | null = null");
    });

    it("should prevent duplicate activation", () => {
      const extensionCode = readFileSync(
        join(__dirname, "research-mode-command.ts"),
        "utf-8"
      );

      expect(extensionCode).toContain("if (isActive)");
      expect(extensionCode).toContain(
        "Research mode already active"
      );
    });
  });

  describe("error handling", () => {
    it("should handle mktemp failure", () => {
      const extensionCode = readFileSync(
        join(__dirname, "research-mode-command.ts"),
        "utf-8"
      );

      expect(extensionCode).toContain("mktempResult.exitCode === 0");
      expect(extensionCode).toContain("Fallback");
    });

    it("should handle path validation failures", () => {
      const extensionCode = readFileSync(
        join(__dirname, "research-mode-command.ts"),
        "utf-8"
      );

      expect(extensionCode).toContain('if (!isSafe)');
      expect(extensionCode).toContain(
        "is not within the research directory"
      );
    });

    it("should handle write failures", () => {
      const extensionCode = readFileSync(
        join(__dirname, "research-mode-command.ts"),
        "utf-8"
      );

      expect(extensionCode).toContain("writeResult.exitCode === 0");
      expect(extensionCode).toContain("Error writing to");
    });

    it("should handle inactive mode for subcommands", () => {
      const extensionCode = readFileSync(
        join(__dirname, "research-mode-command.ts"),
        "utf-8"
      );

      expect(extensionCode).toContain(
        "Research mode not active"
      );
    });
  });

  describe("command help text", () => {
    it("should document all subcommands in description", () => {
      const extensionCode = readFileSync(
        join(__dirname, "research-mode-command.ts"),
        "utf-8"
      );

      // Check that the file header documents all subcommands
      expect(extensionCode).toContain("/research-mode exit");
      expect(extensionCode).toContain("/research-mode status");
      expect(extensionCode).toContain("/research-mode list");
      expect(extensionCode).toContain("/research-mode open");
      expect(extensionCode).toContain("/research-mode path");
      expect(extensionCode).toContain("/research-mode summary");
    });
  });
});
