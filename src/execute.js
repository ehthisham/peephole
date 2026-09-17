import { execFile, spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";

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

/**
 * The session a ticket may be dispatched into: an idle BACKGROUND session only.
 *
 * Interactive sessions are excluded even when idle, and that is the whole point. An interactive
 * session is somebody sitting at a terminal — dispatching into it resumes the conversation they
 * are in the middle of, which is exactly what happened in testing: the queue found the operator's
 * own session idle between turns and resumed it with a ticket prompt. "Idle" means "not mid-turn",
 * not "unattended". (`--resume` on an attached session also just starts a copy, so reusing one is
 * unreliable as well as rude.)
 *
 * Background sessions are the ones that exist to be handed work, so they are the only candidates;
 * when there is none, the queue starts one. Ties break toward the session rooted most tightly in
 * this repo.
 */
function idleSessionOf(sessions) {
  const usable = sessions.filter((s) => s.status !== "busy" && s.kind === "background");
  usable.sort((a, b) => (a.reach ?? 3) - (b.reach ?? 3));
  return usable[0] || null;
}

/** Whether anything at all could take work right now — used to decide between holding the queue
 *  and starting a worker. A repo full of busy background sessions should wait for one; a repo with
 *  only interactive sessions (or none) needs its own worker started. */
function hasBackgroundSession(sessions) {
  return sessions.some((s) => s.kind === "background");
}

/**
 * Opens the ticket in a terminal the developer can sit in, rather than a headless session they can
 * only watch. The session is interactive from its first token: they can interrupt, redirect, answer
 * a question, or take the keyboard entirely — which is the thing a background dispatch cannot offer
 * and the reason `claude attach` existed as a workaround.
 *
 * The prompt goes through a file rather than the command line: gnome-terminal is a thin client to
 * gnome-terminal-server, so environment variables set here do not reach the shell it starts, and a
 * multi-line prompt full of quotes has no business being escaped through two layers of shell.
 */
async function openInTerminal({ repoRoot, sessionId, permissionMode, prompt }) {
  const promptFile = path.join(os.tmpdir(), `peephole-${sessionId}.txt`);
  await fs.writeFile(promptFile, prompt, "utf8");
  // `exec bash` keeps the window alive when the session ends: the developer is left in the repo,
  // in a shell, where they were already working — not staring at a closed window.
  return runInTerminal(
    repoRoot,
    `claude --session-id ${q(sessionId)} --permission-mode ${q(permissionMode)} "$(cat ${q(promptFile)})"; ` +
      `rm -f ${q(promptFile)}; exec bash`,
  );
}

/**
 * Opens a terminal on an existing session — the board's answer to "I want to talk to the agent
 * that is working this ticket". It works whichever way the session started: `claude attach` joins a
 * background worker, and re-opens a session whose own window has since been closed.
 */
export async function attachInTerminal(repoRoot, rawSessionId) {
  const sessionId = safeSessionId(rawSessionId);
  if (!sessionId) return { opened: false, reason: "not a session id" };
  const result = await runInTerminal(repoRoot, `claude attach ${q(sessionId)}; exec bash`);
  // The command is returned either way, so a machine with no terminal emulator (or a board being
  // read over SSH) still gets something it can paste.
  return { ...result, command: `claude attach ${sessionId}` };
}

/** Whether a claude process for this session is still running. `pgrep -f` against the session id,
 *  which appears on the command line of a session Peephole started — the one liveness signal that
 *  does not depend on the CLI choosing to list the session. */
async function processAlive(sessionId) {
  try {
    // Matches both shapes Peephole starts: `--session-id <id>` for a new session, `--resume <id>`
    // for one it continued.
    const { stdout } = await execFileP("pgrep", ["-f", `(session-id|resume) ${sessionId}`], { timeout: 5000 });
    return stdout.trim().length > 0;
  } catch {
    return false; // pgrep exits non-zero when nothing matches
  }
}

/**
 * A session id that is safe to put on a command line, or null.
 *
 * Session ids reach this module from a free-text box in the dispatch dialog — "…or paste a session
 * id" — and end up inside a shell line handed to a terminal. Without this, a pasted
 * `x"; rm -rf ~; #` is a command, not an id. Checked here as well as at the API boundary because
 * this is the module that builds the shell line, and it should not depend on a caller's diligence.
 */
export function safeSessionId(value) {
  const id = String(value == null ? "" : value).trim();
  return /^[0-9a-fA-F][0-9a-fA-F-]{7,63}$/.test(id) ? id : null;
}

/** Single-quotes a value for a shell line, escaping any quotes inside it. Belt to the braces of
 *  safeSessionId: paths come from os.tmpdir() and a repo root the user chose, and neither is
 *  guaranteed free of spaces. */
function q(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

/** Runs one shell line in whichever terminal emulator this machine has. */
async function runInTerminal(repoRoot, line) {
  for (const [cmd, args] of [
    ["gnome-terminal", [`--working-directory=${repoRoot}`, "--", "bash", "-lc", line]],
    ["x-terminal-emulator", ["-e", `bash -lc '${line.replace(/'/g, "'\\''")}'`]],
    ["xterm", ["-e", "bash", "-lc", line]],
  ]) {
    try {
      const child = spawn(cmd, args, { cwd: repoRoot, detached: true, stdio: "ignore" });
      child.unref();
      return { opened: true, terminal: cmd };
    } catch {
      /* try the next emulator */
    }
  }
  return { opened: false, reason: "no terminal emulator found (tried gnome-terminal, x-terminal-emulator, xterm)" };
}

/** The instruction handed to the agent. Deliberately points at the CLI rather than describing the
 *  work in prose: the ticket file is the source of truth, and the agent must drive state through
 *  `peephole ticket advance` so the board reflects reality rather than this prompt's assumptions. */
export function promptFor(ticket, { binPath, port }) {
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

/** The prompt for talking ABOUT a ticket rather than doing it: the agent reads the ticket and the
 *  code around it, then asks and answers rather than editing. It writes its conclusion back as a
 *  ticket comment, so a conversation nobody else saw still leaves something on the board. */
function chatPromptFor(ticket, { binPath, port }) {
  const cli = `node ${binPath}`;
  const parts = [
    `Let's talk about Peephole ticket "${ticket.id}" before anyone builds it. Do not change any files.`,
    "",
    `Intent: ${ticket.intent}`,
  ];
  if (ticket.acceptance) parts.push("", `Acceptance criteria: ${ticket.acceptance}`);
  if (ticket.body) parts.push("", "Ticket notes:", ticket.body);
  parts.push(
    "",
    "Read enough of the repo to have an informed opinion, then tell me: what this ticket is really",
    "asking for, what is ambiguous or missing, what you would do, and what could go wrong.",
    "Ask me questions rather than guessing — this is a conversation, not an implementation.",
    "",
    "When we reach a conclusion, record it on the ticket so it is not lost:",
    `  ${cli} ticket comment ${ticket.id} --text "<what we decided>" --port ${port}`,
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
export function createQueue({ repoRoot, binPath, port, claimTicket, readTicket, onChange }) {
  /** @type {{ticketId: string, permissionMode: string, queuedAt: string}[]} */
  const pending = [];
  let running = null; // {ticketId, sessionId, pid, startedAt}
  let timer = null;
  let lastError = null;

  /** Conversations opened about tickets. Deliberately outside the queue: a chat claims nothing,
   *  blocks nothing and does not take a turn from the worker — it is a person thinking out loud
   *  with an agent, and the board's job is only to say where it is so it can be joined. */
  const chats = [];
  /** Whether finishing one ticket starts the next by itself. */
  let autoContinue = true;
  const TERMINAL_TICKET_STATES = new Set(["shipped", "closed"]);
  const TERMINAL_GRACE_MS = 30000;

  async function startChat(ticketId, permissionMode = "plan") {
    const ticket = readTicket(ticketId);
    if (!ticket) return { started: false, reason: `ticket "${ticketId}" not found` };

    const prompt = chatPromptFor(ticket, { binPath, port });
    let out = "";
    try {
      const code = await new Promise((resolve, reject) => {
        const child = spawn("claude", ["--background", "--permission-mode", permissionMode, prompt], {
          cwd: repoRoot,
          stdio: ["ignore", "pipe", "pipe"],
        });
        child.stdout.on("data", (d) => { out += String(d); });
        child.on("error", reject);
        child.on("exit", resolve);
      });
      if (code !== 0) return { started: false, reason: `claude exited ${code}` };
    } catch (e) {
      return { started: false, reason: e.message };
    }

    const sessionId = await resolveSpawnedSession(out, repoRoot);
    if (!sessionId) return { started: false, reason: "started a session but could not identify it" };
    const existing = chats.findIndex((c) => c.ticketId === ticketId);
    const entry = { ticketId, sessionId, startedAt: new Date().toISOString() };
    if (existing === -1) chats.push(entry);
    else chats[existing] = entry;
    announce();
    watchChats();
    return { started: true, sessionId };
  }

  /** Drops finished conversations from the board. A chat that has exited is no longer joinable, and
   *  leaving it listed would offer an attach command that fails. */
  function watchChats() {
    if (!chats.length) return;
    setTimeout(async () => {
      if (!chats.length) return;
      const sessions = await listSessions(repoRoot);
      const live = new Set(sessions.map((s) => s.sessionId));
      const before = chats.length;
      for (let i = chats.length - 1; i >= 0; i--) {
        if (!live.has(chats[i].sessionId)) chats.splice(i, 1);
      }
      if (chats.length !== before) announce();
      watchChats();
    }, POLL_MS).unref?.();
  }

  function state() {
    return {
      chats: chats.map((c) => ({ ...c })),
      pending: pending.map((p) => ({ ticketId: p.ticketId, queuedAt: p.queuedAt })),
      autoContinue,
      running: running
        ? {
            ticketId: running.ticketId,
            sessionId: running.sessionId,
            startedAt: running.startedAt,
            needsInput: Boolean(running.needsInput),
            launch: running.launch || "background",
          }
        : null,
      lastError,
    };
  }

  function announce() {
    if (onChange) onChange(state());
  }

  function enqueue(ticketId, permissionMode, launch = "background", sessionId = null) {
    if (running && running.ticketId === ticketId) return state();
    if (pending.some((p) => p.ticketId === ticketId)) return state();
    pending.push({ ticketId, permissionMode, launch, sessionId, queuedAt: new Date().toISOString() });
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
    if (!idle && hasBackgroundSession(sessions)) {
      // Workers exist but all are mid-turn: wait for one rather than starting another, and never
      // fall through to an interactive session.
      schedulePoll();
      return;
    }

    const next = pending[0];
    const sessionId = idle ? idle.sessionId : null;
    // Read the ticket without claiming it. The claim happens after the spawn, once there is a real
    // session id to record — claiming twice (once with a guessed id, once with the real one) had
    // the second call refuse the first call's own claim, then stop the agent it had just started.
    const peek = await readTicket(next.ticketId);
    if (!peek) {
      lastError = `${next.ticketId}: ticket not found`;
      pending.shift();
      announce();
      return tick();
    }
    if (peek.control && peek.control !== "run") {
      lastError = `${next.ticketId}: ${peek.control} — not dispatched`;
      pending.shift();
      announce();
      return tick();
    }
    if (peek.owner) {
      lastError = `${next.ticketId}: already claimed by ${peek.ownerName || peek.owner.slice(0, 8)} — not dispatched`;
      pending.shift();
      announce();
      return tick();
    }
    const ticket = peek;

    pending.shift();
    const prompt = promptFor(ticket, { binPath, port });

    if (next.launch === "existing" && next.sessionId) {
      // Continue a conversation that already exists, in a terminal. `--resume` keeps the session's
      // context, which is the whole point of choosing it: the agent already knows this codebase,
      // this ticket's neighbourhood, or the half-finished attempt you are handing it.
      //
      // The CLI's own caveat applies and is surfaced to the picker rather than hidden: resuming a
      // session that is currently RUNNING starts a copy under a new id. The picker marks busy
      // sessions for exactly that reason.
      const sessionId = safeSessionId(next.sessionId);
      if (!sessionId) {
        lastError = `${next.ticketId}: "${String(next.sessionId).slice(0, 24)}" is not a session id`;
        announce();
        return tick();
      }
      const promptFile = path.join(os.tmpdir(), `peephole-resume-${sessionId}.txt`);
      await fs.writeFile(promptFile, prompt, "utf8");
      const opened = await runInTerminal(
        repoRoot,
        `claude --resume ${q(sessionId)} --permission-mode ${q(next.permissionMode)} "$(cat ${q(promptFile)})"; ` +
          `rm -f ${q(promptFile)}; exec bash`,
      );
      if (!opened.opened) {
        lastError = `${next.ticketId}: ${opened.reason}`;
        announce();
        return;
      }
      try {
        const claim = await claimTicket(next.ticketId, sessionId);
        if (!claim || claim.claimed === false) {
          lastError = `${next.ticketId}: resumed ${sessionId.slice(0, 8)}, but not claimed — ${(claim && claim.reason) || "unknown"}`;
        }
      } catch (e) {
        lastError = `${next.ticketId}: resumed ${sessionId.slice(0, 8)}, but not claimed — ${e.message}`;
      }
      running = {
        ticketId: next.ticketId, sessionId, startedAt: new Date().toISOString(),
        launch: "terminal", terminal: opened.terminal, resumed: true,
      };
      announce();
      watchRunning();
      return;
    }

    if (next.launch === "terminal") {
      // The id is minted here rather than read back, because an interactive session accepts
      // --session-id (only --background refuses it). Knowing it up front means the ticket can be
      // claimed for exactly the session the developer is about to be sitting in.
      const sessionId = randomUUID();
      const opened = await openInTerminal({ repoRoot, sessionId, permissionMode: next.permissionMode, prompt });
      if (!opened.opened) {
        lastError = `${next.ticketId}: ${opened.reason}`;
        announce();
        return;
      }
      try {
        const claim = await claimTicket(next.ticketId, sessionId);
        if (!claim || claim.claimed === false) {
          lastError = `${next.ticketId}: opened a terminal, but not claimed — ${(claim && claim.reason) || "unknown"}`;
        }
      } catch (e) {
        lastError = `${next.ticketId}: opened a terminal, but not claimed — ${e.message}`;
      }
      running = {
        ticketId: next.ticketId, sessionId, startedAt: new Date().toISOString(),
        launch: "terminal", terminal: opened.terminal,
      };
      announce();
      watchRunning();
      return;
    }

    // `--background` is the whole point: the dispatched turn outlives this request, and the session
    // stays attachable (`claude attach <id>`) so a human can take over what an agent started.
    //
    // NOT `--print`: the CLI refuses the pair outright ("--bg and --print conflict: --print never
    // starts the interactive session that `claude agents` attaches to"). And not `--session-id`
    // either — with --bg the CLI mints the id itself and says so — which is why a new worker's id
    // is read back from its output instead of chosen here.
    const args = idle
      ? ["--background", "--resume", sessionId, "--permission-mode", next.permissionMode, prompt]
      : ["--background", "--permission-mode", next.permissionMode, prompt];

    let out = "";
    let stderr = "";
    let code = 0;
    try {
      code = await new Promise((resolve, reject) => {
        const child = spawn("claude", args, { cwd: repoRoot, stdio: ["ignore", "pipe", "pipe"] });
        child.stdout.on("data", (d) => { out += String(d); });
        child.stderr.on("data", (d) => { stderr += String(d).slice(0, 2000); });
        child.on("error", reject);
        child.on("exit", resolve);
      });
    } catch (e) {
      lastError = `${next.ticketId}: could not start claude — ${e.message}`;
      announce();
      return;
    }
    if (code !== 0) {
      lastError = `${next.ticketId}: claude exited ${code}${stderr ? ` — ${stderr.trim().split("\n")[0]}` : ""}`;
      announce();
      return;
    }

    // "backgrounded · cd15eb82" — a short id, matched by prefix against the session list. Read for
    // BOTH paths, resume included: `--bg --resume <id>` does not reliably continue under that id
    // (the CLI says as much — it "starts a copy and says so when the session is already running"),
    // and in practice a resume produced a new background job. Believing the id we asked for left
    // the ticket owned by a session that never did the work, and the queue watching the wrong one.
    const started = (await resolveSpawnedSession(out, repoRoot)) || (idle ? sessionId : null);
    if (!started) {
      lastError = `${next.ticketId}: started a background session but could not identify it`;
      announce();
      return;
    }

    // Claim only once there is a real session to claim it FOR. Claiming before the spawn would
    // stamp the ticket with an id that might never exist.
    let claimed = false;
    let claimProblem = null;
    try {
      const claim = await claimTicket(next.ticketId, started);
      claimed = Boolean(claim && claim.claimed !== false);
      if (!claimed) claimProblem = (claim && claim.reason) || "could not claim";
      else if (claim.ticket && claim.ticket.control && claim.ticket.control !== "run") {
        claimProblem = `${claim.ticket.control} was set while it was starting`;
      }
    } catch (e) {
      claimProblem = e.message;
    }

    if (claimProblem) {
      // An agent must not work a ticket this dispatch does not own — somebody else's session may
      // already be on it. A session WE just started is stopped again (its conversation survives,
      // `claude attach` still opens it); a session we resumed is somebody's existing worker, so the
      // turn cannot be taken back and the board says so instead of pretending it was.
      lastError = idle
        ? `${next.ticketId}: ${claimProblem} — a turn was already sent to ${started.slice(0, 8)}`
        : `${next.ticketId}: ${claimProblem} — the session started for it was stopped`;
      if (!idle) {
        await execFileP("claude", ["stop", started], { timeout: LIST_TIMEOUT_MS }).catch(() => {});
      }
      announce();
      return tick();
    }

    running = { ticketId: next.ticketId, sessionId: started, startedAt: new Date().toISOString() };
    announce();
    watchRunning();
  }

  /** The spawned session's id, matched from the CLI's own "backgrounded · <short id>" line against
   *  the session list. Falls back to the newest background session in this repo when the line is
   *  missing, since the alternative is losing track of a session that is already running. */
  async function resolveSpawnedSession(stdout, root) {
    const m = String(stdout).match(/backgrounded[^0-9a-f]*([0-9a-f]{8})/i);
    const sessions = await listSessions(root);
    if (m) {
      const hit = sessions.find((s) => s.sessionId.startsWith(m[1]));
      if (hit) return hit.sessionId;
    }
    const background = sessions.filter((s) => s.kind === "background");
    background.sort((a, b) => (b.startedAt || 0) - (a.startedAt || 0));
    return background[0] ? background[0].sessionId : null;
  }

  /** A backgrounded turn ends without any process of ours exiting, so completion is observed:
   *  poll until the session stops reporting busy (or disappears), then take the next ticket. */
  function watchRunning() {
    if (!running) return;
    setTimeout(async () => {
      if (!running) return;
      // A ticket worked in a terminal ends when the TICKET says so — the developer may keep the
      // session open for hours afterwards, and an interactive session that goes quiet between
      // messages is not a finished one. The agent is told to advance state as it goes, so a
      // terminal state on the ticket is the completion signal for both launch modes.
      const current = readTicket(running.ticketId);
      if (current && TERMINAL_TICKET_STATES.has(current.state)) {
        running = null;
        announce();
        if (autoContinue) tick().catch((e) => console.error("queue tick failed:", e.message));
        return;
      }

      const sessions = await listSessions(repoRoot);
      const live = sessions.find((s) => s.sessionId === running.sessionId);
      if (running.launch === "terminal") {
        // A freshly started interactive session never appears in `claude agents --json`, so that
        // listing cannot answer "is the window still open". The process can: the session id is on
        // its command line. Watching for it means closing the terminal clears the card, instead of
        // leaving it marked running forever.
        //
        // Only after a grace period — a window takes a moment to appear, and a check that fires
        // first would declare every dispatch dead on arrival.
        if (Date.now() - Date.parse(running.startedAt) < TERMINAL_GRACE_MS) return watchRunning();
        if (!(await processAlive(running.sessionId))) {
          lastError = `${running.ticketId}: its terminal was closed before the ticket finished — still claimed, pick it up again when you want`;
          running = null;
          announce();
          if (autoContinue) tick().catch((e) => console.error("queue tick failed:", e.message));
          return;
        }
        return watchRunning();
      }
      if (live && live.status === "busy") {
        if (running.needsInput) { running.needsInput = false; announce(); }
        return watchRunning();
      }
      // "waiting" is an agent that has stopped to ask something — the opposite of finished. Taking
      // the next ticket here would leave a half-done one silently parked behind a question nobody
      // knows was asked, so the queue holds and the board says who is waiting.
      if (live && live.status === "waiting") {
        if (!running.needsInput) { running.needsInput = true; announce(); }
        return watchRunning();
      }
      running = null;
      announce();
      // "Continue to the next one" is a choice: an unattended queue should drain itself, while a
      // developer working in a terminal usually wants to decide what they pick up next.
      if (autoContinue) tick().catch((e) => console.error("queue tick failed:", e.message));
    }, POLL_MS).unref?.();
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
    if (!running) return state();
    if (running.launch === "terminal") {
      // Never kill a terminal somebody is sitting in. Stop here means "the queue stops waiting on
      // this one" — the window, and whatever they are doing in it, is theirs.
      const id = running.ticketId;
      running = null;
      lastError = `${id}: stopped waiting — its terminal is still open and the ticket is still claimed`;
      announce();
      return state();
    }
    // The dispatched turn runs in a background session we no longer own a handle to, so it is
    // stopped the way the CLI stops one. Its conversation survives — `claude attach <id>` still
    // opens it — which is the difference between cancelling work and destroying it.
    const id = running.sessionId;
    running = null;
    announce();
    // `claude stop <id>`, not `claude agents stop` — agents takes no positional arguments.
    execFileP("claude", ["stop", id], { timeout: LIST_TIMEOUT_MS }).catch((e) => {
      lastError = `could not stop ${id.slice(0, 8)}: ${e.message}`;
      announce();
    });
    return state();
  }

  function setAutoContinue(value) {
    autoContinue = Boolean(value);
    announce();
    if (autoContinue && !running) tick().catch((e) => console.error("queue tick failed:", e.message));
    return state();
  }

  return { enqueue, cancel, stop, state, tick, startChat, setAutoContinue };
}
