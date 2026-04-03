/**
 * Chat service interface -- platform adapters implement this
 * so the rest of the codebase doesn't depend on any specific chat platform.
 */

export interface ChatMessage {
  id: string;
  content: string;
  authorId: string;
  authorUsername: string;
  createdAt: Date;
  attachmentCount: number;
  attachments: Array<{
    id: string;
    name: string;
    url: string;
    contentType: string | null;
    size: number;
  }>;
}

export interface RichContent {
  title?: string;
  description?: string;
  color?: number;
  fields?: Array<{ name: string; value: string; inline?: boolean }>;
  footer?: string;
  timestamp?: Date;
}

export interface ChatService {
  readonly platform: string;
  readonly maxMessageLength: number;

  sendToChannel(channelId: string, content: string): Promise<string>;
  sendRichContent(channelId: string, content: RichContent): Promise<string>;
  editMessage(channelId: string, messageId: string, content: string): Promise<void>;
  editRichContent(channelId: string, messageId: string, content: RichContent): Promise<void>;
  fetchMessage(channelId: string, messageId: string): Promise<{ id: string; content: string } | null>;
  purgeChannel(channelId: string): Promise<number>;
  fetchMessages(channelId: string, limit: number): Promise<ChatMessage[]>;
  react(channelId: string, messageId: string, emoji: string): Promise<void>;
  getBotUserId(): string | undefined;

  /** Send a message with file attachments, returns sent message IDs */
  sendWithFiles(channelId: string, content: string, files: string[], replyTo?: string): Promise<string[]>;

  /** Download attachments from a message to a local directory, returns local file paths */
  downloadAttachments(channelId: string, messageId: string, destDir: string): Promise<string[]>;

  /** Format a channel reference for this platform (e.g. <#id> on Discord) */
  formatChannelRef(channelId: string): string;

  /** Extract channel IDs from channel references in message text */
  parseChannelRefs(text: string): string[];
}

/** No-op implementation for tests. */
export class NoopChatService implements ChatService {
  readonly platform = "noop";
  readonly maxMessageLength = 2000;

  sent: Array<{ channelId: string; content: string }> = [];
  purged: string[] = [];
  private messageCounter = 0;

  async sendToChannel(channelId: string, content: string): Promise<string> {
    this.sent.push({ channelId, content });
    return `mock-msg-${++this.messageCounter}`;
  }
  async sendRichContent(channelId: string, _content: RichContent): Promise<string> {
    this.sent.push({ channelId, content: "[rich]" });
    return `mock-msg-${++this.messageCounter}`;
  }
  async editMessage(): Promise<void> {}
  async editRichContent(): Promise<void> {}
  async fetchMessage(_channelId: string, messageId: string) {
    return { id: messageId, content: "" };
  }
  async purgeChannel(channelId: string): Promise<number> {
    this.purged.push(channelId);
    return 0;
  }
  async fetchMessages(): Promise<ChatMessage[]> { return []; }
  async react(): Promise<void> {}
  getBotUserId(): string { return "mock-bot-id"; }
  async sendWithFiles(channelId: string, content: string): Promise<string[]> {
    this.sent.push({ channelId, content });
    return [`mock-msg-${++this.messageCounter}`];
  }
  async downloadAttachments(): Promise<string[]> { return []; }
  formatChannelRef(channelId: string): string { return `#${channelId}`; }
  parseChannelRefs(_text: string): string[] { return []; }
}
