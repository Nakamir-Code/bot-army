/**
 * Claude Code backend — uses MCP development channels for message delivery.
 */

import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import type { BackendDef, BridgeEnv } from "../types.js";
import { ROLE_PROMPT, resolveFromPath, getBunPath } from "../types.js";

const backend: BackendDef = {
  label: "Claude Code",
  installHint: "Install: https://docs.anthropic.com/en/docs/claude-code/overview",
  notificationMethod: "notifications/claude/channel",
  modelPresets: [
    { id: "claude-sonnet-4-6", label: "Sonnet 4.6" },
    { id: "claude-opus-4-6", label: "Opus 4.6" },
    { id: "claude-haiku-4-5", label: "Haiku 4.5" },
  ],

  prepareBridge(worktreePath: string, bridgeEnv: BridgeEnv): string {
    const bridgeDir = join(import.meta.dir);
    const mcpConfig = {
      mcpServers: {
        "bot-army-bridge": {
          command: getBunPath(),
          args: ["run", "--cwd", bridgeDir, "start"],
          env: { ...bridgeEnv, BRIDGE_ENABLE_NOTIFICATIONS: "true" },
        },
      },
    };
    const mcpConfigPath = join(worktreePath, ".bot-army-mcp.json");
    writeFileSync(mcpConfigPath, JSON.stringify(mcpConfig, null, 2));
    return mcpConfigPath;
  },

  onSpawned(child, name) {
    // Auto-confirm the development channel prompt
    const stripAnsi = (s: string) =>
      s.replace(/\x1b[\[\]()#;?]*[0-9;]*[a-zA-Z@`]/g, "")
        .replace(/\x1b\][^\x07]*\x07/g, "")
        .replace(/\x1b[^a-zA-Z\x1b]*[a-zA-Z]/g, "");

    let confirmed = false;
    let buf = "";

    child.stdout?.on("data", (data: Buffer) => {
      if (confirmed) return;
      buf += stripAnsi(data.toString());
      if (
        buf.includes("local development") ||
        buf.includes("localdevelopment") ||
        buf.includes("Enter to confirm") ||
        buf.includes("Entertoconfirm")
      ) {
        confirmed = true;
        console.log(`[${name}] auto-confirming development channel prompt`);
        child.stdin?.write("\r");
        buf = "";
      }
      if (buf.length > 10000) buf = buf.slice(-5000);
    });

    const fallback = setTimeout(() => {
      if (!confirmed) {
        console.log(`[${name}] prompt not detected after 5s, sending Enter as fallback`);
        confirmed = true;
        child.stdin?.write("\r");
      }
    }, 5_000);

    return () => clearTimeout(fallback);
  },

  resolveCommand() {
    const found = resolveFromPath("claude");
    if (found) return found;

    // Fallback to standard install location
    const home = process.env.USERPROFILE ?? process.env.HOME ?? homedir();
    const cmd = join(home, ".local", "bin", process.platform === "win32" ? "claude.exe" : "claude");
    if (!existsSync(cmd)) throw new Error(`${this.label} not found. ${this.installHint}`);
    return cmd;
  },

  buildArgs(opts) {
    const args: string[] = [
      "--mcp-config", opts.mcpConfigPath,
      ...(opts.mode === "bypassPermissions"
        ? ["--dangerously-skip-permissions"]
        : ["--permission-mode", opts.mode]),
      "--dangerously-load-development-channels", "server:bot-army-bridge",
      ...(opts.model ? ["--model", opts.model.replace(/(\d+)\.(\d+)/g, "$1-$2")] : []),
      ...(opts.resume ? ["--continue"] : []),
    ];
    if (opts.role) {
      args.push("--append-system-prompt", ROLE_PROMPT(opts.name, opts.role));
    }
    return args;
  },
};

export default backend;
