import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Self-heal: a leftover .peephole-worktree that has fallen behind the remote must be brought back in
// lockstep automatically on a sync resolve, so it can never serve stale ticket state. Exercised against
// a real local bare remote — no network.

function g(cwd, args) {
  return execFileSync("git", args, { cwd, stdio: ["ignore", "pipe", "pipe"] }).toString().trim();
}

let tmp, remote, repo, ledgerHome, resolveLedger, ensureWorktree;

function writeTicket(dir, id, state) {
  fs.writeFileSync(path.join(dir, `${id}.md`), [
    "---", `id: ${id}`, "project: t", "intent: x", "acceptance: ''",
    `state: ${state}`, "risk: reversible", "control: run", "owner: null",
    "history:", "  - at: '2026-01-01T00:00:00.000Z'", "    from: null", `    to: ${state}`, "    by: seed",
    "---", "",
  ].join("\n"));
}

function readState(file) {
  return (fs.readFileSync(file, "utf8").match(/^state:\s*(\S+)/m) || [])[1];
}

before(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "peephole-ledger-"));
  remote = path.join(tmp, "remote.git");
  repo = path.join(tmp, "repo");
  ledgerHome = path.join(tmp, "ledgers");
  fs.mkdirSync(ledgerHome);
  process.env.PEEPHOLE_LEDGER_HOME = ledgerHome;

  g(tmp, ["init", "--bare", "-b", "main", remote]);
  g(tmp, ["clone", "-q", remote, repo]);
  g(repo, ["config", "user.email", "t@t"]);
  g(repo, ["config", "user.name", "t"]);
  fs.writeFileSync(path.join(repo, "README.md"), "# t\n");
  g(repo, ["add", "-A"]);
  g(repo, ["commit", "-q", "-m", "init"]);
  g(repo, ["push", "-q", "origin", "main"]);

  // peephole-state with one ticket in 'shipped' (T0), pushed.
  g(repo, ["checkout", "-q", "-b", "peephole-state"]);
  const tdir = path.join(repo, ".peephole", "tickets");
  fs.mkdirSync(tdir, { recursive: true });
  fs.writeFileSync(path.join(repo, ".peephole", "config.yaml"), "project: t\nstateBranch: peephole-state\n");
  writeTicket(tdir, "sample", "shipped");
  g(repo, ["add", "-A"]);
  g(repo, ["commit", "-q", "-m", "seed T0"]);
  g(repo, ["push", "-q", "origin", "peephole-state"]);

  ({ resolveLedger } = await import("../src/ledger.js"));
  const gitmod = await import("../src/git.js");
  ensureWorktree = gitmod.ensureWorktree;
});

after(() => {
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
  delete process.env.PEEPHOLE_LEDGER_HOME;
});

test("a stale leftover .peephole-worktree is auto-synced to the remote on a fetch resolve", async () => {
  // Create the in-repo worktree at T0 (in sync).
  await ensureWorktree(repo, "peephole-state", "origin");
  const wtTicket = path.join(repo, ".peephole-worktree", ".peephole", "tickets", "sample.md");
  assert.equal(readState(wtTicket), "shipped", "worktree starts at T0 (shipped)");

  // Advance the remote to T1 (shipped -> closed) from the main checkout, leaving the worktree behind.
  g(repo, ["checkout", "-q", "peephole-state"]);
  writeTicket(path.join(repo, ".peephole", "tickets"), "sample", "closed");
  g(repo, ["add", "-A"]);
  g(repo, ["commit", "-q", "-m", "T1 close"]);
  g(repo, ["push", "-q", "origin", "peephole-state"]);

  // The worktree is now behind origin and still says 'shipped'.
  assert.equal(readState(wtTicket), "shipped", "worktree is stale before resolve");

  // A sync resolve picks the clone AND reconciles the leftover worktree.
  const res = await resolveLedger(repo, "peephole-state", { remote: "origin", fetch: true });
  assert.equal(res.kind, "clone", "clone mode is authoritative once the branch is pushed");
  assert.equal(readState(wtTicket), "closed", "stale worktree was auto-synced to the remote tip");
});

test("a leftover worktree holding UNPUSHED commits is left untouched (no data loss)", async () => {
  // Make a unique commit in the worktree that is not on the remote.
  const wtTickets = path.join(repo, ".peephole-worktree", ".peephole", "tickets");
  writeTicket(wtTickets, "local-only", "proposed");
  g(path.join(repo, ".peephole-worktree"), ["add", "-A"]);
  g(path.join(repo, ".peephole-worktree"), ["commit", "-q", "-m", "local-only work"]);

  await resolveLedger(repo, "peephole-state", { remote: "origin", fetch: true });

  // The unpushed ticket must still be there — reconcile must never hard-reset over unique commits.
  assert.ok(fs.existsSync(path.join(wtTickets, "local-only.md")), "unpushed worktree commit preserved");
});
