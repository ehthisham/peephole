import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { inProgressSpans, ticketActiveMs, ticketLog, ticketSessionIds, claimTimes, ticketWorkedFiles, DEFAULT_IDLE_GAP_MS } from "../src/sessionlog.js";

// --- inProgressSpans: only real state moves bound a span, reopens add their own ----------------

test("inProgressSpans: one claim → built span, metadata events ignored", () => {
  const t = { history: [
    { at: "2026-01-01T10:00:00.000Z", to: "proposed" },
    { at: "2026-01-01T10:01:00.000Z", to: "title:renamed" }, // metadata — ignored
    { at: "2026-01-01T10:05:00.000Z", to: "in-progress" },
    { at: "2026-01-01T10:35:00.000Z", to: "built" },
    { at: "2026-01-01T11:00:00.000Z", to: "closed" },
  ] };
  const spans = inProgressSpans(t);
  assert.equal(spans.length, 1);
  assert.equal(spans[0].to - spans[0].from, 30 * 60 * 1000); // 10:05 → 10:35
});

test("inProgressSpans: a reopen yields two spans", () => {
  const t = { history: [
    { at: "2026-01-01T10:00:00.000Z", to: "in-progress" },
    { at: "2026-01-01T10:10:00.000Z", to: "built" },
    { at: "2026-01-01T10:20:00.000Z", to: "in-progress" }, // reopened
    { at: "2026-01-01T10:25:00.000Z", to: "built" },
  ] };
  const spans = inProgressSpans(t);
  assert.equal(spans.length, 2);
  assert.equal(spans[0].to - spans[0].from, 10 * 60 * 1000);
  assert.equal(spans[1].to - spans[1].from, 5 * 60 * 1000);
});

test("inProgressSpans: still in-progress runs to `now`", () => {
  const now = Date.parse("2026-01-01T12:00:00.000Z");
  const t = { history: [{ at: "2026-01-01T11:00:00.000Z", to: "in-progress" }], state: "in-progress" };
  const spans = inProgressSpans(t, now);
  assert.equal(spans.length, 1);
  assert.equal(spans[0].to, now);
});

// --- ticketActiveMs: idle gaps removed, after-window activity excluded -------------------------

let tmp, transcript;

before(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "peephole-active-"));
  transcript = path.join(tmp, "session.jsonl");
  // Claim 10:00 → built 11:00. Two active clusters (2m each) separated by a 38m idle gap, plus one
  // entry AFTER the window (11:10) that must not count.
  const ts = [
    "2026-01-01T10:00:00.000Z", "2026-01-01T10:01:00.000Z", "2026-01-01T10:02:00.000Z", // cluster A: 2m
    "2026-01-01T10:40:00.000Z", "2026-01-01T10:41:00.000Z", "2026-01-01T10:42:00.000Z", // cluster B: 2m (38m gap before)
    "2026-01-01T11:10:00.000Z", // after built — outside window
  ];
  fs.writeFileSync(transcript, ts.map((t) => JSON.stringify({ type: "assistant", timestamp: t })).join("\n") + "\n");
});

after(() => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {} });

function ticket() {
  return {
    id: "t1",
    state: "built",
    owner: "89a6d3ff-e5c1-4667-b47c-9bfb4a52576a",
    sessions: [{ sessionId: "89a6d3ff-e5c1-4667-b47c-9bfb4a52576a", transcriptPath: transcript }],
    history: [
      { at: "2026-01-01T10:00:00.000Z", to: "in-progress" },
      { at: "2026-01-01T11:00:00.000Z", to: "built" },
    ],
  };
}

test("ticketActiveMs: sums active clusters, drops the idle gap and after-window entries", async () => {
  const r = await ticketActiveMs(ticket());
  assert.equal(r.hadTranscript, true);
  assert.equal(r.spans, 1);
  // 2m (cluster A) + 2m (cluster B); the 38m gap > 10m default is excluded, 11:10 is out of window.
  assert.equal(r.activeMs, 4 * 60 * 1000);
});

test("ticketActiveMs: a larger idle threshold folds the gap back in", async () => {
  const r = await ticketActiveMs(ticket(), { idleGapMs: 60 * 60 * 1000 });
  // Now the 38m gap counts: 10:00 → 10:42 continuous = 42m.
  assert.equal(r.activeMs, 42 * 60 * 1000);
});

test("ticketActiveMs: never claimed → null (no work at all)", async () => {
  const r = await ticketActiveMs({ id: "t2", state: "proposed", history: [{ at: "2026-01-01T10:00:00.000Z", to: "proposed" }] });
  assert.equal(r.activeMs, null);
  assert.equal(r.spans, 0);
});

test("ticketActiveMs: claimed but no transcript on this machine → null, not zero", async () => {
  const r = await ticketActiveMs({
    id: "t3", state: "built",
    sessions: [{ sessionId: "no-such-session-id-at-all", transcriptPath: path.join(tmp, "missing.jsonl") }],
    history: [
      { at: "2026-01-01T10:00:00.000Z", to: "in-progress" },
      { at: "2026-01-01T10:30:00.000Z", to: "built" },
    ],
  });
  assert.equal(r.activeMs, null);
  assert.equal(r.hadTranscript, false);
});

test("DEFAULT_IDLE_GAP_MS is 10 minutes", () => {
  assert.equal(DEFAULT_IDLE_GAP_MS, 10 * 60 * 1000);
});

// --- boundaries: a sibling claim in the same session clips this ticket's worked window ----------

