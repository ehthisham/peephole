// Live Jira Cloud (REST v3) push — one-way, manual. Peephole -> Jira only: create or update an issue
// from a ticket, best-effort move its status, and optionally log worked minutes. No pull, no webhooks.
//
// Everything here is pure except `defaultRequest` (the one place that touches the network) and
// `loadJiraConfig` (reads ~/.peephole/jira.json). The client takes an injectable `request`, so the
// create/update/transition/worklog logic is unit-testable with a fake transport and no account.

import { homedir } from "node:os";
import { join } from "node:path";
import { readFileSync, existsSync } from "node:fs";
import { ticketToRow } from "./jiracsv.js";

/** Credentials + target, from ~/.peephole/jira.json with JIRA_* env overriding each field. The secret
 *  lives OUTSIDE the repo (never committed, never in the ledger), mirroring the peephole.enabled
 *  per-clone contract. `configured` is false until baseUrl + email + token are all present. */
export function loadJiraConfig(env = process.env, home = homedir()) {
  const file = join(home, ".peephole", "jira.json");
  let f = {};
  if (existsSync(file)) {
    try { f = JSON.parse(readFileSync(file, "utf8")) || {}; } catch { f = {}; }
  }
  const cfg = {
    baseUrl: (env.JIRA_BASE_URL || f.baseUrl || "").replace(/\/+$/, ""),
    email: env.JIRA_EMAIL || f.email || "",
    token: env.JIRA_TOKEN || env.JIRA_API_TOKEN || f.token || "",
    projectKey: env.JIRA_PROJECT || env.JIRA_PROJECT_KEY || f.projectKey || f.project || "",
    source: existsSync(file) ? file : null,
  };
  cfg.configured = Boolean(cfg.baseUrl && cfg.email && cfg.token);
  return cfg;
}

/** Minimal valid Atlassian Document Format doc from plain text (Jira v3 bodies are ADF, not text).
 *  Blank-line-separated paragraphs; an empty string becomes one empty paragraph. */
export function textToAdf(text) {
  const t = String(text == null ? "" : text);
  const paras = t.split(/\n{2,}/).map((p) => p.trim()).filter(Boolean);
  const content = (paras.length ? paras : [""]).map((p) => ({
    type: "paragraph",
    content: p ? [{ type: "text", text: p }] : [],
  }));
  return { type: "doc", version: 1, content };
}

/** The Jira issue `fields` object for a ticket, derived from the shared CSV field map so CSV and live
 *  push never drift. Status is deliberately absent — Jira only moves status through transitions, never
 *  a direct field write. Acceptance folds into the description as a labelled section (Jira has no
 *  acceptance field by default); the ticket keeps its own acceptance untouched. */
export function ticketToFields(ticket, { projectKey } = {}) {
  const row = ticketToRow(ticket);
  const parts = [];
  if (row.Description) parts.push(row.Description);
  if (row.Acceptance) parts.push("Acceptance:\n" + row.Acceptance);
  const fields = {
    summary: row.Summary,
    issuetype: { name: row["Issue Type"] || "Task" },
    description: textToAdf(parts.join("\n\n")),
  };
  if (projectKey) fields.project = { key: projectKey };
  if (row.Priority) fields.priority = { name: row.Priority };
  return fields;
}

/** Jira worklog `started` wants an offset (e.g. +0000), not the "Z" that toISOString emits. */
export function jiraStarted(date = new Date()) {
  return date.toISOString().replace(/Z$/, "+0000");
}

function briefErr(res) {
  const b = res && res.json;
  if (b) {
    if (Array.isArray(b.errorMessages) && b.errorMessages.length) return b.errorMessages.join("; ");
    if (b.errors && typeof b.errors === "object") {
      const parts = Object.entries(b.errors).map(([k, v]) => `${k}: ${v}`);
      if (parts.length) return parts.join("; ");
    }
  }
  return (res && typeof res.body === "string" ? res.body.slice(0, 200) : "") || `HTTP ${res && res.status}`;
}

/** The one place that touches the network. Returns a normalized {status, json, body}. */
async function defaultRequest({ url, method, headers, body }, fetchImpl = globalThis.fetch) {
  const res = await fetchImpl(url, { method, headers, body });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = null; }
  return { status: res.status, json, body: text };
}

/** A thin Jira Cloud REST v3 client. `request` is injectable (default = real fetch), which is what
 *  makes the logic testable without an account. Auth is Basic base64(email:token). */
