/**
 * Message router -- routes incoming chat messages to coding agent instances.
 * Platform-agnostic: platform adapters call routeIncoming() with normalized messages.
 */

import type { ChatService } from "./chat-service.js";
import type { InstanceManager } from "./instance-manager.js";
import type { Config, ChannelMap, InstanceName, ChannelNotification } from "./types.js";

export interface IncomingMessage {
  channelId: string;
  messageId: string;
  authorId: string;
  authorUsername: string;
  content: string;
  isBot: boolean;
  createdAt: Date;
  attachmentSummary?: string;
  attachmentCount?: number;
}

export interface MessageRouterDeps {
  manager: InstanceManager;
  chatService: ChatService;
  channelMap: ChannelMap;
  channelToName: Map<string, InstanceName>;
  config: Config;
}

export function createMessageRouter(deps: MessageRouterDeps) {
  const { manager, chatService, channelMap, channelToName, config } = deps;

  function routeIncoming(msg: IncomingMessage): void {
    if (msg.isBot) return;

    if (
      config.user_allowlist?.length &&
      !config.user_allowlist.includes(msg.authorId)
    ) {
      return;
    }

    // Commander channel: route to mentioned bot(s), or broadcast to all
    if (msg.channelId === channelMap.commander_id) {
      const running = [...manager.running.keys()];
      if (running.length === 0) return;

      const mentionedChannelIds = new Set(chatService.parseChannelRefs(msg.content));
      const mentioned = running.filter((n) => {
        const chId = channelMap.workers[n];
        if (chId && mentionedChannelIds.has(chId)) return true;
        return new RegExp(`@${n}\\b`, "i").test(msg.content);
      });
      const targets = mentioned.length > 0 ? mentioned : running;

      const meta = {
        chat_id: msg.channelId,
        message_id: msg.messageId,
        user: msg.authorUsername,
        user_id: msg.authorId,
        ts: msg.createdAt.toISOString(),
      };
      let sent = 0;
      for (const target of targets) {
        const notification: ChannelNotification = {
          method: manager.getNotificationMethod(target),
          params: { content: msg.content, meta },
        };
        if (manager.sendNotification(target, notification)) sent++;
      }
      console.log(`[router] commander message → ${targets.join(", ")} (${sent} sent)`);
      return;
    }

    // Worker channel: route to specific bot
    const name = channelToName.get(msg.channelId);
    if (!name) return;

    if (!manager.isRunning(name)) {
      console.log(`[router] ${name} is not running, ignoring message`);
      return;
    }

    const notification: ChannelNotification = {
      method: manager.getNotificationMethod(name),
      params: {
        content: msg.content,
        meta: {
          chat_id: msg.channelId,
          message_id: msg.messageId,
          user: msg.authorUsername,
          user_id: msg.authorId,
          ts: msg.createdAt.toISOString(),
          ...(msg.attachmentCount && msg.attachmentCount > 0
            ? {
                attachment_count: msg.attachmentCount,
                attachments: msg.attachmentSummary,
              }
            : {}),
        },
      },
    };

    const sent = manager.sendNotification(name, notification);
    console.log(`[router] forwarded message to ${name}: sent=${sent}, content="${msg.content.slice(0, 50)}"`);

    // Cross-talk: if user mentions other bot channels, route to those bots too
    const mentionedChannelIds = chatService.parseChannelRefs(msg.content);
    for (const mentionedChannelId of mentionedChannelIds) {
      const mentionedBot = channelToName.get(mentionedChannelId);
      if (
        mentionedBot &&
        mentionedBot !== name &&
        manager.isRunning(mentionedBot)
      ) {
        const crossNotification: ChannelNotification = {
          method: manager.getNotificationMethod(mentionedBot),
          params: {
            content: `[Message from ${msg.authorUsername} in #${name}]: ${msg.content}`,
            meta: {
              chat_id: mentionedChannelId,
              message_id: msg.messageId,
              user: msg.authorUsername,
              user_id: msg.authorId,
              ts: msg.createdAt.toISOString(),
            },
          },
        };
        manager.sendNotification(mentionedBot, crossNotification);
        console.log(`[crosstalk] user mention in #${name} → ${mentionedBot}`);
      }
    }
  }

  return { routeIncoming };
}
