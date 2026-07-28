import DOMPurify from "dompurify";
import { marked } from "marked";
import React, {
  FormEvent,
  MouseEvent,
  useCallback,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
} from "react";

import { quoteLabels } from "../shared/mermaid";
import { ChatSidebar } from "./ChatSidebar";
import { OptionCards } from "./OptionCards";
import { QuestionCard } from "./QuestionCard";
import { Settings } from "./Settings";
import { vscodeApi } from "./index";
import {
  BackendStatus,
  ChatRecord,
  ChatSummary,
  HostToWebview,
  StreamEvent,
  TextMessage,
  ThreadMessage,
  WebviewToHost,
  parseStreamEvent,
} from "../shared/protocol";
import { buildHistory, retryMessages } from "../shared/chat";

marked.setOptions({ breaks: true, gfm: true });

type NoteMessage = TextMessage & { note?: boolean };

type Theme = "dark" | "light";

interface ChatSession {
  messages: ThreadMessage[];
  pending: boolean;
  activity?: string;
}

interface State {
  sidebar: ChatSummary[];
  activeChatId: string | null;
  sessions: Record<string, ChatSession>;
  backend: BackendStatus;
  drawerOpen: boolean;
}

type Action =
  | {
      type: "init";
      chats: ChatSummary[];
      activeChatId: string | null;
      activeChat: ChatRecord | null;
      backend: BackendStatus;
    }
  | { type: "chatsChanged"; chats: ChatSummary[]; activeChatId: string | null }
  | { type: "chatLoaded"; chat: ChatRecord }
  | { type: "newChat"; chat: ChatRecord }
  | { type: "selectChat"; chatId: string }
  | { type: "send"; chatId: string; message: string }
  | {
      type: "retry";
      chatId: string;
      userMessageId: string;
      exclusive?: boolean;
    }
  | { type: "stream"; chatId: string; event: StreamEvent }
  | { type: "rename"; chatId: string; title: string }
  | { type: "delete"; chatId: string }
  | { type: "drawer"; open: boolean }
  | { type: "backend"; status: BackendStatus };

const defaultBackend: BackendStatus = {
  state: "stopped",
  hasApiKey: false,
  chatModel: "anthropic/claude-sonnet-5",
  workerModel: "anthropic/claude-haiku-4.5",
  port: 8321,
  models: [],
};

const post = (message: WebviewToHost) => vscodeApi.postMessage(message);

const emptySession = (): ChatSession => ({ messages: [], pending: false });

const summaryOf = (chat: ChatRecord | ChatSummary): ChatSummary => ({
  id: chat.id,
  title: chat.title,
  createdAt: chat.createdAt,
  updatedAt: chat.updatedAt,
});

const isNote = (message: ThreadMessage): boolean =>
  message.kind === "text" && (message as NoteMessage).note === true;

function titleFrom(message: string): string {
  const line = message.trim().split("\n", 1)[0].trim();
  if (!line) {
    return "New chat";
  }
  return line.length > 48 ? `${line.slice(0, 48)}…` : line;
}

function closeOpen(messages: ThreadMessage[]): ThreadMessage[] {
  return messages.map((message) =>
    message.kind === "text" && message.open
      ? { ...message, open: false }
      : message,
  );
}

function stripOpen(message: ThreadMessage): ThreadMessage {
  if (message.kind !== "text" || message.open === undefined) {
    return message;
  }
  const { open: _open, ...rest } = message;
  return rest;
}

function withSession(
  state: State,
  chatId: string,
  update: (session: ChatSession) => ChatSession,
): State {
  const session = state.sessions[chatId] ?? emptySession();
  return {
    ...state,
    sessions: { ...state.sessions, [chatId]: update(session) },
  };
}

