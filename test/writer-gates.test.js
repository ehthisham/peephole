import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Exercises writer.setState end-to-end against a real (local, remote-less) git repo so the ledger
// resolves to an in-repo worktree — no network. Proves provenance (mode) and the gate stamp are
// actually written to the ticket file on disk, and that an ungated human move adds neither key.

let tmp, repo, ledgerHome, setState;

function git(cwd, args) {
  return execFileSync("git", args, { cwd, stdio: ["ignore", "pipe", "pipe"] }).toString();
}

function writeTicket(dir, id, state) {
  const now = "2026-01-01T00:00:00.000Z";
  const fm = [
    "---",
    `id: ${id}`,
    "project: t",
    "intent: sample",
    "acceptance: ''",
    `state: ${state}`,
    "risk: reversible",
    "control: run",
    "owner: null",
    "history:",
    `  - at: '${now}'`,
    "    from: null",
    `    to: ${state}`,
    "    by: seed",
    "---",
    "",
  ].join("\n");
  fs.writeFileSync(path.join(dir, `${id}.md`), fm);
}

before(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "peephole-wgate-"));
  repo = path.join(tmp, "repo");
  ledgerHome = path.join(tmp, "ledgers");
  fs.mkdirSync(repo);
  fs.mkdirSync(ledgerHome);
  process.env.PEEPHOLE_LEDGER_HOME = ledgerHome;

  git(repo, ["init", "-q", "-b", "main"]);
  git(repo, ["config", "user.email", "t@t"]);
  git(repo, ["config", "user.name", "t"]);
  fs.writeFileSync(path.join(repo, "README.md"), "# t\n");

  // With no remote, the ledger worktree is branched off HEAD (see ensureWorktree), so the gates
  // config + seed tickets go on HEAD (main) — the worktree inherits them.
  const base = path.join(repo, ".peephole");
  const tickets = path.join(base, "tickets");
  fs.mkdirSync(tickets, { recursive: true });
  fs.writeFileSync(
    path.join(base, "config.yaml"),
    "project: t\nstateBranch: peephole-state\ngates:\n  - verified->shipped\n",
  );
  writeTicket(tickets, "sample", "verified");
  writeTicket(tickets, "early", "in-progress");
  git(repo, ["add", "-A"]);
  git(repo, ["commit", "-q", "-m", "init + seed ledger"]);

  ({ setState } = await import("../src/writer.js"));
});

after(() => {
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
  delete process.env.PEEPHOLE_LEDGER_HOME;
});

test("gated verified->shipped on auto records mode + gate stamp", async () => {
  const res = await setState(repo, "peephole-state", "sample", "shipped", "alice", null, "auto");
  const last = res.ticket.history[res.ticket.history.length - 1];
  assert.equal(last.to, "shipped");
  assert.equal(last.mode, "auto", "provenance recorded");
  assert.equal(last.gate, true, "gate stamp recorded on a gated transition");
});

test("ungated in-progress->built on human adds neither key (byte-compat)", async () => {
  const res = await setState(repo, "peephole-state", "early", "built", "bob", null, "human");
  const last = res.ticket.history[res.ticket.history.length - 1];
  assert.equal(last.to, "built");
  assert.equal("mode" in last, false, "human mode is implicit, not stored");
  assert.equal("gate" in last, false, "ungated move carries no stamp");
});

test("invalid mode is rejected", async () => {
  await assert.rejects(
    () => setState(repo, "peephole-state", "early", "verified", "bob", null, "robot"),
    /invalid mode "robot"/,
  );
});
