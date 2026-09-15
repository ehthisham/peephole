import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";

const execFileP = promisify(execFile);

/** How often the queue looks for a session to hand the next ticket to. Short enough that a freed
 *  session is picked up while you're still looking at the board, long enough that polling an
 *  external CLI stays cheap. */
const POLL_MS = 10000;
const LIST_TIMEOUT_MS = 20000;

/**
 * Live Claude Code sessions — interactive and background alike — as `claude agents --json`
 * reports them, narrowed to the ones started under `repoRoot`. Each entry carries
 * {pid, cwd, kind, sessionId, name, status}; `status: "busy"` means it is mid-turn and cannot
 * take work (resuming a busy session starts a COPY under a new id, which is exactly the session
 * sprawl the queue exists to avoid).
 *
 * Returns [] rather than throwing when the CLI is missing or errors: a board that can't see
 * sessions must still serve, it just can't dispatch.
 */
export async function listSessions(repoRoot) {
  try {
    // Deliberately NOT `--cwd <repoRoot>`: that only matches sessions started at or below the repo,
    // and a session is normally started one level up (`~/workx`, with the repo as a subdirectory),
    // so the filter hid every real session and the queue concluded it had to spawn its own. Filter
    // here instead, accepting a session whose cwd contains the repo as well as one inside it.
    const { stdout } = await execFileP("claude", ["agents", "--json"], {
      timeout: LIST_TIMEOUT_MS,
      maxBuffer: 4 * 1024 * 1024,
    });
    const parsed = JSON.parse(stdout);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((s) => s && s.sessionId && relatedCwd(s.cwd, repoRoot))
      .map((s) => ({ ...s, reach: reachOf(s.cwd, repoRoot) }));
  } catch {
    return [];
  }
}

function within(child, parent) {
  if (!child || !parent) return false;
  const a = String(child).replace(/\/+$/, "");
  const b = String(parent).replace(/\/+$/, "");
  return a === b || a.startsWith(b + "/");
}

/** 0 = rooted exactly at the repo, 1 = rooted inside it, 2 = rooted above it (the repo is reachable
 *  but so is everything else that person is working on). Lower is a better fit for this repo's work. */
function reachOf(cwd, repoRoot) {
  if (!cwd) return 3;
  if (String(cwd).replace(/\/+$/, "") === String(repoRoot).replace(/\/+$/, "")) return 0;
  if (within(cwd, repoRoot)) return 1;
  if (within(repoRoot, cwd)) return 2;
  return 3;
}

function relatedCwd(cwd, repoRoot) {
  return reachOf(cwd, repoRoot) < 3;
}

/** The idle session that fits this repo most tightly. A busy session is never chosen: resuming one
 *  starts a COPY under a new id, which is the session sprawl this queue exists to avoid. */
function idleSessionOf(sessions) {
  const idle = sessions.filter((s) => s.status !== "busy");
  idle.sort((a, b) => (a.reach ?? 3) - (b.reach ?? 3));
  return idle[0] || null;
}

/** The instruction handed to the agent. Deliberately points at the CLI rather than describing the
 *  work in prose: the ticket file is the source of truth, and the agent must drive state through
 *  `peephole ticket advance` so the board reflects reality rather than this prompt's assumptions. */
function promptFor(ticket, { binPath, port }) {
  const cli = `node ${binPath}`;
  const parts = [
    `Work Peephole ticket "${ticket.id}".`,
    "",
    `Intent: ${ticket.intent}`,
  ];
  if (ticket.acceptance) parts.push("", `Acceptance criteria: ${ticket.acceptance}`);
  if (ticket.body) parts.push("", "Ticket notes:", ticket.body);
  parts.push(
    "",
    "This ticket is already claimed for you (state: in-progress, owner: your session).",
    `Advance it as you go — ${cli} ticket advance ${ticket.id} --state <built|verified|shipped> --transcript <your transcript_path> --port ${port}`,
    `Before each step, check you have not been paused — ${cli} control check ${ticket.id} --port ${port}`,
    "Stop and report rather than pushing through if that check fails.",
  );
  return parts.join("\n");
}

/**
 * The execution queue: one ticket at a time, dispatched into an EXISTING idle session wherever
 * possible (`claude -p --resume <id>` continues that session under its own id, so the Agents panel
 * and per-ticket token accounting keep working against one session instead of one per ticket).
 *
 * A fresh background session is started only when the repo has no live session at all. When every
 * session is busy the queue holds — deliberately: taking a busy session would fork a copy, and
 * starting a parallel agent in a repo somebody is actively working is how two agents end up
 * editing the same files.
 */
