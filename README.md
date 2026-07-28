# Systemic

Systemic is a system-design assistant for VS Code. It reads the open workspace
to answer architecture questions, clarify requirements, and compare practical
implementation approaches without changing the codebase.

## Features

- Answers codebase and architecture questions using repository context.
- Produces minimal, balanced, and scaling-focused design options.
- Reviews and revises proposed approaches before presenting them.
- Asks clarifying questions when important requirements are missing.
- Streams responses, progress updates, option cards, and Mermaid diagrams.
- Keeps chat history in VS Code workspace storage.
- Supports separate OpenRouter models for chat and design workers.

## Requirements

- VS Code 1.90 or newer
- Node.js and npm
- Python 3.10 or newer
- An [OpenRouter](https://openrouter.ai/) API key

## Development setup

1. Install the extension dependencies:

   ```sh
   npm install
   ```

2. Create the backend virtual environment and install its dependencies:

   ```sh
   python3 -m venv backend/.venv
   backend/.venv/bin/python -m pip install -r backend/requirements.txt
   ```

   On Windows, use `backend\.venv\Scripts\python` instead.

3. Open the repository in VS Code and press `F5` to build and launch an
   Extension Development Host.

4. In the development host, run **Systemic: Set OpenRouter API Key** from the
   Command Palette. The key is stored in VS Code Secret Storage.

5. Open a workspace, then select **Systemic** in the Activity Bar to start a
   chat. The extension starts and monitors the local Python backend
   automatically.

## Configuration

| Setting | Purpose | Default |
| --- | --- | --- |
| `systemic.chatModel` | Model used for conversation and repository questions | `moonshotai/kimi-k2.5` |
| `systemic.workerModel` | Model used by the design pipeline | `moonshotai/kimi-k2.5` |
| `systemic.pythonPath` | Python executable used to start the backend | `backend/.venv`, then system Python |
| `systemic.port` | Local backend port | `8321` |

Model IDs can be selected in Systemic's settings or entered directly.

## Architecture

- `src/extension.ts` activates the extension, hosts the webviews, and connects
  chats to the backend.
- `src/webview/` contains the React chat interface and design-option cards.
- `src/chatStore.ts` persists chat history in VS Code workspace storage.
- `src/backend.ts` manages the local FastAPI process and its configuration.
- `backend/main.py` exposes the health and streaming chat endpoints.
- `backend/ai/` contains the repository-aware chat agent and the reviewed
  system-design pipeline.

The extension sends chat requests to a local FastAPI server. The backend reads
the selected workspace through sandboxed tools and uses OpenRouter for model
requests. Responses return to the webview as an NDJSON stream.

## Commands

```sh
npm run build       # type-check and create a production bundle
npm run build:dev   # create a development bundle
npm run watch       # rebuild when source files change
npm run typecheck   # run TypeScript checks
npm test            # run TypeScript tests
```

Run the backend's offline checks from the repository root:

```sh
cd backend
.venv/bin/python test_system_design.py
.venv/bin/python -m ai.chat_agent
```

Systemic provides guidance and explains tradeoffs; it does not write or modify
application code.
