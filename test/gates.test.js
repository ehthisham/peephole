import { test } from "node:test";
import assert from "node:assert/strict";
import {
  normalizeGates,
  isGatedTransition,
  validateTicket,
  MODES,
  DEFAULT_MODE,
} from "../src/schema.js";

test("normalizeGates: absent / empty means no gates (back-compat)", () => {
  assert.deepEqual(normalizeGates(undefined), []);
  assert.deepEqual(normalizeGates(null), []);
  assert.deepEqual(normalizeGates([]), []);
});

test("normalizeGates: 'from->to' strings parse, whitespace tolerant", () => {
  assert.deepEqual(normalizeGates(["in-review->shipped"]), [{ from: "in-review", to: "shipped" }]);
  assert.deepEqual(normalizeGates([" in-review -> shipped "]), [{ from: "in-review", to: "shipped" }]);
});

test("normalizeGates: bare target gates every move into that state", () => {
  assert.deepEqual(normalizeGates(["shipped"]), [{ from: null, to: "shipped" }]);
});

test("normalizeGates: object form", () => {
  assert.deepEqual(normalizeGates([{ from: "built", to: "in-review" }]), [{ from: "built", to: "in-review" }]);
  assert.deepEqual(normalizeGates([{ to: "shipped" }]), [{ from: null, to: "shipped" }]);
});

test("isGatedTransition: exact from/to match", () => {
  const g = ["in-review->shipped"];
  assert.equal(isGatedTransition(g, "in-review", "shipped"), true);
  assert.equal(isGatedTransition(g, "built", "in-review"), false);
  assert.equal(isGatedTransition(g, "in-review", "closed"), false);
});

test("isGatedTransition: null-from gate matches any origin", () => {
  const g = ["shipped"]; // == {from:null,to:shipped}
  assert.equal(isGatedTransition(g, "in-review", "shipped"), true);
  assert.equal(isGatedTransition(g, "built", "shipped"), true);
  assert.equal(isGatedTransition(g, "built", "in-review"), false);
});

test("isGatedTransition: no gates => nothing gated", () => {
  assert.equal(isGatedTransition([], "in-review", "shipped"), false);
});

const baseTicket = {
  project: "p",
  intent: "x",
  state: "proposed",
  risk: "reversible",
  control: "run",
  owner: null,
  history: [],
};

test("validateTicket: missing mode on a history entry is fine (reads as human)", () => {
  const t = { ...baseTicket, history: [{ at: "now", from: null, to: "proposed", by: "a" }] };
  assert.deepEqual(validateTicket(t, "t"), []);
});

test("validateTicket: valid mode on a history entry passes", () => {
  for (const mode of MODES) {
    const t = { ...baseTicket, history: [{ at: "now", from: "built", to: "in-review", by: "a", mode }] };
    assert.deepEqual(validateTicket(t, "t"), [], `mode ${mode} should be valid`);
  }
});

test("validateTicket: present-but-invalid mode is an error", () => {
  const t = { ...baseTicket, history: [{ at: "now", from: "built", to: "in-review", by: "a", mode: "robot" }] };
  const errs = validateTicket(t, "t");
  assert.equal(errs.length, 1);
  assert.match(errs[0], /invalid mode "robot"/);
});

test("DEFAULT_MODE is human", () => {
  assert.equal(DEFAULT_MODE, "human");
});
