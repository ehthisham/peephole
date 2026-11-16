import { test } from "node:test";
import assert from "node:assert/strict";
import { parseConfig, defaultConfig, serializeConfig } from "../src/schema.js";

// The committed .peephole/config.yaml gained an optional per-project jiraProjectKey — the Jira project
// new issues from this ledger create under. Non-secret, so it lives here (token stays in jira.json).

test("defaultConfig carries jiraProjectKey (empty = inherit jira.json default)", () => {
  const c = defaultConfig("proj", "git@h:x.git", "peephole-state");
  assert.equal(c.jiraProjectKey, "");
});

test("parseConfig: jiraProjectKey is optional and absence is fine", () => {
  const r = parseConfig("project: p\nstateBranch: peephole-state\n");
  assert.equal(r.ok, true);
  assert.equal(r.config.jiraProjectKey, undefined);
});

test("parseConfig: a string jiraProjectKey is accepted and preserved", () => {
  const r = parseConfig("project: p\nstateBranch: peephole-state\njiraProjectKey: PROJ\n");
  assert.equal(r.ok, true);
  assert.equal(r.config.jiraProjectKey, "PROJ");
});

test("parseConfig: a non-string jiraProjectKey is an error", () => {
  const r = parseConfig("project: p\nstateBranch: peephole-state\njiraProjectKey: 42\n");
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => /jiraProjectKey/.test(e)));
});

test("jiraProjectKey survives a serialize -> parse round-trip", () => {
  const c = defaultConfig("p", "", "peephole-state");
  c.jiraProjectKey = "OPS";
  const r = parseConfig(serializeConfig(c));
  assert.equal(r.ok, true);
  assert.equal(r.config.jiraProjectKey, "OPS");
});
