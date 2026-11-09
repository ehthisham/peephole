import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { markEnabledIfUnset, setEnabled, getEnabled, isLedgerCheckout, ENABLED_KEY } from "../src/enable.js";

let tmp, repo, plain, ledgerHome;

function git(cwd, args) {
  return execFileSync("git", args, { cwd, stdio: ["ignore", "pipe", "pipe"] }).toString().trim();
}
function freshRepo(name) {
  const d = path.join(tmp, name);
  fs.mkdirSync(d, { recursive: true });
  git(d, ["init", "-q"]);
  git(d, ["config", "user.email", "t@t"]);
  git(d, ["config", "user.name", "t"]);
  return d;
}

before(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "peephole-enable-"));
  ledgerHome = path.join(tmp, "ledgers");
  fs.mkdirSync(ledgerHome, { recursive: true });
  process.env.PEEPHOLE_LEDGER_HOME = ledgerHome;
  repo = freshRepo("repo");
  plain = path.join(tmp, "plain");
  fs.mkdirSync(plain, { recursive: true }); // a directory that is NOT a git checkout
});

after(() => {
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
  delete process.env.PEEPHOLE_LEDGER_HOME;
});

test("sets peephole.enabled=true when unset in a git checkout", async () => {
  assert.equal(await getEnabled(repo), null);
  const res = await markEnabledIfUnset(repo);
  assert.equal(res.marked, true);
  assert.equal(git(repo, ["config", "--local", "--get", ENABLED_KEY]), "true");
});

test("does not override an explicit false (opt-out is respected)", async () => {
  const r = freshRepo("optout");
  git(r, ["config", "--local", ENABLED_KEY, "false"]);
  const res = await markEnabledIfUnset(r);
  assert.equal(res.marked, false);
  assert.match(res.reason, /already false/);
  assert.equal(await getEnabled(r), "false");
});

test("does not override an existing true (idempotent)", async () => {
  const res = await markEnabledIfUnset(repo); // already true from the first test
  assert.equal(res.marked, false);
  assert.match(res.reason, /already true/);
});

test("no write when the directory is not a git checkout", async () => {
  const res = await markEnabledIfUnset(plain);
  assert.equal(res.marked, false);
  assert.match(res.reason, /not a git checkout/);
  assert.equal(fs.existsSync(path.join(plain, ".git")), false);
});

test("never marks a ledger checkout", async () => {
  const ledgerRepo = freshRepo(path.join("ledgers", "proj-abc"));
  assert.equal(isLedgerCheckout(ledgerRepo), true);
  const res = await markEnabledIfUnset(ledgerRepo);
  assert.equal(res.marked, false);
  assert.match(res.reason, /ledger checkout/);
  assert.equal(await getEnabled(ledgerRepo), null);
});

test("isLedgerCheckout flags a .peephole-worktree dir", () => {
  assert.equal(isLedgerCheckout("/some/repo/.peephole-worktree"), true);
  assert.equal(isLedgerCheckout("/some/repo"), false);
});

test("enable / disable set the value explicitly (override)", async () => {
  const r = freshRepo("toggle");
  let res = await setEnabled(r, true);
  assert.deepEqual([res.ok, res.value], [true, "true"]);
  res = await setEnabled(r, false);
  assert.deepEqual([res.ok, res.value], [true, "false"]);
  assert.equal(await getEnabled(r), "false");
  // and markEnabledIfUnset now respects that explicit false
  assert.equal((await markEnabledIfUnset(r)).marked, false);
});

test("enable refuses a non-git directory", async () => {
  const res = await setEnabled(plain, true);
  assert.equal(res.ok, false);
  assert.match(res.reason, /not a git checkout/);
});
