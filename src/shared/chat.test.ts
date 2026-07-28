import assert from "node:assert/strict";
import test from "node:test";

import { buildHistory, retryMessages } from "./chat.ts";
import { parseStreamEvent } from "./protocol.ts";
import type { SolveResult, ThreadMessage } from "./protocol.ts";

const result: SolveResult = {
  options: [
    {
      title: "First",
      details: "first details",
      tradeoffs: "first tradeoffs",
      objective: ["minimal"],
      effort: "small",
      risks: [],
      ships_as_is: true,
    },
    {
      title: "Second",
      details: "second details",
      tradeoffs: "second tradeoffs",
      objective: ["scaling"],
      effort: "medium",
      risks: ["risk"],
      ships_as_is: false,
    },
  ],
  comparison: { recommendation: "Choose First." },
  evidence: [],
  sources: [],
};

test("includes cards in history and excludes non-conversation text", () => {
  const messages: ThreadMessage[] = [
    { id: "user", kind: "text", role: "user", content: "Design it" },
    { id: "cards", kind: "cards", result },
    { id: "answer", kind: "text", role: "assistant", content: "Options ready." },
    {
      id: "note",
      kind: "text",
      role: "assistant",
      content: "Generation stopped.",
      note: true,
    } as ThreadMessage,
    {
      id: "error",
      kind: "text",
      role: "assistant",
      content: "Error: failed",
      error: true,
    },
  ];

  const history = buildHistory(messages);
  assert.deepEqual(
    history.map(({ role }) => role),
    ["user", "assistant", "assistant"],
  );
  const cardResult = JSON.parse(history[1].content.split("\n", 2)[1]) as SolveResult;
  assert.deepEqual(
    cardResult.options.map(({ title }) => title),
    ["First", "Second"],
  );
  assert.equal(history[2].content, "Options ready.");
});

test("retry removes every message after the triggering user message", () => {
  const messages: ThreadMessage[] = [
    { id: "old-user", kind: "text", role: "user", content: "Earlier" },
    { id: "old-answer", kind: "text", role: "assistant", content: "Earlier answer" },
    { id: "user", kind: "text", role: "user", content: "Try this" },
    { id: "partial", kind: "text", role: "assistant", content: "Partial" },
    { id: "cards", kind: "cards", result },
    {
      id: "note",
      kind: "text",
      role: "assistant",
      content: "Generation stopped.",
      note: true,
    } as ThreadMessage,
    {
      id: "error",
      kind: "text",
      role: "assistant",
      content: "Error: failed",
      error: true,
    },
  ];

  assert.deepEqual(
    retryMessages(messages, "user").map(({ id }) => id),
    ["old-user", "old-answer", "user"],
  );
});

test("retry keeps a mid-thread user message and ignores unknown ids", () => {
  const messages: ThreadMessage[] = [
    { id: "first", kind: "text", role: "user", content: "First" },
    { id: "answer", kind: "text", role: "assistant", content: "Answer" },
    { id: "second", kind: "text", role: "user", content: "Second" },
    { id: "later", kind: "text", role: "assistant", content: "Later" },
  ];

  assert.deepEqual(
    retryMessages(messages, "first").map(({ id }) => id),
    ["first"],
  );
  // an edit resends new text in place of the target, so it goes too
  assert.deepEqual(
    retryMessages(messages, "second", true).map(({ id }) => id),
    ["first", "answer"],
  );
  assert.equal(retryMessages(messages, "missing"), messages);
});

test("parses questions events and rejects malformed ones", () => {
  assert.deepEqual(
    parseStreamEvent('{"type":"questions","data":["Scale?","Budget?"]}'),
    { type: "questions", data: ["Scale?", "Budget?"] },
  );
  assert.equal(parseStreamEvent('{"type":"questions","data":[1,2]}'), null);
  assert.equal(parseStreamEvent('{"type":"questions","data":"Scale?"}'), null);
});
