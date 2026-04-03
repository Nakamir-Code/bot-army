/**
 * Shared Bridge Client — TCP connection to the Bot Army proxy.
 *
 * This module handles the proxy-side protocol (register, tool calls, tool
 * results, notifications) and is used by both the Claude MCP adapter and the
 * Copilot SDK adapter. Future backends (Codex, Aider, etc.) can reuse it too.
 *
 * Protocol (newline-delimited JSON over TCP):
 *   → { type: "register", name }
 *   → { type: "tool_call", id, tool, args }
 *   ← { type: "tool_result", id, result }
 *   ← { type: "notification", data: { method, params } }
 */

import { connect, type Socket } from "net";
import { createInterface } from "readline";

export interface BridgeNotification {
  method: string;
  params: unknown;
}

export interface BridgeClientOpts {
  host: string;
  port: number;
  instanceName: string;
  /** Called when a notification arrives from the proxy (incoming chat message, etc.) */
  onNotification: (notification: BridgeNotification) => void;
  /** Called when the proxy disconnects */
  onDisconnect?: () => void;
}

export class BridgeClient {
  private socket: Socket;
  private pendingCalls = new Map<
    string,
    { resolve: (result: unknown) => void; reject: (err: Error) => void }
  >();
  private callIdCounter = 0;
  private instanceName: string;

  constructor(private opts: BridgeClientOpts) {
    this.instanceName = opts.instanceName;
    this.socket = connect(opts.port, opts.host);
  }

  /** Connect to the proxy and register this instance. Resolves when registered. */
  async connect(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      this.socket.on("connect", () => {
        this.socket.write(
          JSON.stringify({ type: "register", name: this.instanceName }) + "\n"
        );
        resolve();
      });
      this.socket.on("error", (err) => {
        process.stderr.write(`bridge-client: proxy connection failed: ${err}\n`);
        reject(err);
      });
    });

    const reader = createInterface({ input: this.socket, crlfDelay: Infinity });

    reader.on("line", (line: string) => {
      let parsed: Record<string, unknown>;
      try {
        parsed = JSON.parse(line);
      } catch {
        return;
      }

      if (parsed.type === "notification") {
        this.opts.onNotification(parsed.data as BridgeNotification);
      } else if (parsed.type === "tool_result") {
        const pending = this.pendingCalls.get(parsed.id as string);
        if (pending) {
          this.pendingCalls.delete(parsed.id as string);
          pending.resolve(parsed.result);
        }
      }
    });

    reader.on("close", () => {
      process.stderr.write("bridge-client: proxy disconnected\n");
      this.opts.onDisconnect?.();
    });
  }

  /** Call a tool on the proxy (reply, react, edit_message, etc.) */
  callProxy(tool: string, args: Record<string, unknown>): Promise<unknown> {
    const id = String(++this.callIdCounter);
    this.socket.write(
      JSON.stringify({ type: "tool_call", id, tool, args }) + "\n"
    );

    return new Promise((resolve, reject) => {
      this.pendingCalls.set(id, { resolve, reject });
      setTimeout(() => {
        if (this.pendingCalls.delete(id)) {
          reject(new Error(`tool call ${tool} timed out`));
        }
      }, 30_000);
    });
  }

  /** Cleanly disconnect from the proxy */
  disconnect(): void {
    this.socket.end();
  }
}

/** Tool definitions exposed to the coding agent — shared across all backends */
export const TOOL_DEFINITIONS = [
  {
    name: "reply",
    description:
      "Reply to a message. Pass chat_id from the inbound message. Optionally pass reply_to (message_id) for threading, and files (absolute paths) to attach images or other files.",
    inputSchema: {
      type: "object" as const,
      properties: {
        chat_id: { type: "string" },
        text: { type: "string" },
        reply_to: {
          type: "string",
          description:
            "Message ID to thread under. Use message_id from the inbound <channel> block, or an id from fetch_messages.",
        },
        files: {
          type: "array",
          items: { type: "string" },
          description:
            "Absolute file paths to attach (images, logs, etc). Max 10 files, 25MB each.",
        },
      },
      required: ["chat_id", "text"],
    },
  },
  {
    name: "react",
    description: "Add an emoji reaction to a message.",
    inputSchema: {
      type: "object" as const,
      properties: {
        chat_id: { type: "string" },
        message_id: { type: "string" },
        emoji: { type: "string" },
      },
      required: ["chat_id", "message_id", "emoji"],
    },
  },
  {
    name: "edit_message",
    description: "Edit a message the bot previously sent.",
    inputSchema: {
      type: "object" as const,
      properties: {
        chat_id: { type: "string" },
        message_id: { type: "string" },
        text: { type: "string" },
      },
      required: ["chat_id", "message_id", "text"],
    },
  },
  {
    name: "download_attachment",
    description: "Download attachments from a message.",
    inputSchema: {
      type: "object" as const,
      properties: {
        chat_id: { type: "string" },
        message_id: { type: "string" },
      },
      required: ["chat_id", "message_id"],
    },
  },
  {
    name: "fetch_messages",
    description: "Fetch recent messages from a channel.",
    inputSchema: {
      type: "object" as const,
      properties: {
        channel: { type: "string" },
        limit: { type: "number" },
      },
      required: ["channel"],
    },
  },
  {
    name: "list_bots",
    description:
      "List all running bot army instances with their channels, roles, and status. " +
      "Use this to discover other bots you can delegate tasks to by mentioning their channel.",
    inputSchema: {
      type: "object" as const,
      properties: {},
      required: [],
    },
  },
];

/**
 * Format a channel notification as a <channel> XML tag.
 * Used by SDK-based backends (Copilot, etc.) to inject structured messages
 * with metadata into the agent's prompt. MCP-based backends (Claude) handle
 * this formatting internally via the channel notification system.
 */
export function formatChannelTag(params: { content: string; meta: Record<string, unknown> }): string {
  const attrs = Object.entries(params.meta)
    .map(([k, v]) => `${k}="${v}"`)
    .join(" ");
  return `<channel source="bot-army-bridge" ${attrs}>${params.content}</channel>`;
}

/** Shared instructions for all backends about bridge tools and capabilities */
export const BRIDGE_INSTRUCTIONS =
  'Messages arrive as <channel source="bot-army-bridge" chat_id="..." message_id="..." user="..." user_id="..." ts="...">. ' +
  "Reply with the reply tool, passing chat_id back. " +
  "Use react to add emoji reactions, edit_message to update sent messages, " +
  "fetch_messages to read history, and download_attachment to get files. " +
  "You are part of a bot army. Use list_bots to see which other bots are currently online, " +
  "their channels, and roles. To communicate with another bot, mention their channel " +
  "in your reply -- the proxy will route your message to them.";
