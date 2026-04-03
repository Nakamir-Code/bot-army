/**
 * Tool call handler -- processes bridge tool calls from coding agents.
 * Platform-agnostic: uses ChatService for all messaging operations.
 */

import type { ChatService } from "./chat-service.js";
import type { InstanceManager } from "./instance-manager.js";
import type {
  Config,
  ChannelMap,
  InstanceName,
  ChannelNotification,
  BridgeToolCall,
} from "./types.js";
import { chunkText } from "./actions.js";
import { resolveHome } from "./backends/index.js";
import { mkdirSync } from "fs";
import { join } from "path";

export interface ToolHandlerDeps {
  chatService: ChatService;
  manager: InstanceManager;
  channelMap: ChannelMap;
  channelToName: Map<string, InstanceName>;
  config: Config;
}

export function createToolHandler(deps: ToolHandlerDeps) {
  const { chatService, manager, channelMap, channelToName, config } = deps;

  return async function handleToolCall(
    instanceName: InstanceName,
    call: BridgeToolCall
  ): Promise<unknown> {
    const args = call.args;

    try {
      switch (call.tool) {
        case "reply": {
          const channelId = args.chat_id as string;
          const rawText = args.text as string;
          const replyTo = args.reply_to as string | undefined;
          const files = (args.files as string[] | undefined) ?? [];

          const text = `**[${instanceName}]** ${rawText}`;

          let sentIds: string[];
          if (files.length > 0 || replyTo) {
            sentIds = await chatService.sendWithFiles(channelId, text, files, replyTo);
          } else {
            const chunks = chunkText(text, chatService.maxMessageLength);
            sentIds = [];
            for (const chunk of chunks) {
              const id = await chatService.sendToChannel(channelId, chunk);
              sentIds.push(id);
            }
          }

          // Cross-bot routing: if a bot posts into another bot's channel, notify that bot
          const targetBot = channelToName.get(channelId);
          if (
            targetBot &&
            targetBot !== instanceName &&
            manager.isRunning(targetBot)
          ) {
            const crossNotification: ChannelNotification = {
              method: manager.getNotificationMethod(targetBot),
              params: {
                content: `[Cross-talk from ${instanceName}]: ${rawText}`,
                meta: {
                  chat_id: channelId,
                  message_id: sentIds[0] ?? "unknown",
                  user: instanceName,
                  user_id: "bot-army-crosstalk",
                  ts: new Date().toISOString(),
                },
              },
            };
            manager.sendNotification(targetBot, crossNotification);
            console.log(`[crosstalk] ${instanceName} → ${targetBot}`);
          }

          // Also route via channel references mentioned in the text
          if (channelId !== channelMap.commander_id) {
            const mentionedChannelIds = chatService.parseChannelRefs(rawText);
            for (const mentionedChannelId of mentionedChannelIds) {
              const mentionedBot = channelToName.get(mentionedChannelId);
              if (
                mentionedBot &&
                mentionedBot !== instanceName &&
                mentionedBot !== targetBot &&
                manager.isRunning(mentionedBot)
              ) {
                const crossNotification: ChannelNotification = {
                  method: manager.getNotificationMethod(mentionedBot),
                  params: {
                    content: `[Cross-talk from ${instanceName}]: ${rawText}`,
                    meta: {
                      chat_id: channelId,
                      message_id: `crosstalk-${sentIds[0] ?? "unknown"}`,
                      user: instanceName,
                      user_id: "bot-army-crosstalk",
                      ts: new Date().toISOString(),
                    },
                  },
                };
                manager.sendNotification(mentionedBot, crossNotification);
                console.log(`[crosstalk] ${instanceName} → ${mentionedBot}`);
              }
            }
          }

          const result =
            sentIds.length === 1
              ? `sent (id: ${sentIds[0]})`
              : `sent ${sentIds.length} parts (ids: ${sentIds.join(", ")})`;
          return { content: [{ type: "text", text: result }] };
        }

        case "fetch_messages": {
          const channelId = args.channel as string;
          const limit = Math.min((args.limit as number) ?? 20, 100);
          const messages = await chatService.fetchMessages(channelId, limit);
          const me = chatService.getBotUserId();
          const out =
            messages.length === 0
              ? "(no messages)"
              : messages
                  .map((m) => {
                    const who = m.authorId === me ? "me" : m.authorUsername;
                    const atts = m.attachmentCount > 0 ? ` +${m.attachmentCount}att` : "";
                    const text = m.content.replace(/[\r\n]+/g, " ⏎ ");
                    return `[${m.createdAt.toISOString()}] ${who}: ${text}  (id: ${m.id}${atts})`;
                  })
                  .join("\n");
          return { content: [{ type: "text", text: out }] };
        }

        case "react": {
          await chatService.react(args.chat_id as string, args.message_id as string, args.emoji as string);
          return { content: [{ type: "text", text: "reacted" }] };
        }

        case "edit_message": {
          await chatService.editMessage(args.chat_id as string, args.message_id as string, args.text as string);
          return { content: [{ type: "text", text: "edited" }] };
        }

        case "download_attachment": {
          const channelId = args.chat_id as string;
          const messageId = args.message_id as string;
          const inboxDir = join(
            resolveHome(config.worktree_base),
            instanceName,
            "inbox"
          );
          mkdirSync(inboxDir, { recursive: true });
          const paths = await chatService.downloadAttachments(channelId, messageId, inboxDir);
          if (paths.length === 0) {
            return { content: [{ type: "text", text: "message has no attachments" }] };
          }
          return {
            content: [{ type: "text", text: `downloaded ${paths.length} attachment(s):\n${paths.map((p) => `  ${p}`).join("\n")}` }],
          };
        }

        case "list_bots": {
          const statuses = manager.getStatus();
          const lines = statuses
            .filter((s) => s.running)
            .map((s) => {
              const roleStr = s.role ? ` (${s.role})` : "";
              const worktree = s.worktreePath ? ` — worktree: ${s.worktreePath}` : "";
              return `${s.name}${roleStr} — ${chatService.formatChannelRef(s.channelId!)} — ${s.mode} — ${s.uptime}${worktree}`;
            });
          const header = lines.length > 0
            ? `Running bots:\n${lines.join("\n")}`
            : "No bots currently running.";
          return {
            content: [{
              type: "text",
              text: `${header}\n\nCommander channel: ${chatService.formatChannelRef(channelMap.commander_id)} (use this for status updates and announcements)`,
            }],
          };
        }

        default:
          return {
            content: [{ type: "text", text: `unknown tool: ${call.tool}` }],
            isError: true,
          };
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        content: [{ type: "text", text: `${call.tool} failed: ${msg}` }],
        isError: true,
      };
    }
  };
}
