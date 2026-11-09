import { test } from "node:test";
import assert from "node:assert/strict";
import {
  toCsv,
  parseCsv,
  exportCsv,
  ticketToRow,
  rowsToTickets,
  CSV_COLUMNS,
} from "../src/jiracsv.js";

test("toCsv quotes commas, quotes and newlines (RFC-4180)", () => {
  const out = toCsv([["a", "b,c", 'he said "hi"', "line1\nline2"]]);
  assert.equal(out, 'a,"b,c","he said ""hi""","line1\nline2"\r\n');
});

test("parseCsv round-trips a field with comma, quote and newline", () => {
  const rows = [["Summary", "Description"], ["Fix, now", 'a "quoted"\nvalue']];
  const back = parseCsv(toCsv(rows));
  assert.deepEqual(back, rows);
});

test("parseCsv tolerates \\n-only line endings and trailing newline", () => {
  const rows = parseCsv("A,B\n1,2\n");
  assert.deepEqual(rows, [["A", "B"], ["1", "2"]]);
});

test("parseCsv strips a UTF-8 BOM", () => {
  const rows = parseCsv("﻿A,B\n1,2\n");
  assert.deepEqual(rows[0], ["A", "B"]);
});

test("exportCsv header is the fixed Jira column set", () => {
  const csv = exportCsv([]);
  assert.equal(csv.trim(), CSV_COLUMNS.join(","));
});

test("ticketToRow maps peephole fields to Jira columns", () => {
  const row = ticketToRow({
    id: "t1", title: "Add login", intent: "users must sign in", acceptance: "redirects",
    state: "verified", priority: "urgent", type: "bug", ownerName: "Ada", epic: "Auth",
  });
  assert.equal(row.Summary, "Add login");
  assert.equal(row["Issue Type"], "Bug");
  assert.equal(row.Status, "In Review");
  assert.equal(row.Priority, "Highest");
  assert.equal(row.Assignee, "Ada");
  assert.equal(row["Epic Link"], "Auth");
  assert.equal(row["peephole-id"], "t1");
  assert.equal(row.Description, "users must sign in");
  assert.equal(row.Acceptance, "redirects");
});

test("ticketToRow: Summary falls back to intent then id", () => {
  assert.equal(ticketToRow({ id: "x", intent: "why" }).Summary, "why");
  assert.equal(ticketToRow({ id: "x" }).Summary, "x");
});

test("rowsToTickets maps Jira values back, dedup key = peephole-id", () => {
  const csv = [
    ["Issue Type", "Summary", "Description", "Status", "Priority", "Epic Link", "peephole-id"],
    ["Bug", "Crash on save", "NPE in save()", "In Progress", "Highest", "Stability", "crash-on-save"],
  ];
  const { records, warnings } = rowsToTickets(csv);
  assert.equal(warnings.length, 0);
  assert.equal(records.length, 1);
  const r = records[0];
  assert.equal(r.id, "crash-on-save");
  assert.equal(r.type, "bug");
  assert.equal(r.state, "in-progress");
  assert.equal(r.priority, "urgent");
  assert.equal(r.epic, "Stability");
  assert.equal(r.intent, "NPE in save()");
});

test("rowsToTickets: unknown Status/Priority/Type fall back with a warning, not a failure", () => {
  const csv = [
    ["Issue Type", "Summary", "Status", "Priority"],
    ["Mystery", "Do a thing", "Parked", "Spicy"],
  ];
  const { records, warnings } = rowsToTickets(csv);
  assert.equal(records.length, 1);
  assert.equal(records[0].state, "proposed");
  assert.equal(records[0].priority, "normal");
  assert.equal(records[0].type, "feature");
  assert.equal(warnings.length, 3, "one warning each for status/priority/type");
});

test("rowsToTickets: derives id from Issue key, then slug of Summary", () => {
  const withKey = rowsToTickets([["Issue key", "Summary"], ["PROJ-42", "Thing"]]).records[0];
  assert.equal(withKey.id, "proj-42");
  const noKey = rowsToTickets([["Summary"], ["Add dark mode!"]], { slugify: (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") }).records[0];
  assert.equal(noKey.id, "add-dark-mode");
});

test("rowsToTickets: a row with no Summary is skipped with a warning", () => {
  const { records, warnings } = rowsToTickets([["Summary", "Status"], ["", "Done"]]);
  assert.equal(records.length, 0);
  assert.ok(warnings.some((w) => /no Summary/.test(w)));
});

test("export -> import is a stable round-trip on core fields", () => {
  const tickets = [
    { id: "a", title: "Alpha", intent: "do alpha", state: "shipped", priority: "high", type: "chore", epic: "E1" },
    { id: "b", title: "Beta, mkII", intent: "do \"beta\"\nnow", state: "proposed", priority: "low", type: "feature" },
  ];
  const { records } = rowsToTickets(parseCsv(exportCsv(tickets)));
  assert.equal(records.length, 2);
  const a = records.find((r) => r.id === "a");
  assert.equal(a.title, "Alpha");
  assert.equal(a.state, "shipped");
  assert.equal(a.priority, "high");
  assert.equal(a.type, "chore");
  assert.equal(a.epic, "E1");
  const b = records.find((r) => r.id === "b");
  assert.equal(b.title, "Beta, mkII");
  assert.match(b.intent, /do "beta"\nnow/);
});
