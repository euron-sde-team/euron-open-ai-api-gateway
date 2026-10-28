/** Parse one SSE buffer into complete `data:` payloads and the unfinished remainder. Pure (tested). */
export function splitSse(buffer: string): { events: string[]; rest: string } {
  const parts = buffer.split(/\r?\n\r?\n/);
  const rest = parts.pop() ?? "";
  const events = parts.map((p) =>
    p
      .split(/\r?\n/)
      .filter((l) => l.startsWith("data:"))
      .map((l) => l.slice(5).trimStart())
      .join("\n"),
  );
  return { events: events.filter(Boolean), rest };
}
