import yaml from "js-yaml";

/** The ledger's own branch. Dedicated and fixed by default so a team converges on one branch
 * rather than each machine picking a code branch — and NOT simply "peephole": the worktree's local
 * branch is `peephole/<stateBranch>`, and git cannot hold both `refs/heads/peephole` and
 * `refs/heads/peephole/...` at once. */
export const DEFAULT_STATE_BRANCH = "peephole-state";

export const STATES = ["proposed", "in-progress", "built", "verified", "shipped", "closed"];
export const FORWARD_STATES = ["proposed", "in-progress", "built", "verified", "shipped"];
export const CONTROLS = ["run", "pause", "skip", "restart"];
export const RISKS = ["reversible", "irreversible"];
// Ascending urgency. `normal` is the default and the value a ticket with no `priority` is read as,
// so the field stays optional — every ticket written before priority existed keeps parsing and is
// treated as normal rather than breaking validation.
export const PRIORITIES = ["low", "normal", "high", "urgent"];
export const DEFAULT_PRIORITY = "normal";
// Ticket kind, Pivotal-Tracker style. `feature` is the default and the value a ticket with no
// `type` is read as, so the field stays optional — pre-existing tickets keep parsing.
export const TYPES = ["feature", "bug", "chore"];
export const DEFAULT_TYPE = "feature";

// Provenance of a state change: `human` means a person decided it, `auto` means an agent/automation
// advanced it with no human in the loop. Recorded on every history entry — who DECIDED a move, not
// just what ran. `human` is the default and the value a history entry with no `mode` is read as, so
// entries written before provenance existed keep parsing.
export const MODES = ["human", "auto"];
export const DEFAULT_MODE = "human";

/** Parse a `gates:` config block into a normalized list of {from, to} transitions that require a
 *  review stamp. Accepts "from->to" strings (whitespace-tolerant) or {from, to} objects; a bare
 *  "to" string (or {to}) gates every transition INTO that state. Absent/empty = no gates, which is
 *  the back-compatible default: every transition is ungated, exactly as before this feature. */
export function normalizeGates(gates) {
  if (!Array.isArray(gates)) return [];
  const out = [];
  for (const g of gates) {
    if (typeof g === "string") {
      const [from, to] = g.includes("->") ? g.split("->").map((s) => s.trim()) : [null, g.trim()];
      if (to) out.push({ from: from || null, to });
    } else if (g && typeof g === "object" && g.to) {
      out.push({ from: g.from ? String(g.from).trim() : null, to: String(g.to).trim() });
    }
  }
  return out;
}

/** True when moving `from` -> `to` crosses a declared gate (so the move must be stamped). A gate
 *  with a null `from` matches any origin. */
export function isGatedTransition(gates, from, to) {
  return normalizeGates(gates).some((g) => g.to === to && (g.from === null || g.from === from));
}

const REQUIRED_TICKET_FIELDS = ["id", "project", "intent", "state", "risk", "control", "owner", "history"];

export function defaultConfig(project, remoteUrl, stateBranch) {
  return {
    project,
    gitHost: "bitbucket",
    stateBranch,
    remote: remoteUrl || "",
    states: STATES,
    control: CONTROLS,
    risk: RISKS,
    priority: PRIORITIES,
    type: TYPES,
    // No transition is gated by default — advance stays free until a project opts in by listing
    // "from->to" (or a bare target state) here. e.g. gates: [verified->shipped].
    gates: [],
  };
}

export function parseConfig(text) {
  const errors = [];
  let data;
  try {
    data = yaml.load(text) || {};
  } catch (e) {
    return { ok: false, errors: [`config.yaml does not parse as YAML: ${e.message}`] };
  }
  for (const f of ["project", "stateBranch"]) {
    if (!data[f]) errors.push(`config.yaml is missing required field "${f}"`);
  }
  return { ok: errors.length === 0, config: data, errors };
}

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/;

/** Parses a ticket markdown file (YAML frontmatter + free-text body). */
export function parseTicket(raw, id) {
  const m = raw.match(FRONTMATTER_RE);
  if (!m) {
    return { ok: false, id, errors: [`${id}.md has no --- frontmatter block`] };
  }
  let frontmatter;
  try {
    frontmatter = yaml.load(m[1]) || {};
  } catch (e) {
    return { ok: false, id, errors: [`${id}.md frontmatter does not parse as YAML: ${e.message}`] };
  }
  const body = m[2] || "";
  const errors = validateTicket(frontmatter, id);
  return { ok: errors.length === 0, id, ticket: { ...frontmatter, id, body: body.trim() }, errors };
}

