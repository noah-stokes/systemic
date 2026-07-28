// Shared protocol types for the extension host and the webview.
// This module must not import from "vscode" and must not use DOM types.

// ---- backend status (moved from backend.ts) ----

export type BackendState = "starting" | "ready" | "failed" | "stopped";

export interface BackendStatus {
  state: BackendState;
  detail?: string;
  hasApiKey: boolean;
  chatModel: string;
  workerModel: string;
  port: number;
  models: readonly string[];
}

// ---- design cards (moved from OptionCards.tsx) ----

export interface DesignOption {
  title: string;
  details: string;
  tradeoffs: string;
  objective: string[];
  effort: string;
  risks: string[];
  ships_as_is: boolean;
  // Card spec. Optional: chats saved before these existed replay without them.
  pipeline?: string[];
  points?: string[];
  build?: string;
  ceiling?: string;
  cost?: string;
}

export interface SolveResult {
  options: DesignOption[];
  comparison: {
    differences?: string;
    recommendation?: string;
    duplicate_groups?: string[][];
  };
  evidence: string[];
  sources: string[];
}

// ---- thread messages (moved from App.tsx, unchanged shapes) ----

export type TextMessage = {
  id: string;
  kind: "text";
  role: "user" | "assistant";
  content: string;
  open?: boolean;
  error?: boolean;
};

export type CardsMessage = {
  id: string;
  kind: "cards";
  result: SolveResult;
};

export type QuestionsMessage = {
  id: string;
  kind: "questions";
  questions: string[];
};

export type ThreadMessage = TextMessage | CardsMessage | QuestionsMessage;

// ---- chat storage ----

export interface ChatSummary {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
}

export interface ChatRecord extends ChatSummary {
  messages: ThreadMessage[];
}

export interface ChatIndex {
  version: 1;
  activeChatId: string | null;
  chats: ChatSummary[];
} // ordered updatedAt desc

// ---- stream events ----

export type StreamEvent =
  | { type: "status"; message: string }
  | { type: "token"; text: string }
  | { type: "cards"; data: SolveResult }
  | { type: "questions"; data: string[] }
  | { type: "done" }
  | { type: "aborted" }
  | { type: "error"; message: string };

// ---- webview -> host ----

export type WebviewToHost =
  | { type: "ready" }
  | {
      type: "chat";
      chatId: string;
      message: string;
      history: { role: "user" | "assistant"; content: string }[];
    }
  | { type: "stopGeneration"; chatId: string }
  | { type: "createChat"; chat: ChatRecord }
  | { type: "selectChat"; chatId: string }
  | { type: "renameChat"; chatId: string; title: string }
  | { type: "deleteChat"; chatId: string }
  | { type: "saveChat"; chat: ChatRecord }
  | { type: "setApiKey" }
  | { type: "restartBackend" }
  | { type: "setSetting"; key: "chatModel" | "workerModel"; value: string }
  | { type: "openExternal"; href: string }
  | { type: "copyText"; text: string };

// ---- host -> webview ----

export type HostToWebview =
  | {
      type: "init";
      chats: ChatSummary[];
      activeChatId: string | null;
      activeChat: ChatRecord | null;
      backend: BackendStatus;
    }
  | { type: "chatsChanged"; chats: ChatSummary[]; activeChatId: string | null }
  | { type: "chatLoaded"; chat: ChatRecord }
  | { type: "stream"; chatId: string; line: string }
  | { type: "backendStatus"; status: BackendStatus }
  | { type: "hostCommand"; command: "newChat" };

// ---- stream event parsing ----

export function parseStreamEvent(line: string): StreamEvent | null {
  try {
    const event = JSON.parse(line) as
      ({ type?: unknown } & Record<string, unknown>) | null;
    if (event === null || typeof event !== "object") {
      return null;
    }
    switch (event.type) {
      case "status":
      case "error":
        return typeof event.message === "string"
          ? (event as unknown as StreamEvent)
          : null;
      case "token":
        return typeof event.text === "string"
          ? (event as unknown as StreamEvent)
          : null;
      case "cards":
        return typeof event.data === "object" && event.data !== null
          ? (event as unknown as StreamEvent)
          : null;
      case "questions":
        return Array.isArray(event.data) &&
          event.data.every((item) => typeof item === "string")
          ? (event as unknown as StreamEvent)
          : null;
      case "done":
      case "aborted":
        return { type: event.type };
      default:
        return null;
    }
  } catch {
    return null;
  }
}