function reducer(state: State, action: Action): State {
  switch (action.type) {
    case "init": {
      const sessions = { ...state.sessions };
      if (action.activeChat && !sessions[action.activeChat.id]) {
        sessions[action.activeChat.id] = {
          messages: action.activeChat.messages,
          pending: false,
        };
      }
      return {
        ...state,
        sidebar: action.chats,
        activeChatId: action.activeChatId,
        sessions,
        backend: action.backend,
      };
    }
    case "chatsChanged": {
      const ids = new Set(action.chats.map((chat) => chat.id));
      const keepLocal =
        state.activeChatId !== null &&
        (ids.has(state.activeChatId) || state.activeChatId in state.sessions);
      return {
        ...state,
        sidebar: action.chats,
        activeChatId: keepLocal ? state.activeChatId : action.activeChatId,
      };
    }
    case "chatLoaded": {
      const sidebar = state.sidebar.some((chat) => chat.id === action.chat.id)
        ? state.sidebar.map((chat) =>
            chat.id === action.chat.id ? summaryOf(action.chat) : chat,
          )
        : [summaryOf(action.chat), ...state.sidebar];
      const sessions = state.sessions[action.chat.id]
        ? state.sessions
        : {
            ...state.sessions,
            [action.chat.id]: {
              messages: action.chat.messages,
              pending: false,
            },
          };
      return { ...state, sidebar, sessions };
    }
    case "newChat":
      return {
        ...state,
        sidebar: [summaryOf(action.chat), ...state.sidebar],
        sessions: {
          ...state.sessions,
          [action.chat.id]: { messages: action.chat.messages, pending: false },
        },
        activeChatId: action.chat.id,
        drawerOpen: false,
      };
    case "selectChat":
      return { ...state, activeChatId: action.chatId, drawerOpen: false };
    case "send": {
      const session = state.sessions[action.chatId] ?? emptySession();
      const hasUserMessage = session.messages.some(
        (message) => message.kind === "text" && message.role === "user",
      );
      const sidebar = state.sidebar.map((chat) => {
        if (chat.id !== action.chatId) {
          return chat;
        }
        const title =
          !hasUserMessage && chat.title === "New chat"
            ? titleFrom(action.message)
            : chat.title;
        return { ...chat, title, updatedAt: Date.now() };
      });
      return {
        ...state,
        sidebar,
        sessions: {
          ...state.sessions,
          [action.chatId]: {
            messages: [
              ...session.messages,
              {
                id: crypto.randomUUID(),
                kind: "text",
                role: "user",
                content: action.message,
              },
            ],
            pending: true,
            activity: undefined,
          },
        },
      };
    }
    case "retry":
      return withSession(state, action.chatId, (session) => ({
        messages: retryMessages(
          session.messages,
          action.userMessageId,
          action.exclusive,
        ),
        pending: true,
        activity: undefined,
      }));
    case "stream": {
      const event = action.event;
      return withSession(state, action.chatId, (session) => {
        switch (event.type) {
          case "status":
            return { ...session, activity: event.message };
          case "token": {
            const messages = [...session.messages];
            const last = messages.at(-1);
            if (
              last?.kind === "text" &&
              last.role === "assistant" &&
              last.open
            ) {
              messages[messages.length - 1] = {
                ...last,
                content: last.content + event.text,
              };
            } else {
              messages.push({
                id: crypto.randomUUID(),
                kind: "text",
                role: "assistant",
                content: event.text,
                open: true,
              });
            }
            return { ...session, activity: undefined, messages };
          }
          case "cards":
            return {
              ...session,
              activity: undefined,
              messages: [
                ...session.messages,
                { id: crypto.randomUUID(), kind: "cards", result: event.data },
              ],
            };
          case "questions":
            return {
              ...session,
              activity: undefined,
              messages: [
                ...session.messages,
                {
                  id: crypto.randomUUID(),
                  kind: "questions",
                  questions: event.data,
                },
              ],
            };
          case "done":
            return {
              messages: closeOpen(session.messages),
              pending: false,
              activity: undefined,
            };
          case "aborted": {
            const note: NoteMessage = {
              id: crypto.randomUUID(),
              kind: "text",
              role: "assistant",
              content: "Generation stopped.",
              note: true,
            };
            return {
              messages: [...closeOpen(session.messages), note],
              pending: false,
              activity: undefined,
            };
          }
          case "error":
            return {
              messages: [
                ...closeOpen(session.messages),
                {
                  id: crypto.randomUUID(),
                  kind: "text",
                  role: "assistant",
                  content: `Error: ${event.message}`,
                  error: true,
                },
              ],
              pending: false,
              activity: undefined,
            };
        }
      });
    }
    case "rename":
      return {
        ...state,
        sidebar: state.sidebar.map((chat) =>
          chat.id === action.chatId ? { ...chat, title: action.title } : chat,
        ),
      };
    case "delete": {
      const sessions = { ...state.sessions };
      delete sessions[action.chatId];
      return {
        ...state,
        sidebar: state.sidebar.filter((chat) => chat.id !== action.chatId),
        sessions,
        activeChatId:
          state.activeChatId === action.chatId ? null : state.activeChatId,
      };
    }
    case "drawer":
      return { ...state, drawerOpen: action.open };
    case "backend":
      return { ...state, backend: action.status };
  }
}

