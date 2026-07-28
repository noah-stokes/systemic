import json
from typing import Literal

from fastapi import FastAPI
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field

from ai.chat_agent import chat_stream

app = FastAPI(title="Systemic Backend")


@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok"}


class HistoryItem(BaseModel):
    role: Literal["user", "assistant"]
    content: str = Field(max_length=32_000)


class ChatRequest(BaseModel):
    message: str = Field(min_length=1, max_length=32_000)
    history: list[HistoryItem] = Field(default_factory=list, max_length=200)


@app.post("/chat")
async def chat_endpoint(request: ChatRequest) -> StreamingResponse:
    history = [h.model_dump() for h in request.history]

    async def ndjson():
        async for event in chat_stream(request.message, history):
            yield json.dumps(event, ensure_ascii=False) + "\n"

    return StreamingResponse(ndjson(), media_type="application/x-ndjson")