export function createQueue({ repoRoot, binPath, port, claimTicket, onChange }) {
  /** @type {{ticketId: string, permissionMode: string, queuedAt: string}[]} */
  const pending = [];
  let running = null; // {ticketId, sessionId, pid, startedAt}
  let timer = null;
  let lastError = null;

  function state() {
    return {
      pending: pending.map((p) => ({ ticketId: p.ticketId, queuedAt: p.queuedAt })),
      running: running ? { ticketId: running.ticketId, sessionId: running.sessionId, startedAt: running.startedAt } : null,
      lastError,
    };
  }

  function announce() {
    if (onChange) onChange(state());
  }

  function enqueue(ticketId, permissionMode) {
    if (running && running.ticketId === ticketId) return state();
    if (pending.some((p) => p.ticketId === ticketId)) return state();
    pending.push({ ticketId, permissionMode, queuedAt: new Date().toISOString() });
    announce();
    tick().catch((e) => console.error("queue tick failed:", e.message));
    return state();
  }

  function cancel(ticketId) {
    const idx = pending.findIndex((p) => p.ticketId === ticketId);
    if (idx !== -1) pending.splice(idx, 1);
    announce();
    return state();
  }

  /** Attempts to start the head of the queue. No-op while something is already running, or while
   *  every session is busy — in which case the poll timer tries again. */
  async function tick() {
    if (running || pending.length === 0) return;
    const sessions = await listSessions(repoRoot);
    const idle = idleSessionOf(sessions);
    if (!idle && sessions.length > 0) {
      schedulePoll(); // everything busy: hold the queue rather than forking a copy
      return;
    }

    const next = pending[0];
    const sessionId = idle ? idle.sessionId : randomUUID();
    let ticket;
    try {
      // Claim first: the ticket must already show in-progress and owned by the session that is
      // about to be handed the work, so the board never displays a ticket being worked by nobody.
      const claim = await claimTicket(next.ticketId, sessionId);
      if (!claim || claim.claimed === false) {
        lastError = `${next.ticketId}: ${claim && claim.reason ? claim.reason : "could not claim"}`;
        pending.shift();
        announce();
        return tick();
      }
      ticket = claim.ticket;
    } catch (e) {
      lastError = `${next.ticketId}: ${e.message}`;
      pending.shift();
      announce();
      return;
    }

    pending.shift();
    const prompt = promptFor(ticket, { binPath, port });
    const args = idle
      ? ["-p", "--resume", sessionId, "--permission-mode", next.permissionMode, prompt]
      : ["-p", "--session-id", sessionId, "--permission-mode", next.permissionMode, prompt];

    let child;
    try {
      child = spawn("claude", args, { cwd: repoRoot, stdio: ["ignore", "pipe", "pipe"] });
    } catch (e) {
      lastError = `${next.ticketId}: could not start claude — ${e.message}`;
      announce();
      return;
    }

    running = { ticketId: next.ticketId, sessionId, pid: child.pid, startedAt: new Date().toISOString(), child };
    lastError = null;
    announce();

    let stderr = "";
    child.stdout.on("data", () => {}); // drained, not stored: the transcript is the record
    child.stderr.on("data", (d) => { stderr += String(d).slice(0, 2000); });
    child.on("exit", (code) => {
      if (code !== 0) lastError = `${running.ticketId}: claude exited ${code}${stderr ? ` — ${stderr.trim().split("\\n")[0]}` : ""}`;
      running = null;
      announce();
      tick().catch((e) => console.error("queue tick failed:", e.message));
    });
    child.on("error", (e) => {
      lastError = `${running ? running.ticketId : "queue"}: ${e.message}`;
      running = null;
      announce();
    });
  }

  function schedulePoll() {
    if (timer) return;
    timer = setTimeout(() => {
      timer = null;
      tick().catch((e) => console.error("queue tick failed:", e.message));
    }, POLL_MS);
    if (timer.unref) timer.unref();
  }

  /** Stops the running dispatch. The session itself survives — only the turn we started is cut,
   *  which is the difference between cancelling work and killing somebody's session. */
  function stop() {
    if (running && running.child) running.child.kill("SIGTERM");
    return state();
  }

  return { enqueue, cancel, stop, state, tick };
}
