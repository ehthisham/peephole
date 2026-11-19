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

/** The default idle gap: a pause longer than this inside an in-progress span is treated as the
 *  person/agent being away (a break, an overnight, waiting on something external), not work. Ten
 *  minutes is deliberately forgiving — a local test or build run between tool calls still counts. */
export const DEFAULT_IDLE_GAP_MS = 10 * 60 * 1000;

// `verified` kept as a legacy alias so history spans on pre-0.13.0 tickets still read as real state moves.
const STATE_SET = new Set(["proposed", "in-progress", "built", "in-review", "verified", "shipped", "closed"]);

/** The in-progress spans from a ticket's history: each claim (→ in-progress) until the NEXT real
 *  state move (when it left in-progress), or `now` if it is still in-progress. A ticket reopened
 *  into in-progress more than once yields more than one span. Metadata events (title:/control:/…)
 *  share the history array and are ignored — only real state transitions bound a span. */
export function inProgressSpans(ticket, now = Date.now()) {
  const history = Array.isArray(ticket.history) ? ticket.history : [];
  const moves = history.filter((h) => STATE_SET.has(h.to));
  const spans = [];
  for (let i = 0; i < moves.length; i++) {
    if (moves[i].to !== "in-progress") continue;
    const from = Date.parse(moves[i].at);
    const to = i + 1 < moves.length ? Date.parse(moves[i + 1].at) : now;
    if (Number.isFinite(from) && Number.isFinite(to) && to > from) spans.push({ from, to });
  }
  return spans;
}

/** The session ids that touched a ticket: its recorded `sessions[]` plus the owner when the owner is
 *  itself a session uuid. The set used to resolve which transcript(s) to read for this ticket. */
export function ticketSessionIds(ticket) {
  const sessions = Array.isArray(ticket.sessions) ? ticket.sessions : [];
  const ids = new Set(sessions.map((s) => s.sessionId).filter(Boolean));
  if (ticket.owner && /^[0-9a-f]{8}-/i.test(ticket.owner)) ids.add(ticket.owner);
  return ids;
}

/** The timestamps (ms) at which a ticket was moved INTO in-progress — one per claim/reopen. */
export function claimTimes(ticket) {
  const history = Array.isArray(ticket.history) ? ticket.history : [];
  return history.filter((h) => h.to === "in-progress").map((h) => Date.parse(h.at)).filter(Number.isFinite);
}

/** Clip each span's end down to the earliest `boundary` that falls strictly inside it. The boundaries
 *  are the claim times of OTHER tickets worked by the same session: when a session claims a different
 *  ticket, it has stopped working this one (ownership is exclusive — one ticket at a time), so this
 *  ticket's worked window ends there. Without the clip, a ticket left in-progress while the session
 *  moved on to another ticket absorbs the other ticket's transcript activity, and the shared stamps
 *  are counted on both tickets — the "duration adds up across tickets in one session" bug. */
function clipSpans(spans, boundaries) {
  if (!boundaries || !boundaries.length) return spans;
  return spans
    .map((s) => {
      let to = s.to;
      for (const b of boundaries) if (b > s.from && b < to) to = b;
      return { from: s.from, to };
    })
    .filter((s) => s.to > s.from);
}

// A transcript is append-only and shared across many tickets, so parse each file's timestamps once
// per (size, mtime) version and reuse them for every ticket that reads it. Keyed by path.
const stampCache = new Map();

/** Every entry timestamp in a transcript, oldest first, read from the tail (bounded by MAX_SCAN)
 *  and memoised by the file's size+mtime so one 500MB file is scanned once, not once per ticket. */
async function transcriptStamps(file) {
  let st;
  try {
    st = await fs.stat(file);
  } catch {
    return [];
  }
  const cached = stampCache.get(file);
  if (cached && cached.size === st.size && cached.mtimeMs === st.mtimeMs) return cached.stamps;
  const stamps = [];
  try {
    // since=0: never early-stop, so the cache holds the whole scannable tail regardless of which
    // ticket's window asked for it first.
    const lines = await tailLines(file, 0);
    for (const line of lines) {
      const m = line.match(/"timestamp":"([^"]+)"/);
      if (!m) continue;
      const t = Date.parse(m[1]);
      if (Number.isFinite(t)) stamps.push(t);
    }
  } catch {
    return [];
  }
  stamps.sort((a, b) => a - b);
  stampCache.set(file, { size: st.size, mtimeMs: st.mtimeMs, stamps });
  return stamps;
}

/**
 * Actual worked time on a ticket: the time the transcript shows real activity inside the ticket's
 * in-progress span(s), with idle gaps removed. This is "work duration" — distinct from cycle time
 * (the raw in-progress span), which counts the overnight a ticket sits claimed but untouched.
 *
 * Timestamps from every transcript that touched the ticket are UNIONED (not summed per file) before
 * clustering, so two agents working the same ticket in parallel yield wall-clock active time rather
 * than double-counted effort. `boundaries` are claim times of OTHER tickets handled by the same
 * session(s); each in-progress span is clipped to end at the next such claim, so time a shared session
 * spent on a different ticket is never counted here too (see clipSpans). Returns { activeMs, spans,
 * hadTranscript }: activeMs is null when no transcript is on this machine (unknown, not zero) and 0
 * when a transcript exists but shows no activity in the window.
 */
