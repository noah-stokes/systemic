import * as crypto from "crypto";
import * as vscode from "vscode";

import { BackendManager } from "./backend";
import { ChatStore } from "./chatStore";
import { HostToWebview, WebviewToHost } from "./shared/protocol";

type Surface = {
  post: (message: HostToWebview) => void;
  ready: boolean;
  queue: HostToWebview[];
};

let backend: BackendManager | undefined;
let currentPanel: vscode.WebviewPanel | undefined;
const surfaces = new Set<Surface>();

// Fan out to every live surface: sidebar and panel can both be open, and a
// command should land wherever the user is looking. Each queues until its own
// webview signals "ready" so commands sent right after creation are not
// dropped before that webview's message listener attaches.
function postCommand(message: HostToWebview) {
  for (const surface of surfaces) {
    if (surface.ready) {
      surface.post(message);
    } else {
      surface.queue.push(message);
    }
  }
}

export function activate(context: vscode.ExtensionContext) {
  const output = vscode.window.createOutputChannel("Systemic Backend");
  backend = new BackendManager(context, output);
  const store = new ChatStore(context.workspaceState);
  void store.cleanupOrphans();

  let configDebounce: NodeJS.Timeout | undefined;

  context.subscriptions.push(
    output,
    backend,
    vscode.window.registerWebviewViewProvider(
      "systemic.chatView",
      {
        resolveWebviewView(view) {
          view.webview.options = {
            enableScripts: true,
            localResourceRoots: [
              vscode.Uri.joinPath(context.extensionUri, "dist"),
            ],
          };
          const wiring = wireWebview(view.webview, context, backend!, store);
          view.onDidDispose(() => wiring.dispose());
        },
      },
      { webviewOptions: { retainContextWhenHidden: true } }
    ),
    // ponytail: the panel stays because the 3D carousel in OptionCards.tsx needs
    // more width than the sidebar has. Sidebar is the default entry point; the
    // panel is for reading design options.
    vscode.commands.registerCommand("systemic.openPanel", () =>
      openPanel(context, backend!, store)
    ),
    vscode.commands.registerCommand("systemic.newChat", async () => {
      if (surfaces.size === 0) {
        await vscode.commands.executeCommand("systemic.chatView.focus");
      }
      postCommand({ type: "hostCommand", command: "newChat" });
    }),
    vscode.commands.registerCommand("systemic.setApiKey", async () => {
      const apiKey = await vscode.window.showInputBox({
        title: "Set OpenRouter API Key",
        prompt: "Stored securely in VS Code SecretStorage.",
        password: true,
        ignoreFocusOut: true,
        validateInput: (value) =>
          value.trim() ? undefined : "An API key is required.",
      });
      if (apiKey === undefined) {
        return;
      }
      await context.secrets.store("systemic.openrouterKey", apiKey.trim());
      await backend!.restart();
    }),
    vscode.commands.registerCommand("systemic.restartBackend", () =>
      backend!.restart()
    ),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration("systemic")) {
        clearTimeout(configDebounce);
        configDebounce = setTimeout(
          () => void backend!.restartIfConfigChanged(),
          600
        );
      }
    })
  );

  void backend.start();
}

export function deactivate() {
  backend?.stop();
}

function openPanel(
  context: vscode.ExtensionContext,
  backendManager: BackendManager,
  store: ChatStore
) {
  if (currentPanel) {
    currentPanel.reveal(vscode.ViewColumn.One);
    return;
  }

  const panel = vscode.window.createWebviewPanel(
    "systemic.panel",
    "Systemic",
    vscode.ViewColumn.One,
    {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, "dist")],
    }
  );
  currentPanel = panel;

  const wiring = wireWebview(panel.webview, context, backendManager, store);
  panel.onDidDispose(() => {
    wiring.dispose();
    currentPanel = undefined;
  });
}

function wireWebview(
  webview: vscode.Webview,
  context: vscode.ExtensionContext,
  backendManager: BackendManager,
  store: ChatStore
): vscode.Disposable {
  webview.html = getHtml(webview, context.extensionUri);

  let disposed = false;
  const controllers = new Map<string, AbortController>();
  const safePost = (message: HostToWebview) => {
    if (!disposed) {
      void webview.postMessage(message);
    }
  };
  const surface: Surface = { post: safePost, ready: false, queue: [] };
  surfaces.add(surface);

  const postChatsChanged = () => {
    const index = store.index();
    safePost({
      type: "chatsChanged",
      chats: index.chats,
      activeChatId: index.activeChatId,
    });
  };

  const statusSubscription = backendManager.onDidChangeStatus((status) =>
    safePost({ type: "backendStatus", status })
  );

  webview.onDidReceiveMessage(async (message: WebviewToHost) => {
    switch (message.type) {
      case "ready": {
        const index = store.index();
        safePost({
          type: "init",
          chats: index.chats,
          activeChatId: index.activeChatId,
          activeChat: index.activeChatId
            ? (store.get(index.activeChatId) ?? null)
            : null,
          backend: await backendManager.status(),
        });
        surface.ready = true;
        for (const pending of surface.queue.splice(0)) {
          safePost(pending);
        }
        break;
      }
      case "createChat":
        await store.save(message.chat);
        await store.setActive(message.chat.id);
        postChatsChanged();
        break;
      case "selectChat": {
        await store.setActive(message.chatId);
        const chat = store.get(message.chatId);
        if (chat) {
          safePost({ type: "chatLoaded", chat });
        }
        postChatsChanged();
        break;
      }
      case "renameChat":
        await store.rename(message.chatId, message.title);
        postChatsChanged();
        break;
      case "deleteChat": {
        controllers.get(message.chatId)?.abort();
        await store.remove(message.chatId);
        const index = store.index();
        safePost({
          type: "chatsChanged",
          chats: index.chats,
          activeChatId: index.activeChatId,
        });
        const chat = index.activeChatId
          ? store.get(index.activeChatId)
          : undefined;
        if (chat) {
          safePost({ type: "chatLoaded", chat });
        }
        break;
      }
      case "saveChat":
        await store.save(message.chat);
        postChatsChanged();
        break;
      case "chat":
        if (controllers.has(message.chatId)) {
          safePost({
            type: "stream",
            chatId: message.chatId,
            line: JSON.stringify({
              type: "error",
              message: "A response is already streaming in this chat.",
            }),
          });
          break;
        }
        await streamChat(
          safePost,
          () => disposed,
          controllers,
          backendManager,
          message.chatId,
          message.message,
          message.history
        );
        break;
      case "stopGeneration":
        controllers.get(message.chatId)?.abort();
        break;
      case "setApiKey":
        await vscode.commands.executeCommand("systemic.setApiKey");
        break;
      case "restartBackend":
        await vscode.commands.executeCommand("systemic.restartBackend");
        break;
      case "setSetting":
        await updateSetting(message.key, message.value);
        break;
      case "openExternal":
        await openExternal(message.href);
        break;
      // ponytail: copy routes through the host because the webview is a
      // sandboxed iframe where navigator.clipboard is permission-dependent;
      // vscode.env.clipboard always works.
      case "copyText":
        await vscode.env.clipboard.writeText(message.text);
        break;
    }
  });

  return new vscode.Disposable(() => {
    disposed = true;
    surfaces.delete(surface);
    for (const controller of controllers.values()) {
      controller.abort();
    }
    statusSubscription.dispose();
  });
}

