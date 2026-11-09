import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// importTickets end-to-end against a real remote-less repo (in-repo worktree ledger). Proves
// create / update / skip decisions, dry-run writing nothing, and dedup-by-id (re-import updates).

let tmp, repo, setState, importTickets, parseTicket;

function git(cwd, args) {
  return execFileSync("git", args, { cwd, stdio: ["ignore", "pipe", "pipe"] }).toString();
}

before(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "peephole-import-"));
  repo = path.join(tmp, "repo");
  fs.mkdirSync(repo);
  process.env.PEEPHOLE_LEDGER_HOME = path.join(tmp, "ledgers");

  git(repo, ["init", "-q", "-b", "main"]);
  git(repo, ["config", "user.email", "t@t"]);
  git(repo, ["config", "user.name", "t"]);
  fs.writeFileSync(path.join(repo, "README.md"), "# t\n");
  const base = path.join(repo, ".peephole", "tickets");
  fs.mkdirSync(base, { recursive: true });
  fs.writeFileSync(path.join(repo, ".peephole", "config.yaml"), "project: imp\nstateBranch: peephole-state\n");
  git(repo, ["add", "-A"]);
  git(repo, ["commit", "-q", "-m", "init ledger"]);

  ({ importTickets } = await import("../src/writer.js"));
  ({ setState } = await import("../src/writer.js"));
  ({ parseTicket } = await import("../src/schema.js"));
});

after(() => {
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
  delete process.env.PEEPHOLE_LEDGER_HOME;
});

const recA = { id: "alpha", title: "Alpha", intent: "do alpha", state: "proposed", priority: "high", type: "feature", epic: null };
const recB = { id: "beta", title: "Beta", intent: "do beta", state: "in-progress", priority: "normal", type: "bug", epic: "E" };

test("dry-run reports decisions and writes nothing", async () => {
  const res = await importTickets(repo, "peephole-state", [recA, recB], { dryRun: true });
  assert.equal(res.committed, false);
  assert.equal(res.dryRun, true);
  assert.equal(res.created.length, 2);
  assert.equal(res.updated.length, 0);
  // Nothing committed — a real import right after still sees both as NEW.
  const real = await importTickets(repo, "peephole-state", [recA, recB], {});
  assert.equal(real.created.length, 2);
  assert.equal(real.committed, true);
});

test("re-import of identical rows skips (dedup by id, no duplicates)", async () => {
  const res = await importTickets(repo, "peephole-state", [recA, recB], {});
  assert.equal(res.created.length, 0);
  assert.equal(res.skipped.length, 2);
  assert.ok(res.skipped.every((s) => s.reason === "unchanged"));
});

test("changed field updates only that ticket, recording via:jira-import", async () => {
  const changed = { ...recA, priority: "urgent", title: "Alpha!" };
  const res = await importTickets(repo, "peephole-state", [changed, recB], {});
  assert.equal(res.updated.length, 1);
  assert.equal(res.updated[0].id, "alpha");
  assert.deepEqual(res.updated[0].changes.sort(), ["priority", "title"]);
  assert.equal(res.skipped.length, 1); // beta unchanged
});

test("imported ticket is valid and carries the mapped fields", async () => {
  // Resolve the ledger worktree the writer used and read alpha back.
  const f = path.join(repo, ".peephole-worktree", ".peephole", "tickets", "alpha.md");
  assert.ok(fs.existsSync(f), "ledger worktree holds the imported ticket");
  const parsed = parseTicket(fs.readFileSync(f, "utf8"), "alpha");
  assert.deepEqual(parsed.errors, []);
  assert.equal(parsed.ticket.priority, "urgent");
  assert.equal(parsed.ticket.type, "feature");
  assert.ok(parsed.ticket.history.some((h) => h.via === "jira-import"));
});