export function createJiraClient({ baseUrl, email, token, request } = {}) {
  if (!baseUrl) throw new Error("Jira baseUrl is required");
  const root = String(baseUrl).replace(/\/+$/, "");
  const auth = "Basic " + Buffer.from(`${email || ""}:${token || ""}`).toString("base64");
  const call = request || defaultRequest;
  function api(method, path, body) {
    return call({
      url: root + path,
      method,
      headers: { Authorization: auth, "Content-Type": "application/json", Accept: "application/json" },
      body: body == null ? undefined : JSON.stringify(body),
    });
  }
  return {
    async createIssue(fields) {
      const res = await api("POST", "/rest/api/3/issue", { fields });
      if (res.status >= 300) throw new Error(`Jira create failed (${res.status}): ${briefErr(res)}`);
      return res.json && res.json.key;
    },
    /** Returns {ok} on success, {notFound:true} on a 404 (the stored key points at a deleted issue), so
     *  the caller can fall back to creating a fresh one. */
    async updateIssue(key, fields) {
      const res = await api("PUT", `/rest/api/3/issue/${encodeURIComponent(key)}`, { fields });
      if (res.status === 404) return { notFound: true };
      if (res.status >= 300) throw new Error(`Jira update failed (${res.status}): ${briefErr(res)}`);
      return { ok: true };
    },
    /** Best-effort: find a transition whose TARGET status matches and POST it. Never throws — a status
     *  Jira's workflow won't allow from here must not fail the whole push. Returns {moved, reason?}. */
    async transitionTo(key, statusName) {
      const want = String(statusName || "").toLowerCase();
      if (!want) return { moved: false, reason: "no target status" };
      const list = await api("GET", `/rest/api/3/issue/${encodeURIComponent(key)}/transitions`);
      if (list.status >= 300) return { moved: false, reason: `could not read transitions (${list.status})` };
      const transitions = (list.json && list.json.transitions) || [];
      const match =
        transitions.find((t) => t.to && String(t.to.name).toLowerCase() === want) ||
        transitions.find((t) => String(t.name).toLowerCase() === want);
      if (!match) return { moved: false, reason: `no available transition to "${statusName}"` };
      const res = await api("POST", `/rest/api/3/issue/${encodeURIComponent(key)}/transitions`, {
        transition: { id: match.id },
      });
      if (res.status >= 300) return { moved: false, reason: `transition failed (${res.status})` };
      return { moved: true, to: statusName };
    },
    async addWorklog(key, minutes, { started, comment } = {}) {
      const body = { timeSpentSeconds: Math.round(Number(minutes) * 60) };
      if (started) body.started = started;
      if (comment) body.comment = textToAdf(comment);
      const res = await api("POST", `/rest/api/3/issue/${encodeURIComponent(key)}/worklog`, body);
      if (res.status >= 300) throw new Error(`Jira worklog failed (${res.status}): ${briefErr(res)}`);
      return res.json;
    },
  };
}

/** Push ONE ticket to Jira, one-way: create (no key, or stored key 404s) or update, then a best-effort
 *  status transition, then a worklog only when workedMinutes is a positive number (worklogs are
 *  append-only, so logging every sync would double-count). Returns what happened; the caller stamps
 *  the key + synced time back onto the ledger. `statusFor` maps a peephole state to a Jira status name
 *  (defaults to the shared CSV map). `now` is injectable for deterministic tests. */
export async function pushTicketToJira(ticket, opts, client, deps = {}) {
  const { projectKey, workedMinutes } = opts || {};
  const statusFor = deps.statusFor || (await import("./jiracsv.js")).jiraStatusForState;
  const now = deps.now || (() => new Date());

  const fields = ticketToFields(ticket, { projectKey });
  let key = ticket.jira || null;
  let created = false;

  if (key) {
    const upd = await client.updateIssue(key, fields);
    if (upd.notFound) { key = await client.createIssue(fields); created = true; }
  } else {
    key = await client.createIssue(fields);
    created = true;
  }

  const transition = await client.transitionTo(key, statusFor(ticket.state));

  let worklog = null;
  const mins = Number(workedMinutes);
  if (Number.isFinite(mins) && mins > 0) {
    await client.addWorklog(key, mins, { started: jiraStarted(now()), comment: `Logged from Peephole for ${ticket.id}` });
    worklog = { minutes: mins };
  }

  return { key, created, transition, worklog, syncedAt: now().toISOString() };
}