function bodyTheme(): Theme {
  const classes = document.body.classList;
  const dark =
    classes.contains("vscode-dark") ||
    (classes.contains("vscode-high-contrast") &&
      !classes.contains("vscode-high-contrast-light"));
  return dark ? "dark" : "light";
}

export function App() {
  const [state, dispatch] = useReducer(reducer, undefined, (): State => ({
    sidebar: [],
    activeChatId: null,
    sessions: {},
    backend: defaultBackend,
    drawerOpen:
      vscodeApi.getState<{ drawerOpen?: boolean }>()?.drawerOpen === true,
  }));
  const [draft, setDraft] = useState("");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [hint, setHint] = useState<string | null>(null);
  const [showJump, setShowJump] = useState(false);
  const [theme, setTheme] = useState<Theme>(bodyTheme);
  const scrollRef = useRef<HTMLElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const stuckRef = useRef(true);
  const saveNeeded = useRef(new Set<string>());

  const activeSession = state.activeChatId
    ? state.sessions[state.activeChatId]
    : undefined;
  const messages = activeSession?.messages ?? [];
  const pending = activeSession?.pending ?? false;
  const activity = activeSession?.activity;

  const streamingIds = useMemo(
    () =>
      new Set(
        Object.keys(state.sessions).filter(
          (chatId) => state.sessions[chatId].pending,
        ),
      ),
    [state.sessions],
  );

  const newChat = useCallback(() => {
    const now = Date.now();
    const chat: ChatRecord = {
      id: crypto.randomUUID(),
      title: "New chat",
      createdAt: now,
      updatedAt: now,
      messages: [],
    };
    dispatch({ type: "newChat", chat });
    post({ type: "createChat", chat });
    return chat;
  }, []);

  useEffect(() => {
    const listener = (event: MessageEvent) => {
      const data = event.data as HostToWebview | undefined;
      if (!data || typeof data !== "object") {
        return;
      }
      switch (data.type) {
        case "init":
          dispatch({
            type: "init",
            chats: data.chats,
            activeChatId: data.activeChatId,
            activeChat: data.activeChat,
            backend: data.backend,
          });
          break;
        case "chatsChanged":
          dispatch({
            type: "chatsChanged",
            chats: data.chats,
            activeChatId: data.activeChatId,
          });
          break;
        case "chatLoaded":
          dispatch({ type: "chatLoaded", chat: data.chat });
          break;
        case "backendStatus":
          dispatch({ type: "backend", status: data.status });
          break;
        case "hostCommand":
          if (data.command === "newChat") {
            newChat();
          }
          break;
        case "stream": {
          const parsed = parseStreamEvent(data.line);
          if (parsed) {
            dispatch({ type: "stream", chatId: data.chatId, event: parsed });
            if (
              parsed.type === "done" ||
              parsed.type === "error" ||
              parsed.type === "aborted" ||
              parsed.type === "cards" ||
              parsed.type === "questions"
            ) {
              saveNeeded.current.add(data.chatId);
            }
          } else if (data.line.trim()) {
            try {
              JSON.parse(data.line);
            } catch {
              dispatch({
                type: "stream",
                chatId: data.chatId,
                event: { type: "error", message: "Invalid backend event." },
              });
              saveNeeded.current.add(data.chatId);
            }
          }
          break;
        }
      }
    };
    window.addEventListener("message", listener);
    post({ type: "ready" });
    return () => window.removeEventListener("message", listener);
  }, [newChat]);

  useEffect(() => {
    const observer = new MutationObserver(() => setTheme(bodyTheme()));
    observer.observe(document.body, {
      attributes: true,
      attributeFilter: ["class"],
    });
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    vscodeApi.setState({
      activeChatId: state.activeChatId,
      drawerOpen: state.drawerOpen,
    });
  }, [state.activeChatId, state.drawerOpen]);

  useEffect(() => {
    if (saveNeeded.current.size === 0) {
      return;
    }
    const chatIds = [...saveNeeded.current];
    saveNeeded.current.clear();
    for (const chatId of chatIds) {
      const summary = state.sidebar.find((chat) => chat.id === chatId);
      const session = state.sessions[chatId];
      if (!summary || !session) {
        continue;
      }
      post({
        type: "saveChat",
        chat: {
          id: summary.id,
          title: summary.title,
          createdAt: summary.createdAt,
          updatedAt: Date.now(),
          messages: session.messages.map(stripOpen),
        },
      });
    }
  });

  useEffect(() => {
    if (state.backend.state === "ready" && state.backend.hasApiKey) {
      setHint(null);
    }
  }, [state.backend.state, state.backend.hasApiKey]);

  useEffect(() => {
    // leaving the chat abandons the edit — the thread is only truncated on send
    setEditingId(null);
    stuckRef.current = true;
    setShowJump(false);
    const el = scrollRef.current;
    if (el) {
      el.scrollTop = el.scrollHeight;
    }
  }, [state.activeChatId]);

  useEffect(() => {
    const el = scrollRef.current;
    if (el && stuckRef.current) {
      el.scrollTop = el.scrollHeight;
    }
  }, [messages, activity]);

  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) {
      return;
    }
    const near = el.scrollHeight - el.scrollTop - el.clientHeight < 48;
    stuckRef.current = near;
    setShowJump(!near);
  };

  const jumpToLatest = () => {
    const el = scrollRef.current;
    if (el) {
      el.scrollTop = el.scrollHeight;
    }
    stuckRef.current = true;
    setShowJump(false);
  };

  const blockedHint = (): string | null => {
    if (!state.backend.hasApiKey) {
      return "Set API key first.";
    }
    if (state.backend.state === "ready") {
      return null;
    }
    return state.backend.state === "starting"
      ? "Backend starting…"
      : "Backend not running — restart it from settings.";
  };

  // truncateFromId: an edited message — everything from it on is replaced by
  // the new text, so the turn is resent in its place rather than appended.
  const send = (value: string, truncateFromId?: string) => {
    const message = value.trim();
    if (!message) {
      return;
    }
    const blocked = blockedHint();
    if (blocked) {
      setHint(blocked);
      return;
    }
    let chatId = state.activeChatId;
    if (chatId && state.sessions[chatId]?.pending) {
      return;
    }
    let priorMessages = chatId ? (state.sessions[chatId]?.messages ?? []) : [];
    if (!chatId) {
      chatId = newChat().id;
      priorMessages = [];
    }
    if (truncateFromId) {
      priorMessages = retryMessages(priorMessages, truncateFromId, true);
      dispatch({
        type: "retry",
        chatId,
        userMessageId: truncateFromId,
        exclusive: true,
      });
    }
    dispatch({ type: "send", chatId, message });
    setEditingId(null);
    saveNeeded.current.add(chatId);
    post({
      type: "chat",
      chatId,
      message,
      history: buildHistory(priorMessages),
    });
    setDraft("");
    setHint(null);
    const el = textareaRef.current;
    if (el) {
      el.style.height = "auto";
    }
  };

  const rerunFrom = (chatId: string, messageId: string) => {
    const session = state.sessions[chatId];
    if (!session || session.pending) {
      return;
    }
    const blocked = blockedHint();
    if (blocked) {
      setHint(blocked);
      return;
    }
    const fromIndex = session.messages.findIndex(
      (message) => message.id === messageId,
    );
    if (fromIndex < 0) {
      return;
    }
    const from = session.messages[fromIndex];
    // Rerunning a user message reruns that turn — walking back from
    // fromIndex - 1 would resend the turn before it instead.
    const isUser = from.kind === "text" && from.role === "user" && !from.error;
    let userIndex = isUser ? fromIndex : -1;
    for (let index = fromIndex - 1; userIndex < 0 && index >= 0; index--) {
      const message = session.messages[index];
      if (
        message.kind === "text" &&
        message.role === "user" &&
        !message.error
      ) {
        userIndex = index;
      }
    }
    if (userIndex < 0) {
      return;
    }
    const userMessage = session.messages[userIndex] as TextMessage;
    dispatch({
      type: "retry",
      chatId,
      userMessageId: userMessage.id,
    });
    saveNeeded.current.add(chatId);
    post({
      type: "chat",
      chatId,
      message: userMessage.content,
      history: buildHistory(session.messages.slice(0, userIndex)),
    });
  };

  const selectChat = (chatId: string) => {
    dispatch({ type: "selectChat", chatId });
    post({ type: "selectChat", chatId });
  };

  const stop = () => {
    if (state.activeChatId) {
      post({ type: "stopGeneration", chatId: state.activeChatId });
    }
  };

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (pending) {
      return;
    }
    send(draft, editingId ?? undefined);
  };

  const startEdit = (message: TextMessage) => {
    if (pending) {
      return;
    }
    setDraft(message.content);
    setEditingId(message.id);
    textareaRef.current?.focus();
  };

  const messageActions = (message: ThreadMessage) => {
    const chatId = state.activeChatId;
    if (!chatId) {
      return null;
    }
    const text =
      message.kind === "cards"
        ? JSON.stringify(message.result, null, 2)
        : message.kind === "text"
          ? message.content
          : "";
    return (
      <div className="message-actions">
        <button
          className="msg-action"
          disabled={pending}
          title="Copy message"
          aria-label="Copy message"
          onClick={() => post({ type: "copyText", text })}
        >
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <rect x="8" y="8" width="11" height="11" rx="2" />
            <path d="M16 8V7a2 2 0 0 0-2-2H7a2 2 0 0 0-2 2v7a2 2 0 0 0 2 2h1" />
          </svg>
        </button>
        <button
          className="msg-action"
          disabled={pending}
          title="Rerun from this message"
          aria-label="Rerun from this message"
          onClick={() => rerunFrom(chatId, message.id)}
        >
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="M20 7v5h-5M19 12a7 7 0 1 0-2.1 5" />
          </svg>
        </button>
        {message.kind === "text" && message.role === "user" && (
          <button
            className="msg-action"
            disabled={pending}
            title="Edit and resend"
            aria-label="Edit and resend"
            onClick={() => startEdit(message)}
          >
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path d="m14 6 4 4M5 19l1-4L16.5 4.5a2.121 2.121 0 0 1 3 3L9 18l-4 1Z" />
            </svg>
          </button>
        )}
      </div>
    );
  };

  const last = messages.at(-1);
  const streamingOpen =
    last?.kind === "text" && last.role === "assistant" && last.open === true;
  const showThinking = pending && !activity && !streamingOpen;
  const chatting = messages.length > 0;

  return (
    <div className="app">
      <header className="header">
        <button
          className="icon-button"
          aria-label="Open chats"
          onClick={() => dispatch({ type: "drawer", open: !state.drawerOpen })}
        >
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="M4 6.5h16M4 12h16M4 17.5h16" />
          </svg>
        </button>
        <div className="mark" />
        <span className="brand">SYSTEMIC</span>
        <span
          className={`status-dot ${state.backend.state}`}
          title={state.backend.detail}
        />
        <span className="spacer" />
        <button
          className="icon-button"
          aria-label="New chat"
          onClick={() => newChat()}
        >
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="M12 5v14M5 12h14" />
          </svg>
        </button>
        <button
          className="icon-button"
          aria-label="Open settings"
          onClick={() => setSettingsOpen((open) => !open)}
        >
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <circle cx="12" cy="12" r="3" />
            <path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1-2.8 2.8-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.6v.2h-4V21a1.7 1.7 0 0 0-1-1.6 1.7 1.7 0 0 0-1.9.3l-.1.1L4.2 17l.1-.1a1.7 1.7 0 0 0 .3-1.9A1.7 1.7 0 0 0 3 14H2.8v-4H3a1.7 1.7 0 0 0 1.6-1 1.7 1.7 0 0 0-.3-1.9L4.2 7 7 4.2l.1.1A1.7 1.7 0 0 0 9 4.6 1.7 1.7 0 0 0 10 3v-.2h4V3a1.7 1.7 0 0 0 1 1.6 1.7 1.7 0 0 0 1.9-.3l.1-.1L19.8 7l-.1.1a1.7 1.7 0 0 0-.3 1.9 1.7 1.7 0 0 0 1.6 1h.2v4H21a1.7 1.7 0 0 0-1.6 1Z" />
          </svg>
        </button>
      </header>

      <ChatSidebar
        open={state.drawerOpen}
        chats={state.sidebar}
        activeChatId={state.activeChatId}
        streamingIds={streamingIds}
        onClose={() => dispatch({ type: "drawer", open: false })}
        onNewChat={() => newChat()}
        onSelect={selectChat}
        onRename={(chatId, title) => {
          dispatch({ type: "rename", chatId, title });
          post({ type: "renameChat", chatId, title });
        }}
        onDelete={(chatId) => {
          dispatch({ type: "delete", chatId });
          post({ type: "deleteChat", chatId });
        }}
      />

      {settingsOpen && (
        <Settings
          status={state.backend}
          onClose={() => setSettingsOpen(false)}
          onSetApiKey={() => post({ type: "setApiKey" })}
          onRestart={() => post({ type: "restartBackend" })}
          onSetSetting={(key, value) =>
            post({ type: "setSetting", key, value })
          }
        />
      )}

      <div className="main-wrap">
        <main ref={scrollRef} onScroll={onScroll}>
          {!chatting ? (
            <section className="empty">
              <div>
                <svg
                  className="logo"
                  width="42"
                  height="42"
                  viewBox="0 0 40 40"
                  fill="none"
                  stroke="currentColor"
                >
                  <path d="M20 8 8 30h24Z" opacity=".3" />
                  <circle
                    cx="20"
                    cy="8"
                    r="3"
                    fill="currentColor"
                    stroke="none"
                  />
                  <circle
                    cx="8"
                    cy="30"
                    r="3"
                    fill="currentColor"
                    stroke="none"
                  />
                  <circle
                    cx="32"
                    cy="30"
                    r="3"
                    fill="currentColor"
                    stroke="none"
                  />
                </svg>
                <h1>Design the system.</h1>
                <p className="subtitle">
                  Your pair for architecture. Explore tradeoffs and reason about
                  scale, grounded in your repository.
                </p>
              </div>
              <div>
                <div className="kicker">START WITH</div>
                <div className="starts">
                  {[
                    "Map the architecture of this repository",
                    "Compare approaches for my next feature",
                    "Find bottlenecks in this service",
                  ].map((prompt) => (
                    <button
                      className="chip"
                      key={prompt}
                      disabled={state.backend.state !== "ready"}
                      onClick={() => send(prompt)}
                    >
                      {prompt}
                      <span>→</span>
                    </button>
                  ))}
                </div>
              </div>
            </section>
          ) : (
            <section className="thread">
              {messages.map((message) =>
                message.kind === "questions" ? (
                  <QuestionCard
                    key={message.id}
                    questions={message.questions}
                    disabled={pending}
                    onSubmit={send}
                  />
                ) : message.kind === "cards" ? (
                  <div className="cards-block" key={message.id}>
                    <OptionCards
                      result={message.result}
                      onOpenSource={(source) =>
                        post({ type: "openExternal", href: source })
                      }
                      onDraft={(option) =>
                        send(`Draft the "${option.title}" approach.`)
                      }
                    />
                    {messageActions(message)}
                  </div>
                ) : (
                  <article
                    className={`message ${message.role}${
                      message.error ? " error" : ""
                    }${isNote(message) ? " note" : ""}`}
                    key={message.id}
                  >
                    {message.role === "assistant" && !isNote(message) && (
                      <span className="bot-dot" />
                    )}
                    {message.role === "assistant" && !isNote(message) ? (
                      <Markdown
                        content={message.content}
                        renderDiagrams={!message.open}
                        theme={theme}
                      />
                    ) : (
                      message.content
                    )}
                    {message.error && state.activeChatId && (
                      <button
                        className="retry-button"
                        title="Retry message"
                        aria-label="Retry message"
                        onClick={() =>
                          rerunFrom(state.activeChatId!, message.id)
                        }
                      >
                        <svg viewBox="0 0 24 24" aria-hidden="true">
                          <path d="M20 7v5h-5M19 12a7 7 0 1 0-2.1 5" />
                        </svg>
                      </button>
                    )}
                    {!message.error &&
                      !isNote(message) &&
                      messageActions(message)}
                  </article>
                ),
              )}
              {(activity || showThinking) && (
                <div className="activity" aria-live="polite">
                  <span className="pulse" />
                  {activity ?? "Thinking"}
                  {showThinking && <span className="dots" />}
                </div>
              )}
            </section>
          )}
        </main>
        {showJump && pending && (
          <button className="jump-pill" onClick={jumpToLatest}>
            ↓ Latest
          </button>
        )}
      </div>

      {!state.backend.hasApiKey && (
        <div className="backend-banner">
          <span>OpenRouter API key required.</span>
          <button onClick={() => post({ type: "setApiKey" })}>
            Set API key
          </button>
        </div>
      )}
      {state.backend.hasApiKey && state.backend.state === "failed" && (
        <div className="backend-banner error">
          <span>{state.backend.detail ?? "Backend failed."}</span>
          <button onClick={() => post({ type: "restartBackend" })}>
            Restart
          </button>
        </div>
      )}

      <form className="footer" onSubmit={submit}>
        <div className="composer">
          <textarea
            ref={textareaRef}
            rows={1}
            value={draft}
            onChange={(event) => {
              setDraft(event.target.value);
              if (!event.target.value.trim()) {
                setEditingId(null);
              }
              const el = event.currentTarget;
              el.style.height = "auto";
              el.style.height = `${Math.min(el.scrollHeight, 160)}px`;
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                submit(event);
              }
            }}
            placeholder={
              state.backend.state === "ready"
                ? "Ask about a system…"
                : "Waiting for backend…"
            }
          />
          <div className="composer-tools">
            <span className="model-name">
              {shortModel(state.backend.chatModel)}
            </span>
            {pending ? (
              <button
                className="send"
                type="button"
                onClick={stop}
                aria-label="Stop generation"
              >
                <svg viewBox="0 0 15 15" aria-hidden="true">
                  <rect
                    x="4"
                    y="4"
                    width="7"
                    height="7"
                    rx="1"
                    fill="currentColor"
                    stroke="none"
                  />
                </svg>
              </button>
            ) : (
              <button
                className="send"
                type="submit"
                disabled={!draft.trim()}
                aria-label="Send"
              >
                <svg viewBox="0 0 15 15" aria-hidden="true">
                  <path d="M7.5 12V3.5M3.8 7.2l3.7-3.8 3.7 3.8" />
                </svg>
              </button>
            )}
          </div>
        </div>
        {hint && <div className="composer-hint">{hint}</div>}
      </form>
    </div>
  );
}

