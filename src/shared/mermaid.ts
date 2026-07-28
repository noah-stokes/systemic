// Mermaid rejects a bare "(", "|", "{", "[" or "@" inside unquoted labels, which
// models emit constantly (`A[parse_query()]`, `A -->|fetch()| B`,
// `A[find|list|show]`). Quote those labels so the diagram parses.
// ponytail: only runs after a real parse failure, so valid diagrams never hit it.

// Characters mermaid cannot read in an unquoted label. Everything else
// (slashes, commas, colons, apostrophes, "&", "+", "#", "%") parses fine
// unquoted, so leaving it alone keeps already-valid diagrams byte-identical.
const NEEDS_QUOTING = /[()[\]{}|@<>]/;

const OPENERS: Record<string, string> = { "[": "]", "{": "}", "|": "|" };

// Find the delimiter that closes the label opened at `start`, tracking nesting
// so `A[leads.py [find|list]]` closes on the final "]" and not the inner one.
// Labels never span lines, so a newline means this was not a label at all.
function findCloser(source: string, start: number): number {
  const opener = source[start];
  const closer = OPENERS[opener];
  if (opener === "|") {
    const end = source.indexOf("|", start + 1);
    const newline = source.indexOf("\n", start + 1);
    return end !== -1 && (newline === -1 || end < newline) ? end : -1;
  }
  let depth = 0;
  for (let index = start; index < source.length; index++) {
    const char = source[index];
    if (char === "\n") {
      return -1;
    }
    if (char === opener) {
      depth += 1;
    } else if (char === closer) {
      depth -= 1;
      if (depth === 0) {
        return index;
      }
    }
  }
  return -1;
}

// Shapes whose body is itself delimited — [(cylinder)], [[subroutine]],
// {{hexagon}}, ([stadium]) — are already valid and must not be quoted.
function isWrappedShape(body: string): boolean {
  return (
    /^\(.*\)$/.test(body) ||
    /^\{.*\}$/.test(body) ||
    /^\[.*\]$/.test(body)
  );
}

export function quoteLabels(source: string): string {
  let out = "";
  let index = 0;
  while (index < source.length) {
    const char = source[index];
    // Copy existing quoted text verbatim; it is already valid.
    if (char === '"') {
      const end = source.indexOf('"', index + 1);
      if (end === -1) {
        return out + source.slice(index);
      }
      out += source.slice(index, end + 1);
      index = end + 1;
      continue;
    }
    const closer = OPENERS[char];
    const end = closer ? findCloser(source, index) : -1;
    const body = end === -1 ? "" : source.slice(index + 1, end);
    if (
      body &&
      NEEDS_QUOTING.test(body) &&
      !body.includes('"') &&
      !isWrappedShape(body)
    ) {
      out += `${char}"${body}"${closer}`;
      index = end + 1;
      continue;
    }
    out += char;
    index += 1;
  }
  return out;
}
