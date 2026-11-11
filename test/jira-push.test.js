import { test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import {
  loadJiraConfig,
  textToAdf,
  ticketToFields,
  jiraStarted,
  createJiraClient,
  pushTicketToJira,
} from "../src/jira.js";

// A fake transport: records every request and replies from a scripted handler. No network, no account.
function recorder(handler) {
  const calls = [];
  const request = async (req) => {
    calls.push({ ...req, parsed: req.body ? JSON.parse(req.body) : undefined });
    const r = handler(req, calls.length - 1) || {};
    return { status: r.status ?? 200, json: r.json ?? null, body: r.body ?? "" };
  };
  return { request, calls };
}

const TICKET = {
  id: "crash-on-save", title: "Crash on save", intent: "NPE in save()", acceptance: "no NPE",
  state: "verified", priority: "urgent", type: "bug", epic: "Stability",
};

// --- config ------------------------------------------------------------------------------------

test("loadJiraConfig: env overrides file; configured needs baseUrl+email+token", () => {
  const env = { JIRA_BASE_URL: "https://acme.atlassian.net/", JIRA_EMAIL: "a@b.c", JIRA_TOKEN: "tok", JIRA_PROJECT: "ACME" };
  const cfg = loadJiraConfig(env, os.tmpdir() + "/definitely-no-peephole-home-" + Math.random());
  assert.equal(cfg.baseUrl, "https://acme.atlassian.net"); // trailing slash trimmed
  assert.equal(cfg.email, "a@b.c");
  assert.equal(cfg.projectKey, "ACME");
  assert.equal(cfg.configured, true);
});

test("loadJiraConfig: missing token -> not configured", () => {
  const cfg = loadJiraConfig({ JIRA_BASE_URL: "https://x", JIRA_EMAIL: "a@b.c" }, os.tmpdir() + "/nope-" + Math.random());
  assert.equal(cfg.configured, false);
});

// --- mapping -----------------------------------------------------------------------------------

test("textToAdf wraps paragraphs; empty text -> one empty paragraph", () => {
  const doc = textToAdf("one\n\ntwo");
  assert.equal(doc.type, "doc");
  assert.equal(doc.content.length, 2);
  assert.equal(doc.content[0].content[0].text, "one");
  assert.equal(textToAdf("").content.length, 1);
});

test("ticketToFields maps summary/issuetype/priority, folds acceptance into description, sets project, omits status", () => {
  const f = ticketToFields(TICKET, { projectKey: "ACME" });
  assert.equal(f.summary, "Crash on save");
  assert.equal(f.issuetype.name, "Bug");
  assert.equal(f.priority.name, "Highest");
  assert.equal(f.project.key, "ACME");
  assert.equal(f.description.type, "doc");
  assert.ok(JSON.stringify(f.description).includes("Acceptance"));
  assert.equal("status", Object.keys(f).includes("status") ? "present" : "status"); // status must NOT be a field
  assert.ok(!("status" in f));
});

test("jiraStarted uses an offset, not Z", () => {
  assert.match(jiraStarted(new Date("2026-11-11T09:00:00.000Z")), /\+0000$/);
});

// --- client ------------------------------------------------------------------------------------

test("createIssue POSTs to /rest/api/3/issue and returns the key", async () => {
  const { request, calls } = recorder(() => ({ status: 201, json: { key: "ACME-10" } }));
  const c = createJiraClient({ baseUrl: "https://x", email: "e", token: "t", request });
  const key = await c.createIssue(ticketToFields(TICKET, { projectKey: "ACME" }));
  assert.equal(key, "ACME-10");
  assert.equal(calls[0].method, "POST");
  assert.match(calls[0].url, /\/rest\/api\/3\/issue$/);
  assert.match(calls[0].headers.Authorization, /^Basic /);
  assert.ok(calls[0].parsed.fields.summary);
});

test("createIssue throws with Jira's error message on failure", async () => {
  const { request } = recorder(() => ({ status: 400, json: { errorMessages: ["bad issue type"] } }));
  const c = createJiraClient({ baseUrl: "https://x", email: "e", token: "t", request });
  await assert.rejects(() => c.createIssue({}), /bad issue type/);
});

test("updateIssue returns notFound on 404 (deleted issue)", async () => {
  const { request } = recorder(() => ({ status: 404, json: { errorMessages: ["does not exist"] } }));
  const c = createJiraClient({ baseUrl: "https://x", email: "e", token: "t", request });
  assert.deepEqual(await c.updateIssue("ACME-99", {}), { notFound: true });
});

test("transitionTo finds the transition whose target status matches and posts it", async () => {
  const { request, calls } = recorder((req) => {
    if (req.method === "GET") return { status: 200, json: { transitions: [
      { id: "11", name: "Start", to: { name: "In Progress" } },
      { id: "31", name: "Review", to: { name: "In Review" } },
    ] } };
    return { status: 204 };
  });
  const c = createJiraClient({ baseUrl: "https://x", email: "e", token: "t", request });
  const r = await c.transitionTo("ACME-1", "In Review");
  assert.deepEqual(r, { moved: true, to: "In Review" });
  assert.equal(calls[1].parsed.transition.id, "31");
});

test("transitionTo is best-effort: unknown target returns {moved:false}, never throws", async () => {
  const { request } = recorder(() => ({ status: 200, json: { transitions: [{ id: "11", name: "Go", to: { name: "Done" } }] } }));
  const c = createJiraClient({ baseUrl: "https://x", email: "e", token: "t", request });
  const r = await c.transitionTo("ACME-1", "In Review");
  assert.equal(r.moved, false);
  assert.match(r.reason, /no available transition/);
});

test("addWorklog sends timeSpentSeconds = minutes*60 and a started stamp", async () => {
  const { request, calls } = recorder(() => ({ status: 201, json: { id: "w1" } }));
  const c = createJiraClient({ baseUrl: "https://x", email: "e", token: "t", request });
  await c.addWorklog("ACME-1", 90, { started: jiraStarted(new Date("2026-11-11T09:00:00.000Z")) });
  assert.equal(calls[0].parsed.timeSpentSeconds, 5400);
  assert.match(calls[0].parsed.started, /\+0000$/);
  assert.match(calls[0].url, /\/worklog$/);
});

// --- orchestration -----------------------------------------------------------------------------

function pushHarness(handler) {
  const { request, calls } = recorder(handler);
  const client = createJiraClient({ baseUrl: "https://x", email: "e", token: "t", request });
  return { client, calls };
}

test("pushTicketToJira: no key -> creates, stamps created=true, returns key", async () => {
  const { client, calls } = pushHarness((req) => {
    if (req.method === "POST" && /\/issue$/.test(req.url)) return { status: 201, json: { key: "ACME-5" } };
    if (req.method === "GET") return { status: 200, json: { transitions: [] } };
    return { status: 204 };
  });
  const r = await pushTicketToJira(TICKET, { projectKey: "ACME" }, client, { now: () => new Date("2026-11-11T10:00:00.000Z") });
  assert.equal(r.key, "ACME-5");
  assert.equal(r.created, true);
  assert.equal(r.worklog, null, "no minutes -> no worklog");
  assert.equal(r.syncedAt, "2026-11-11T10:00:00.000Z");
  assert.ok(calls.some((c) => c.method === "POST" && /\/issue$/.test(c.url)));
});

test("pushTicketToJira: existing key -> updates, no create", async () => {
  const { client, calls } = pushHarness((req) => {
    if (req.method === "PUT") return { status: 204 };
    if (req.method === "GET") return { status: 200, json: { transitions: [{ id: "9", to: { name: "In Review" } }] } };
    return { status: 204 };
  });
  const r = await pushTicketToJira({ ...TICKET, jira: "ACME-7" }, { projectKey: "ACME" }, client, { now: () => new Date() });
  assert.equal(r.key, "ACME-7");
  assert.equal(r.created, false);
  assert.ok(!calls.some((c) => c.method === "POST" && /\/issue$/.test(c.url)), "must not create when updating");
});

test("pushTicketToJira: stored key 404s -> falls back to create", async () => {
  const { client } = pushHarness((req) => {
    if (req.method === "PUT") return { status: 404, json: { errorMessages: ["gone"] } };
    if (req.method === "POST" && /\/issue$/.test(req.url)) return { status: 201, json: { key: "ACME-NEW" } };
    if (req.method === "GET") return { status: 200, json: { transitions: [] } };
    return { status: 204 };
  });
  const r = await pushTicketToJira({ ...TICKET, jira: "ACME-DEAD" }, { projectKey: "ACME" }, client, { now: () => new Date() });
  assert.equal(r.key, "ACME-NEW");
  assert.equal(r.created, true);
});

test("pushTicketToJira: worklog logged only when workedMinutes > 0", async () => {
  const mk = () => pushHarness((req) => {
    if (req.method === "POST" && /\/issue$/.test(req.url)) return { status: 201, json: { key: "ACME-1" } };
    if (req.method === "GET") return { status: 200, json: { transitions: [] } };
    return { status: 201, json: { id: "w" } };
  });
  const a = mk();
  const r1 = await pushTicketToJira(TICKET, { projectKey: "ACME", workedMinutes: 30 }, a.client, { now: () => new Date() });
  assert.deepEqual(r1.worklog, { minutes: 30 });
  assert.ok(a.calls.some((c) => /\/worklog$/.test(c.url)));

  const b = mk();
  const r2 = await pushTicketToJira(TICKET, { projectKey: "ACME", workedMinutes: 0 }, b.client, { now: () => new Date() });
  assert.equal(r2.worklog, null);
  assert.ok(!b.calls.some((c) => /\/worklog$/.test(c.url)), "0 minutes -> no worklog call");
});

test("pushTicketToJira: a transition Jira won't allow does not fail the push", async () => {
  const { client } = pushHarness((req) => {
    if (req.method === "POST" && /\/issue$/.test(req.url)) return { status: 201, json: { key: "ACME-1" } };
    if (req.method === "GET") return { status: 200, json: { transitions: [{ id: "1", to: { name: "Some Other" } }] } };
    return { status: 204 };
  });
  const r = await pushTicketToJira(TICKET, { projectKey: "ACME" }, client, { now: () => new Date() });
  assert.equal(r.key, "ACME-1");
  assert.equal(r.transition.moved, false);
});
