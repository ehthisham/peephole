import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { validateTicket } from "../src/schema.js";

// --- schema: pr is an optional string -----------------------------------------------------------

const BASE = { project: "t", intent: "x", state: "proposed", risk: "reversible", control: "run", owner: null, history: [] };

test("validateTicket: pr absent is fine (back-compat)", () => {
  assert.deepEqual(validateTicket({ ...BASE }, "t1"), []);
});

test("validateTicket: pr as a URL string, and null, are accepted", () => {
  assert.deepEqual(validateTicket({ ...BASE, pr: "https://github.com/o/r/pull/42" }, "t1"), []);
  assert.deepEqual(validateTicket({ ...BASE, pr: null }, "t1"), []);
});

test("validateTicket: non-string pr is an error", () => {
  const errs = validateTicket({ ...BASE, pr: 42 }, "t1");
  assert.equal(errs.length, 1);
  assert.match(errs[0], /invalid pr/);
});

// --- writer: createTicket defaults pr null; setPr links / clears / onlyIfEmpty ------------------

let tmp, repo, ledgerHome, createTicket, setPr;

function git(cwd, args) {
  return execFileSync("git", args, { cwd, stdio: ["ignore", "pipe", "pipe"] }).toString();
}

function read(id) {
  const p = path.join(repo, ".peephole-worktree", ".peephole", "tickets", `${id}.md`);
  const alt = path.join(repo, ".peephole", "tickets", `${id}.md`);
  return fs.readFileSync(fs.existsSync(p) ? p : alt, "utf8");
}

before(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "peephole-pr-"));
  repo = path.join(tmp, "repo");
  ledgerHome = path.join(tmp, "ledgers");
  fs.mkdirSync(repo);
  fs.mkdirSync(ledgerHome);
  process.env.PEEPHOLE_LEDGER_HOME = ledgerHome;

  git(repo, ["init", "-q", "-b", "main"]);
  git(repo, ["config", "user.email", "t@t"]);
  git(repo, ["config", "user.name", "t"]);
  const base = path.join(repo, ".peephole");
  fs.mkdirSync(path.join(base, "tickets"), { recursive: true });
  fs.writeFileSync(path.join(base, "config.yaml"), "project: t\nstateBranch: peephole-state\n");
  git(repo, ["add", "-A"]);
  git(repo, ["commit", "-q", "-m", "init ledger"]);

  ({ createTicket, setPr } = await import("../src/writer.js"));
});

after(() => {
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
  delete process.env.PEEPHOLE_LEDGER_HOME;
});

test("createTicket defaults pr to null", async () => {
  const r = await createTicket(repo, "peephole-state", { id: "no-pr", project: "t", intent: "x" });
  assert.equal(r.ticket.pr, null);
});

test("setPr links, no-ops on repeat, then clears — recorded in history", async () => {
  await createTicket(repo, "peephole-state", { id: "p1", project: "t", intent: "x" });
  const url = "https://github.com/o/r/pull/7";

  const linked = await setPr(repo, "peephole-state", "p1", url, "alice");
  assert.equal(linked.ticket.pr, url);
  assert.equal(linked.ticket.history[linked.ticket.history.length - 1].to, `pr:${url}`);
  assert.match(read("p1"), /pull\/7/);

  const noop = await setPr(repo, "peephole-state", "p1", url, "alice");
  assert.equal(noop.committed, false, "re-setting the same url commits nothing");

  const cleared = await setPr(repo, "peephole-state", "p1", "", "alice");
  assert.equal(cleared.ticket.pr, null);
});

test("setPr rejects a non-http(s) URL (no javascript:/data: scheme reaches an href)", async () => {
  await createTicket(repo, "peephole-state", { id: "p3", project: "t", intent: "x" });
  await assert.rejects(() => setPr(repo, "peephole-state", "p3", "javascript:alert(1)", "alice"), /invalid pr URL/);
  await assert.rejects(() => setPr(repo, "peephole-state", "p3", "data:text/html,x", "alice"), /invalid pr URL/);
  // A plain empty clear is still allowed.
  const cleared = await setPr(repo, "peephole-state", "p3", "", "alice");
  assert.equal(cleared.ticket.pr, null);
});

test("setPr onlyIfEmpty: stamps an empty ticket but never clobbers an existing link", async () => {
  await createTicket(repo, "peephole-state", { id: "p2", project: "t", intent: "x" });

  // Auto path stamps the first time (field empty).
  const first = await setPr(repo, "peephole-state", "p2", "https://github.com/o/r/pull/1", "peephole-hook", { onlyIfEmpty: true });
  assert.equal(first.committed, true);
  assert.equal(first.ticket.pr, "https://github.com/o/r/pull/1");

  // Auto path seeing a different URL later leaves the existing link untouched.
  const second = await setPr(repo, "peephole-state", "p2", "https://github.com/o/r/pull/2", "peephole-hook", { onlyIfEmpty: true });
  assert.equal(second.committed, false);
  assert.equal(second.skipped, "already set");
  assert.equal(second.ticket.pr, "https://github.com/o/r/pull/1", "existing PR link is never clobbered by auto-capture");
});