export async function ticketActiveMs(ticket, { idleGapMs = DEFAULT_IDLE_GAP_MS, now = Date.now(), boundaries = [] } = {}) {
  const rawSpans = inProgressSpans(ticket, now);
  if (!rawSpans.length) return { activeMs: null, spans: 0, hadTranscript: false }; // never claimed → unknown
  const spans = clipSpans(rawSpans, boundaries);
  // Claimed, but every moment was reassigned to another ticket of the same session → zero worked here,
  // not "unknown". (A genuinely never-claimed ticket already returned null above.)
  if (!spans.length) return { activeMs: 0, spans: 0, hadTranscript: false };

  const sessions = Array.isArray(ticket.sessions) ? ticket.sessions : [];
  const ids = ticketSessionIds(ticket);

  const files = new Set();
  for (const sessionId of ids) {
    const recorded = (sessions.find((s) => s.sessionId === sessionId) || {}).transcriptPath || null;
    const file = await findTranscript(sessionId, recorded);
    if (file) files.add(file);
  }
  if (!files.size) return { activeMs: null, spans: spans.length, hadTranscript: false };

  const inWindow = [];
  for (const file of files) {
    const stamps = await transcriptStamps(file);
    for (const t of stamps) {
      if (spans.some((s) => t >= s.from && t <= s.to)) inWindow.push(t);
    }
  }
  if (!inWindow.length) return { activeMs: 0, spans: spans.length, hadTranscript: true };

  inWindow.sort((a, b) => a - b);
  let active = 0;
  for (let i = 1; i < inWindow.length; i++) {
    const d = inWindow[i] - inWindow[i - 1];
    if (d <= idleGapMs) active += d;
  }
  return { activeMs: active, spans: spans.length, hadTranscript: true };
}

// The tools that actually write to a file, mapped to the input key that names the file. Reads,
// searches and shell commands are excluded — "worked files" is what the agent edited, not looked at.
const EDIT_TOOLS = { Write: "file_path", Edit: "file_path", MultiEdit: "file_path", NotebookEdit: "notebook_path" };

/**
 * The files the agent actually edited while this ticket was in-progress, read from the session
 * transcript(s). Distinct from "changed files" (a git diff against the base branch): worked files
 * come from the transcript, so they are available with no branch, scoped to this ticket's claim
 * window, and reflect effort (a file edited then reverted still shows) rather than net result.
 *
 * Returns { files: [{ path, edits }] (most-edited first), hadTranscript }. `files` is empty with
 * hadTranscript:false when no transcript is on this machine (unknown), empty with hadTranscript:true
 * when a transcript exists but no edit happened in the window.
 */
export async function ticketWorkedFiles(ticket) {
  const sessions = Array.isArray(ticket.sessions) ? ticket.sessions : [];
  const spans = inProgressSpans(ticket);
  if (!spans.length) return { files: [], hadTranscript: false }; // never claimed → unknown
  const GRACE = 60000;
  const inWindow = (ts) => spans.some((s) => ts >= s.from - GRACE && ts <= s.to + GRACE);
  const from = Math.min(...spans.map((s) => s.from));

  const ids = ticketSessionIds(ticket);
  const counts = new Map(); // file path -> number of edits
  const seenFiles = new Set(); // resolved transcripts already parsed (two ids can share one file)
  let hadTranscript = false;
  for (const sessionId of ids) {
    const recorded = (sessions.find((s) => s.sessionId === sessionId) || {}).transcriptPath || null;
    const file = await findTranscript(sessionId, recorded);
    if (!file || seenFiles.has(file)) continue;
    seenFiles.add(file);
    hadTranscript = true;
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
        if (ts == null || !inWindow(ts)) continue;
        if (entry.type !== "assistant") continue;
        const blocks = Array.isArray(entry.message && entry.message.content) ? entry.message.content : [];
        for (const b of blocks) {
          if (b.type !== "tool_use") continue;
          const key = EDIT_TOOLS[b.name];
          if (!key) continue;
          const p = b.input && b.input[key];
          if (typeof p === "string" && p.trim()) counts.set(p, (counts.get(p) || 0) + 1);
        }
      }
    } catch {
      /* skip an unreadable transcript, keep what the others gave */
    }
  }
  const files = [...counts.entries()]
    .map(([path, edits]) => ({ path, edits }))
    .sort((a, b) => b.edits - a.edits || a.path.localeCompare(b.path));
  return { files, hadTranscript };
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
 * The log for one ticket: every session that touched it, with the events inside that ticket's
 * in-progress span(s). A session's transcript covers everything it ever did, most of which has
 * nothing to do with this ticket, so events are kept ONLY while the ticket was actually in-progress.
 *
 * The window must close when the ticket LEAVES in-progress — not merely when it is shipped/closed.
 * A ticket parked in `built` or `in-review` is no longer being worked, so running the window to `now`
 * dumped everything the session did on later tickets into this one's log (a built ticket claimed two
 * days ago showed two days of unrelated activity). Only a ticket literally in-progress right now has
 * an open span that reaches `now`.
 */
export async function ticketLog(ticket) {
  const sessions = Array.isArray(ticket.sessions) ? ticket.sessions : [];
  const history = Array.isArray(ticket.history) ? ticket.history : [];
  const spans = inProgressSpans(ticket);
  // Events are kept iff they fall inside an in-progress span (60s grace at each end to catch the
  // message that triggered the state change). Without spans (never claimed) nothing qualifies.
  const GRACE = 60000;
  const inWindow = (ts) => spans.some((s) => ts >= s.from - GRACE && ts <= s.to + GRACE);
  const from = spans.length ? Math.min(...spans.map((s) => s.from)) : (ticket.createdAt ? Date.parse(ticket.createdAt) : null);
  const to = spans.length ? Math.max(...spans.map((s) => s.to)) : Date.now();

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
        if (ts == null || !inWindow(ts)) continue;
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