export function validateTicket(t, id) {
  const errors = [];
  for (const f of REQUIRED_TICKET_FIELDS) {
    if (f === "id" || f === "owner") continue;
    if (t[f] === undefined) errors.push(`${id}.md is missing required field "${f}"`);
  }
  if (!("owner" in t)) errors.push(`${id}.md is missing required field "owner" (use null if unclaimed)`);
  if (t.state && !STATES.includes(t.state)) {
    errors.push(`${id}.md has invalid state "${t.state}" (expected one of ${STATES.join(", ")})`);
  }
  if (t.risk && !RISKS.includes(t.risk)) {
    errors.push(`${id}.md has invalid risk "${t.risk}" (expected one of ${RISKS.join(", ")})`);
  }
  if (t.control && !CONTROLS.includes(t.control)) {
    errors.push(`${id}.md has invalid control "${t.control}" (expected one of ${CONTROLS.join(", ")})`);
  }
  // Optional: a ticket with no `priority` is read as the default elsewhere, so only a present-but-bad
  // value is an error — never a missing one.
  if (t.priority !== undefined && !PRIORITIES.includes(t.priority)) {
    errors.push(`${id}.md has invalid priority "${t.priority}" (expected one of ${PRIORITIES.join(", ")})`);
  }
  if (t.type !== undefined && !TYPES.includes(t.type)) {
    errors.push(`${id}.md has invalid type "${t.type}" (expected one of ${TYPES.join(", ")})`);
  }
  // Optional Jira issue key (e.g. PROJ-42). Free-form string so any Jira scheme is accepted; only a
  // present-but-non-string value is an error. Absent/null reads as "not linked" — pre-existing tickets
  // keep parsing unchanged.
  if (t.jira !== undefined && t.jira !== null && typeof t.jira !== "string") {
    errors.push(`${id}.md has invalid jira "${t.jira}" (expected a string issue key like PROJ-42)`);
  }
  // Optional ISO timestamp of the last successful Jira push; only a present-but-non-string value is an
  // error. Absent/null reads as "never synced".
  if (t.jiraSyncedAt !== undefined && t.jiraSyncedAt !== null && typeof t.jiraSyncedAt !== "string") {
    errors.push(`${id}.md has invalid jiraSyncedAt "${t.jiraSyncedAt}" (expected an ISO timestamp string)`);
  }
  // Optional cumulative minutes already logged to the Jira worklog from Peephole. Lets the UI avoid
  // double-logging the same worked duration. Absent/null reads as "nothing logged yet".
  if (t.jiraWorklogMinutes !== undefined && t.jiraWorklogMinutes !== null &&
      (typeof t.jiraWorklogMinutes !== "number" || !Number.isFinite(t.jiraWorklogMinutes) || t.jiraWorklogMinutes < 0)) {
    errors.push(`${id}.md has invalid jiraWorklogMinutes "${t.jiraWorklogMinutes}" (expected a non-negative number of minutes)`);
  }
  if (t.history !== undefined && !Array.isArray(t.history)) {
    errors.push(`${id}.md's "history" must be a list`);
  }
  // Provenance is optional per history entry: an entry with no `mode` reads as `human`, so only a
  // present-but-invalid value is an error — never a missing one. Keeps every pre-provenance history
  // entry parsing unchanged.
  if (Array.isArray(t.history)) {
    for (const h of t.history) {
      if (h && h.mode !== undefined && !MODES.includes(h.mode)) {
        errors.push(`${id}.md has a history entry with invalid mode "${h.mode}" (expected one of ${MODES.join(", ")})`);
      }
    }
  }
  return errors;
}

/** Serializes a ticket back to frontmatter + body, preserving field order. */
export function serializeTicket(ticket) {
  const { body, ...frontmatter } = ticket;
  const yamlText = yaml.dump(frontmatter, { lineWidth: 100, noRefs: true });
  return `---\n${yamlText}---\n${body ? body.trim() + "\n" : ""}`;
}

export function serializeConfig(config) {
  return yaml.dump(config, { lineWidth: 100, noRefs: true });
}