test("ticketSessionIds / claimTimes expose the session + claim moments", () => {
  const t = {
    owner: "89a6d3ff-e5c1-4667-b47c-9bfb4a52576a",
    sessions: [{ sessionId: "89a6d3ff-e5c1-4667-b47c-9bfb4a52576a" }, { sessionId: "other" }],
    history: [
      { at: "2026-01-01T10:00:00.000Z", to: "in-progress" },
      { at: "2026-01-01T10:30:00.000Z", to: "built" },
      { at: "2026-01-01T11:00:00.000Z", to: "in-progress" },
    ],
  };
  assert.deepEqual([...ticketSessionIds(t)].sort(), ["89a6d3ff-e5c1-4667-b47c-9bfb4a52576a", "other"]);
  assert.deepEqual(claimTimes(t), [Date.parse("2026-01-01T10:00:00.000Z"), Date.parse("2026-01-01T11:00:00.000Z")]);
});

test("ticketActiveMs: a boundary (sibling claim) clips the span so shared-session time is not double-counted", async () => {
  // Same transcript as the suite's fixture: clusters at 10:00-10:02 and 10:40-10:42, window 10:00→11:00.
  // Without a boundary both clusters count (4m). A sibling ticket claimed at 10:30 means this ticket's
  // worked window ends at 10:30 — so cluster B (10:40+) belongs to the sibling, not here.
  const boundary = Date.parse("2026-01-01T10:30:00.000Z");
  const r = await ticketActiveMs(ticket(), { boundaries: [boundary] });
  assert.equal(r.activeMs, 2 * 60 * 1000, "only cluster A (before the sibling claim) counts");
});

test("ticketActiveMs: a boundary at/after the claim with no later work → 0, not null (claimed, just handed off)", async () => {
  const boundary = Date.parse("2026-01-01T10:00:30.000Z"); // 30s after claim, before any real cluster
  const r = await ticketActiveMs(ticket(), { boundaries: [boundary] });
  // The span is clipped to 10:00:00–10:00:30; the 10:00:00 stamp is the only one inside → 0 elapsed.
  assert.equal(r.activeMs, 0);
});

// --- ticketWorkedFiles: edited files scoped to the claim window, counted, deduped --------------

test("ticketWorkedFiles: lists edited files in the window, most-edited first, excludes reads/out-of-window", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "peephole-worked-"));
  const file = path.join(dir, "s.jsonl");
  const tool = (ts, name, input) => JSON.stringify({
    type: "assistant", timestamp: ts, message: { content: [{ type: "tool_use", name, input }] },
  });
  // Claim 10:00 → built 11:00. Edit a.js twice + b.js once inside; a Read (not an edit) inside;
  // and an Edit AFTER built (another ticket) that must not count.
  fs.writeFileSync(file, [
    tool("2026-01-01T10:10:00.000Z", "Edit", { file_path: "src/a.js" }),
    tool("2026-01-01T10:15:00.000Z", "Read", { file_path: "src/ignore-me.js" }),
    tool("2026-01-01T10:20:00.000Z", "Write", { file_path: "src/a.js" }),
    tool("2026-01-01T10:30:00.000Z", "Edit", { file_path: "src/b.js" }),
    tool("2026-01-01T15:00:00.000Z", "Edit", { file_path: "src/later.js" }),
  ].join("\n") + "\n");
  const t = {
    id: "t-wf", state: "built",
    sessions: [{ sessionId: "bbbbbbbb-0000-0000-0000-000000000000", transcriptPath: file }],
    history: [
      { at: "2026-01-01T10:00:00.000Z", to: "in-progress" },
      { at: "2026-01-01T11:00:00.000Z", to: "built" },
    ],
  };
  try {
    const r = await ticketWorkedFiles(t);
    assert.equal(r.hadTranscript, true);
    assert.deepEqual(r.files, [
      { path: "src/a.js", edits: 2 },
      { path: "src/b.js", edits: 1 },
    ]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("ticketWorkedFiles: never claimed → empty, hadTranscript false (unknown)", async () => {
  const r = await ticketWorkedFiles({ id: "t-none", state: "proposed", history: [{ at: "2026-01-01T10:00:00.000Z", to: "proposed" }] });
  assert.deepEqual(r.files, []);
  assert.equal(r.hadTranscript, false);
});

// --- ticketLog: events scoped to the in-progress span, not to `now` ----------------------------

test("ticketLog: a built ticket's log excludes activity after it left in-progress", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "peephole-log-"));
  const file = path.join(dir, "s.jsonl");
  const line = (ts, text) => JSON.stringify({ type: "assistant", timestamp: ts, message: { content: [{ type: "text", text }] } });
  // Claim 10:00 → built 11:00. One message inside the span, one AFTER built (work on another ticket).
  fs.writeFileSync(file, [
    line("2026-01-01T10:30:00.000Z", "working on THIS ticket"),
    line("2026-01-01T15:00:00.000Z", "later work on ANOTHER ticket"),
  ].join("\n") + "\n");
  const t = {
    id: "t-log", state: "built",
    sessions: [{ sessionId: "aaaaaaaa-0000-0000-0000-000000000000", transcriptPath: file }],
    history: [
      { at: "2026-01-01T10:00:00.000Z", to: "in-progress" },
      { at: "2026-01-01T11:00:00.000Z", to: "built" },
    ],
  };
  const r = await ticketLog(t);
  const texts = r.sessions.flatMap((s) => s.events.map((e) => e.text));
  try {
    assert.ok(texts.some((x) => x.includes("THIS ticket")), "in-span event is kept");
    assert.ok(!texts.some((x) => x.includes("ANOTHER ticket")), "post-built event is excluded");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
