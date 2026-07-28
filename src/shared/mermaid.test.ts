// Run: npm test
import assert from "node:assert/strict";
import test from "node:test";

import { quoteLabels } from "./mermaid.ts";

test("quotes edge and node labels containing parentheses", () => {
  assert.equal(
    quoteLabels("A[element_to_lead()] --> |fetch_osm()| B"),
    'A["element_to_lead()"] --> |"fetch_osm()"| B',
  );
  assert.equal(quoteLabels("A{is ok()?} --> B"), 'A{"is ok()?"} --> B');
});

test("leaves already-valid syntax alone", () => {
  for (const source of [
    'CMD["leads.py [find|list|show]"]',
    "SQLITE[(SQLite<br/>leads.db)]",
    "A -->|No| B",
    'A["parse()"] --> B',
    "HEX{{Overpass API}} --> B",
    "SUB[[run_job]] --> B",
    "A[jobs/internships] --> B",
    "A[Greenhouse, Lever, Ashby] --> B",
    "classDef cli fill:#e1f5ff,stroke:#01579b",
    "class CLI,FIND,LIST cli",
  ]) {
    assert.equal(quoteLabels(source), source);
  }
});

// Every one of these was verified to fail mermaid's parser unquoted.
test("quotes labels broken by characters other than parentheses", () => {
  assert.equal(
    quoteLabels("CSV[exports/job{N}.csv]"),
    'CSV["exports/job{N}.csv"]',
  );
  assert.equal(quoteLabels("CMD[find|list|show]"), 'CMD["find|list|show"]');
  assert.equal(quoteLabels("A[user@host]"), 'A["user@host"]');
  assert.equal(
    quoteLabels("CMD[leads.py [find|list]]"),
    'CMD["leads.py [find|list]"]',
  );
  assert.equal(
    quoteLabels("CLI[main()<br/>argparse subcommands]"),
    'CLI["main()<br/>argparse subcommands"]',
  );
});

test("does not run past the end of a line looking for a closer", () => {
  const source = "A[unclosed\nB --> C";
  assert.equal(quoteLabels(source), source);
});

test("does not quote inside existing quoted text", () => {
  const source = 'A["keep (this)"] --> |drop()| B';
  assert.equal(quoteLabels(source), 'A["keep (this)"] --> |"drop()"| B');
});
