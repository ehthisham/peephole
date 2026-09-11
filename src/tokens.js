import fs from "node:fs/promises";

/**
 * Sums token usage for one Claude Code session from its transcript JSONL
 * (the `transcript_path` every hook receives on stdin — see hooks/*.js). Reads
 * the whole file since a transcript is append-only and small relative to a
 * session's own work; called only on the throttled heartbeat path (once a
 * minute at most), never per tool call.
 *
 * `cacheReadTokens` is kept separate from the headline total: it's context
 * re-sent (and heavily discounted) on every turn, not new work, so folding it
 * into "tokens used" would make the number balloon with turn count rather
 * than reflect actual usage. `totalTokens` here is input + output + cache
 * writes — the tokens actually billed at full/near-full rate.
 */
export async function sessionTokenUsage(transcriptPath) {
  if (!transcriptPath) return null;
  let text;
  try {
    text = await fs.readFile(transcriptPath, "utf8");
  } catch {
    return null;
  }

  let inputTokens = 0;
  let outputTokens = 0;
  let cacheReadTokens = 0;
  let cacheCreationTokens = 0;

  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (entry.type !== "assistant") continue;
    const usage = entry.message && entry.message.usage;
    if (!usage) continue;
    inputTokens += usage.input_tokens || 0;
    outputTokens += usage.output_tokens || 0;
    cacheReadTokens += usage.cache_read_input_tokens || 0;
    cacheCreationTokens += usage.cache_creation_input_tokens || 0;
  }

  return {
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheCreationTokens,
    totalTokens: inputTokens + outputTokens + cacheCreationTokens,
  };
}
