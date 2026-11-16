import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { scan } from "../src/scan.js";
import { serializeTicket } from "../src/schema.js";

// scan() memoizes parseTicket by file (size, mtime). We can't spy on the parser across the module
// boundary, so we prove it behaviourally: an unchanged file yields the SAME parsed ticket object
// across two scans (a cache hit returns the cached object by reference), and a changed file yields a
// NEW object with the new content (a miss re-parses).

let dir, ticketPath;

function writeTicket(intent) {
  const md = serializeTicket({
    project: "t", intent, state: "closed", risk: "reversible", control: "run", owner: null,
    history: [{ at: "2026-01-01T00:00:00.000Z", to: "proposed" }],
  });
  fs.writeFileSync(ticketPath, md, "utf8");
}

before(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "peephole-scan-"));
  fs.mkdirSync(path.join(dir, ".peephole", "tickets"), { recursive: true });
  fs.mkdirSync(path.join(dir, ".peephole", "agents"), { recursive: true });
  fs.writeFileSync(path.join(dir, ".peephole", "config.yaml"), "project: t\nstateBranch: peephole-state\n");
  ticketPath = path.join(dir, ".peephole", "tickets", "t1.md");
  writeTicket("first");
});

after(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} });

test("scan: an unchanged ticket is returned from cache (same object identity across scans)", async () => {
  const a = await scan(dir, "HEAD");
  const b = await scan(dir, "HEAD");
  const ta = a.tickets.find((t) => t.id === "t1");
  const tb = b.tickets.find((t) => t.id === "t1");
  assert.ok(ta && tb);
  assert.equal(ta.intent, "first");
  assert.equal(ta, tb, "cache hit must return the very same parsed ticket object");
});

test("scan: changing the ticket file invalidates the cache (new object, new content)", async () => {
  const before = await scan(dir, "HEAD");
  const tBefore = before.tickets.find((t) => t.id === "t1");

  // New content → different size → guaranteed cache miss (key is size+mtime).
  writeTicket("second intent, longer than the first");
  const after = await scan(dir, "HEAD");
  const tAfter = after.tickets.find((t) => t.id === "t1");

  assert.equal(tAfter.intent, "second intent, longer than the first");
  assert.notEqual(tAfter, tBefore, "a changed file must be re-parsed into a fresh object");
});

test("scan: a cache hit still re-reports an invalid ticket each scan", async () => {
  // Write a malformed ticket (missing required fields), scan twice, both scans must surface the issue
  // — the cache memoizes the parse RESULT (errors included), it does not swallow errors on the 2nd run.
  const badPath = path.join(dir, ".peephole", "tickets", "bad.md");
  fs.writeFileSync(badPath, "---\nstate: nonsense-state\n---\nbody\n", "utf8");
  const a = await scan(dir, "HEAD");
  const b = await scan(dir, "HEAD");
  const has = (r) => r.issues.some((i) => i.kind === "invalid-ticket" && i.ticketId === "bad");
  assert.ok(has(a), "first scan reports the invalid ticket");
  assert.ok(has(b), "cached scan still reports the invalid ticket");
});
