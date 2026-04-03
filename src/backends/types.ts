/**
 * Backend interface — defines how to spawn and communicate with a coding agent.
 *
 * To add a new backend: create a folder under src/backends/<name>/ with a
 * backend.ts that exports a BackendDef, then register it in src/backends/index.ts.
 */

import type { ChildProcess } from "node:child_process";
import type { ModelPreset, InstanceName, PermissionMode } from "../types.js";

/** Environment variables passed to the bridge for proxy connection */
export interface BridgeEnv {
  BRIDGE_PROXY_HOST: string;
  BRIDGE_PROXY_PORT: string;
  BRIDGE_INSTANCE_NAME: string;
}

/** Options passed to buildArgs when spawning an instance */
export interface SpawnOpts {
  mcpConfigPath: string;
  mode: PermissionMode;
  model?: string;
  resume: boolean;
  name: InstanceName;
  role?: string;
  worktreePath: string;
}

/** Backend definition — one per supported coding agent CLI */
export interface BackendDef {
  label: string;
  installHint: string;
  modelPresets: ModelPreset[];
  /** MCP notification method for channel messages (e.g. "notifications/claude/channel") */
  notificationMethod: string;
  /** Return the CLI command path. Throw if not installed. */
  resolveCommand: () => string;
  /**
   * Set up the bridge for message delivery. Writes any needed files to the
   * worktree (MCP config, extension loaders, etc.) and returns the MCP config
   * path to pass to buildArgs.
   */
  prepareBridge: (worktreePath: string, bridgeEnv: BridgeEnv) => string;
  /** Build the CLI args for spawning. */
  buildArgs: (opts: SpawnOpts) => string[];
  /** Optional post-spawn setup (e.g. auto-confirm prompts, sidecar processes). Returns a cleanup function. */
  onSpawned?: (child: ChildProcess, name: string, bridgeEnv: BridgeEnv) => (() => void) | void;
}

// --- Shared utilities for backends ---

import { execSync } from "node:child_process";
import { join } from "node:path";
import { homedir } from "node:os";

/** Resolve `~` to the user's home directory */
export function resolveHome(path: string): string {
  return path.replace(/^~/, homedir());
}

/** Replace the user's home directory with `~` for cleaner log output */
export function shortenHome(path: string): string {
  const home = homedir();
  return path.startsWith(home) ? "~" + path.slice(home.length) : path;
}

/** Resolve a CLI binary from PATH. On Windows, prefers .cmd/.exe over shell scripts. */
export function resolveFromPath(name: string): string | null {
  const whichCmd = process.platform === "win32" ? "where" : "which";
  try {
    const results = execSync(`${whichCmd} ${name}`, { stdio: "pipe" }).toString().trim().split("\n");
    if (process.platform === "win32") {
      const cmd = results.find((r) => r.endsWith(".cmd") || r.endsWith(".exe"));
      if (cmd) return cmd.trim();
    }
    return results[0].trim();
  } catch {
    return null;
  }
}

/** Resolve the bun binary path */
export function getBunPath(): string {
  return join(homedir(), ".bun", "bin", process.platform === "win32" ? "bun.exe" : "bun");
}

/** Shared role prompt template used by all backends */
export const ROLE_PROMPT = (name: string, role: string) =>
  `You are ${name}, a bot army instance. Your role/specialization is: ${role}. ` +
  `When asked about your role, always report this specialization — not your permission mode. ` +
  `Use the list_bots tool to discover other running bots, their roles, and their worktree paths. ` +
  `You can read files from another bot's worktree to review their code. ` +
  `To communicate with another bot, mention their channel in your reply.`;
