/**
 * Discord platform adapter -- all discord.js code lives here.
 */

import {
  Client,
  GatewayIntentBits,
  Partials,
  REST,
  Routes,
  SlashCommandBuilder,
  EmbedBuilder,
  type Message,
  type TextChannel,
  type Interaction,
  type ChatInputCommandInteraction,
} from "discord.js";
import type { ChatService, RichContent } from "../../chat-service.js";
import type { InstanceManager } from "../../instance-manager.js";
import type { Config, ChannelMap, InstanceName } from "../../types.js";
import type { Actions } from "../../actions.js";
import { createMessageRouter, type IncomingMessage } from "../../message-router.js";
import { getCommandDefinitions, handleCommand, type CommandContext } from "../../command-handler.js";
import { writeFileSync } from "fs";
import { join } from "path";

export interface DiscordAdapterConfig {
  config: Config;
  channelMap: ChannelMap;
  instanceNames: string[];
  channelToName: Map<string, InstanceName>;
}

export class DiscordAdapter {
  private client: Client;
  private adapterConfig: DiscordAdapterConfig;
  private dashboardMessageId: string | null = null;
  private _manager!: InstanceManager;

  readonly chatService: ChatService;

  constructor(adapterConfig: DiscordAdapterConfig) {
    this.adapterConfig = adapterConfig;
    this.client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
      ],
      partials: [Partials.Channel],
    });

    // Suppress stale interaction errors
    this.client.on("error", (err: Error & { code?: number }) => {
      if (err.code === 10062 || err.code === 40060) return;
      console.error("Discord client error:", err);
    });

    this.chatService = this.buildChatService();
  }

  private buildChatService(): ChatService {
    const client = this.client;

    return {
      platform: "discord",
      maxMessageLength: 2000,

      async sendToChannel(channelId: string, content: string): Promise<string> {
        const channel = (client.channels.cache.get(channelId)
          ?? await client.channels.fetch(channelId)) as TextChannel;
        const msg = await channel.send(content);
        return msg.id;
      },

      async sendRichContent(channelId: string, content: RichContent): Promise<string> {
        const channel = (await client.channels.fetch(channelId)) as TextChannel;
        const embed = richContentToEmbed(content);
        const msg = await channel.send({ embeds: [embed] });
        return msg.id;
      },

      async editMessage(channelId: string, messageId: string, content: string): Promise<void> {
        const channel = (await client.channels.fetch(channelId)) as TextChannel;
        const msg = await channel.messages.fetch(messageId);
        await msg.edit(content);
      },

      async editRichContent(channelId: string, messageId: string, content: RichContent): Promise<void> {
        const channel = (await client.channels.fetch(channelId)) as TextChannel;
        const msg = await channel.messages.fetch(messageId);
        await msg.edit({ embeds: [richContentToEmbed(content)] });
      },

      async fetchMessage(channelId: string, messageId: string) {
        const channel = (await client.channels.fetch(channelId)) as TextChannel;
        const msg = await channel.messages.fetch(messageId);
        return { id: msg.id, content: msg.content };
      },

      async purgeChannel(channelId: string): Promise<number> {
        const channel = (await client.channels.fetch(channelId)) as TextChannel;
        return purgeDiscordChannel(channel);
      },

      async fetchMessages(channelId: string, limit: number) {
        const channel = (await client.channels.fetch(channelId)) as TextChannel;
        const msgs = await channel.messages.fetch({ limit });
        return [...msgs.values()].reverse().map((m) => ({
          id: m.id,
          content: m.content,
          authorId: m.author.id,
          authorUsername: m.author.username,
          createdAt: m.createdAt,
          attachmentCount: m.attachments.size,
          attachments: [...m.attachments.values()].map((a) => ({
            id: a.id,
            name: a.name ?? "file",
            url: a.url,
            contentType: a.contentType,
            size: a.size,
          })),
        }));
      },

      async react(channelId: string, messageId: string, emoji: string): Promise<void> {
        const channel = (await client.channels.fetch(channelId)) as TextChannel;
        const msg = await channel.messages.fetch(messageId);
        await msg.react(emoji);
      },

      getBotUserId(): string | undefined {
        return client.user?.id;
      },

      async sendWithFiles(channelId: string, content: string, files: string[], replyTo?: string): Promise<string[]> {
        const channel = (await client.channels.fetch(channelId)) as TextChannel;
        // Chunk the text content, attach files to the first chunk
        const { chunkText } = await import("../../actions.js");
        const chunks = chunkText(content, 2000);
        const sentIds: string[] = [];

        for (let i = 0; i < chunks.length; i++) {
          const sent = await channel.send({
            content: chunks[i],
            ...(i === 0 && files.length > 0
              ? { files: files.map((f) => ({ attachment: f })) }
              : {}),
            ...(replyTo && i === 0
              ? { reply: { messageReference: replyTo, failIfNotExists: false } }
              : {}),
          });
          sentIds.push(sent.id);
        }
        return sentIds;
      },

      async downloadAttachments(channelId: string, messageId: string, destDir: string): Promise<string[]> {
        const channel = (await client.channels.fetch(channelId)) as TextChannel;
        const msg = await channel.messages.fetch(messageId);
        if (msg.attachments.size === 0) return [];

        const paths: string[] = [];
        for (const att of msg.attachments.values()) {
          const res = await fetch(att.url);
          const buf = Buffer.from(await res.arrayBuffer());
          const safeName = (att.name ?? "attachment").replace(/[^a-zA-Z0-9._-]/g, "_");
          const path = join(destDir, `${att.id}_${safeName}`);
          writeFileSync(path, buf);
          const kb = (att.size / 1024).toFixed(0);
          paths.push(`${path}  (${safeName}, ${att.contentType ?? "unknown"}, ${kb}KB)`);
        }
        return paths;
      },

      formatChannelRef(channelId: string): string {
        return `<#${channelId}>`;
      },

      parseChannelRefs(text: string): string[] {
        const ids: string[] = [];
        const regex = /<#(\d+)>/g;
        let match;
        while ((match = regex.exec(text)) !== null) {
          ids.push(match[1]);
        }
        return ids;
      },
    };
  }

  async start(manager: InstanceManager, actions: Actions): Promise<void> {
    const { config, channelMap, instanceNames, channelToName } = this.adapterConfig;
    if (!config.bot_token) throw new Error("bot_token is required for Discord platform");
    if (!config.guild_id) throw new Error("guild_id is required for Discord platform");
    const botToken = config.bot_token;
    const guildId = config.guild_id;
    const chatService = this.chatService;
    this._manager = manager;

    // Message routing
    const router = createMessageRouter({
      manager,
      chatService,
      channelMap,
      channelToName,
      config,
    });

    this.client.on("messageCreate", (msg: Message) => {
      const incoming: IncomingMessage = {
        channelId: msg.channel.id,
        messageId: msg.id,
        authorId: msg.author.id,
        authorUsername: msg.author.username,
        content: msg.content,
        isBot: msg.author.bot,
        createdAt: msg.createdAt,
        attachmentCount: msg.attachments.size,
        attachmentSummary: msg.attachments.size > 0
          ? [...msg.attachments.values()]
              .map((a) => `${a.name ?? "file"}; ${a.contentType ?? "unknown"}; ${(a.size / 1024).toFixed(0)}KB`)
              .join("\n")
          : undefined,
      };
      router.routeIncoming(incoming);
    });

    // Slash commands
    const commandDefs = getCommandDefinitions(config);

    this.client.on("interactionCreate", async (interaction: Interaction) => {
      if (interaction.isAutocomplete()) {
        const focused = interaction.options.getFocused().toLowerCase();
        const filtered = instanceNames.filter((n) => n.startsWith(focused)).slice(0, 25);
        await interaction.respond(filtered.map((n) => ({ name: n, value: n })));
        return;
      }

      if (!interaction.isChatInputCommand()) return;

      try {
        const ctx = this.interactionToContext(interaction);
        await handleCommand(ctx, {
          manager,
          actions,
          chatService,
          config,
          instanceNames,
          buildStatusContent: () => this.buildStatusContent(),
          purgeCurrentChannel: async (_channelId: string) => {
            const channel = interaction.channel as TextChannel;
            return purgeDiscordChannel(channel);
          },
        });
      } catch (err: unknown) {
        if (err && typeof err === "object" && "code" in err) {
          const code = (err as { code: number }).code;
          if (code === 10062 || code === 40060) return;
        }
        console.error("Interaction handler error:", err);
      }
    });

    // Login and wait for ready
    await new Promise<void>((resolve) => {
      this.client.once("clientReady", async () => {
        console.log(`Logged in as ${this.client.user?.tag}`);

        const rest = new REST({ version: "10" }).setToken(botToken);
        try {
          const slashCommands = this.buildSlashCommands(commandDefs, config);
          await rest.put(
            Routes.applicationGuildCommands(this.client.user!.id, guildId),
            { body: slashCommands.map((c) => c.toJSON()) }
          );
          console.log("Slash commands registered.");
        } catch (err) {
          console.error("Failed to register slash commands:", err);
        }

        await actions.logToCommander(
          `**${config.army_name} Bot Army** is online. Use \`/status\` to see instances.`
        );
        resolve();
      });
      this.client.login(botToken);
    });
  }

  async updateDashboard(): Promise<void> {
    try {
      const channelId = this.adapterConfig.channelMap.commander_id;
      const embed = richContentToEmbed(this.buildStatusContent());
      if (this.dashboardMessageId) {
        try {
          const channel = (await this.client.channels.fetch(channelId)) as TextChannel;
          const msg = await channel.messages.fetch(this.dashboardMessageId);
          await msg.edit({ embeds: [embed] });
          return;
        } catch {
          this.dashboardMessageId = null;
        }
      }
      const channel = (await this.client.channels.fetch(channelId)) as TextChannel;
      const dashMsg = await channel.send({ embeds: [embed] });
      this.dashboardMessageId = dashMsg.id;
    } catch (err) {
      console.error("Failed to update dashboard:", err);
    }
  }

  private buildStatusContent(): RichContent {
    const statuses = this._manager.getStatus();
    const runningCount = statuses.filter((s) => s.running).length;
    const running = statuses.filter((s) => s.running);
    const stopped = statuses.filter((s) => !s.running);

    const fields: RichContent["fields"] = [];

    if (running.length > 0) {
      const lines = running.map((s) => {
        const roleStr = s.role ? ` · ${s.role}` : "";
        const modelStr = s.model ? ` · \`${s.model}\`` : "";
        return `🟢 **${s.name}** — \`${s.branch}\` — ${s.mode} — ${s.uptime} — <#${s.channelId}>${roleStr}${modelStr}`;
      });
      fields.push({ name: "Running", value: lines.join("\n") });
    }

    if (stopped.length > 0) {
      const names = stopped.map((s) => s.role ? `${s.name} (${s.role})` : s.name);
      fields.push({ name: "Available", value: names.join(", ") });
    }

    return {
      title: `${this.adapterConfig.config.army_name} Bot Army`,
      color: runningCount > 0 ? 0x00ff00 : 0x808080,
      fields,
      footer: `${runningCount} active / ${statuses.length} total`,
      timestamp: new Date(),
    };
  }

  private interactionToContext(interaction: ChatInputCommandInteraction): CommandContext {
    const options: Record<string, string | number | boolean | null> = {};
    for (const opt of interaction.options.data) {
      options[opt.name] = opt.value ?? null;
    }

    let deferred = false;
    return {
      command: interaction.commandName,
      options,
      userId: interaction.user.id,
      channelId: interaction.channel?.id ?? "",
      async defer() {
        deferred = true;
        await interaction.deferReply();
      },
      async reply(content: string) {
        if (deferred) {
          await interaction.editReply(content);
        } else {
          await interaction.reply(content);
        }
      },
      async replyRich(content: RichContent) {
        const embed = richContentToEmbed(content);
        if (deferred) {
          await interaction.editReply({ embeds: [embed] });
        } else {
          await interaction.reply({ embeds: [embed] });
        }
      },
      async editReply(content: string) {
        await interaction.editReply(content);
      },
    };
  }

  private buildSlashCommands(defs: ReturnType<typeof getCommandDefinitions>, _config: Config) {
    // Build discord.js SlashCommandBuilder from platform-neutral definitions
    return defs.map((def) => {
      const builder = new SlashCommandBuilder()
        .setName(def.name)
        .setDescription(def.description);

      for (const opt of def.options) {
        if (opt.type === "string") {
          builder.addStringOption((o) => {
            o.setName(opt.name).setDescription(opt.description).setRequired(opt.required);
            if (opt.choices) o.addChoices(...opt.choices);
            if (opt.autocomplete) o.setAutocomplete(true);
            return o;
          });
        } else if (opt.type === "integer") {
          builder.addIntegerOption((o) => {
            o.setName(opt.name).setDescription(opt.description).setRequired(opt.required);
            return o;
          });
        } else if (opt.type === "boolean") {
          builder.addBooleanOption((o) => {
            o.setName(opt.name).setDescription(opt.description).setRequired(opt.required);
            return o;
          });
        }
      }

      return builder;
    });
  }

  async shutdown(): Promise<void> {
    this.client.destroy();
  }
}

// --- Helpers ---

function richContentToEmbed(content: RichContent): EmbedBuilder {
  const embed = new EmbedBuilder();
  if (content.title) embed.setTitle(content.title);
  if (content.description) embed.setDescription(content.description);
  if (content.color != null) embed.setColor(content.color);
  if (content.footer) embed.setFooter({ text: content.footer });
  if (content.timestamp) embed.setTimestamp(content.timestamp);
  if (content.fields) {
    for (const f of content.fields) {
      embed.addFields({ name: f.name, value: f.value, inline: f.inline });
    }
  }
  return embed;
}

async function purgeDiscordChannel(channel: TextChannel): Promise<number> {
  let total = 0;
  try {
    while (true) {
      const deleted = await channel.bulkDelete(100, true);
      total += deleted.size;
      if (deleted.size < 2) break;
    }
    while (true) {
      const messages = await channel.messages.fetch({ limit: 100 });
      if (messages.size === 0) break;
      for (const msg of messages.values()) {
        try { await msg.delete(); } catch {}
      }
      total += messages.size;
    }
  } catch {}
  return total;
}
