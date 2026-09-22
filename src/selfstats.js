import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";

/**
 * How YOU worked with Claude, from your own transcripts on this machine.
 *
 * Local-only by construction, and that is the design rather than a limitation. Other people's
 * transcripts are not on this machine, and shipping them into a shared ledger so a board could
 * compare colleagues would turn an introspective metric into surveillance. So this answers
 * questions about the person running the board, appears only on their own member page, and is
 * never committed, never broadcast, never included in the board's state.
 *
 * Everything here is measured from timestamps and message counts. Nothing reads what you wrote
 * except one deliberate heuristic — steers — which counts short prompts that read like a course
 * correction, and is labelled as a guess wherever it is shown.
 */
const CHUNK = 2 * 1024 * 1024;
const MAX_SCAN_PER_FILE = 32 * 1024 * 1024;
const MAX_FILES = 40;
/** A gap longer than this ends a stretch of focused work. Twelve minutes is long enough to survive
 *  reading a diff or waiting on a build, short enough that lunch is not counted as work. */
const FOCUS_GAP_MS = 12 * 60 * 1000;

/** Phrases that read like redirecting the model rather than asking it something new. A blunt
 *  instrument, deliberately: it is shown as "steers (rough)" and never as a score. */
const STEER = /\b(no|nope|wrong|don't|dont|stop|revert|undo|actually|instead|that's not|thats not|not what|rollback|go back)\b/i;

function dayKey(ts) {
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/** The tail of a JSONL file, back to `since`, in whole lines. Same reasoning as the ticket log:
 *  transcripts are append-only and one of them is 580MB. */
async function tailLines(file, since) {
  const handle = await fs.open(file, "r");
  try {
    const { size } = await handle.stat();
    let end = size;
    let text = "";
    while (end > 0 && size - end < MAX_SCAN_PER_FILE) {
      const start = Math.max(0, end - CHUNK);
      const buf = Buffer.alloc(end - start);
      await handle.read(buf, 0, buf.length, start);
      text = buf.toString("utf8") + text;
      end = start;
      const firstTs = text.match(/"timestamp":"([^"]+)"/);
      if (firstTs && Date.parse(firstTs[1]) < since) break;
    }
    const lines = text.split("\n");
    if (end > 0) lines.shift();
    return lines;
  } finally {
    await handle.close();
  }
}

async function recentTranscripts(since) {
  const root = path.join(os.homedir(), ".claude", "projects");
  let dirs = [];
  try {
    dirs = await fs.readdir(root);
  } catch {
    return [];
  }
  const files = [];
  for (const dir of dirs) {
    let names = [];
    try {
      names = await fs.readdir(path.join(root, dir));
    } catch {
      continue;
    }
    for (const name of names) {
      if (!name.endsWith(".jsonl")) continue;
      const file = path.join(root, dir, name);
      try {
        const stat = await fs.stat(file);
        // A file untouched since the window started cannot contain anything in it.
        if (stat.mtimeMs >= since) files.push({ file, project: dir, mtimeMs: stat.mtimeMs, size: stat.size });
      } catch {
        /* skip */
      }
    }
  }
  return files.sort((a, b) => b.mtimeMs - a.mtimeMs).slice(0, MAX_FILES);
}

/**
 * A day-by-day summary of the last `days` days: how long you were actually working, how many
 * sessions, how much you said, how much the model did, and roughly how often you steered it.
 *
 * Focused time is the sum of gaps between consecutive events that are shorter than FOCUS_GAP_MS —
 * not wall-clock from first to last event, which would count a session left open overnight as a
 * fourteen-hour day.
 */
export async function selfStats({ days = 7 } = {}) {
  const since = Date.now() - days * 24 * 60 * 60 * 1000;
  const files = await recentTranscripts(since);
  const byDay = new Map();
  const projects = new Map();

  function day(key) {
    if (!byDay.has(key)) {
      byDay.set(key, { date: key, focusedMs: 0, sessions: new Set(), prompts: 0, replies: 0, tools: 0, steers: 0 });
    }
    return byDay.get(key);
  }

  for (const { file, project } of files) {
    let lines;
    try {
      lines = await tailLines(file, since);
    } catch {
      continue;
    }
    let previous = null;
    for (const line of lines) {
      if (!line.trim()) continue;
      let entry;
      try {
        entry = JSON.parse(line);
      } catch {
        continue;
      }
      const ts = entry.timestamp ? Date.parse(entry.timestamp) : null;
      if (!ts || ts < since) continue;
      if (entry.type !== "user" && entry.type !== "assistant") continue;

      const d = day(dayKey(ts));
      if (entry.sessionId) d.sessions.add(entry.sessionId);
      // Gaps are measured within a file: two projects worked in parallel are two streams, and
      // interleaving them would invent focus that was really one stretch counted twice.
      if (previous && ts - previous < FOCUS_GAP_MS && ts > previous) d.focusedMs += ts - previous;
      previous = ts;

      const msg = entry.message || {};
      if (entry.type === "assistant") {
        d.replies += 1;
        const blocks = Array.isArray(msg.content) ? msg.content : [];
        d.tools += blocks.filter((b) => b.type === "tool_use").length;
        continue;
      }
      if (entry.isMeta) continue;
      const content = typeof msg.content === "string"
        ? msg.content
        : (msg.content || []).filter((c) => c.type === "text").map((c) => c.text).join(" ");
      if (Array.isArray(msg.content) && msg.content.some((c) => c.type === "tool_result")) continue;
      if (!content.trim()) continue;
      d.prompts += 1;
      // Short and corrective: a long message that happens to contain "no" is usually a new
      // instruction, not a steer.
      if (content.length < 240 && STEER.test(content)) d.steers += 1;
      projects.set(project, (projects.get(project) || 0) + 1);
    }
  }

  const daysOut = [...byDay.values()]
    .map((d) => ({
      date: d.date,
      focusedMinutes: Math.round(d.focusedMs / 60000),
      sessions: d.sessions.size,
      prompts: d.prompts,
      replies: d.replies,
      tools: d.tools,
      steers: d.steers,
    }))
    .sort((a, b) => a.date.localeCompare(b.date));

  const totals = daysOut.reduce(
    (acc, d) => ({
      focusedMinutes: acc.focusedMinutes + d.focusedMinutes,
      sessions: acc.sessions + d.sessions,
      prompts: acc.prompts + d.prompts,
      replies: acc.replies + d.replies,
      tools: acc.tools + d.tools,
      steers: acc.steers + d.steers,
    }),
    { focusedMinutes: 0, sessions: 0, prompts: 0, replies: 0, tools: 0, steers: 0 },
  );

  return {
    windowDays: days,
    scannedFiles: files.length,
    days: daysOut,
    totals,
    topProjects: [...projects.entries()].sort((a, b) => b[1] - a[1]).slice(0, 4).map(([name, prompts]) => ({ name, prompts })),
  };
}
