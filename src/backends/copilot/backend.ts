/**
 * Copilot CLI backend — uses the Copilot Extension SDK for message delivery.
 */

import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { BackendDef, BridgeEnv } from "../types.js";
import { ROLE_PROMPT, resolveFromPath, getBunPath } from "../types.js";

const backend: BackendDef = {
  label: "Copilot CLI",
  installHint: "Install: npm install -g @githubnext/github-copilot-cli",
  notificationMethod: "notifications/claude/channel",
  modelPresets: [
    { id: "claude-sonnet-4.6", label: "Sonnet 4.6" },
    { id: "claude-opus-4.6", label: "Opus 4.6" },
    { id: "claude-haiku-4.5", label: "Haiku 4.5" },
    { id: "gpt-5.3-codex", label: "GPT-5.3 Codex" },
    { id: "gpt-5-mini", label: "GPT-5 Mini" },
    { id: "gemini-3-pro", label: "Gemini 3 Pro" },
  ],

  prepareBridge(worktreePath: string, bridgeEnv: BridgeEnv): string {
    // 1. Install the SDK extension for message delivery (session.send / session.on)
    // Copilot auto-discovers extensions from .github/extensions/<name>/extension.mjs
    // and forks them as child processes.
    const extDir = join(worktreePath, ".github", "extensions", "bot-army-bridge");
    mkdirSync(extDir, { recursive: true });

    const realExtension = join(import.meta.dir, "extension.mjs");
    writeFileSync(join(extDir, "extension.mjs"),
      `// Auto-generated wrapper — sets bridge env vars then loads the real extension\n` +
      `process.env.BRIDGE_PROXY_HOST = ${JSON.stringify(bridgeEnv.BRIDGE_PROXY_HOST)};\n` +
      `process.env.BRIDGE_PROXY_PORT = ${JSON.stringify(bridgeEnv.BRIDGE_PROXY_PORT)};\n` +
      `process.env.BRIDGE_INSTANCE_NAME = ${JSON.stringify(bridgeEnv.BRIDGE_INSTANCE_NAME)};\n` +
      `process.env.BRIDGE_NOTIFICATION_METHOD = ${JSON.stringify(backend.notificationMethod)};\n` +
      `await import(${JSON.stringify("file:///" + realExtension.replace(/\\/g, "/"))});\n`
    );

    // 2. Also start the MCP bridge for tool access (reply, react, fetch_messages, etc.)
    // Both the extension and MCP bridge connect to the proxy — the proxy supports
    // multiple sockets per instance so they don't conflict.
    const claudeBridgeDir = join(import.meta.dir, "..", "claude");
    const mcpConfig = {
      mcpServers: {
        "bot-army-bridge": {
          command: getBunPath(),
          args: ["run", "--cwd", claudeBridgeDir, "start"],
          env: bridgeEnv,
        },
      },
    };
    const mcpConfigPath = join(worktreePath, ".bot-army-mcp.json");
    writeFileSync(mcpConfigPath, JSON.stringify(mcpConfig, null, 2));
    return mcpConfigPath;
  },

  resolveCommand() {
    const found = resolveFromPath("copilot");
    if (found) return found;
    throw new Error(`${this.label} not found. ${this.installHint}`);
  },

  buildArgs(opts) {
    const args: string[] = [
      "--additional-mcp-config", `@${opts.mcpConfigPath}`,
      "--autopilot",
    ];
    if (opts.mode === "bypassPermissions") args.push("--yolo");
    if (opts.model) args.push("--model", opts.model.replace(/(\d+)-(\d+)/g, "$1.$2"));
    // --continue resumes the most recent session silently (--resume opens a picker)
    if (opts.resume) args.push("--continue");
    if (opts.role) {
      writeFileSync(join(opts.worktreePath, "AGENTS.md"), ROLE_PROMPT(opts.name, opts.role) + "\n");
    }
    return args;
  },
};

export default backend;
