import * as vscode from "vscode";

import { ChatIndex, ChatRecord, ChatSummary } from "./shared/protocol";

const INDEX_KEY = "systemic.chats.index";
const CHAT_KEY_PREFIX = "systemic.chat.";
const MAX_CHATS = 50;
const MAX_MESSAGES = 200;
const MAX_TEXT_LENGTH = 64_000;

export class ChatStore {
  constructor(private readonly memento: vscode.Memento) {}

  index(): ChatIndex {
    return (
      this.memento.get<ChatIndex>(INDEX_KEY) ?? {
        version: 1,
        activeChatId: null,
        chats: [],
      }
    );
  }

  get(id: string): ChatRecord | undefined {
    return this.memento.get<ChatRecord>(CHAT_KEY_PREFIX + id);
  }

  async save(record: ChatRecord): Promise<void> {
    const normalized = this.normalize(record);
    await this.memento.update(CHAT_KEY_PREFIX + normalized.id, normalized);

    const index = this.index();
    const summary: ChatSummary = {
      id: normalized.id,
      title: normalized.title,
      createdAt: normalized.createdAt,
      updatedAt: normalized.updatedAt,
    };
    const chats = [
      summary,
      ...index.chats.filter((chat) => chat.id !== summary.id),
    ];
    chats.sort((a, b) => b.updatedAt - a.updatedAt);
    for (let i = chats.length - 1; chats.length > MAX_CHATS && i >= 0; i--) {
      if (chats[i].id === index.activeChatId || chats[i].id === summary.id) {
        continue;
      }
      const [pruned] = chats.splice(i, 1);
      await this.memento.update(CHAT_KEY_PREFIX + pruned.id, undefined);
    }
    await this.writeIndex({ ...index, chats });
  }

  async rename(id: string, title: string): Promise<void> {
    const record = this.get(id);
    if (record) {
      await this.memento.update(CHAT_KEY_PREFIX + id, { ...record, title });
    }
    const index = this.index();
    await this.writeIndex({
      ...index,
      chats: index.chats.map((chat) =>
        chat.id === id ? { ...chat, title } : chat
      ),
    });
  }

  async remove(id: string): Promise<void> {
    await this.memento.update(CHAT_KEY_PREFIX + id, undefined);
    const index = this.index();
    const chats = index.chats.filter((chat) => chat.id !== id);
    const activeChatId =
      index.activeChatId === id
        ? (chats[0]?.id ?? null)
        : index.activeChatId;
    await this.writeIndex({ version: 1, activeChatId, chats });
  }

  async setActive(id: string | null): Promise<void> {
    await this.writeIndex({ ...this.index(), activeChatId: id });
  }

  async cleanupOrphans(): Promise<void> {
    const known = new Set(
      this.index().chats.map((chat) => CHAT_KEY_PREFIX + chat.id)
    );
    for (const key of this.memento.keys()) {
      if (key.startsWith(CHAT_KEY_PREFIX) && !known.has(key)) {
        await this.memento.update(key, undefined);
      }
    }
  }

  private normalize(record: ChatRecord): ChatRecord {
    const messages = record.messages.slice(-MAX_MESSAGES).map((message) => {
      if (message.kind === "text" && message.content.length > MAX_TEXT_LENGTH) {
        return {
          ...message,
          content: message.content.slice(0, MAX_TEXT_LENGTH) + "\n\n[truncated]",
        };
      }
      return message;
    });
    return { ...record, messages };
  }

  private writeIndex(index: ChatIndex): Thenable<void> {
    return this.memento.update(INDEX_KEY, index);
  }
}
