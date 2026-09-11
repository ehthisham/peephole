import yaml from "js-yaml";

export const STATES = ["proposed", "in-progress", "built", "verified", "shipped", "closed"];
export const FORWARD_STATES = ["proposed", "in-progress", "built", "verified", "shipped"];
export const CONTROLS = ["run", "pause", "skip", "restart"];
export const RISKS = ["reversible", "irreversible"];

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
  if (t.history !== undefined && !Array.isArray(t.history)) {
    errors.push(`${id}.md's "history" must be a list`);
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
