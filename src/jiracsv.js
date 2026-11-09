// Jira <-> Peephole CSV interop. Pure functions: RFC-4180 CSV read/write plus the field maps that
// translate a peephole ticket to a Jira-import row and back. No git, no IO — the CLI pairs these
// with the ledger reader (scan) and writer (importTickets).
//
// Field map (peephole -> Jira column):
//   title||intent -> Summary      intent(+acceptance) -> Description
//   state         -> Status       priority            -> Priority
//   type          -> Issue Type   ownerName/assignee  -> Assignee
//   epic          -> Epic Link    id                  -> peephole-id (round-trip key)

import { DEFAULT_PRIORITY, DEFAULT_TYPE } from "./schema.js";

export const CSV_COLUMNS = [
  "Issue Type",
  "Summary",
  "Description",
  // Peephole's acceptance criteria get their own column rather than being folded into Description —
  // Jira ignores an unmapped column, and keeping it separate makes export->import a faithful
  // round-trip on both intent (Description) and acceptance.
  "Acceptance",
  "Status",
  "Priority",
  "Assignee",
  "Epic Link",
  "peephole-id",
];

// peephole -> Jira
const STATE_TO_STATUS = {
  proposed: "To Do",
  "in-progress": "In Progress",
  built: "In Progress",
  verified: "In Review",
  shipped: "Done",
  closed: "Done",
};
const PRIORITY_TO_JIRA = { low: "Low", normal: "Medium", high: "High", urgent: "Highest" };
const TYPE_TO_ISSUETYPE = { feature: "Story", bug: "Bug", chore: "Task" };

// Jira -> peephole (lowercased keys; several Jira values fold onto one peephole value).
const STATUS_TO_STATE = {
  "to do": "proposed", backlog: "proposed", open: "proposed", "selected for development": "proposed",
  "in progress": "in-progress", "in development": "in-progress",
  "in review": "verified", "code review": "verified", review: "verified",
  done: "shipped", closed: "shipped", resolved: "shipped", complete: "shipped", completed: "shipped",
};
const JIRA_TO_PRIORITY = {
  lowest: "low", low: "low", trivial: "low", minor: "low",
  medium: "normal", normal: "normal", major: "high", high: "high",
  highest: "urgent", critical: "urgent", blocker: "urgent",
};
const JIRA_TO_TYPE = {
  story: "feature", "new feature": "feature", feature: "feature", epic: "feature", improvement: "feature",
  bug: "bug", defect: "bug",
  task: "chore", "sub-task": "chore", subtask: "chore", chore: "chore",
};

// ---------- RFC-4180 CSV ----------

/** Serialize one field: quote when it holds a comma, quote, CR or LF; escape quotes by doubling. */
function csvField(v) {
  const s = v == null ? "" : String(v);
  return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

/** Rows (array of arrays) -> CSV text (CRLF line endings, RFC-4180). */
export function toCsv(rows) {
  return rows.map((r) => r.map(csvField).join(",")).join("\r\n") + "\r\n";
}

/** Parse CSV text -> array of arrays. Handles quoted fields with embedded commas, CR/LF and ""
 *  escapes. Tolerant of both \r\n and \n line endings. */
export function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = "";
  let inQuotes = false;
  let i = 0;
  const n = text.length;
  // Strip a leading UTF-8 BOM if present.
  if (text.charCodeAt(0) === 0xfeff) i = 1;
  while (i < n) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i += 2; continue; }
        inQuotes = false; i++; continue;
      }
      field += c; i++; continue;
    }
    if (c === '"') { inQuotes = true; i++; continue; }
    if (c === ",") { row.push(field); field = ""; i++; continue; }
    if (c === "\r") { i++; continue; }
    if (c === "\n") { row.push(field); rows.push(row); row = []; field = ""; i++; continue; }
    field += c; i++;
  }
  // Flush the trailing field/row unless the file ended on a clean newline with nothing after.
  if (field !== "" || row.length) { row.push(field); rows.push(row); }
  // Drop fully-empty trailing rows (a file ending in a newline yields none; a blank line yields one).
  return rows.filter((r) => !(r.length === 1 && r[0] === ""));
}

