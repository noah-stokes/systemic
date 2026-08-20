#!/usr/bin/env python3
"""Real-process backend smoke test with no external traffic.

Run from the repository root:
    backend/.venv/bin/python backend/e2e_http_check.py
"""

import json
import os
import socket
import subprocess
import sys
import tempfile
import threading
import time
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

BACKEND = Path(__file__).resolve().parent
SENTINEL = "systemic-e2e-ok"


class MockOpenAI(BaseHTTPRequestHandler):
    requests: list[dict] = []
    errors: list[str] = []

    def do_POST(self) -> None:
        try:
            if self.path != "/v1/chat/completions":
                raise AssertionError(f"unexpected mock path: {self.path}")
            length = int(self.headers.get("content-length", "0"))
            body = json.loads(self.rfile.read(length))
            self.requests.append(body)
            if body.get("stream") is not True:
                raise AssertionError("chat request was not streamed")
            self._stream_completion()
        except Exception as exc:
            self.errors.append(str(exc))
            self.send_error(500, str(exc))

    def _stream_completion(self) -> None:
        chunks = [
            {
                "id": "chatcmpl-systemic-e2e",
                "object": "chat.completion.chunk",
                "created": 0,
                "model": "mock-chat",
                "choices": [
                    {
                        "index": 0,
                        "delta": {"role": "assistant", "content": SENTINEL},
                        "finish_reason": None,
                    }
                ],
            },
            {
                "id": "chatcmpl-systemic-e2e",
                "object": "chat.completion.chunk",
                "created": 0,
                "model": "mock-chat",
                "choices": [{"index": 0, "delta": {}, "finish_reason": "stop"}],
            },
        ]
        self.send_response(200)
        self.send_header("content-type", "text/event-stream")
        self.send_header("connection", "close")
        self.end_headers()
        for chunk in chunks:
            self.wfile.write(f"data: {json.dumps(chunk)}\n\n".encode())
            self.wfile.flush()
        self.wfile.write(b"data: [DONE]\n\n")
        self.wfile.flush()

    def log_message(self, _format: str, *_args) -> None:
        pass


def serve_backend() -> None:
    import uvicorn

    sock = socket.socket()
    sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    sock.bind(("127.0.0.1", 0))
    sock.listen(2048)
    Path(os.environ["SYSTEMIC_E2E_PORT_FILE"]).write_text(
        str(sock.getsockname()[1])
    )
    uvicorn.Server(
        uvicorn.Config("main:app", host="127.0.0.1", log_level="warning")
    ).run(sockets=[sock])


def wait_for_backend(port_file: Path, process: subprocess.Popen) -> int:
    deadline = time.monotonic() + 15
    while time.monotonic() < deadline:
        if process.poll() is not None:
            raise RuntimeError(f"backend exited with {process.returncode}")
        try:
            port = int(port_file.read_text())
            with urllib.request.urlopen(
                f"http://127.0.0.1:{port}/health", timeout=0.5
            ) as response:
                assert json.load(response) == {"status": "ok"}
                return port
        except (FileNotFoundError, ValueError, OSError):
            time.sleep(0.05)
    raise TimeoutError("backend did not become healthy")


def stop(process: subprocess.Popen) -> None:
    if process.poll() is not None:
        return
    process.terminate()
    try:
        process.wait(timeout=5)
    except subprocess.TimeoutExpired:
        process.kill()
        process.wait(timeout=5)


def run() -> None:
    MockOpenAI.requests.clear()
    MockOpenAI.errors.clear()
    mock = ThreadingHTTPServer(("127.0.0.1", 0), MockOpenAI)
    mock_thread = threading.Thread(target=mock.serve_forever, daemon=True)
    mock_thread.start()
    try:
        with tempfile.TemporaryDirectory(prefix="systemic-e2e-") as directory:
            temp = Path(directory)
            repo = temp / "repo"
            repo.mkdir()
            (repo / "app.py").write_text("print('fixture')\n")
            port_file = temp / "backend.port"
            log = (temp / "backend.log").open("w+")
            env = os.environ.copy()
            env.update(
                {
                    "CHAT_MODEL": "mock-chat",
                    "WORKER_MODEL": "mock-worker",
                    "OPENROUTER_API_KEY": "local-e2e-key",
                    "OPENROUTER_BASE_URL": (
                        f"http://127.0.0.1:{mock.server_port}/v1"
                    ),
                    "REPO_ROOT": str(repo),
                    "SYSTEMIC_E2E_PORT_FILE": str(port_file),
                    "NO_PROXY": "127.0.0.1,localhost",
                    "no_proxy": "127.0.0.1,localhost",
                }
            )
            process = None
            try:
                process = subprocess.Popen(
                    [sys.executable, str(Path(__file__).resolve()), "--serve-backend"],
                    cwd=BACKEND,
                    env=env,
                    stdout=log,
                    stderr=subprocess.STDOUT,
                )
                port = wait_for_backend(port_file, process)
                request = urllib.request.Request(
                    f"http://127.0.0.1:{port}/chat",
                    data=json.dumps({"message": "Say hello", "history": []}).encode(),
                    headers={"content-type": "application/json"},
                    method="POST",
                )
                with urllib.request.urlopen(request, timeout=15) as response:
                    assert response.headers.get_content_type() == "application/x-ndjson"
                    events = [json.loads(line) for line in response if line.strip()]
                assert "".join(
                    event.get("text", "")
                    for event in events
                    if event["type"] == "token"
                ) == SENTINEL, events
                assert events[-1] == {"type": "done"}, events
                assert len(MockOpenAI.requests) == 1, MockOpenAI.requests
                assert not MockOpenAI.errors, MockOpenAI.errors
            except Exception:
                log.flush()
                log.seek(0)
                output = log.read().strip()
                if output:
                    print(output, file=sys.stderr)
                raise
            finally:
                if process:
                    stop(process)
                log.close()
    finally:
        mock.shutdown()
        mock.server_close()
        mock_thread.join(timeout=5)
    print("backend HTTP e2e ok")


if __name__ == "__main__":
    if sys.argv[1:] == ["--serve-backend"]:
        serve_backend()
    else:
        run()
