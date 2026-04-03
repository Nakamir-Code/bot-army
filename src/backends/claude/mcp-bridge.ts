#!/usr/bin/env bun
/**
 * Claude Code Bridge — MCP channel adapter for the Bot Army proxy.
 *
 * Thin adapter that connects the shared BridgeClient (TCP ↔ proxy) to
 * Claude Code's MCP development channel system. Declares the "claude/channel"
 * capability and exposes chat tools as MCP tools.
 *
 * Environment variables (set by the proxy when spawning):
 *   BRIDGE_PROXY_HOST     — proxy TCP host (default: 127.0.0.1)
 *   BRIDGE_PROXY_PORT     — proxy TCP port (required)
 *   BRIDGE_INSTANCE_NAME  — instance name (required)
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { BridgeClient, TOOL_DEFINITIONS, BRIDGE_INSTRUCTIONS } from "../bridge-client.js";

const PROXY_HOST = process.env.BRIDGE_PROXY_HOST ?? "127.0.0.1";
const PROXY_PORT = parseInt(process.env.BRIDGE_PROXY_PORT ?? "0", 10);
const INSTANCE_NAME = process.env.BRIDGE_INSTANCE_NAME ?? "";

if (!PROXY_PORT || !INSTANCE_NAME) {
  process.stderr.write(
    "claude-bridge: BRIDGE_PROXY_PORT and BRIDGE_INSTANCE_NAME are required.\n"
  );
  process.exit(1);
}

// --- MCP server ---
// BRIDGE_ENABLE_NOTIFICATIONS: set to "true" by backends that receive messages
// via MCP notifications (e.g. Claude Code's claude/channel). Backends that use
// a separate mechanism (e.g. SDK extension) set it to "false" or omit it.
const enableNotifications = process.env.BRIDGE_ENABLE_NOTIFICATIONS === "true";

const mcp = new Server(
  { name: "bot-army-bridge", version: "0.0.1" },
  {
    capabilities: {
      ...(enableNotifications ? { experimental: { "claude/channel": {} } } : {}),
      tools: {},
    },
    instructions: BRIDGE_INSTRUCTIONS,
  }
);

mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: TOOL_DEFINITIONS,
}));

// --- Shared bridge client (TCP ↔ proxy) ---

const bridge = new BridgeClient({
  host: PROXY_HOST,
  port: PROXY_PORT,
  instanceName: INSTANCE_NAME,
  onNotification(notification) {
    // Only forward notifications if the MCP client supports them.
    // Backends that use SDK extensions for message delivery disable this.
    if (enableNotifications) {
      void mcp.notification(notification as any).catch(() => {});
    }
  },
  onDisconnect() {
    process.stderr.write("claude-bridge: proxy disconnected, shutting down\n");
    process.exit(0);
  },
});

await bridge.connect();

// Route MCP tool calls through the shared bridge client
mcp.setRequestHandler(CallToolRequestSchema, async (req) => {
  const args = (req.params.arguments ?? {}) as Record<string, unknown>;
  try {
    const result = await bridge.callProxy(req.params.name, args);
    if (
      typeof result === "object" &&
      result !== null &&
      "content" in result
    ) {
      return result as { content: Array<{ type: string; text: string }> };
    }
    return { content: [{ type: "text", text: String(result) }] };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      content: [{ type: "text", text: `${req.params.name} failed: ${msg}` }],
      isError: true,
    };
  }
});

// Connect MCP to Claude Code via stdio
await mcp.connect(new StdioServerTransport());

// Shutdown
let shuttingDown = false;
function shutdown(): void {
  if (shuttingDown) return;
  shuttingDown = true;
  process.stderr.write("claude-bridge: shutting down\n");
  bridge.disconnect();
  setTimeout(() => process.exit(0), 2000);
}
process.stdin.on("end", shutdown);
process.stdin.on("close", shutdown);
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
