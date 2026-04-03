/** Instance name — any string from the configured channel list */
export type InstanceName = string;

/** Channel definition with optional defaults for role, model, backend */
export interface ChannelConfig {
  name: string;
  role?: string;
  model?: string;
  backend?: CliBackend;
  repo?: string;
}

/**
 * CLI backend type — kept here to avoid circular imports with Config.
 * When adding a new backend, also register it in src/backends/index.ts.
 * TypeScript will error if they're out of sync (BACKENDS uses Record<CliBackend, ...>).
 */
export type CliBackend = "claude" | "copilot";

/** Permission modes — mapped to backend-specific flags */
export type PermissionMode = "default" | "acceptEdits" | "plan" | "auto" | "dontAsk" | "bypassPermissions";

/** Model preset shown in command dropdowns and CLI help */
export interface ModelPreset {
  id: string;     // e.g. "claude-sonnet-4-6"
  label: string;  // e.g. "Sonnet 4.6"
}

export type Platform = "discord"; // TODO: add more platforms (e.g. Telegram)

export interface Config {
  army_name: string;
  /** Chat platform (default: "discord") */
  platform?: Platform;
  target_repo: string;
  worktree_base: string;
  user_allowlist: string[];

  guild_id?: string;
  bot_token?: string;
  /** CLI backend (default: "claude") */
  backend?: CliBackend;
  /**
   * Channel definitions (default: alpha-zulu). Can be simple strings or objects:
   *   channels: ["frontend", "backend"]
   *   channels:
   *     - name: frontend
   *       role: "frontend specialist"
   *       model: "claude-sonnet-4-6"
   *       backend: copilot
   */
  channels?: Array<string | ChannelConfig>;
  /** Custom commander channel name (default: "commander") */
  commander_name?: string;
  /** Git branch instances spawn on by default (default: "dev") */
  default_branch?: string;
  /** Default permission mode (default: "default") */
  default_mode?: PermissionMode;
  /** Default model for all bots — per-bot overrides via /model take priority */
  default_model?: string;
  /** Additional model presets (merged with built-in defaults) */
  model_presets?: ModelPreset[];
  /** Auto-spawn config on startup — set to false to disable, or customize */
  auto_spawn?: false | {
    name?: InstanceName;
    branch?: string;
    mode?: PermissionMode;
  };
  /** Whether to purge channel messages on spawn/kill (default: false) */
  purge_channels?: boolean;
  /** HTTP CLI API port (default: 3100) */
  cli_port?: number;
  /** Auto-update: poll for new commits and restart (set to false to disable) */
  auto_update?: false | {
    /** Polling interval in seconds (default: 60) */
    interval_seconds?: number;
    /** Remote branch to track (default: "main") */
    branch?: string;
  };
}

/** Normalize channel config — handles both string and object formats */
export function parseChannels(raw?: Array<string | ChannelConfig>): ChannelConfig[] {
  if (!raw || raw.length === 0) {
    throw new Error("No channels configured. Add a `channels` list to config.yaml.");
  }
  return raw.map((ch) => typeof ch === "string" ? { name: ch } : ch);
}

export interface ChannelMap {
  category_id: string;
  commander_id: string;
  workers: Record<string, string>; // instance name -> channel snowflake
}

/** MCP notification sent to the coding agent when a chat message arrives */
export interface ChannelNotification {
  method: string;
  params: {
    content: string;
    meta: {
      chat_id: string;
      message_id: string;
      user: string;
      user_id: string;
      ts: string;
      attachment_count?: number;
      attachments?: string;
    };
  };
}

/** Message from bridge -> proxy (over TCP) */
export interface BridgeToolCall {
  type: "tool_call";
  id: string;
  tool: string;
  args: Record<string, unknown>;
}

export interface BridgeToolResult {
  type: "tool_result";
  id: string;
  result: unknown;
}
