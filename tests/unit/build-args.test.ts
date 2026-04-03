import { describe, expect, test } from "bun:test";
import type { SpawnOpts } from "../../src/backends/types.js";

// Import buildArgs from each backend directly
import claudeBackend from "../../src/backends/claude/backend.js";
import copilotBackend from "../../src/backends/copilot/backend.js";

const baseOpts: SpawnOpts = {
  mcpConfigPath: "/tmp/test-mcp.json",
  mode: "bypassPermissions",
  resume: false,
  name: "alpha",
  worktreePath: "/tmp/test-worktree",
};

// --- Claude Code ---

describe("claude buildArgs", () => {
  test("includes mcp config and dev channel flags", () => {
    const args = claudeBackend.buildArgs(baseOpts);
    expect(args).toContain("--mcp-config");
    expect(args).toContain("/tmp/test-mcp.json");
    expect(args).toContain("--dangerously-load-development-channels");
    expect(args).toContain("server:bot-army-bridge");
  });

  test("bypassPermissions maps to --dangerously-skip-permissions", () => {
    const args = claudeBackend.buildArgs({ ...baseOpts, mode: "bypassPermissions" });
    expect(args).toContain("--dangerously-skip-permissions");
    expect(args).not.toContain("--permission-mode");
  });

  test("plan mode maps to --permission-mode plan", () => {
    const args = claudeBackend.buildArgs({ ...baseOpts, mode: "plan" });
    expect(args).toContain("--permission-mode");
    expect(args).toContain("plan");
    expect(args).not.toContain("--dangerously-skip-permissions");
  });

  test("includes --model when set", () => {
    const args = claudeBackend.buildArgs({ ...baseOpts, model: "claude-opus-4-6" });
    expect(args).toContain("--model");
    expect(args).toContain("claude-opus-4-6");
  });

  test("omits --model when not set", () => {
    const args = claudeBackend.buildArgs(baseOpts);
    expect(args).not.toContain("--model");
  });

  test("includes --continue when resuming", () => {
    const args = claudeBackend.buildArgs({ ...baseOpts, resume: true });
    expect(args).toContain("--continue");
  });

  test("omits --continue when not resuming", () => {
    const args = claudeBackend.buildArgs(baseOpts);
    expect(args).not.toContain("--continue");
  });

  test("includes --append-system-prompt when role is set", () => {
    const args = claudeBackend.buildArgs({ ...baseOpts, role: "code reviewer" });
    expect(args).toContain("--append-system-prompt");
    const promptIdx = args.indexOf("--append-system-prompt");
    expect(args[promptIdx + 1]).toContain("code reviewer");
    expect(args[promptIdx + 1]).toContain("alpha");
  });

  test("omits --append-system-prompt when no role", () => {
    const args = claudeBackend.buildArgs(baseOpts);
    expect(args).not.toContain("--append-system-prompt");
  });

  test("all modes produce valid args (no undefined)", () => {
    const modes = ["default", "acceptEdits", "plan", "auto", "dontAsk", "bypassPermissions"] as const;
    for (const mode of modes) {
      const args = claudeBackend.buildArgs({ ...baseOpts, mode });
      expect(args.every((a) => a !== undefined)).toBe(true);
    }
  });
});

// --- Copilot CLI ---

describe("copilot buildArgs", () => {
  test("includes --additional-mcp-config with @ prefix", () => {
    const args = copilotBackend.buildArgs(baseOpts);
    expect(args).toContain("--additional-mcp-config");
    expect(args).toContain("@/tmp/test-mcp.json");
  });

  test("always includes --autopilot", () => {
    const args = copilotBackend.buildArgs(baseOpts);
    expect(args).toContain("--autopilot");
  });

  test("bypassPermissions maps to --yolo", () => {
    const args = copilotBackend.buildArgs({ ...baseOpts, mode: "bypassPermissions" });
    expect(args).toContain("--yolo");
  });

  test("non-bypass mode omits --yolo", () => {
    const args = copilotBackend.buildArgs({ ...baseOpts, mode: "plan" });
    expect(args).not.toContain("--yolo");
  });

  test("includes --model when set", () => {
    const args = copilotBackend.buildArgs({ ...baseOpts, model: "gpt-5.3-codex" });
    expect(args).toContain("--model");
    expect(args).toContain("gpt-5.3-codex");
  });

  test("includes --continue when resuming", () => {
    const args = copilotBackend.buildArgs({ ...baseOpts, resume: true });
    expect(args).toContain("--continue");
  });

  test("omits --continue when not resuming", () => {
    const args = copilotBackend.buildArgs(baseOpts);
    expect(args).not.toContain("--continue");
  });

  test("all modes produce valid args", () => {
    const modes = ["default", "acceptEdits", "plan", "auto", "dontAsk", "bypassPermissions"] as const;
    for (const mode of modes) {
      const args = copilotBackend.buildArgs({ ...baseOpts, mode });
      expect(args.every((a) => a !== undefined)).toBe(true);
    }
  });
});

// --- Backend parity ---

describe("backend parity", () => {
  test("both backends have model presets", () => {
    expect(claudeBackend.modelPresets.length).toBeGreaterThan(0);
    expect(copilotBackend.modelPresets.length).toBeGreaterThan(0);
  });

  test("both backends have label and installHint", () => {
    expect(claudeBackend.label).toBeTruthy();
    expect(claudeBackend.installHint).toBeTruthy();
    expect(copilotBackend.label).toBeTruthy();
    expect(copilotBackend.installHint).toBeTruthy();
  });

  test("both backends include --continue for resume", () => {
    const claudeArgs = claudeBackend.buildArgs({ ...baseOpts, resume: true });
    const copilotArgs = copilotBackend.buildArgs({ ...baseOpts, resume: true });
    expect(claudeArgs).toContain("--continue");
    expect(copilotArgs).toContain("--continue");
  });

  test("both backends include model flag when model is set", () => {
    const claudeArgs = claudeBackend.buildArgs({ ...baseOpts, model: "test-model" });
    const copilotArgs = copilotBackend.buildArgs({ ...baseOpts, model: "test-model" });
    expect(claudeArgs).toContain("--model");
    expect(copilotArgs).toContain("--model");
  });
});
