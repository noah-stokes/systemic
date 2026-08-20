"""Streaming front-door chat agent for codebase questions and design options."""

import asyncio
import logging
import os
import time
from collections.abc import AsyncIterator, Callable
from threading import Event
from typing import TypeVar

from langchain.agents import create_agent
from langchain_core.messages import AIMessage, ToolMessage
from langchain_core.tools import tool

from ai.system_design import READ_TOOLS, _model, solve

CHAT_MODEL = os.getenv("CHAT_MODEL", "moonshotai/kimi-k2.5")
HEARTBEAT_SECONDS = 3.0
T = TypeVar("T")

log = logging.getLogger(__name__)

SYSTEM_PROMPT = (
    "You are Systemic's chat assistant. Answer architecture and codebase "
    "questions by reading the repository with your tools. When the user asks "
    "how to build, design, fix, or approach a substantial change and has "
    "identified a concrete feature or problem, call the `design_solution` "
    "tool. If the feature or problem is unspecified, ask what they want to "
    "build or change and do not call `design_solution` in that turn. Its "
    "structured options render separately in the UI, so acknowledge them "
    "briefly instead of repeating every card. When `design_solution` comes "
    "back with clarifying questions instead of options, they render separately "
    "in the UI: do not repeat, paraphrase, or acknowledge them; end the turn "
    "without emitting assistant text and do not call the tool again. Once the "
    "user answers, "
    "call `design_solution` with the SAME `problem` and a `qa` list holding "
    "one entry per question you asked, in the order you asked them, each "
    "entry pairing the question with the user's answer — e.g. \"Q: What "
    "scale? A: ~10k rps\". For a question the user skipped or ignored, write "
    "\"A: (user declined to answer)\". For "
    "greetings, clarifying questions, and general chat, answer directly.\n\n"
    "When a diagram materially helps, include it as a fenced Mermaid block "
    "using ```mermaid. Prefer `flowchart TD`, label edges, and keep node text "
    "short. Always wrap label text in double quotes — `A[\"parse()\"] -->|\"on "
    "hit\"| B` — because unquoted parentheses break the parser. The UI renders "
    "Mermaid inline; never call an external diagram tool."
)


def _text(content) -> str:
    """Flatten message content into plain text."""
    if isinstance(content, str):
        return content
    parts = []
    for block in content:
        if isinstance(block, str):
            parts.append(block)
        elif isinstance(block, dict) and block.get("type") == "text":
            parts.append(block.get("text", ""))
    return "".join(parts)


def _assistant_text(message) -> str:
    """Return user-visible assistant text, excluding tool calls and results."""
    if not isinstance(message, AIMessage) or getattr(message, "tool_call_chunks", None):
        return ""
    return _text(message.content)


def _status(tool_call: dict) -> str | None:
    name = tool_call.get("name")
    args = tool_call.get("args") or {}
    if name == "design_solution":
        return "Running design pipeline…"
    if name == "read_file":
        return f"Reading {args.get('path', 'path')}…"
    if name == "glob_files":
        return "Scanning repository files…"
    if name == "grep":
        return "Searching the codebase…"
    return None


async def _run_pipeline(
    problem: str,
    sink: list[dict],
    qa: list[str] | None = None,
    progress: Callable[[str], None] | None = None,
) -> str:
    """Run solve() off the event loop; append its result to sink.

    A pipeline agent that exhausts its recursion budget raises
    GraphRecursionError, which ToolNode re-raises (it is not a
    ToolInvocationError) and which would otherwise tear down the whole chat
    graph. Report the failure back to the model as text so the turn survives.
    """
    cancel_event = Event()
    try:
        result = await asyncio.to_thread(
            solve,
            problem,
            qa=qa,
            progress=progress,
            cancel_event=cancel_event,
        )
        sink.append(result)
        if result.get("questions"):
            return (
                "The pipeline needs answers before it can run. Its clarifying "
                "questions are already visible to the user. Emit no assistant "
                "text and end the turn."
            )
        return "The design options are ready and visible to the user."
    except asyncio.CancelledError:
        cancel_event.set()
        raise
    except Exception as exc:
        log.exception("design pipeline failed")
        return (
            f"The design pipeline failed: {exc}\n"
            "Do not call design_solution again this turn. Tell the user it "
            "failed, then answer their question directly with your read tools."
        )


