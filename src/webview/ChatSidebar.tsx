import React, { useEffect, useRef, useState } from "react";

import { ChatSummary } from "../shared/protocol";

interface Props {
  open: boolean;
  chats: ChatSummary[];
  activeChatId: string | null;
  streamingIds: ReadonlySet<string>;
  onClose: () => void;
  onNewChat: () => void;
  onSelect: (chatId: string) => void;
  onRename: (chatId: string, title: string) => void;
  onDelete: (chatId: string) => void;
}

function relativeTime(timestamp: number): string {
  const seconds = Math.max(0, Math.floor((Date.now() - timestamp) / 1000));
  if (seconds < 60) {
    return "now";
  }
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) {
    return `${minutes}m ago`;
  }
  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    return `${hours}h ago`;
  }
  const days = Math.floor(hours / 24);
  if (days < 7) {
    return `${days}d ago`;
  }
  const weeks = Math.floor(days / 7);
  if (weeks < 5) {
    return `${weeks}w ago`;
  }
  return new Date(timestamp).toLocaleDateString();
}

export function ChatSidebar({
  open,
  chats,
  activeChatId,
  streamingIds,
  onClose,
  onNewChat,
  onSelect,
  onRename,
  onDelete,
}: Props) {
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const renameCancelled = useRef(false);
  const confirmTimer = useRef<number | undefined>(undefined);

  useEffect(() => {
    if (!open) {
      setRenamingId(null);
      setConfirmId(null);
      return;
    }
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        onClose();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  useEffect(() => () => window.clearTimeout(confirmTimer.current), []);

  const armDelete = (chatId: string) => {
    setConfirmId(chatId);
    window.clearTimeout(confirmTimer.current);
    confirmTimer.current = window.setTimeout(() => setConfirmId(null), 3000);
  };

  const startRename = (chat: ChatSummary) => {
    renameCancelled.current = false;
    setRenamingId(chat.id);
    setRenameValue(chat.title);
  };

  const commitRename = (chatId: string) => {
    if (renameCancelled.current) {
      renameCancelled.current = false;
      return;
    }
    const title = renameValue.trim();
    setRenamingId(null);
    if (title) {
      onRename(chatId, title);
    }
  };

  const cancelRename = () => {
    renameCancelled.current = true;
    setRenamingId(null);
  };

  return (
    <>
      <div
        className={`drawer-backdrop${open ? " open" : ""}`}
        onClick={onClose}
      />
      <aside
        className={`drawer${open ? " open" : ""}`}
        aria-label="Chats"
        inert={!open}
      >
        <div className="drawer-head">
          <span className="kicker">CHATS</span>
          <button
            className="icon-button"
            aria-label="Close chats"
            onClick={onClose}
          >
            ×
          </button>
        </div>
        <div className="chat-list">
          <button className="new-chat-row" onClick={onNewChat}>
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path d="M12 5v14M5 12h14" />
            </svg>
            New chat
          </button>
          {chats.map((chat) => {
            const renaming = renamingId === chat.id;
            return (
              <div
                className={`chat-row${chat.id === activeChatId ? " active" : ""}`}
                key={chat.id}
                role="button"
                tabIndex={0}
                onClick={() => {
                  if (!renaming) {
                    onSelect(chat.id);
                  }
                }}
                onKeyDown={(event) => {
                  if (
                    !renaming &&
                    event.target === event.currentTarget &&
                    (event.key === "Enter" || event.key === " ")
                  ) {
                    event.preventDefault();
                    onSelect(chat.id);
                  }
                }}
              >
                {streamingIds.has(chat.id) && <span className="pulse" />}
                {renaming ? (
                  <input
                    className="rename-input"
                    value={renameValue}
                    autoFocus
                    spellCheck={false}
                    onClick={(event) => event.stopPropagation()}
                    onChange={(event) => setRenameValue(event.target.value)}
                    onBlur={() => commitRename(chat.id)}
                    onKeyDown={(event) => {
                      event.stopPropagation();
                      if (event.key === "Enter") {
                        event.preventDefault();
                        commitRename(chat.id);
                      } else if (event.key === "Escape") {
                        cancelRename();
                      }
                    }}
                  />
                ) : (
                  <>
                    <span className="chat-title">{chat.title}</span>
                    <span className="chat-when">
                      {relativeTime(chat.updatedAt)}
                    </span>
                    {confirmId === chat.id ? (
                      <button
                        className="confirm-delete"
                        onClick={(event) => {
                          event.stopPropagation();
                          window.clearTimeout(confirmTimer.current);
                          setConfirmId(null);
                          onDelete(chat.id);
                        }}
                      >
                        Delete?
                      </button>
                    ) : (
                      <span className="row-actions">
                        <button
                          className="icon-button"
                          aria-label="Rename chat"
                          onClick={(event) => {
                            event.stopPropagation();
                            startRename(chat);
                          }}
                        >
                          <svg viewBox="0 0 24 24" aria-hidden="true">
                            <path d="m14 6 4 4M5 19l1-4L16.5 4.5a2.121 2.121 0 0 1 3 3L9 18l-4 1Z" />
                          </svg>
                        </button>
                        <button
                          className="icon-button"
                          aria-label="Delete chat"
                          onClick={(event) => {
                            event.stopPropagation();
                            armDelete(chat.id);
                          }}
                        >
                          <svg viewBox="0 0 24 24" aria-hidden="true">
                            <path d="M4 7h16M9 7V5h6v2M6.5 7l1 13h9l1-13M10 11v5.5M14 11v5.5" />
                          </svg>
                        </button>
                      </span>
                    )}
                  </>
                )}
              </div>
            );
          })}
          {chats.length === 0 && (
            <div className="chat-list-empty">No chats yet.</div>
          )}
        </div>
      </aside>
    </>
  );
}
