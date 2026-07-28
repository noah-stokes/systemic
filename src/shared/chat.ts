import type { ThreadMessage } from "./protocol";

export type HistoryItem = {
  role: "user" | "assistant";
  content: string;
};

const isNote = (message: ThreadMessage): boolean =>
  message.kind === "text" &&
  (message as ThreadMessage & { note?: boolean }).note === true;

export function buildHistory(messages: ThreadMessage[]): HistoryItem[] {
  const entries = messages
    .flatMap((message): HistoryItem[] => {
      if (message.kind === "cards") {
        return [
          {
            role: "assistant",
            content: `Design options shown in the UI, in display order:\n${JSON.stringify(message.result)}`,
          },
        ];
      }
      if (message.kind === "questions") {
        return [
          {
            role: "assistant",
            content: `Clarifying questions asked in the UI:\n${message.questions
              .map((question, index) => `${index + 1}. ${question}`)
              .join("\n")}`,
          },
        ];
      }
      if (message.error || isNote(message) || !message.content.trim()) {
        return [];
      }
      return [{ role: message.role, content: message.content }];
    })
    .slice(-40);

  const history: HistoryItem[] = [];
  let total = 0;
  for (let index = entries.length - 1; index >= 0; index--) {
    const entry = entries[index];
    if (history.length > 0 && total + entry.content.length > 24_000) {
      break;
    }
    total += entry.content.length;
    history.unshift(entry);
  }
  return history;
}

// exclusive drops the target message too — editing a message resends new text
// in its place, rerunning one keeps it.
export function retryMessages(
  messages: ThreadMessage[],
  userMessageId: string,
  exclusive = false,
): ThreadMessage[] {
  const index = messages.findIndex((message) => message.id === userMessageId);
  return index < 0 ? messages : messages.slice(0, exclusive ? index : index + 1);
}