async def _with_heartbeat(
    stream: AsyncIterator[T], interval: float = HEARTBEAT_SECONDS
) -> AsyncIterator[T | None]:
    """Yield None when the pending stream has been quiet for one interval."""
    iterator = aiter(stream)
    pending = asyncio.create_task(anext(iterator))
    try:
        while True:
            done, _pending = await asyncio.wait({pending}, timeout=interval)
            if not done:
                yield None
                continue
            try:
                item = pending.result()
            except StopAsyncIteration:
                return
            yield item
            pending = asyncio.create_task(anext(iterator))
    finally:
        if not pending.done():
            pending.cancel()
            try:
                await pending
            except asyncio.CancelledError:
                pass


async def chat_stream(
    message: str, history: list[dict] | None = None
) -> AsyncIterator[dict]:
    """Yield status, token, cards, questions, done, or error events for one turn."""
    artifacts: list[dict] = []
    pipeline_active = False
    questions_visible = False
    stage = "Running design pipeline…"
    last_status = ""

    @tool
    async def design_solution(problem: str, qa: list[str] | None = None) -> str:
        """Generate structured implementation options for a design task.

        When a previous call returned clarifying questions, pass the same
        `problem` plus `qa`: one entry per question you asked, in the order you
        asked them, each carrying both the question and the user's answer, e.g.
        "Q: What scale? A: ~10k rps".
        """
        nonlocal pipeline_active

        def on_progress(text: str) -> None:
            nonlocal stage
            # ponytail: solve() runs in a worker thread, but a lone string
            # assignment is atomic under the GIL, so no lock is needed. Use a
            # queue if per-worker sub-progress is ever wanted.
            stage = text

        try:
            return await _run_pipeline(problem, artifacts, qa, on_progress)
        finally:
            pipeline_active = False

    agent = create_agent(
        model=_model(CHAT_MODEL),
        tools=[design_solution, *READ_TOOLS],
        system_prompt=SYSTEM_PROMPT,
    )
    messages = (history or []) + [{"role": "user", "content": message}]

    try:
        stream = agent.astream(
            {"messages": messages}, stream_mode=["messages", "updates"]
        )
        async for event in _with_heartbeat(stream, HEARTBEAT_SECONDS):
            if event is None:
                if pipeline_active and stage != last_status:
                    last_status = stage
                    yield {"type": "status", "message": stage}
                continue
            mode, data = event
            if mode == "messages":
                chunk, _metadata = data
                text = _assistant_text(chunk)
                if text and not questions_visible:
                    yield {"type": "token", "text": text}
                continue

            for update in data.values():
                if not isinstance(update, dict):
                    continue
                for updated_message in update.get("messages", []):
                    for tool_call in getattr(updated_message, "tool_calls", []):
                        if tool_call.get("name") == "design_solution":
                            pipeline_active = True
                        status = _status(tool_call)
                        if status:
                            last_status = status
                            yield {"type": "status", "message": status}

            while artifacts:
                result = artifacts.pop(0)
                if result.get("questions"):
                    questions_visible = True
                    yield {"type": "questions", "data": result["questions"]}
                else:
                    yield {"type": "cards", "data": result}

        yield {"type": "done"}
    except Exception as exc:
        log.exception("chat turn failed")
        yield {"type": "error", "message": str(exc)}
        # the webview only closes an open message on `done`; without this the
        # bubble streams forever after a failure.
        yield {"type": "done"}


async def _check_pipeline_failure_is_text() -> None:
    def boom(_problem, qa=None, progress=None, cancel_event=None):
        raise RecursionError("Recursion limit of 40 reached")

    # patch this module's own globals: run as __main__ it is a different module
    # object than `ai.chat_agent`, so importing it here would patch the wrong one
    # and the check would hit the real API.
    g = globals()
    sink: list[dict] = []
    orig, g["solve"] = g["solve"], boom
    try:
        out = await _run_pipeline("problem", sink)
    finally:
        g["solve"] = orig
    assert "The design pipeline failed" in out, out
    assert "Recursion limit of 40" in out, out
    assert sink == []


async def _check_repeated_progress_emits_one_status() -> None:
    def slow_solve(problem, qa=None, progress=None, cancel_event=None):
        for _ in range(2):
            progress("Reviewing approaches…")
            time.sleep(0.05)  # long enough for the heartbeat to fire
        return {"options": [], "comparison": {}, "evidence": [], "sources": []}

    class FakeAgent:
        """Replays one design_solution tool call, then runs the real tool."""

        def __init__(self, tools):
            self.tool = next(t for t in tools if t.name == "design_solution")

        async def astream(self, _state, stream_mode=None):
            call = {"name": "design_solution", "args": {"problem": "p"}, "id": "1"}
            yield ("updates", {"agent": {"messages": [AIMessage("", tool_calls=[call])]}})
            await self.tool.ainvoke({"problem": "p"})
            yield ("updates", {"tools": {}})

    g = globals()  # see the note in _check_pipeline_failure_is_text
    orig = (g["solve"], g["create_agent"], g["HEARTBEAT_SECONDS"])
    g["solve"] = slow_solve
    g["create_agent"] = lambda **kw: FakeAgent(kw["tools"])
    g["HEARTBEAT_SECONDS"] = 0.01
    try:
        events = [e async for e in chat_stream("hi")]
    finally:
        g["solve"], g["create_agent"], g["HEARTBEAT_SECONDS"] = orig
    statuses = [e["message"] for e in events if e["type"] == "status"]
    assert statuses == ["Running design pipeline…", "Reviewing approaches…"], statuses