// ---------- mapping ----------

/** One peephole ticket -> a row object keyed by CSV column. */
export function ticketToRow(t) {
  const summary = (t.title && t.title.trim()) || t.intent || t.id;
  return {
    "Issue Type": TYPE_TO_ISSUETYPE[t.type || DEFAULT_TYPE] || "Story",
    Summary: summary,
    Description: t.intent || "",
    Acceptance: t.acceptance || "",
    Status: STATE_TO_STATUS[t.state] || "To Do",
    Priority: PRIORITY_TO_JIRA[t.priority || DEFAULT_PRIORITY] || "Medium",
    Assignee: t.ownerName || t.assignee || "",
    "Epic Link": t.epic || "",
    "peephole-id": t.id,
  };
}

/** Peephole tickets -> full CSV text (header + rows). */
export function exportCsv(tickets) {
  const header = CSV_COLUMNS;
  const rows = [header, ...tickets.map((t) => {
    const obj = ticketToRow(t);
    return header.map((c) => obj[c]);
  })];
  return toCsv(rows);
}

function lower(s) {
  return String(s == null ? "" : s).trim().toLowerCase();
}

/** A parsed CSV (array of arrays, first row = header) -> normalized import records plus warnings.
 *  Each record: {id, title, intent, acceptance, state, priority, type, epic, assignee, raw}.
 *  Unknown Status/Priority/Issue Type fall back to peephole defaults with a warning, never a hard
 *  fail (acceptance item 5). */
export function rowsToTickets(rows, { slugify } = {}) {
  const warnings = [];
  if (!rows.length) return { records: [], warnings: ["CSV is empty"] };
  const header = rows[0].map((h) => h.trim());
  const idx = (name) => header.findIndex((h) => h.toLowerCase() === name.toLowerCase());
  const col = {
    summary: idx("Summary"),
    description: idx("Description"),
    acceptance: idx("Acceptance"),
    status: idx("Status"),
    priority: idx("Priority"),
    type: idx("Issue Type"),
    assignee: idx("Assignee"),
    epic: idx("Epic Link"),
    pid: idx("peephole-id"),
    key: idx("Issue key"),
  };
  if (col.summary === -1) warnings.push('no "Summary" column — rows without a summary will be skipped');

  const records = [];
  for (let r = 1; r < rows.length; r++) {
    const cells = rows[r];
    const get = (c) => (c >= 0 && c < cells.length ? String(cells[c] || "").trim() : "");
    const summary = get(col.summary);
    if (!summary) { warnings.push(`row ${r + 1}: no Summary — skipped`); continue; }

    let id = get(col.pid);
    if (!id) {
      const key = get(col.key);
      id = key ? key.toLowerCase() : (slugify ? slugify(summary) : summary.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, ""));
    }

    const statusRaw = get(col.status);
    let state = STATUS_TO_STATE[lower(statusRaw)];
    if (statusRaw && !state) { warnings.push(`row ${r + 1} ("${summary}"): unknown Status "${statusRaw}" -> proposed`); }
    state = state || "proposed";

    const prioRaw = get(col.priority);
    let priority = JIRA_TO_PRIORITY[lower(prioRaw)];
    if (prioRaw && !priority) { warnings.push(`row ${r + 1} ("${summary}"): unknown Priority "${prioRaw}" -> ${DEFAULT_PRIORITY}`); }
    priority = priority || DEFAULT_PRIORITY;

    const typeRaw = get(col.type);
    let type = JIRA_TO_TYPE[lower(typeRaw)];
    if (typeRaw && !type) { warnings.push(`row ${r + 1} ("${summary}"): unknown Issue Type "${typeRaw}" -> ${DEFAULT_TYPE}`); }
    type = type || DEFAULT_TYPE;

    records.push({
      id,
      title: summary,
      intent: get(col.description) || summary,
      acceptance: get(col.acceptance),
      state,
      priority,
      type,
      epic: get(col.epic) || null,
      assignee: get(col.assignee) || null,
    });
  }
  return { records, warnings };
}
