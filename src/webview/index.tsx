import React from "react";
import { createRoot } from "react-dom/client";

import { App } from "./App";
import "./styles.css";

interface VsCodeApi {
  postMessage(message: unknown): void;
  getState<T>(): T | undefined;
  setState(state: unknown): void;
}

declare function acquireVsCodeApi(): VsCodeApi;

export const vscodeApi = acquireVsCodeApi();

const root = document.getElementById("root");
if (!root) {
  throw new Error("Missing webview root.");
}

createRoot(root).render(<App />);
