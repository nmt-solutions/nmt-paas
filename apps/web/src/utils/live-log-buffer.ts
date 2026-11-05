// Browser-safe retained-output limits. See docs/bounded-deployment-log-history.md.
export const LIVE_LOG_LINES = 1_000;
export const LIVE_LOG_CHARACTERS = 128 * 1024;

export type LiveLogBuffer = { lines: string[]; truncated: boolean };

export function appendLiveLog(
  current: LiveLogBuffer,
  text: string,
): LiveLogBuffer {
  let tail = text.slice(-LIVE_LOG_CHARACTERS);
  // Do not leave half a surrogate pair at the start of a clipped line.
  if (tail.length < text.length && /^[\uDC00-\uDFFF]/.test(tail))
    tail = tail.slice(1);
  const lines = [...current.lines, ...tail.split("\n")];
  let characters = lines.reduce(
    (total, line) => total + line.length,
    lines.length - 1,
  );
  let removed = 0;
  while (
    lines.length - removed > LIVE_LOG_LINES ||
    characters > LIVE_LOG_CHARACTERS
  ) {
    characters -= lines[removed]!.length + 1;
    removed++;
  }
  return {
    lines: lines.slice(removed),
    truncated: current.truncated || removed > 0 || tail.length < text.length,
  };
}
