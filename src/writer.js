import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as git from "./git.js";
import { defaultConfig, serializeConfig, serializeTicket } from "./schema.js";
import { upsertMarkedSection, agentNoteBody, readmeNoteBody } from "./notes.js";

const PEEPHOLE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function prepWorktree(repoRoot, remoteBranch) {
  const { worktreePath, localBranch } = await git.ensureWorktree(repoRoot, remoteBranch);
  await git.syncWorktreeIfClean(worktreePath, localBranch, remoteBranch);
  return { worktreePath, localBranch };
}

async function ensureDir(p) {
  await fs.mkdir(p, { recursive: true });
}

async function fileExists(p) {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * Wires the Claude Code hooks (SessionStart/PreToolUse/SessionEnd) into THIS machine's
 * `.claude/settings.local.json` in the real repo root — never through the isolated worktree, and
 * never committed: it's per-machine config (absolute paths to this checkout of peephole), exactly
 * what `settings.local.json` is for. Idempotent: does nothing if already wired.
 */
export async function setupHooksLocal(repoRoot, { port }) {
  const claudeDir = path.join(repoRoot, ".claude");
  await ensureDir(claudeDir);
  const settingsPath = path.join(claudeDir, "settings.local.json");

  let settings = {};
  if (await fileExists(settingsPath)) {
    try {
      settings = JSON.parse(await fs.readFile(settingsPath, "utf8"));
    } catch {
      settings = {};
    }
  }
  settings.hooks = settings.hooks || {};

  const hooksDir = path.join(PEEPHOLE_ROOT, "hooks");
  const plan = [
    ["SessionStart", "startup|resume", path.join(hooksDir, "session-start.js")],
    ["PreToolUse", "*", path.join(hooksDir, "pre-tool-use.js")],
    ["SessionEnd", "*", path.join(hooksDir, "session-end.js")],
  ];

  const added = [];
  for (const [event, matcher, scriptPath] of plan) {
    settings.hooks[event] = settings.hooks[event] || [];
    const already = settings.hooks[event].some((g) => (g.hooks || []).some((h) => (h.command || "").includes("peephole/hooks/")));
    if (already) continue;
    settings.hooks[event].push({ matcher, hooks: [{ type: "command", command: `PEEPHOLE_PORT=${port} node "${scriptPath}"` }] });
    added.push(event);
  }

  if (added.length > 0) {
    await fs.writeFile(settingsPath, JSON.stringify(settings, null, 2) + "\n", "utf8");
  }
  return { added, settingsPath };
}

/** Creates whatever structural pieces are missing (config.yaml, tickets/, agents/, CLAUDE.md / README.md sections, the local Claude Code hook wiring) and commits locally (git-tracked pieces only). Never pushes. */
export async function scaffold(repoRoot, remoteBranch, { projectName, remoteUrl, issues, peepholeCmd, peepholeBin, port }) {
  const { worktreePath, localBranch } = await prepWorktree(repoRoot, remoteBranch);
  const base = path.join(worktreePath, ".peephole");
  await ensureDir(base);

  const kinds = new Set(issues.map((i) => i.kind));
  const created = [];
  const paths = [".peephole"];

  let hookSetup = null;
  if (kinds.has("missing-hook-setup")) {
    hookSetup = await setupHooksLocal(repoRoot, { port });
  }

  if (kinds.has("missing-config")) {
    const config = defaultConfig(projectName, remoteUrl, remoteBranch);
    await fs.writeFile(path.join(base, "config.yaml"), serializeConfig(config), "utf8");
    created.push("config.yaml");
  }
  if (kinds.has("missing-tickets-dir")) {
    const dir = path.join(base, "tickets");
    await ensureDir(dir);
    if (!(await fileExists(path.join(dir, ".gitkeep")))) {
      await fs.writeFile(path.join(dir, ".gitkeep"), "", "utf8");
    }
    created.push("tickets/");
  }
  if (kinds.has("missing-agents-dir")) {
    const dir = path.join(base, "agents");
    await ensureDir(dir);
    if (!(await fileExists(path.join(dir, ".gitkeep")))) {
      await fs.writeFile(path.join(dir, ".gitkeep"), "", "utf8");
    }
    created.push("agents/");
  }
  if (kinds.has("missing-agent-note")) {
    const claudeMdPath = path.join(worktreePath, "CLAUDE.md");
    await upsertMarkedSection(claudeMdPath, agentNoteBody({ binPath: peepholeBin, repoRoot, port }), `# ${projectName} — working notes`);
    paths.push("CLAUDE.md");
    created.push("CLAUDE.md (Peephole section)");
  }
  if (kinds.has("missing-readme-note")) {
    const readmePath = path.join(worktreePath, "README.md");
    await upsertMarkedSection(readmePath, readmeNoteBody(peepholeCmd), `# ${projectName}`);
    paths.push("README.md");
    created.push("README.md (Peephole section)");
  }

  if (created.length === 0) {
    return { committed: false, created: [], worktreePath, localBranch, hookSetup };
  }

  const sha = await git.commitAll(worktreePath, `peephole: scaffold ${created.join(", ")}`, paths);
  const unpushed = await git.unpushedCount(worktreePath, localBranch, remoteBranch);
  return { committed: Boolean(sha), created, sha, unpushed, worktreePath, localBranch, hookSetup };
}

/**
 * Stages whatever's already written and commits — amending the previous commit instead of
 * stacking a new one when that previous commit (a) is still unpushed and (b) has the same
 * `subjectPrefix` (i.e. it's another write to the same rapidly-changing thing: this ticket's
 * control, or this session's heartbeat). A push, a different target, or nothing pending all
 * start a fresh commit. The full history is never lost — this only collapses git-commit noise,
 * never the ticket's own `history` array or the heartbeat's `lastSeenAt`.
 */
async function commitOrAmend(worktreePath, localBranch, remoteBranch, subjectPrefix, message) {
  const pendingBefore = await git.unpushedCount(worktreePath, localBranch, remoteBranch);
  const lastSubject = await git.lastCommitSubject(worktreePath);
  const amendable = pendingBefore > 0 && lastSubject && lastSubject.startsWith(subjectPrefix);
  await git.stageAll(worktreePath);
  const sha = amendable ? await git.amendStaged(worktreePath, message) : await git.commitStaged(worktreePath, message);
  const unpushed = await git.unpushedCount(worktreePath, localBranch, remoteBranch);
  return { sha, unpushed };
}

/** Writes a new `control` value onto one ticket, appends a history entry, commits locally. Never pushes. */
export async function setControl(repoRoot, remoteBranch, ticketId, control, actor = "peephole-ui") {
  const { worktreePath, localBranch } = await prepWorktree(repoRoot, remoteBranch);
  const file = path.join(worktreePath, ".peephole", "tickets", `${ticketId}.md`);
  const raw = await fs.readFile(file, "utf8");

  const { parseTicket } = await import("./schema.js");
  const parsed = parseTicket(raw, ticketId);
  if (!parsed.ok) {
    throw new Error(`Cannot update ${ticketId}: ${parsed.errors.join("; ")}`);
  }
  const ticket = parsed.ticket;
  const from = ticket.control;
  ticket.control = control;
  ticket.updatedAt = new Date().toISOString();
  ticket.history = Array.isArray(ticket.history) ? ticket.history : [];
  ticket.history.push({ at: ticket.updatedAt, from: `control:${from}`, to: `control:${control}`, by: actor });
  if (control === "restart") {
    ticket.owner = null;
    ticket.branch = null;
  }
  if (control === "skip") {
    ticket.owner = null;
  }

  await fs.writeFile(file, serializeTicket(ticket), "utf8");
  const { sha, unpushed } = await commitOrAmend(
    worktreePath, localBranch, remoteBranch,
    `peephole: ${ticketId} control -> `, `peephole: ${ticketId} control -> ${control}`,
  );
  return { committed: Boolean(sha), sha, unpushed, worktreePath, localBranch };
}

/** Moves a ticket's `state` — forward (proposed→...→shipped) or to `closed`, per the ledger rule
 * (state only ever advances or closes, never drags backward, never deletes). Always its own commit:
 * unlike `control` clicks this is a meaningful milestone, never rapid-fire. */
export async function setState(repoRoot, remoteBranch, ticketId, state, actor = "peephole-ui") {
  const { STATES, FORWARD_STATES, parseTicket } = await import("./schema.js");
  if (!STATES.includes(state)) {
    throw new Error(`invalid state "${state}" (expected one of ${STATES.join(", ")})`);
  }
  const { worktreePath, localBranch } = await prepWorktree(repoRoot, remoteBranch);
  const file = path.join(worktreePath, ".peephole", "tickets", `${ticketId}.md`);
  if (!(await fileExists(file))) throw new Error(`ticket "${ticketId}" not found`);
  const raw = await fs.readFile(file, "utf8");

  const parsed = parseTicket(raw, ticketId);
  if (!parsed.ok) throw new Error(`Cannot update ${ticketId}: ${parsed.errors.join("; ")}`);
  const ticket = parsed.ticket;

  const fromIdx = FORWARD_STATES.indexOf(ticket.state);
  const toIdx = FORWARD_STATES.indexOf(state);
  const isForward = fromIdx !== -1 && toIdx !== -1 && toIdx > fromIdx;
  const isClose = state === "closed";
  if (!isForward && !isClose) {
    throw new Error(`cannot move "${ticketId}" from ${ticket.state} to ${state} — state only ever advances forward or to closed`);
  }

  const from = ticket.state;
  ticket.state = state;
  ticket.updatedAt = new Date().toISOString();
  ticket.history = Array.isArray(ticket.history) ? ticket.history : [];
  ticket.history.push({ at: ticket.updatedAt, from, to: state, by: actor });

  await fs.writeFile(file, serializeTicket(ticket), "utf8");
  const sha = await git.commitAll(worktreePath, `peephole: ${ticketId} state -> ${state}`);
  const unpushed = await git.unpushedCount(worktreePath, localBranch, remoteBranch);
  return { committed: Boolean(sha), sha, unpushed, ticket };
}

/** Creates a new ticket file with a schema-correct frontmatter — the deterministic alternative to an agent hand-writing YAML. Always its own commit. */
export async function createTicket(repoRoot, remoteBranch, { id, project, intent, acceptance = "", body = "", risk = "reversible", owner = null, state: stateOverride, actor = "agent" }) {
  if (!project || !intent) throw new Error("project and intent are required");
  const { STATES } = await import("./schema.js");
  if (stateOverride && !STATES.includes(stateOverride)) {
    throw new Error(`invalid state "${stateOverride}" (expected one of ${STATES.join(", ")})`);
  }
  const { worktreePath, localBranch } = await prepWorktree(repoRoot, remoteBranch);
  const dir = path.join(worktreePath, ".peephole", "tickets");
  await ensureDir(dir);
  const file = path.join(dir, `${id}.md`);
  if (await fileExists(file)) throw new Error(`ticket "${id}" already exists`);

  const now = new Date().toISOString();
  const state = stateOverride || (owner ? "in-progress" : "proposed");
  const ticket = {
    id, project, intent, acceptance, body, state, risk, blockedOn: "", control: "run", owner,
    branch: null, pr: null, estimate: null, createdAt: now, updatedAt: now,
    history: [{ at: now, from: null, to: state, by: actor }],
  };
  await fs.writeFile(file, serializeTicket(ticket), "utf8");
  const sha = await git.commitAll(worktreePath, `peephole: new ticket ${id}`);
  const unpushed = await git.unpushedCount(worktreePath, localBranch, remoteBranch);
  return { committed: Boolean(sha), sha, unpushed, ticket };
}

/** Claims (or re-affirms) ownership of an existing ticket, advancing proposed -> in-progress. Always its own commit. */
export async function claimTicket(repoRoot, remoteBranch, ticketId, owner, actor) {
  const { worktreePath, localBranch } = await prepWorktree(repoRoot, remoteBranch);
  const file = path.join(worktreePath, ".peephole", "tickets", `${ticketId}.md`);
  if (!(await fileExists(file))) throw new Error(`ticket "${ticketId}" not found`);
  const raw = await fs.readFile(file, "utf8");

  const { parseTicket } = await import("./schema.js");
  const parsed = parseTicket(raw, ticketId);
  if (!parsed.ok) throw new Error(`Cannot claim ${ticketId}: ${parsed.errors.join("; ")}`);
  const ticket = parsed.ticket;
  if (ticket.owner && ticket.owner !== owner) {
    return { claimed: false, reason: `already claimed by ${ticket.owner}`, ticket };
  }

  const from = ticket.state;
  ticket.owner = owner;
  if (ticket.state === "proposed") ticket.state = "in-progress";
  ticket.updatedAt = new Date().toISOString();
  ticket.history.push({ at: ticket.updatedAt, from, to: ticket.state, by: actor || owner });

  await fs.writeFile(file, serializeTicket(ticket), "utf8");
  const sha = await git.commitAll(worktreePath, `peephole: ${ticketId} claimed by ${owner}`);
  const unpushed = await git.unpushedCount(worktreePath, localBranch, remoteBranch);
  return { claimed: true, committed: Boolean(sha), sha, unpushed, ticket };
}

/** Upserts one session's heartbeat file. Rapid repeat calls (same session, still unpushed) amend, same as control writes. */
export async function writeHeartbeat(repoRoot, remoteBranch, { sessionId, host, activeTicket, status, tokens, author }) {
  const { worktreePath, localBranch } = await prepWorktree(repoRoot, remoteBranch);
  const dir = path.join(worktreePath, ".peephole", "agents");
  await ensureDir(dir);
  const file = path.join(dir, `${sessionId}.json`);

  let existing = {};
  if (await fileExists(file)) {
    try {
      existing = JSON.parse(await fs.readFile(file, "utf8"));
    } catch {
      existing = {};
    }
  }
  const now = new Date().toISOString();
  const agent = {
    sessionId,
    host: host || existing.host || "unknown",
    startedAt: existing.startedAt || now,
    lastSeenAt: now,
    activeTicket: activeTicket !== undefined ? activeTicket : (existing.activeTicket ?? null),
    status: status || existing.status || "working",
    tokens: tokens ?? existing.tokens ?? null,
    // Set once at SessionStart (the machine's global git identity) and preserved on every
    // later heartbeat — PreToolUse's throttled checkin path never sends one, by design.
    author: author ?? existing.author ?? null,
  };
  await fs.writeFile(file, JSON.stringify(agent, null, 2) + "\n", "utf8");
  const { sha, unpushed } = await commitOrAmend(
    worktreePath, localBranch, remoteBranch,
    `peephole: heartbeat ${sessionId}`, `peephole: heartbeat ${sessionId}`,
  );
  return { committed: Boolean(sha), sha, unpushed, agent };
}

export async function push(repoRoot, remoteBranch) {
  const { worktreePath, localBranch } = await git.ensureWorktree(repoRoot, remoteBranch);
  await git.pushWorktree(worktreePath, localBranch, remoteBranch);
  return { pushed: true };
}

export async function pendingPush(repoRoot, remoteBranch) {
  const { worktreePath, localBranch } = await git.ensureWorktree(repoRoot, remoteBranch);
  return git.unpushedCount(worktreePath, localBranch, remoteBranch);
}
