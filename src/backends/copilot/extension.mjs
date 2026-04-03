/**
 * Copilot CLI Bridge — Extension adapter for the Bot Army proxy.
 *
 * Handles incoming messages: onNotification → session.send({ prompt })
 * Outgoing responses are handled by the agent via MCP reply tool.
 *
 * Auto-discovered by Copilot from .github/extensions/. Env vars set by wrapper.
 */

import { joinSession } from "@github/copilot-sdk/extension";
import { connect } from "net";
import { createInterface } from "readline";

// Set by the backend wrapper via BRIDGE_NOTIFICATION_METHOD env var
const NOTIFICATION_METHOD = process.env.BRIDGE_NOTIFICATION_METHOD ?? "notifications/claude/channel";

// Mirrors formatChannelTag() in bridge-client.ts
function formatChannelTag(params) {
  const attrs = Object.entries(params.meta || {})
    .map(([k, v]) => `${k}="${v}"`)
    .join(" ");
  return `<channel source="bot-army-bridge" ${attrs}>${params.content}</channel>`;
}

const PROXY_HOST = process.env.BRIDGE_PROXY_HOST ?? "127.0.0.1";
const PROXY_PORT = parseInt(process.env.BRIDGE_PROXY_PORT ?? "0", 10);
const INSTANCE_NAME = process.env.BRIDGE_INSTANCE_NAME ?? "";

if (!PROXY_PORT || !INSTANCE_NAME) {
  console.error("copilot-bridge: BRIDGE_PROXY_PORT and BRIDGE_INSTANCE_NAME are required.");
  process.exit(1);
}

// --- TCP bridge client ---

const socket = connect(PROXY_PORT, PROXY_HOST);
const pendingCalls = new Map();
let callIdCounter = 0;
let onNotification = () => {};

await new Promise((resolve, reject) => {
  socket.on("connect", () => {
    socket.write(JSON.stringify({ type: "register", name: INSTANCE_NAME }) + "\n");
    console.error(`copilot-bridge: connected to proxy as ${INSTANCE_NAME}`);
    resolve();
  });
  socket.on("error", (err) => {
    console.error(`copilot-bridge: proxy connection failed: ${err}`);
    reject(err);
  });
});

const reader = createInterface({ input: socket, crlfDelay: Infinity });
reader.on("line", (line) => {
  let parsed;
  try { parsed = JSON.parse(line); } catch { return; }

  if (parsed.type === "notification") {
    onNotification(parsed.data);
  } else if (parsed.type === "tool_result") {
    const pending = pendingCalls.get(parsed.id);
    if (pending) {
      pendingCalls.delete(parsed.id);
      pending.resolve(parsed.result);
    }
  }
});

reader.on("close", () => {
  console.error("copilot-bridge: proxy disconnected");
  process.exit(0);
});

function callProxy(tool, args) {
  const id = String(++callIdCounter);
  socket.write(JSON.stringify({ type: "tool_call", id, tool, args }) + "\n");
  return new Promise((resolve, reject) => {
    pendingCalls.set(id, { resolve, reject });
    setTimeout(() => {
      if (pendingCalls.delete(id)) reject(new Error(`tool call ${tool} timed out`));
    }, 30000);
  });
}

// --- Copilot CLI Extension SDK ---

const session = await joinSession({
  onUserInputRequest: () => ({ result: "approve" }),
  onPermissionRequest: () => ({ result: "approve" }),
  hooks: {
    onSessionStart: () => ({
      additionalContext:
        `[Bot Army Bridge]\n` +
        `Instance: ${INSTANCE_NAME}\n` +
        `Messages from Discord users will appear as prompts. Your responses are automatically sent back.\n` +
        `You also have MCP tools available: reply (with chat_id), react (emoji), edit_message, fetch_messages, download_attachment, list_bots.\n` +
        `You can send GIFs by including a tenor.com/view/... URL in your message — Discord will auto-embed it.\n` +
        `You are part of a bot army. Use list_bots to see other running bots.\n` +
        `To communicate with another bot, mention their channel (e.g. <#channelId>) in your reply.`,
    }),
  },
});

console.error(`copilot-bridge: joined session for ${INSTANCE_NAME}`);

// --- Discord → Copilot: inject incoming messages ---

onNotification = (notification) => {
  if (notification.method === NOTIFICATION_METHOD) {
    const params = notification.params;
    const meta = params.meta || {};
    const user = meta.user || "unknown";

    // Format as <channel> tag — mirrors formatChannelTag() in bridge-client.ts
    const prompt = formatChannelTag(params);

    console.error(`copilot-bridge: injecting message from ${user}`);
    session.send({ prompt }).catch((err) => {
      console.error(`copilot-bridge: failed to send message: ${err.message}`);
    });
  }
};

// Agent responses are sent to Discord via the MCP reply tool — the agent calls
// it explicitly with the chat_id from the <channel> tag. No auto-relay needed.

// Shutdown
function shutdown() {
  socket.end();
  setTimeout(() => process.exit(0), 2000);
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
