import React, { useEffect, useState } from "react";

import { BackendStatus } from "../shared/protocol";

interface Props {
  status: BackendStatus;
  onClose: () => void;
  onSetApiKey: () => void;
  onRestart: () => void;
  onSetSetting: (key: "chatModel" | "workerModel", value: string) => void;
}

export function Settings({
  status,
  onClose,
  onSetApiKey,
  onRestart,
  onSetSetting,
}: Props) {
  const [chatModel, setChatModel] = useState(status.chatModel);
  const [workerModel, setWorkerModel] = useState(status.workerModel);

  useEffect(() => setChatModel(status.chatModel), [status.chatModel]);
  useEffect(() => setWorkerModel(status.workerModel), [status.workerModel]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        onClose();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const modelField = (
    label: string,
    setting: "chatModel" | "workerModel",
    value: string,
    setValue: (value: string) => void,
  ) => (
    <label className="setting-field">
      <span>{label}</span>
      <select
        value={status.models.includes(value) ? value : ""}
        onChange={(event) => {
          if (event.target.value) {
            setValue(event.target.value);
            onSetSetting(setting, event.target.value);
          }
        }}
      >
        <option value="">Custom model ID</option>
        {status.models.map((model) => (
          <option value={model} key={model}>
            {model}
          </option>
        ))}
      </select>
      <input
        value={value}
        onChange={(event) => setValue(event.target.value)}
        onBlur={() => value.trim() && onSetSetting(setting, value)}
        onKeyDown={(event) => {
          if (event.key === "Enter" && value.trim()) {
            event.currentTarget.blur();
          }
        }}
        spellCheck={false}
      />
    </label>
  );

  return (
    <div
      className="settings-backdrop"
      onClick={(event) => {
        if (event.target === event.currentTarget) {
          onClose();
        }
      }}
    >
      <aside className="settings" aria-label="Systemic settings">
        <div className="settings-head">
          <div>
            <div className="kicker">SETTINGS</div>
            <h2>Models and backend</h2>
          </div>
          <button className="icon-button" onClick={onClose} aria-label="Close">
            ×
          </button>
        </div>

        <div className="backend-row">
          <span className={`status-dot ${status.state}`} />
          <div>
            <strong>{status.state}</strong>
            <small>{status.detail ?? `Port ${status.port}`}</small>
          </div>
          <button className="secondary-button" onClick={onRestart}>
            Restart
          </button>
        </div>

        {modelField("Chat model", "chatModel", chatModel, setChatModel)}
        {modelField("Worker model", "workerModel", workerModel, setWorkerModel)}

        <div className="key-row">
          <div>
            <span>OpenRouter API key</span>
            <small>
              {status.hasApiKey ? "Stored securely" : "Not configured"}
            </small>
          </div>
          <button className="secondary-button" onClick={onSetApiKey}>
            {status.hasApiKey ? "Replace key" : "Set API key"}
          </button>
        </div>
      </aside>
    </div>
  );
}