const diagramId = () =>
  `systemic-mermaid-${crypto.randomUUID().replaceAll("-", "")}`;

function Markdown({
  content,
  renderDiagrams,
  theme,
}: {
  content: string;
  renderDiagrams: boolean;
  theme: Theme;
}) {
  const root = useRef<HTMLDivElement>(null);
  const html = useMemo(
    () => DOMPurify.sanitize(marked.parse(content) as string),
    [content],
  );

  useEffect(() => {
    const container = root.current;
    if (!container || !renderDiagrams) {
      return;
    }
    const blocks = () => [
      ...container.querySelectorAll<HTMLElement>("pre code.language-mermaid"),
    ];
    if (blocks().length === 0) {
      return;
    }
    let cancelled = false;
    const render = async () => {
      const { default: mermaid } = await import("mermaid");
      if (cancelled) {
        return;
      }
      mermaid.initialize({
        startOnLoad: false,
        securityLevel: "strict",
        theme: theme === "dark" ? "dark" : "neutral",
        suppressErrorRendering: true,
        // Labels must be SVG <text>, not <foreignObject> HTML — the SVG-only
        // sanitize below strips foreignObject and leaves empty shapes.
        htmlLabels: false,
        flowchart: { htmlLabels: false },
      });
      container
        .querySelectorAll(".mermaid-diagram")
        .forEach((diagram) => diagram.remove());
      // Re-query: loading the mermaid chunk takes long enough that the
      // markdown HTML can have been replaced, detaching the nodes we found
      // above — inserting next to those would silently render into nothing.
      for (const code of blocks()) {
        const pre = code.parentElement;
        if (!pre) {
          continue;
        }
        const source = code.textContent ?? "";
        try {
          let svg: string;
          try {
            svg = (await mermaid.render(diagramId(), source)).svg;
          } catch {
            svg = (await mermaid.render(diagramId(), quoteLabels(source))).svg;
          }
          if (cancelled) {
            return;
          }
          const diagram = document.createElement("div");
          diagram.className = "mermaid-diagram";
          diagram.innerHTML = DOMPurify.sanitize(svg, {
            USE_PROFILES: { svg: true, svgFilters: true },
          });
          pre.classList.add("mermaid-source");
          pre.classList.remove("mermaid-error");
          pre.insertAdjacentElement("afterend", diagram);
        } catch (error) {
          if (!cancelled) {
            pre.classList.add("mermaid-error");
            pre.title = String(error);
          }
        }
      }
    };
    // Anything that throws before the per-diagram catch above — most likely
    // the lazily loaded mermaid chunk failing to arrive — used to reject
    // unhandled, leaving the raw source on screen with no explanation.
    void render().catch((error) => {
      if (cancelled) {
        return;
      }
      for (const code of blocks()) {
        code.parentElement?.classList.add("mermaid-error");
        code.parentElement?.setAttribute("title", String(error));
      }
    });
    return () => {
      cancelled = true;
    };
  }, [html, renderDiagrams, theme]);

  // dangerouslySetInnerHTML wipes the container's children whenever the html
  // changes, so the buttons are re-injected per render instead of once.
  useEffect(() => {
    root.current?.querySelectorAll("pre").forEach((pre) => {
      const button = document.createElement("button");
      button.className = "copy-code";
      button.innerHTML =
        '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="8" y="8" width="11" height="11" rx="2"></rect><path d="M16 8V7a2 2 0 0 0-2-2H7a2 2 0 0 0-2 2v7a2 2 0 0 0 2 2h1"></path></svg>';
      button.title = "Copy code";
      button.ariaLabel = "Copy code";
      pre.append(button);
    });
  }, [html]);

  const onClick = (event: MouseEvent<HTMLDivElement>) => {
    const target = event.target as Element;
    const pre = target.closest("button.copy-code")?.closest("pre");
    if (pre) {
      // the injected button lives inside the pre — read the code, not both
      const code = pre.querySelector("code") ?? pre;
      post({ type: "copyText", text: code.textContent ?? "" });
      return;
    }
    const anchor = target.closest("a");
    if (!anchor?.href) {
      return;
    }
    event.preventDefault();
    post({ type: "openExternal", href: anchor.href });
  };

  return (
    <div
      ref={root}
      className="markdown"
      onClick={onClick}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}

function shortModel(model: string) {
  return model.split("/").at(-1)?.replaceAll("-", " ") ?? model;
}
