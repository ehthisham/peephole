import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as git from "./git.js";
import { defaultConfig, serializeConfig, serializeTicket } from "./schema.js";
import { upsertMarkedSection, agentNoteBody, readmeNoteBody } from "./notes.js";
import { resolveLedger } from "./ledger.js";

const PEEPHOLE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const TICKET_ID_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/;

function assertSafeTicketId(id, label = "ticket id") {
  if (typeof id !== "string" || !TICKET_ID_RE.test(id)) {
    throw new Error(`invalid ${label} "${id}"`);
  }
}

function ticketPath(dir, id, label) {
  assertSafeTicketId(id, label);
  const file = path.join(dir, `${id}.md`);
  if (path.dirname(file) !== path.resolve(dir)) throw new Error(`invalid ${label} "${id}"`);
  return file;
}

/** The one place every ledger write resolves its checkout — a sparse clone outside the repo when
 *  that is possible, the in-repo worktree when it is not (see src/ledger.js). Callers are unchanged
 *  either way: they get a directory holding `.peephole/**` and the branch to commit on. */
async function prepWorktree(repoRoot, remoteBranch) {
  const ledger = await resolveLedger(repoRoot, remoteBranch);
  return { worktreePath: ledger.path, localBranch: ledger.localBranch, ledgerKind: ledger.kind };
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
  const docsWritten = [];
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
  // The same config also goes on the CODE branch, as a pointer. Branch resolution reads
  // `.peephole/config.yaml` at the remote's default ref, so without it a teammate's board finds the
  // ledger only by falling through to "a branch named peephole-state exists" — which works by
  // accident and says nothing about which branch is canonical if a second one ever appears. It is
  // one file declaring where the tickets live, written into the checkout and left for the
  // developer to commit, like the doc sections.
  if (kinds.has("missing-config") || kinds.has("missing-pointer")) {
    const pointerDir = path.join(repoRoot, ".peephole");
    await ensureDir(pointerDir);
    const pointerPath = path.join(pointerDir, "config.yaml");
    if (!(await fileExists(pointerPath))) {
      await fs.writeFile(pointerPath, serializeConfig(defaultConfig(projectName, remoteUrl, remoteBranch)), "utf8");
      docsWritten.push(".peephole/config.yaml");
    }
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
  // CLAUDE.md and README.md belong to the CODE branch — an agent reads CLAUDE.md from the branch
  // it is working on, and a human opens README.md there. Writing them into the ledger worktree put
  // them on the ledger branch, where nobody reads them; once the ledger is a dedicated branch that
  // is simply wrong, and with a sparse ledger checkout they would be stubs in an otherwise empty
  // tree. They are written into the developer's own checkout instead — and deliberately NOT
  // committed: that is their working tree and their branch to commit on.
  if (kinds.has("missing-gitignore")) {
    // In the repo's own .gitignore, uncommitted like the doc sections: it is a change to the code
    // branch, and that is the developer's commit to make.
    const ignorePath = path.join(repoRoot, ".gitignore");
    const current = await fs.readFile(ignorePath, "utf8").catch(() => "");
    const next = current && !current.endsWith("\n") ? `${current}\n` : current;
    await fs.writeFile(ignorePath, `${next}.peephole-worktree/\n`, "utf8");
    docsWritten.push(".gitignore");
  }
  if (kinds.has("missing-agent-note") || kinds.has("stale-agent-note")) {
    await upsertMarkedSection(
      path.join(repoRoot, "CLAUDE.md"),
      agentNoteBody({ binPath: peepholeBin, repoRoot, port }),
      `# ${projectName} — working notes`,
    );
    docsWritten.push("CLAUDE.md");
  }
  if (kinds.has("missing-readme-note") || kinds.has("stale-readme-note")) {
    await upsertMarkedSection(path.join(repoRoot, "README.md"), readmeNoteBody(peepholeCmd), `# ${projectName}`);
    docsWritten.push("README.md");
  }

  // `created` is what went into the ledger; docsWritten went into the checkout. Either counts as
  // the scaffold having done something — a run that only refreshed CLAUDE.md must not report
  // "nothing to do".
  if (created.length === 0) {
    return { committed: false, created: [], docsWritten, worktreePath, localBranch, hookSetup };
  }

  const sha = await git.commitAll(worktreePath, `peephole: scaffold ${created.join(", ")}`, paths);
  const unpushed = await git.unpushedCount(worktreePath, localBranch, remoteBranch);
  return { committed: Boolean(sha), created, docsWritten, sha, unpushed, worktreePath, localBranch, hookSetup };
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
export async function setControl(repoRoot, remoteBranch, ticketId, control, actor = "peephole-ui", note = "") {
  // Validate before touching the file: an undefined/garbage value used to be written straight onto
  // the ticket, and since yaml.dump drops an undefined key the result was a ticket with no
  // `control` field — which then failed validation and vanished from the board entirely.
  const { CONTROLS } = await import("./schema.js");
  if (!CONTROLS.includes(control)) {
    throw new Error(`invalid control "${control}" (expected one of ${CONTROLS.join(", ")})`);
  }
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
  // "Why is this skipped?" is the question a bare control flag can never answer, so the reason is
  // stored as a comment — the same place every other human sentence about the ticket goes.
  const reason = String(note || "").trim();
  if (reason) {
    ticket.comments = Array.isArray(ticket.comments) ? ticket.comments : [];
    ticket.comments.push({ at: ticket.updatedAt, by: actor, text: reason, control });
  }
  if (control === "restart") {
    ticket.owner = null;
    ticket.branch = null;
  }
  if (control === "skip") {
    ticket.owner = null;
    ticket.ownerName = null;
  }
  // Selected-for-execution and blocked are contradictory states: a skipped or paused ticket that
  // stayed selected would be handed to an agent by the next "execute selected", which is precisely
  // what the block said not to do. Blocking clears the selection.
  if (control !== "run") ticket.selected = false;

  await fs.writeFile(file, serializeTicket(ticket), "utf8");
  const { sha, unpushed } = await commitOrAmend(
    worktreePath, localBranch, remoteBranch,
    `peephole: ${ticketId} control -> `, `peephole: ${ticketId} control -> ${control}`,
  );
  return { committed: Boolean(sha), sha, unpushed, worktreePath, localBranch };
}

/** Upserts one {sessionId, transcriptPath, tokensAtStart, tokensAtLatest} entry into
 * ticket.sessions by sessionId — the durable link from a ticket back to the actual chat effort
 * (transcript + tokens) that produced it, since chat sessions are ephemeral (agents/*.json
 * heartbeats get overwritten/expire) but a ticket file is committed history.
 *
 * `tokens` passed in is always the SESSION's cumulative total (that's all a transcript can give
 * us — it has no per-ticket boundaries), so it can't be stored as this ticket's cost directly:
 * every ticket the same long-running session ever touches would end up showing that session's
 * entire lifetime total. Storing tokensAtStart (set once, on first touch) alongside
 * tokensAtLatest (advanced on every touch) lets the caller compute (tokensAtLatest -
 * tokensAtStart) — the marginal spend actually attributable to this ticket's span, not the
 * whole session. No-op if sessionId isn't given (nothing to link). */
function upsertSession(ticket, { sessionId, transcriptPath, tokens }) {
  if (!sessionId) return;
  ticket.sessions = Array.isArray(ticket.sessions) ? ticket.sessions : [];
  const at = new Date().toISOString();
  const existing = ticket.sessions.find((s) => s.sessionId === sessionId);
  if (existing) {
    existing.transcriptPath = transcriptPath || existing.transcriptPath;
    if (existing.tokensAtStart == null && tokens != null) existing.tokensAtStart = tokens;
    if (tokens != null) existing.tokensAtLatest = tokens;
    existing.at = at;
  } else {
    ticket.sessions.push({
      sessionId, transcriptPath: transcriptPath || null,
      tokensAtStart: tokens ?? null, tokensAtLatest: tokens ?? null, at,
    });
  }
}

/** Refreshes the token high-water mark on a ticket's session entry WITHOUT any other change —
 * called from the throttled (<=1/min) session check-in, which is the only place that sees a
 * session's running total while the work is still happening.
 *
 * Without this, `tokensAtLatest` only ever advanced when the agent happened to make a ticket
 * write (create/claim/advance), so a ticket claimed and worked for an hour recorded the delta
 * between two writes seconds apart — measured across a real repo, 4 of 5 scoped entries came out
 * at exactly 0. Amends rather than piles up commits, same as a control write: a per-minute
 * heartbeat is not a milestone. */
export async function touchTicketSession(repoRoot, remoteBranch, ticketId, { sessionId, transcriptPath, tokens, author }) {
  if (!ticketId || !sessionId || tokens == null) return { committed: false };
  const { worktreePath, localBranch } = await prepWorktree(repoRoot, remoteBranch);
  const file = path.join(worktreePath, ".peephole", "tickets", `${ticketId}.md`);
  if (!(await fileExists(file))) return { committed: false };

  const { parseTicket } = await import("./schema.js");
  const parsed = parseTicket(await fs.readFile(file, "utf8"), ticketId);
  if (!parsed.ok) return { committed: false };
  const ticket = parsed.ticket;

  const before = JSON.stringify(ticket.sessions || []);
  upsertSession(ticket, { sessionId, transcriptPath, tokens });
  if (author && author.name && !ticket.ownerName && ticket.owner === sessionId) ticket.ownerName = author.name;
  if (JSON.stringify(ticket.sessions) === before) return { committed: false };
  // Deliberately no history entry and no updatedAt bump: this is measurement, not an event, and
  // it must not make an idle ticket look freshly touched in the lane sort.

  await fs.writeFile(file, serializeTicket(ticket), "utf8");
  const { sha, unpushed } = await commitOrAmend(
    worktreePath, localBranch, remoteBranch,
    `peephole: ${ticketId} session tokens`, `peephole: ${ticketId} session tokens`,
  );
  return { committed: Boolean(sha), sha, unpushed };
}

/** Moves a ticket's `state` — forward (proposed→...→shipped) or to `closed`, per the ledger rule
 * (state only ever advances or closes, never drags backward, never deletes). Always its own commit:
 * unlike `control` clicks this is a meaningful milestone, never rapid-fire. */
export async function setState(repoRoot, remoteBranch, ticketId, state, actor = "peephole-ui", session = null) {
  // Whoever moves a ticket to a terminal state is the closest thing to an author the ledger has for
  // work that was never claimed. Recorded as `finishedBy` so it can be attributed without pretending
  // somebody owned it — an unclaimed ticket has no owner, and inventing one would be a lie the
  // member pages then report as fact.
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
  if (session) upsertSession(ticket, { sessionId: session.sessionId || actor, transcriptPath: session.transcriptPath, tokens: session.tokens });

  const MACHINE_ACTORS = new Set(["peephole-ui", "peephole-queue", "agent", ""]);
  if (["shipped", "closed"].includes(state) && actor && !MACHINE_ACTORS.has(actor)) {
    ticket.finishedBy = actor;
  }

  await fs.writeFile(file, serializeTicket(ticket), "utf8");
  const sha = await git.commitAll(worktreePath, `peephole: ${ticketId} state -> ${state}`);
  const unpushed = await git.unpushedCount(worktreePath, localBranch, remoteBranch);
  return { committed: Boolean(sha), sha, unpushed, ticket };
}

/** Creates a new ticket file with a schema-correct frontmatter — the deterministic alternative to an agent hand-writing YAML. Always its own commit. */
export async function createTicket(repoRoot, remoteBranch, { id, project, intent, acceptance = "", body = "", risk = "reversible", owner = null, assignee = null, epic = null, tags = [], createdBy = null, state: stateOverride, actor, session = null }) {
  if (!project || !intent) throw new Error("project and intent are required");
  const { STATES } = await import("./schema.js");
  if (stateOverride && !STATES.includes(stateOverride)) {
    throw new Error(`invalid state "${stateOverride}" (expected one of ${STATES.join(", ")})`);
  }
  const { worktreePath, localBranch } = await prepWorktree(repoRoot, remoteBranch);
  const dir = path.join(worktreePath, ".peephole", "tickets");
  await ensureDir(dir);
  const file = ticketPath(dir, id, "ticket id");
  if (await fileExists(file)) throw new Error(`ticket "${id}" already exists`);

  const now = new Date().toISOString();
  const state = stateOverride || (owner ? "in-progress" : "proposed");
  const who = actor || createdBy || "agent";
  const ticket = {
    id, project, intent, acceptance, body, state, risk, blockedOn: "", control: "run", owner,
    ownerName: owner ? session?.author?.name ?? null : null, assignee: assignee || null,
    epic: epic || null, selected: false, comments: [],
    tags: Array.isArray(tags) ? tags : [], createdBy,
    branch: null, pr: null, estimate: null, createdAt: now, updatedAt: now,
    history: [{ at: now, from: null, to: state, by: who }],
  };
  if (session) upsertSession(ticket, { sessionId: session.sessionId || owner || who, transcriptPath: session.transcriptPath, tokens: session.tokens });
  await fs.writeFile(file, serializeTicket(ticket), "utf8");
  const sha = await git.commitAll(worktreePath, `peephole: new ticket ${id}`);
  const unpushed = await git.unpushedCount(worktreePath, localBranch, remoteBranch);
  return { committed: Boolean(sha), sha, unpushed, ticket };
}

/** Claims (or re-affirms) ownership of an existing ticket, advancing proposed -> in-progress. Always its own commit. */
export async function claimTicket(repoRoot, remoteBranch, ticketId, owner, actor, session = null) {
  const { worktreePath, localBranch } = await prepWorktree(repoRoot, remoteBranch);
  const file = path.join(worktreePath, ".peephole", "tickets", `${ticketId}.md`);
  if (!(await fileExists(file))) throw new Error(`ticket "${ticketId}" not found`);
  const raw = await fs.readFile(file, "utf8");

  const { parseTicket } = await import("./schema.js");
  const parsed = parseTicket(raw, ticketId);
  if (!parsed.ok) throw new Error(`Cannot claim ${ticketId}: ${parsed.errors.join("; ")}`);
  const ticket = parsed.ticket;
  if (ticket.owner && ticket.owner !== owner) {
    return { claimed: false, reason: `already claimed by ${ticket.ownerName || ticket.owner}`, ticket };
  }
  // An assigned ticket is reserved for one person: any other person's session is refused here, at
  // the only door into ownership. The claimer proves who they are with the git identity their
  // SessionStart hook already reports (session.author) — an anonymous claimer can't take an
  // assigned ticket at all, since "unidentified" can never equal a named assignee.
  const claimantName = session?.author?.name ?? null;
  if (ticket.assignee && ticket.assignee !== claimantName) {
    return {
      claimed: false,
      reason: claimantName
        ? `assigned to ${ticket.assignee} — ${claimantName} cannot claim it`
        : `assigned to ${ticket.assignee} — claimer has no git identity to match`,
      ticket,
    };
  }

  const from = ticket.state;
  ticket.owner = owner;
  ticket.selected = false; // it is being worked now; leaving it selected would re-queue it
  if (claimantName) ticket.ownerName = claimantName;
  // A control left over from a previous claim (a skip, say) would otherwise deny this session on
  // its very first tool call — the block belongs to the claim that earned it, not to this one.
  ticket.control = "run";
  if (ticket.state === "proposed") ticket.state = "in-progress";
  if (session) upsertSession(ticket, { sessionId: session.sessionId || owner, transcriptPath: session.transcriptPath, tokens: session.tokens });
  ticket.updatedAt = new Date().toISOString();
  ticket.history.push({ at: ticket.updatedAt, from, to: ticket.state, by: actor || owner });

  await fs.writeFile(file, serializeTicket(ticket), "utf8");
  const sha = await git.commitAll(worktreePath, `peephole: ${ticketId} claimed by ${owner}`);
  const unpushed = await git.unpushedCount(worktreePath, localBranch, remoteBranch);
  return { claimed: true, committed: Boolean(sha), sha, unpushed, ticket };
}

/** Changes a ticket's risk. Risk is a judgement that usually arrives AFTER the ticket is written —
 * you discover the migration is one-way while planning it — so it cannot only be settable at
 * creation. Recorded in history, because "who decided this was safe" is the question asked after
 * something irreversible goes wrong. */
export async function setRisk(repoRoot, remoteBranch, ticketId, risk, actor = "peephole-ui") {
  const { RISKS, parseTicket } = await import("./schema.js");
  if (!RISKS.includes(risk)) {
    throw new Error(`invalid risk "${risk}" (expected one of ${RISKS.join(", ")})`);
  }
  const { worktreePath, localBranch } = await prepWorktree(repoRoot, remoteBranch);
  const file = path.join(worktreePath, ".peephole", "tickets", `${ticketId}.md`);
  if (!(await fileExists(file))) throw new Error(`ticket "${ticketId}" not found`);

  const parsed = parseTicket(await fs.readFile(file, "utf8"), ticketId);
  if (!parsed.ok) throw new Error(`Cannot set risk on ${ticketId}: ${parsed.errors.join("; ")}`);
  const ticket = parsed.ticket;
  if (ticket.risk === risk) return { committed: false, ticket };

  const from = ticket.risk;
  ticket.risk = risk;
  ticket.updatedAt = new Date().toISOString();
  ticket.history = Array.isArray(ticket.history) ? ticket.history : [];
  ticket.history.push({ at: ticket.updatedAt, from: `risk:${from}`, to: `risk:${risk}`, by: actor });

  await fs.writeFile(file, serializeTicket(ticket), "utf8");
  const sha = await git.commitAll(worktreePath, `peephole: ${ticketId} risk -> ${risk}`);
  const unpushed = await git.unpushedCount(worktreePath, localBranch, remoteBranch);
  return { committed: Boolean(sha), sha, unpushed, ticket };
}

/** Appends a comment to a ticket: free text, plus who wrote it and when. Comments are the only
 * place a human sentence belongs on a ticket — `history` records what changed, and the body says
 * what the work is; neither can hold "skipping this until the rule engine lands". Always its own
 * commit: a comment is something someone said, never a rapid-fire toggle to be amended away. */
export async function addComment(repoRoot, remoteBranch, ticketId, text, author = "peephole-ui") {
  const body = String(text == null ? "" : text).trim();
  if (!body) throw new Error("comment text is required");

  const { worktreePath, localBranch } = await prepWorktree(repoRoot, remoteBranch);
  const file = path.join(worktreePath, ".peephole", "tickets", `${ticketId}.md`);
  if (!(await fileExists(file))) throw new Error(`ticket "${ticketId}" not found`);

  const { parseTicket } = await import("./schema.js");
  const parsed = parseTicket(await fs.readFile(file, "utf8"), ticketId);
  if (!parsed.ok) throw new Error(`Cannot comment on ${ticketId}: ${parsed.errors.join("; ")}`);
  const ticket = parsed.ticket;

  const at = new Date().toISOString();
  ticket.comments = Array.isArray(ticket.comments) ? ticket.comments : [];
  ticket.comments.push({ at, by: author, text: body });
  ticket.updatedAt = at;

  await fs.writeFile(file, serializeTicket(ticket), "utf8");
  const sha = await git.commitAll(worktreePath, `peephole: ${ticketId} comment by ${author}`);
  const unpushed = await git.unpushedCount(worktreePath, localBranch, remoteBranch);
  return { committed: Boolean(sha), sha, unpushed, ticket };
}

/** Marks a ticket as selected for execution (or clears it). Selection is a queue-building act,
 * separate from `control`: `control` says whether an agent already working a ticket may continue,
 * selection says whether this ticket should be handed to an agent at all. Amends rather than
 * piling up commits — ticking boxes down a lane is not a milestone. */
export async function setSelected(repoRoot, remoteBranch, ticketId, selected, actor = "peephole-ui") {
  const { worktreePath, localBranch } = await prepWorktree(repoRoot, remoteBranch);
  const file = path.join(worktreePath, ".peephole", "tickets", `${ticketId}.md`);
  if (!(await fileExists(file))) throw new Error(`ticket "${ticketId}" not found`);

  const { parseTicket } = await import("./schema.js");
  const parsed = parseTicket(await fs.readFile(file, "utf8"), ticketId);
  if (!parsed.ok) throw new Error(`Cannot select ${ticketId}: ${parsed.errors.join("; ")}`);
  const ticket = parsed.ticket;

  const want = Boolean(selected);
  const blocked = ticket.control && ticket.control !== "run";
  // A blocked ticket cannot be selected at all. Selecting used to lift the block, which meant a
  // pause somebody else set could be undone by a click that didn't look like unblocking; the block
  // has to be cleared deliberately, with its own button, first.
  if (want && blocked) {
    throw new Error(`"${ticketId}" is ${ticket.control} — clear that before selecting it for execution`);
  }
  if (Boolean(ticket.selected) === want) return { committed: false, ticket };
  ticket.selected = want;
  ticket.updatedAt = new Date().toISOString();

  await fs.writeFile(file, serializeTicket(ticket), "utf8");
  const { sha, unpushed } = await commitOrAmend(
    worktreePath, localBranch, remoteBranch,
    `peephole: ${ticketId} selected -> `, `peephole: ${ticketId} selected -> ${want}`,
  );
  return { committed: Boolean(sha), sha, unpushed, ticket };
}

/** Files a ticket under an epic (or clears it with null). An epic is a free-text grouping label,
 * not a record of its own: tickets are the only durable unit here, and a board that needed an
 * epic to exist first would push the ceremony back onto the agent creating the ticket. The board
 * derives the epic list from whatever the tickets actually carry. Always its own commit. */
export async function setEpic(repoRoot, remoteBranch, ticketId, epic, actor = "peephole-ui") {
  const { worktreePath, localBranch } = await prepWorktree(repoRoot, remoteBranch);
  const file = path.join(worktreePath, ".peephole", "tickets", `${ticketId}.md`);
  if (!(await fileExists(file))) throw new Error(`ticket "${ticketId}" not found`);

  const { parseTicket } = await import("./schema.js");
  const parsed = parseTicket(await fs.readFile(file, "utf8"), ticketId);
  if (!parsed.ok) throw new Error(`Cannot set epic on ${ticketId}: ${parsed.errors.join("; ")}`);
  const ticket = parsed.ticket;

  const name = epic ? String(epic).trim() : null;
  const from = ticket.epic || null;
  if (from === name) return { committed: false, ticket };
  ticket.epic = name;
  ticket.updatedAt = new Date().toISOString();
  ticket.history = Array.isArray(ticket.history) ? ticket.history : [];
  ticket.history.push({ at: ticket.updatedAt, from: `epic:${from || "none"}`, to: `epic:${name || "none"}`, by: actor });

  await fs.writeFile(file, serializeTicket(ticket), "utf8");
  const sha = await git.commitAll(worktreePath, `peephole: ${ticketId} epic -> ${name || "none"}`);
  const unpushed = await git.unpushedCount(worktreePath, localBranch, remoteBranch);
  return { committed: Boolean(sha), sha, unpushed, ticket };
}

/** Reserves a ticket for one person by name (or clears the reservation with null). An assignee is
 * checked in `claimTicket`, so it is a real gate on ownership rather than a label: another
 * person's session is refused at claim time and never starts the work. Deliberately a name, not a
 * session id — people outlive sessions, and the name is the same git identity the Members panel
 * and the heartbeats already use. Always its own commit. */
export async function assignTicket(repoRoot, remoteBranch, ticketId, assignee, actor = "peephole-ui") {
  const { worktreePath, localBranch } = await prepWorktree(repoRoot, remoteBranch);
  const file = path.join(worktreePath, ".peephole", "tickets", `${ticketId}.md`);
  if (!(await fileExists(file))) throw new Error(`ticket "${ticketId}" not found`);
  const raw = await fs.readFile(file, "utf8");

  const { parseTicket } = await import("./schema.js");
  const parsed = parseTicket(raw, ticketId);
  if (!parsed.ok) throw new Error(`Cannot assign ${ticketId}: ${parsed.errors.join("; ")}`);
  const ticket = parsed.ticket;

  const name = assignee ? String(assignee).trim() : null;
  // Reassigning a ticket someone is actively working is a coordination decision, not a mechanical
  // one — refuse it rather than silently stranding the running session's claim.
  if (name && ticket.owner && (ticket.ownerName || null) !== name) {
    throw new Error(`"${ticketId}" is already being worked by ${ticket.ownerName || ticket.owner} — unclaim it before assigning to ${name}`);
  }
  const from = ticket.assignee || null;
  ticket.assignee = name;
  ticket.updatedAt = new Date().toISOString();
  ticket.history = Array.isArray(ticket.history) ? ticket.history : [];
  ticket.history.push({ at: ticket.updatedAt, from: `assignee:${from || "none"}`, to: `assignee:${name || "none"}`, by: actor });

  await fs.writeFile(file, serializeTicket(ticket), "utf8");
  const sha = await git.commitAll(worktreePath, `peephole: ${ticketId} assigned -> ${name || "unassigned"}`);
  const unpushed = await git.unpushedCount(worktreePath, localBranch, remoteBranch);
  return { committed: Boolean(sha), sha, unpushed, ticket };
}

/** Returns a ticket to `proposed` and clears its owner — the one bounded exception to
 * forward-only state, mirroring how `closed` is reachable from anywhere. Ownership is a
 * coordination lock, not a hard one: an agent can hang, crash, or misjudge, so a human (or
 * anyone) must always have an escape hatch to hand a ticket back. It's deliberately narrow —
 * only from `in-progress`, never from `built`/`verified`/`shipped` — so it can undo a claim
 * before any real progress exists without ever rewinding actual work. */
export async function unclaimTicket(repoRoot, remoteBranch, ticketId, actor = "peephole-ui") {
  const { worktreePath, localBranch } = await prepWorktree(repoRoot, remoteBranch);
  const file = path.join(worktreePath, ".peephole", "tickets", `${ticketId}.md`);
  if (!(await fileExists(file))) throw new Error(`ticket "${ticketId}" not found`);
  const raw = await fs.readFile(file, "utf8");

  const { parseTicket } = await import("./schema.js");
  const parsed = parseTicket(raw, ticketId);
  if (!parsed.ok) throw new Error(`Cannot unclaim ${ticketId}: ${parsed.errors.join("; ")}`);
  const ticket = parsed.ticket;
  if (ticket.state !== "in-progress") {
    throw new Error(`cannot unclaim "${ticketId}" from ${ticket.state} — only in-progress tickets can be returned to proposed`);
  }

  const from = ticket.state;
  ticket.owner = null;
  ticket.ownerName = null;
  ticket.state = "proposed";
  ticket.updatedAt = new Date().toISOString();
  ticket.history.push({ at: ticket.updatedAt, from, to: ticket.state, by: actor });

  await fs.writeFile(file, serializeTicket(ticket), "utf8");
  const sha = await git.commitAll(worktreePath, `peephole: ${ticketId} unclaimed -> proposed`);
  const unpushed = await git.unpushedCount(worktreePath, localBranch, remoteBranch);
  return { committed: Boolean(sha), sha, unpushed, ticket };
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

/** Renames a ticket's id (and its filename) — for fixing a bad id, never for hiding history: the
 * old id is recorded in `history` so anything cross-referencing it can still be traced. */
export async function renameTicket(repoRoot, remoteBranch, oldId, newId, actor = "peephole-ui", tags) {
  const { worktreePath, localBranch } = await prepWorktree(repoRoot, remoteBranch);
  const dir = path.join(worktreePath, ".peephole", "tickets");
  const oldFile = ticketPath(dir, oldId, "old ticket id");
  const newFile = ticketPath(dir, newId, "new ticket id");
  if (!(await fileExists(oldFile))) throw new Error(`ticket "${oldId}" not found`);
  if (await fileExists(newFile)) throw new Error(`ticket "${newId}" already exists`);

  const raw = await fs.readFile(oldFile, "utf8");
  const { parseTicket } = await import("./schema.js");
  const parsed = parseTicket(raw, oldId);
  if (!parsed.ok) throw new Error(`Cannot rename ${oldId}: ${parsed.errors.join("; ")}`);
  const ticket = parsed.ticket;
  ticket.id = newId;
  if (Array.isArray(tags)) ticket.tags = tags;
  ticket.updatedAt = new Date().toISOString();
  ticket.history = Array.isArray(ticket.history) ? ticket.history : [];
  ticket.history.push({ at: ticket.updatedAt, from: `id:${oldId}`, to: `id:${newId}`, by: actor });

  await fs.writeFile(newFile, serializeTicket(ticket), "utf8");
  await fs.unlink(oldFile);
  const sha = await git.commitAll(worktreePath, `peephole: rename ticket ${oldId} -> ${newId}`);
  const unpushed = await git.unpushedCount(worktreePath, localBranch, remoteBranch);
  return { committed: Boolean(sha), sha, unpushed, oldId, newId };
}

/**
 * Moves the ledger onto another branch WITHOUT losing anything: the new branch is created from the
 * current ledger branch, so every ticket, every history entry and every comment is carried as
 * commits rather than copied as files. The old branch is left exactly as it is — if the migration
 * turns out wrong, pointing `stateBranch` back at it restores the previous board.
 *
 * Returns the ticket count seen before and after, so a caller can prove nothing was dropped.
 */
export async function migrateLedger(repoRoot, fromBranch, toBranch, { remote = "origin", push: doPush = false } = {}) {
  if (!toBranch || toBranch === fromBranch) throw new Error("a different target branch is required");
  const { worktreePath, localBranch } = await prepWorktree(repoRoot, fromBranch);

  const ticketsDir = path.join(worktreePath, ".peephole", "tickets");
  const before = (await fs.readdir(ticketsDir).catch(() => [])).filter((f) => f.endsWith(".md"));

  // The target may already exist (a teammate migrated first) — in that case join it rather than
  // overwrite it, and refuse if it holds a ledger that isn't an ancestor of this one.
  const targetRemoteRef = `${remote}/${toBranch}`;
  const targetExists = await git.refExists(worktreePath, targetRemoteRef);
  if (targetExists) {
    const merged = await git.isAncestor(worktreePath, localBranch, targetRemoteRef).catch(() => false);
    if (!merged) {
      throw new Error(
        `${targetRemoteRef} already exists and does not contain this ledger — merge them by hand rather than risk losing either`,
      );
    }
  }

  const localTarget = `peephole/${toBranch}`;
  await git.createBranchAt(worktreePath, localTarget, localBranch);
  await git.checkoutBranch(worktreePath, localTarget);

  // Declare the new home in the config the branch itself carries, so every teammate resolves it.
  const configPath = path.join(worktreePath, ".peephole", "config.yaml");
  const raw = await fs.readFile(configPath, "utf8");
  const next = raw.match(/^stateBranch:.*$/m)
    ? raw.replace(/^stateBranch:.*$/m, `stateBranch: ${toBranch}`)
    : `stateBranch: ${toBranch}\n${raw}`;
  await fs.writeFile(configPath, next, "utf8");
  const sha = await git.commitAll(worktreePath, `peephole: move the ledger to ${toBranch}`);

  // Leave a forwarding pointer on the OLD branch as well. Branch resolution reads the config at the
  // remote's default ref, so a migration that only updated the new branch would be invisible:
  // everyone would keep resolving the old branch from the old declaration and quietly go on using
  // the old ledger. Both branches now name the new home; the old one keeps its tickets untouched.
  await git.checkoutBranch(worktreePath, localBranch);
  const oldConfig = await fs.readFile(configPath, "utf8");
  if (!new RegExp(`^stateBranch:\\s*${toBranch}\\s*$`, "m").test(oldConfig)) {
    await fs.writeFile(
      configPath,
      oldConfig.match(/^stateBranch:.*$/m)
        ? oldConfig.replace(/^stateBranch:.*$/m, `stateBranch: ${toBranch}`)
        : `stateBranch: ${toBranch}\n${oldConfig}`,
      "utf8",
    );
    await git.commitAll(worktreePath, `peephole: the ledger now lives on ${toBranch}`);
  }
  await git.checkoutBranch(worktreePath, localTarget);

  const after = (await fs.readdir(ticketsDir).catch(() => [])).filter((f) => f.endsWith(".md"));
  let pushed = false;
  if (doPush) {
    await git.pushWorktree(worktreePath, localTarget, toBranch, remote);
    // The forwarding pointer is only useful once it is where teammates look.
    await git.pushWorktree(worktreePath, localBranch, fromBranch, remote);
    pushed = true;
  }
  return {
    from: fromBranch, to: toBranch, sha, pushed,
    ticketsBefore: before.length, ticketsAfter: after.length,
    missing: before.filter((f) => !after.includes(f)),
  };
}

// Both of these used git.ensureWorktree directly, which bypasses the ledger resolver: with the
// ledger in a clone, the write landed in the clone while the push published the in-repo worktree —
// reporting success having sent nothing, and creating a worktree in a repo that had none. Every
// ledger operation goes through prepWorktree.
export async function push(repoRoot, remoteBranch) {
  const { worktreePath, localBranch } = await prepWorktree(repoRoot, remoteBranch);
  await git.pushWorktree(worktreePath, localBranch, remoteBranch);
  return { pushed: true };
}

export async function pendingPush(repoRoot, remoteBranch) {
  const { worktreePath, localBranch } = await prepWorktree(repoRoot, remoteBranch);
  return git.unpushedCount(worktreePath, localBranch, remoteBranch);
}