async def _check_pipeline_questions_suppress_assistant_echo() -> None:
    def ask(_problem, qa=None, progress=None, cancel_event=None):
        return {"questions": ["What scale?"]}

    class FakeAgent:
        def __init__(self, tools):
            self.tool = next(t for t in tools if t.name == "design_solution")

        async def astream(self, _state, stream_mode=None):
            call = {"name": "design_solution", "args": {"problem": "p"}, "id": "1"}
            yield ("updates", {"agent": {"messages": [AIMessage("", tool_calls=[call])]}})
            await self.tool.ainvoke({"problem": "p"})
            yield ("updates", {"tools": {}})
            yield ("messages", (AIMessage("What scale?"), {}))

    g = globals()
    orig = (g["solve"], g["create_agent"])
    g["solve"] = ask
    g["create_agent"] = lambda **kw: FakeAgent(kw["tools"])
    try:
        events = [e async for e in chat_stream("design it")]
    finally:
        g["solve"], g["create_agent"] = orig
    assert [e for e in events if e["type"] == "questions"] == [
        {"type": "questions", "data": ["What scale?"]}
    ]
    assert not [e for e in events if e["type"] == "token"], events


async def _check_heartbeat() -> None:
    release = asyncio.Event()

    async def delayed() -> AsyncIterator[str]:
        await release.wait()
        yield "done"

    stream = _with_heartbeat(delayed(), interval=0.001)
    assert await anext(stream) is None
    release.set()
    await asyncio.sleep(0)
    assert await anext(stream) == "done"
    await stream.aclose()


async def _check_chat_stream_cancellation_stops_worker() -> None:
    started = Event()
    stopped = Event()

    def waiting_solve(problem, qa=None, progress=None, cancel_event=None):
        started.set()
        while not cancel_event.is_set():
            time.sleep(0.001)
        stopped.set()
        return {"options": [], "comparison": {}, "evidence": [], "sources": []}

    class FakeAgent:
        def __init__(self, tools):
            self.tool = next(t for t in tools if t.name == "design_solution")

        async def astream(self, _state, stream_mode=None):
            call = {"name": "design_solution", "args": {"problem": "p"}, "id": "1"}
            yield ("updates", {"agent": {"messages": [AIMessage("", tool_calls=[call])]}})
            await self.tool.ainvoke({"problem": "p"})
            yield ("updates", {"tools": {}})

    g = globals()
    original = (g["solve"], g["create_agent"])
    g["solve"] = waiting_solve
    g["create_agent"] = lambda **kw: FakeAgent(kw["tools"])
    stream = chat_stream("design it")
    assert (await anext(stream))["type"] == "status"
    pending = asyncio.create_task(anext(stream))
    try:
        while not started.is_set():
            await asyncio.sleep(0.001)
        pending.cancel()
        try:
            await pending
        except asyncio.CancelledError:
            pass
        await stream.aclose()
        for _ in range(100):
            if stopped.is_set():
                break
            await asyncio.sleep(0.001)
    finally:
        g["solve"], g["create_agent"] = original
    assert stopped.is_set(), "worker did not receive cancellation"


if __name__ == "__main__":
    assert _text("hello") == "hello"
    assert _text([{"type": "text", "text": "a"}, {"type": "text", "text": "b"}]) == "ab"
    assert _text([{"type": "tool_use", "id": "x"}, {"type": "text", "text": "hi"}]) == "hi"
    assert _text(["raw", {"type": "text", "text": "!"}]) == "raw!"
    assert _assistant_text(AIMessage(content="answer")) == "answer"
    assert _assistant_text(ToolMessage(content="1:file line", tool_call_id="x")) == ""
    assert _status({"name": "read_file", "args": {"path": "src/app.ts"}}) == "Reading src/app.ts…"
    asyncio.run(_check_heartbeat())
    asyncio.run(_check_chat_stream_cancellation_stops_worker())
    asyncio.run(_check_pipeline_failure_is_text())
    asyncio.run(_check_repeated_progress_emits_one_status())
    asyncio.run(_check_pipeline_questions_suppress_assistant_echo())
    print("ok")
