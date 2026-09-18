import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";

/**
 * What Claude actually did on a ticket, read from the session transcripts.
 *
 * A ticket records which sessions touched it (`sessions[]`, with the transcript path when the
 * agent passed `--transcript`). The transcript is the only durable account of the work itself —
 * the prompts, the replies, the tools used — and until now the board recorded that it happened
 * without being able to show any of it.
 *
 * Read BACKWARDS from the end of the file. Transcripts are append-only and chronological, and a
 * long-running session's file is enormous — 547MB on a real machine — so parsing one from the
 * start to find yesterday's ticket is not an option. Reading the tail until the timestamps fall
 * before the window costs a few megabytes for a recent ticket and stops early.
 */
const CHUNK = 2 * 1024 * 1024;
const MAX_SCAN = 64 * 1024 * 1024;
const MAX_EVENTS = 400;
const MAX_TEXT = 400;

function clip(text, max = MAX_TEXT) {
  const flat = String(text == null ? "" : text).replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/** Where a session's transcript lives: the path the agent reported, else the conventional location
 *  under ~/.claude/projects/<slugged cwd>/<session id>.jsonl, searched across projects because the
 *  session may have run from a different directory than the board is watching. */
async function findTranscript(sessionId, recordedPath) {
  if (recordedPath) {
    try {
      await fs.access(recordedPath);
      return recordedPath;
    } catch {
      /* fall through to the search */
    }
  }
  const root = path.join(os.homedir(), ".claude", "projects");
  let dirs = [];
  try {
    dirs = await fs.readdir(root);
  } catch {
    return null;
  }
  for (const dir of dirs) {
    const candidate = path.join(root, dir, `${sessionId}.jsonl`);
    try {
      await fs.access(candidate);
      return candidate;
    } catch {
      /* keep looking */
    }
  }
  return null;
}

/** The last `MAX_SCAN` bytes at most, read in chunks from the end, stopping as soon as a chunk
 *  contains a timestamp older than `since`. Returns whole lines, oldest first. */
async function tailLines(file, since) {
  const handle = await fs.open(file, "r");
  try {
    const { size } = await handle.stat();
    let end = size;
    let text = "";
    while (end > 0 && size - end < MAX_SCAN) {
      const start = Math.max(0, end - CHUNK);
      const buf = Buffer.alloc(end - start);
      await handle.read(buf, 0, buf.length, start);
      text = buf.toString("utf8") + text;
      end = start;
      // Stop once this much of the file predates the window — one timestamp older than `since`
      // means everything before it is older still.
      const firstTs = text.match(/"timestamp":"([^"]+)"/);
      if (since && firstTs && Date.parse(firstTs[1]) < since) break;
    }
    const lines = text.split("\n");
    // The first line is very likely truncated by the chunk boundary.
    if (end > 0) lines.shift();
    return lines;
  } finally {
    await handle.close();
  }
}

/** One readable event per transcript entry that carries something a person would want to see. */
function eventFrom(entry) {
  const at = entry.timestamp || null;
  const msg = entry.message || {};
  if (entry.type === "user") {
    if (entry.isMeta) return null;
    const content = typeof msg.content === "string"
      ? msg.content
      : (msg.content || []).filter((c) => c.type === "text").map((c) => c.text).join(" ");
    // Tool results arrive as user messages; they are noise next to the tool call itself.
    const isToolResult = Array.isArray(msg.content) && msg.content.some((c) => c.type === "tool_result");
    if (isToolResult || !content.trim()) return null;
    return { at, kind: "prompt", text: clip(content) };
  }
  if (entry.type === "assistant") {
    const blocks = Array.isArray(msg.content) ? msg.content : [];
    const said = blocks.filter((b) => b.type === "text").map((b) => b.text).join(" ");
    const tools = blocks.filter((b) => b.type === "tool_use").map((b) => {
      const input = b.input || {};
      // The one identifying detail per tool, not the whole input: a command, a path, a pattern.
      const detail = input.command || input.file_path || input.pattern || input.path || input.url || "";
      return { name: b.name, detail: clip(detail, 120) };
    });
    if (!said.trim() && !tools.length) return null;
    return {
      at, kind: "assistant",
      text: clip(said),
      tools,
      sidechain: Boolean(entry.isSidechain),
    };
  }
  return null;
}

/**
 * The log for one ticket: every session that touched it, with the events inside that session's
 * window on this ticket. The window comes from the ticket's own history — claimed until finished,
 * or until now — because a session's transcript covers everything it ever did, most of which has
 * nothing to do with this ticket.
 */
export async function ticketLog(ticket) {
  const sessions = Array.isArray(ticket.sessions) ? ticket.sessions : [];
  const history = Array.isArray(ticket.history) ? ticket.history : [];
  const claimedAt = history.find((h) => h.to === "in-progress");
  const finishedAt = [...history].reverse().find((h) => ["shipped", "closed"].includes(h.to));
  const from = claimedAt ? Date.parse(claimedAt.at) : (ticket.createdAt ? Date.parse(ticket.createdAt) : null);
  const to = finishedAt ? Date.parse(finishedAt.at) : Date.now();

  // A ticket whose owner was never recorded in sessions[] still has an owner worth trying.
  const ids = new Set(sessions.map((s) => s.sessionId).filter(Boolean));
  if (ticket.owner && /^[0-9a-f]{8}-/i.test(ticket.owner)) ids.add(ticket.owner);

  const out = [];
  const byFile = new Map(); // resolved transcript -> the entry already built for it
  for (const sessionId of ids) {
    const recorded = (sessions.find((s) => s.sessionId === sessionId) || {}).transcriptPath || null;
    const file = await findTranscript(sessionId, recorded);
    if (!file) {
      out.push({ sessionId, found: false, events: [], reason: "no transcript on this machine" });
      continue;
    }
    // Older CLI calls recorded a person's NAME in sessions[].sessionId while passing that
    // session's transcript path, so two entries can resolve to one file. Read it once and note
    // both ids, rather than printing the same 63 events twice.
    const already = byFile.get(file);
    if (already) {
      already.alsoRecordedAs = [...(already.alsoRecordedAs || []), sessionId];
      continue;
    }

    let events = [];
    try {
      const lines = await tailLines(file, from);
      for (const line of lines) {
        if (!line.trim()) continue;
        let entry;
        try {
          entry = JSON.parse(line);
        } catch {
          continue; // a partial line at a chunk boundary
        }
        const ts = entry.timestamp ? Date.parse(entry.timestamp) : null;
        if (ts == null || (from && ts < from) || ts > to + 60000) continue;
        const event = eventFrom(entry);
        if (event) events.push(event);
      }
    } catch (e) {
      out.push({ sessionId, found: true, file, events: [], reason: e.message });
      continue;
    }
    // Newest last, and capped from the END: the tail of a ticket's work is the part worth reading.
    if (events.length > MAX_EVENTS) events = events.slice(events.length - MAX_EVENTS);
    const entry = { sessionId, found: true, file, events, window: { from, to } };
    byFile.set(file, entry);
    out.push(entry);
  }
  return { ticketId: ticket.id, sessions: out };
}
