import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { validateTicket } from "../src/schema.js";

// --- schema: jira is an optional string ---------------------------------------------------------

test("validateTicket: jira absent is fine (back-compat)", () => {
  const base = { project: "t", intent: "x", state: "proposed", risk: "reversible", control: "run", owner: null, history: [] };
  assert.deepEqual(validateTicket(base, "t1"), []);
});

test("validateTicket: jira as a string is accepted", () => {
  const base = { project: "t", intent: "x", state: "proposed", risk: "reversible", control: "run", owner: null, history: [], jira: "PROJ-42" };
  assert.deepEqual(validateTicket(base, "t1"), []);
});

test("validateTicket: jira null is accepted (explicitly unlinked)", () => {
  const base = { project: "t", intent: "x", state: "proposed", risk: "reversible", control: "run", owner: null, history: [], jira: null };
  assert.deepEqual(validateTicket(base, "t1"), []);
});

test("validateTicket: non-string jira is an error", () => {
  const base = { project: "t", intent: "x", state: "proposed", risk: "reversible", control: "run", owner: null, history: [], jira: 42 };
  const errs = validateTicket(base, "t1");
  assert.equal(errs.length, 1);
  assert.match(errs[0], /invalid jira/);
});

// --- writer: createTicket / setJira / editTicket against a real remote-less repo ----------------

let tmp, repo, ledgerHome, createTicket, setJira, editTicket, parseFile;

function git(cwd, args) {
  return execFileSync("git", args, { cwd, stdio: ["ignore", "pipe", "pipe"] }).toString();
}

function read(id) {
  // Ledger resolves to an in-repo worktree when there's no remote; read the committed ticket file.
  const p = path.join(repo, ".peephole-worktree", ".peephole", "tickets", `${id}.md`);
  const alt = path.join(repo, ".peephole", "tickets", `${id}.md`);
  const file = fs.existsSync(p) ? p : alt;
  return fs.readFileSync(file, "utf8");
}

before(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "peephole-jira-"));
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

  ({ createTicket, setJira, editTicket } = await import("../src/writer.js"));
  ({ parseTicket: parseFile } = await import("../src/schema.js"));
});

after(() => {
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
  delete process.env.PEEPHOLE_LEDGER_HOME;
});

test("createTicket stores a jira key passed at creation", async () => {
  const r = await createTicket(repo, "peephole-state", { id: "with-jira", project: "t", intent: "linked", jira: "ACME-1" });
  assert.equal(r.ticket.jira, "ACME-1");
  assert.match(read("with-jira"), /jira: ACME-1/);
});

test("createTicket defaults jira to null when omitted", async () => {
  const r = await createTicket(repo, "peephole-state", { id: "no-jira", project: "t", intent: "unlinked" });
  assert.equal(r.ticket.jira, null);
});

test("setJira links, then clears, with a no-op in between", async () => {
  await createTicket(repo, "peephole-state", { id: "settable", project: "t", intent: "x" });

  const linked = await setJira(repo, "peephole-state", "settable", "PROJ-7", "alice");
  assert.equal(linked.ticket.jira, "PROJ-7");
  const last = linked.ticket.history[linked.ticket.history.length - 1];
  assert.equal(last.to, "jira:PROJ-7");

  const noop = await setJira(repo, "peephole-state", "settable", "PROJ-7", "alice");
  assert.equal(noop.committed, false, "re-setting the same key commits nothing");

  const cleared = await setJira(repo, "peephole-state", "settable", "", "alice");
  assert.equal(cleared.ticket.jira, null);
});

test("editTicket changes intent/acceptance/notes in one commit", async () => {
  await createTicket(repo, "peephole-state", { id: "editable", project: "t", intent: "old", acceptance: "oldacc" });
  const r = await editTicket(repo, "peephole-state", "editable", { intent: "new why", acceptance: "new done", body: "some notes" }, "bob");
  assert.deepEqual(r.changed.sort(), ["acceptance", "body", "intent"]);
  assert.equal(r.ticket.intent, "new why");
  assert.equal(r.ticket.acceptance, "new done");
  assert.equal(r.ticket.body, "some notes");
});

test("editTicket refuses to blank a required intent", async () => {
  await createTicket(repo, "peephole-state", { id: "keep-intent", project: "t", intent: "must stay" });
  await assert.rejects(() => editTicket(repo, "peephole-state", "keep-intent", { intent: "   " }, "bob"), /intent cannot be empty/);
});

test("editTicket with no real change commits nothing", async () => {
  await createTicket(repo, "peephole-state", { id: "unchanged", project: "t", intent: "same" });
  const r = await editTicket(repo, "peephole-state", "unchanged", { intent: "same" }, "bob");
  assert.equal(r.committed, false);
});

test("editTicket rejects an empty patch", async () => {
  await createTicket(repo, "peephole-state", { id: "empty-patch", project: "t", intent: "x" });
  await assert.rejects(() => editTicket(repo, "peephole-state", "empty-patch", {}, "bob"), /no editable fields/);
});