async function streamChat(
  safePost: (message: HostToWebview) => void,
  isDisposed: () => boolean,
  controllers: Map<string, AbortController>,
  backendManager: BackendManager,
  chatId: string,
  message: string,
  history: { role: "user" | "assistant"; content: string }[]
) {
  const controller = new AbortController();
  controllers.set(chatId, controller);

  let watchdogFired = false;
  let watchdog: NodeJS.Timeout | undefined;
  const resetWatchdog = () => {
    clearTimeout(watchdog);
    watchdog = setTimeout(() => {
      watchdogFired = true;
      controller.abort();
    }, 120_000);
  };
  const post = (line: string) => safePost({ type: "stream", chatId, line });

  try {
    const response = await fetch(`${backendManager.url}/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message, history }),
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new Error(
        `Backend returned ${response.status}: ${await response.text()}`
      );
    }
    if (!response.body) {
      throw new Error("Backend returned an empty stream.");
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let terminalEvent = false;

    const forward = (line: string) => {
      if (!line.trim()) {
        return;
      }
      try {
        const event = JSON.parse(line) as { type?: string };
        terminalEvent ||=
          event.type === "done" ||
          event.type === "error" ||
          event.type === "aborted";
      } catch {
        throw new Error("Backend returned invalid NDJSON.");
      }
      post(line);
    };

    resetWatchdog();
    while (true) {
      const { value, done } = await reader.read();
      resetWatchdog();
      buffer += decoder.decode(value, { stream: !done });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        forward(line);
      }
      if (done) {
        break;
      }
    }
    forward(buffer);
    if (!terminalEvent) {
      throw new Error("Backend stream ended before a done event.");
    }
  } catch (error) {
    if (controller.signal.aborted) {
      if (watchdogFired) {
        post(
          JSON.stringify({
            type: "error",
            message: "Backend stalled (no data for 120s).",
          })
        );
      } else if (!isDisposed()) {
        post(JSON.stringify({ type: "aborted" }));
      }
    } else {
      const text = error instanceof Error ? error.message : String(error);
      post(JSON.stringify({ type: "error", message: text }));
    }
  } finally {
    clearTimeout(watchdog);
    controllers.delete(chatId);
  }
}

async function updateSetting(key: unknown, value: unknown) {
  if (
    (key !== "chatModel" && key !== "workerModel") ||
    typeof value !== "string" ||
    !value.trim()
  ) {
    return;
  }
  const target = vscode.workspace.workspaceFolders?.length
    ? vscode.ConfigurationTarget.Workspace
    : vscode.ConfigurationTarget.Global;
  try {
    await vscode.workspace
      .getConfiguration("systemic")
      .update(key, value.trim(), target);
  } catch (error) {
    const text = error instanceof Error ? error.message : String(error);
    void vscode.window.showErrorMessage(
      `Systemic: could not save setting: ${text}`
    );
  }
}

async function openExternal(href: unknown) {
  if (typeof href !== "string") {
    return;
  }
  const uri = vscode.Uri.parse(href);
  if (uri.scheme === "https" || uri.scheme === "http") {
    await vscode.env.openExternal(uri);
  }
}

function getHtml(
  webview: vscode.Webview,
  extensionUri: vscode.Uri
): string {
  const nonce = crypto.randomBytes(16).toString("base64");
  const scriptUri = webview.asWebviewUri(
    vscode.Uri.joinPath(extensionUri, "dist", "webview.js")
  );
  const styleUri = webview.asWebviewUri(
    vscode.Uri.joinPath(extensionUri, "dist", "webview.css")
  );
  return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy"
        content="default-src 'none'; img-src ${webview.cspSource} data:; font-src ${webview.cspSource}; style-src ${webview.cspSource} 'unsafe-inline'; script-src ${webview.cspSource} 'nonce-${nonce}';">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <link href="${styleUri}" rel="stylesheet">
  <title>Systemic</title>
</head>
<body>
  <div id="root"></div>
  <script type="module" nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
}
