import * as childProcess from "child_process";
import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";

import { BackendState, BackendStatus } from "./shared/protocol";

export const CURATED_MODELS = [
  "anthropic/claude-sonnet-5",
  "anthropic/claude-haiku-4.5",
  "openai/gpt-5.1",
  "google/gemini-3-flash-preview",
  "deepseek/deepseek-v4-pro",
  "deepseek/deepseek-v3.2",
  "minimax/minimax-m2.5",
  "qwen/qwen3-coder",
  "z-ai/glm-5.2",
  "z-ai/glm-4.7-flash",
  "moonshotai/kimi-k2.5",
] as const;

const delay = (milliseconds: number) =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

interface BackendConfig {
  chatModel: string;
  workerModel: string;
  pythonPath: string;
  port: number;
}

export class BackendManager implements vscode.Disposable {
  private child?: childProcess.ChildProcess;
  private generation = 0;
  private state: BackendState = "stopped";
  private detail?: string;
  private hasApiKey = false;
  private startedConfig?: BackendConfig;
  private readonly statusEmitter = new vscode.EventEmitter<BackendStatus>();

  readonly onDidChangeStatus = this.statusEmitter.event;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly output: vscode.OutputChannel
  ) {}

  get url(): string {
    return `http://127.0.0.1:${this.configuration().port}`;
  }

  async status(): Promise<BackendStatus> {
    this.hasApiKey = Boolean(
      await this.context.secrets.get("systemic.openrouterKey")
    );
    return this.snapshot();
  }

  async start(): Promise<void> {
    const generation = ++this.generation;
    this.terminateChild();

    const workspace = vscode.workspace.workspaceFolders?.[0];
    const apiKey = await this.context.secrets.get("systemic.openrouterKey");
    this.hasApiKey = Boolean(apiKey);

    if (!workspace) {
      this.publish("failed", "Open a workspace folder to start the backend.");
      return;
    }
    if (!apiKey) {
      this.publish("stopped", "Set an OpenRouter API key to start the backend.");
      return;
    }

    const config = this.configuration();
    const python = this.resolvePython(config.pythonPath);
    const backendDirectory = path.join(this.context.extensionPath, "backend");
    const command = `${python} -m uvicorn main:app --port ${config.port}`;
    this.publish("starting", `Starting on port ${config.port}…`);
    this.output.appendLine(`$ ${command}`);

    const child = childProcess.spawn(
      python,
      ["-m", "uvicorn", "main:app", "--port", String(config.port)],
      {
        cwd: backendDirectory,
        detached: process.platform !== "win32",
        env: {
          ...process.env,
          OPENROUTER_API_KEY: apiKey,
          CHAT_MODEL: config.chatModel,
          WORKER_MODEL: config.workerModel,
          REPO_ROOT: workspace.uri.fsPath,
          PORT: String(config.port),
          PYTHONUNBUFFERED: "1",
        },
      }
    );
    this.child = child;

    child.stdout?.on("data", (chunk) => this.output.append(chunk.toString()));
    child.stderr?.on("data", (chunk) => this.output.append(chunk.toString()));
    child.on("error", (error) => {
      if (this.child === child) {
        this.output.appendLine(`Backend process error: ${error.message}`);
      }
    });
    child.on("exit", (code, signal) => {
      if (this.child !== child) {
        return;
      }
      this.child = undefined;
      this.publish(
        "failed",
        `Backend exited (${signal ?? `code ${code ?? "unknown"}`}).`
      );
    });

    try {
      await this.waitForHealth(config.port, generation);
      if (this.child === child && this.generation === generation) {
        this.startedConfig = config;
        this.publish("ready", `Ready on port ${config.port}.`);
      }
    } catch (error) {
      if (this.generation !== generation) {
        return;
      }
      this.terminateChild();
      const reason = error instanceof Error ? error.message : String(error);
      this.publish("failed", reason);
      const action = await vscode.window.showErrorMessage(
        `Systemic backend failed to start. Run manually from ${backendDirectory}: ${command}`,
        "Show Logs"
      );
      if (action === "Show Logs") {
        this.output.show(true);
      }
    }
  }

  restart(): Promise<void> {
    return this.start();
  }

  async restartIfConfigChanged(): Promise<void> {
    const current = this.configuration();
    const snapshot = this.startedConfig;
    if (
      snapshot &&
      snapshot.chatModel === current.chatModel &&
      snapshot.workerModel === current.workerModel &&
      snapshot.pythonPath === current.pythonPath &&
      snapshot.port === current.port
    ) {
      return;
    }
    await this.restart();
  }

  stop(): void {
    ++this.generation;
    this.terminateChild();
    this.publish("stopped", "Backend stopped.");
  }

  dispose(): void {
    this.stop();
    this.statusEmitter.dispose();
  }

  private configuration(): BackendConfig {
    const config = vscode.workspace.getConfiguration("systemic");
    return {
      chatModel: config.get("chatModel", CURATED_MODELS[0]),
      workerModel: config.get("workerModel", CURATED_MODELS[1]),
      pythonPath: config.get("pythonPath", ""),
      port: config.get("port", 8321),
    };
  }

  private resolvePython(configured: string): string {
    if (configured.trim()) {
      return configured.trim();
    }
    const virtualenvPython = path.join(
      this.context.extensionPath,
      "backend",
      ".venv",
      process.platform === "win32" ? "Scripts/python.exe" : "bin/python"
    );
    if (fs.existsSync(virtualenvPython)) {
      return virtualenvPython;
    }
    return process.platform === "win32" ? "python" : "python3";
  }

  private async waitForHealth(port: number, generation: number): Promise<void> {
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      if (generation !== this.generation || !this.child) {
        throw new Error("Backend start was cancelled.");
      }
      const attemptStarted = Date.now();
      const controller = new AbortController();
      const timeout = setTimeout(
        () => controller.abort(),
        Math.min(450, deadline - Date.now())
      );
      try {
        const response = await fetch(`http://127.0.0.1:${port}/health`, {
          signal: controller.signal,
        });
        if (response.ok) {
          return;
        }
      } catch {
        // The process is still importing or the socket is not listening yet.
      } finally {
        clearTimeout(timeout);
      }
      const remaining = deadline - Date.now();
      if (remaining > 0) {
        await delay(
          Math.min(
            Math.max(0, 500 - (Date.now() - attemptStarted)),
            remaining
          )
        );
      }
    }
    throw new Error("Backend health check timed out after 30 seconds.");
  }

  private terminateChild(): void {
    const child = this.child;
    this.child = undefined;
    if (!child || (child.exitCode !== null || child.signalCode !== null)) {
      return;
    }
    const detached = process.platform !== "win32";
    const kill = (signal: NodeJS.Signals) => {
      if (detached && child.pid) {
        try {
          process.kill(-child.pid, signal);
          return;
        } catch {
          // The process group is already gone; fall back to the child itself.
        }
      }
      child.kill(signal);
    };
    kill("SIGTERM");
    setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) {
        try {
          kill("SIGKILL");
        } catch {
          // The process exited between the check and the kill.
        }
      }
    }, 2000).unref();
  }

  private publish(state: BackendState, detail?: string): void {
    this.state = state;
    this.detail = detail;
    this.statusEmitter.fire(this.snapshot());
  }

  private snapshot(): BackendStatus {
    const config = this.configuration();
    return {
      state: this.state,
      detail: this.detail,
      hasApiKey: this.hasApiKey,
      chatModel: config.chatModel,
      workerModel: config.workerModel,
      port: config.port,
      models: CURATED_MODELS,
    };
  }
}
