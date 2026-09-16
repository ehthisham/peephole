import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as git from "./git.js";
import { scan } from "./scan.js";
import { repoStats } from "./repoStats.js";
import * as writer from "./writer.js";
import * as tokenUsage from "./tokens.js";
import { createQueue, listSessions } from "./execute.js";
import { detectCoverage } from "./coverage.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(__dirname, "..", "public");

function slugify(text, maxLen = 48) {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, maxLen).replace(/-+$/, "");
}

const CONTENT_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
};

/** Permission modes a dispatched session may run with. Chosen per dispatch in the UI rather than
 *  configured once: "let an agent edit files unattended" and "let it run any command unattended"
 *  are different decisions, and which one is appropriate depends on the ticket.
 *
 * `bypassPermissions` spawns an agent that may run ANY tool, unattended, in the watched repo — so
 * it is not reachable from the API by default. Picking it in the UI is a decision about your own
 * machine; accepting it from an unauthenticated HTTP request is a remote-code-execution hole, and
 * the two must not be the same switch. Opt in per server with PEEPHOLE_ALLOW_BYPASS=1. */
const BASE_PERMISSION_MODES = ["plan", "acceptEdits"];
const BYPASS_MODE = "bypassPermissions";
const BYPASS_REFUSED =
  "bypassPermissions is disabled on this server — restart it with PEEPHOLE_ALLOW_BYPASS=1 to allow " +
  "agents that may run any tool unattended";
const bypassAllowed = process.env.PEEPHOLE_ALLOW_BYPASS === "1";
const PERMISSION_MODES = bypassAllowed ? [...BASE_PERMISSION_MODES, BYPASS_MODE] : BASE_PERMISSION_MODES;

/** Requests that can reach a board can create tickets, push branches and (with bypass enabled)
 *  start agents, all unauthenticated — so the server listens on loopback unless told otherwise.
 *  It used to bind every interface, which put all of that on whatever network the laptop was on. */
const DEFAULT_HOST = "127.0.0.1";

/**
 * Which branch the ticket ledger lives on, in order of authority:
 *
 *   1. `--branch` on the command line — one run, one answer.
 *   2. `stateBranch` in the repo's own `.peephole/config.yaml` — committed, so every teammate
 *      resolves the same branch instead of each machine deciding for itself.
 *   3. the remote's default branch, as a last resort.
 *
 * (3) alone was the old behaviour and it silently pinned the ledger to whatever a host happened to
 * call default — here, a feature branch (`feat/versioning-v1-lineage`). When such a branch merges
 * and is deleted, the tickets leave the default line with it, and anyone whose `git remote show`
 * fails falls back to their own checked-out branch and quietly reads a different board.
 */
async function resolveStateBranch(repoRoot, remote, override) {
  const fallback = await git.defaultRemoteBranch(repoRoot, remote);
  if (override) return { branch: override, source: "--branch" };
  for (const ref of [`${remote}/${fallback}`, fallback]) {
    if (!(await git.refExists(repoRoot, ref))) continue;
    const declared = await git.declaredStateBranch(repoRoot, ref).catch(() => null);
    if (declared) return { branch: declared, source: ".peephole/config.yaml" };
    break;
  }
  return { branch: fallback, source: "remote default" };
}

export async function startServer(repoRoot, { port = 4173, remote = "origin", host = DEFAULT_HOST, branch = null } = {}) {
  const peepholeBin = path.join(__dirname, "..", "bin", "peephole.js");
  const resolved = await resolveStateBranch(repoRoot, remote, branch);
  const stateBranch = resolved.branch;
  const stateBranchSource = resolved.source;
  const remoteUrl = await git.remoteUrl(repoRoot, remote);
  const { worktreePath, localBranch } = await git.ensureWorktree(repoRoot, stateBranch, remote);
  // The identity a UI-created ticket's "created by" defaults to — this machine's configured git
  // identity, resolved through .mailmap so it matches the Members panel's naming.
  const rawGitUser = await git.gitUser(repoRoot);
  const gitUser = rawGitUser.name && rawGitUser.email
    ? await git.checkMailmap(repoRoot, rawGitUser.name, rawGitUser.email)
    : rawGitUser;

  let cache = { config: null, tickets: [], agents: [], issues: [], lastFetchedAt: null, unpushed: 0, coverage: null };
  let queueState = { pending: [], running: null, lastError: null };
  let lastCoverageStamp = null;
  // Dispatching a ticket claims it for the session that is about to work it, then re-reads, so the
  // board shows in-progress before the agent's first tool call rather than after it.
  const queue = createQueue({
    repoRoot,
    binPath: peepholeBin,
    port,
    claimTicket: async (ticketId, sessionId) => {
      const result = await writer.claimTicket(repoRoot, stateBranch, ticketId, sessionId, "peephole-queue", {
        sessionId, transcriptPath: null, tokens: null, author: gitUser && gitUser.name ? gitUser : null,
      });
      await refresh({ doFetch: false });
      return result;
    },
    onChange: (next) => {
      queueState = next;
      broadcast();
    },
  });
  let autoFetch = { enabled: false, intervalMinutes: 5 };
  let autoFetchTimer = null;
  const sseClients = new Set();
  // Last time each session's PreToolUse hook checked in (every call) — drives the honest
  // "Hook: connected" indicator. Separate from the git-heartbeat write throttle below.
  const sessionLastCheckin = new Map();
  // Last time each session's heartbeat was actually committed to git — only this one gates writes.
  const sessionLastHeartbeatWrite = new Map();
  const HEARTBEAT_WRITE_INTERVAL_MS = 60 * 1000;
  const HOOK_LIVE_WINDOW_MS = 10 * 60 * 1000;

  /** Joins each agent's token usage onto the Members list by (mailmap-resolved) author name —
   *  the piece that was missing: token tracking existed per SESSION, but a session has no
   *  visible link to a person until this. An agent with no `author` (an older heartbeat, or a
   *  machine with no global git identity set) simply contributes nothing here; it still shows
   *  in the Agents panel and the per-session "Tokens by session" list, just not per-member. */
  async function withMemberTokens(agents, contributorList) {
    if (!contributorList) return contributorList;
    const totals = new Map();
    for (const a of agents || []) {
      if (!a.author || !a.tokens || !a.tokens.totalTokens) continue;
      const resolved = await git.checkMailmap(repoRoot, a.author.name, a.author.email);
      totals.set(resolved.name, (totals.get(resolved.name) || 0) + a.tokens.totalTokens);
    }
    return contributorList.map((c) => ({ ...c, tokens: totals.get(c.name) || 0 }));
  }

  /** The git identity a session already reported through its heartbeat, so a CLI call that didn't
   *  pass --author still resolves to a person. Null when that session has never checked in. */
  function agentAuthor(sessionId) {
    const agent = (cache.agents || []).find((a) => a.sessionId === sessionId);
    return agent && agent.author ? agent.author : null;
  }

  /** Turns a ticket-write request body into the {sessionId, transcriptPath, tokens} a ticket file
   *  can carry — the durable link from a ticket back to the actual chat effort (transcript +
   *  tokens) that produced it, so "who/what session did this" doesn't require hunting the
   *  separate, overwritable agents/*.json heartbeat. Callers pass whichever id field the route
   *  already treats as the acting session (owner for claim, actor for state, etc). Null if
   *  nothing to link (no session id at all — e.g. a human clicking the UI). */
  async function sessionFromBody(body, sessionId) {
    if (!sessionId) return null;
    const tokens = body.transcriptPath ? await tokenUsage.sessionTokenUsage(body.transcriptPath).catch(() => null) : null;
    return {
      sessionId, transcriptPath: body.transcriptPath || null, tokens: tokens?.totalTokens ?? null,
      // Git identity of whoever is claiming — the same {name,email} the SessionStart hook reports.
      // It is what an `assignee` is matched against, and what the board shows instead of a UUID.
      author: body.author || (sessionId ? agentAuthor(sessionId) : null),
    };
  }

  function broadcast() {
    const payload = JSON.stringify({ type: "state", payload: publicState() });
    for (const res of sseClients) res.write(`data: ${payload}\n\n`);
  }

  function hookConfigured() {
    const now = Date.now();
    for (const last of sessionLastCheckin.values()) {
      if (now - last < HOOK_LIVE_WINDOW_MS) return true;
    }
    return false;
  }

  function publicState() {
    return {
      project: path.basename(repoRoot),
      remoteUrl,
      remote,
      stateBranch,
      stateBranchSource,
      gitUser,
      hookConfigured: hookConfigured(),
      autoFetch,
      queue: queueState,
      permissionModes: PERMISSION_MODES,
      ...cache,
    };
  }

  /** Cheap change-detector for the coverage profile: size + mtime, no parsing. Null when no
   *  profile exists, which is itself a change worth noticing (a deleted profile clears coverage). */
  async function coverageStamp(root) {
    try {
      const st = await fs.stat(path.join(root, "coverage.out"));
      return `${st.size}:${st.mtimeMs}`;
    } catch {
      return null;
    }
  }

  async function refresh({ doFetch }) {
    if (doFetch) {
      await git.fetch(repoRoot, remote);
      await git.syncWorktreeIfClean(worktreePath, localBranch, stateBranch, remote);
    }
    const [state, stats] = await Promise.all([
      scan(repoRoot, localBranch),
      repoStats(repoRoot, localBranch).catch((e) => {
        console.error("repoStats failed:", e.message);
        return null;
      }),
    ]);
    const unpushed = await git.unpushedCount(worktreePath, localBranch, stateBranch, remote).catch(() => 0);
    const enrichedStats = stats
      ? { ...stats, contributorList: await withMemberTokens(state.agents, stats.contributorList) }
      : stats;
    // Coverage is a live-filesystem check (a test-run artifact, not committed — see coverage.js),
    // so it is recomputed on a real fetch cycle OR whenever the profile itself has changed on
    // disk. Fetch-only was wrong: a test run rewrites coverage.out without touching git, so the
    // board kept reporting a figure from before the run — 56% while `go tool cover` said 80% —
    // and only a Pull latest would correct it.
    const coverageChanged = await coverageStamp(repoRoot).then((stamp) => {
      if (stamp === lastCoverageStamp) return false;
      lastCoverageStamp = stamp;
      return true;
    });
    const coverage = doFetch || coverageChanged || cache.coverage == null
      ? await detectCoverage(repoRoot).catch((e) => {
          console.error("coverage detection failed:", e.message);
          return cache.coverage ?? null;
        })
      : cache.coverage ?? null;
    cache = { ...state, stats: enrichedStats, coverage, lastFetchedAt: new Date().toISOString(), unpushed };
    broadcast();
    return cache;
  }

  function setAutoFetch(enabled, intervalMinutes) {
    autoFetch = { enabled, intervalMinutes: Math.max(1, Number(intervalMinutes) || 5) };
    if (autoFetchTimer) clearInterval(autoFetchTimer);
    autoFetchTimer = null;
    if (autoFetch.enabled) {
      autoFetchTimer = setInterval(() => {
        refresh({ doFetch: true }).catch((e) => console.error("auto-fetch failed:", e.message));
      }, autoFetch.intervalMinutes * 60 * 1000);
      if (autoFetchTimer.unref) autoFetchTimer.unref();
    }
    broadcast();
  }

  async function readJsonBody(req) {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    if (chunks.length === 0) return {};
    try {
      return JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } catch {
      return {};
    }
  }

  function sendJson(res, code, obj) {
    const body = JSON.stringify(obj);
    res.writeHead(code, { "Content-Type": "application/json; charset=utf-8", "Content-Length": Buffer.byteLength(body) });
    res.end(body);
  }

  async function serveStatic(res, filePath) {
    try {
      const ext = path.extname(filePath);
      const data = await fs.readFile(filePath);
      res.writeHead(200, { "Content-Type": CONTENT_TYPES[ext] || "application/octet-stream" });
      res.end(data);
    } catch {
      res.writeHead(404);
      res.end("not found");
    }
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://localhost:${port}`);

    try {
      if (req.method === "GET" && url.pathname === "/") {
        return serveStatic(res, path.join(publicDir, "index.html"));
      }
      if (req.method === "GET" && url.pathname === "/app.js") {
        return serveStatic(res, path.join(publicDir, "app.js"));
      }
      if (req.method === "GET" && url.pathname === "/api/state") {
        return sendJson(res, 200, publicState());
      }
      if (req.method === "GET" && url.pathname === "/api/standards") {
        const content = await git.showFile(repoRoot, localBranch, "ENGINEERING-STANDARDS-GO.md");
        return sendJson(res, 200, { content });
      }
      if (req.method === "GET" && url.pathname === "/api/events") {
        res.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
        });
        res.write(`data: ${JSON.stringify({ type: "state", payload: publicState() })}\n\n`);
        sseClients.add(res);
        const ping = setInterval(() => res.write(": ping\n\n"), 20000);
        req.on("close", () => {
          clearInterval(ping);
          sseClients.delete(res);
        });
        return;
      }
      if (req.method === "POST" && url.pathname === "/api/pull") {
        await refresh({ doFetch: true });
        return sendJson(res, 200, publicState());
      }
      if (req.method === "POST" && url.pathname === "/api/autofetch") {
        const body = await readJsonBody(req);
        setAutoFetch(Boolean(body.enabled), body.intervalMinutes);
        return sendJson(res, 200, publicState());
      }
      if (req.method === "POST" && url.pathname === "/api/scaffold") {
        const binPath = peepholeBin;
        const result = await writer.scaffold(repoRoot, stateBranch, {
          projectName: path.basename(repoRoot),
          remoteUrl,
          issues: cache.issues,
          peepholeCmd: `node ${binPath} serve --repo ${repoRoot}`,
          peepholeBin: binPath,
          port,
        });
        await refresh({ doFetch: false });
        return sendJson(res, 200, { ...result, state: publicState() });
      }
      if (req.method === "POST" && url.pathname === "/api/push") {
        await writer.push(repoRoot, stateBranch);
        await refresh({ doFetch: true });
        return sendJson(res, 200, { pushed: true, state: publicState() });
      }
      const controlMatch = url.pathname.match(/^\/api\/tickets\/([^/]+)\/control$/);
      if (req.method === "POST" && controlMatch) {
        const body = await readJsonBody(req);
        const result = await writer.setControl(
          repoRoot, stateBranch, controlMatch[1], body.control,
          body.actor || (gitUser && gitUser.name) || "peephole-ui", body.note,
        );
        // Dropping the selection is not enough on its own: a ticket already sitting in the queue
        // would still be dispatched when a worker frees up.
        if (body.control !== "run") queueState = queue.cancel(controlMatch[1]);
        await refresh({ doFetch: false });
        return sendJson(res, 200, { ...result, state: publicState() });
      }
      if (req.method === "POST" && url.pathname === "/api/tickets") {
        const body = await readJsonBody(req);
        const id = body.id || slugify(body.intent || "ticket");
        const session = await sessionFromBody(body, body.owner || body.createdBy || body.actor);
        const result = await writer.createTicket(repoRoot, stateBranch, { ...body, id, session });
        await refresh({ doFetch: false });
        return sendJson(res, 200, { ...result, state: publicState() });
      }
      const claimMatch = url.pathname.match(/^\/api\/tickets\/([^/]+)\/claim$/);
      if (req.method === "POST" && claimMatch) {
        const body = await readJsonBody(req);
        const session = await sessionFromBody(body, body.owner);
        const result = await writer.claimTicket(repoRoot, stateBranch, claimMatch[1], body.owner, body.actor, session);
        await refresh({ doFetch: false });
        return sendJson(res, 200, { ...result, state: publicState() });
      }
      const unclaimMatch = url.pathname.match(/^\/api\/tickets\/([^/]+)\/unclaim$/);
      if (req.method === "POST" && unclaimMatch) {
        const body = await readJsonBody(req);
        const result = await writer.unclaimTicket(repoRoot, stateBranch, unclaimMatch[1], body.actor);
        await refresh({ doFetch: false });
        return sendJson(res, 200, { ...result, state: publicState() });
      }
      const riskMatch = url.pathname.match(/^\/api\/tickets\/([^/]+)\/risk$/);
      if (req.method === "POST" && riskMatch) {
        const body = await readJsonBody(req);
        const result = await writer.setRisk(
          repoRoot, stateBranch, riskMatch[1], body.risk,
          body.actor || (gitUser && gitUser.name) || "peephole-ui",
        );
        await refresh({ doFetch: false });
        return sendJson(res, 200, { ...result, state: publicState() });
      }
      const commentMatch = url.pathname.match(/^\/api\/tickets\/([^/]+)\/comments$/);
      if (req.method === "POST" && commentMatch) {
        const body = await readJsonBody(req);
        // Authorship defaults to this machine's git identity, so a comment is attributable without
        // the UI having to ask who is typing.
        const author = body.author || (gitUser && gitUser.name) || "peephole-ui";
        const result = await writer.addComment(repoRoot, stateBranch, commentMatch[1], body.text, author);
        await refresh({ doFetch: false });
        return sendJson(res, 200, { ...result, state: publicState() });
      }
      const selectMatch = url.pathname.match(/^\/api\/tickets\/([^/]+)\/selected$/);
      if (req.method === "POST" && selectMatch) {
        const body = await readJsonBody(req);
        const result = await writer.setSelected(repoRoot, stateBranch, selectMatch[1], body.selected, body.actor);
        await refresh({ doFetch: false });
        return sendJson(res, 200, { ...result, state: publicState() });
      }
      const executeMatch = url.pathname.match(/^\/api\/tickets\/([^/]+)\/execute$/);
      if (req.method === "POST" && executeMatch) {
        const body = await readJsonBody(req);
        if (body.permissionMode === BYPASS_MODE && !bypassAllowed) return sendJson(res, 403, { error: BYPASS_REFUSED });
        const mode = PERMISSION_MODES.includes(body.permissionMode) ? body.permissionMode : "acceptEdits";
        queueState = queue.enqueue(executeMatch[1], mode);
        return sendJson(res, 200, { queued: true, queue: queueState, state: publicState() });
      }
      if (req.method === "POST" && url.pathname === "/api/execute") {
        const body = await readJsonBody(req);
        if (body.permissionMode === BYPASS_MODE && !bypassAllowed) return sendJson(res, 403, { error: BYPASS_REFUSED });
        const mode = PERMISSION_MODES.includes(body.permissionMode) ? body.permissionMode : "acceptEdits";
        // Lane order, not click order: "run the selected ones" means the order they are read in.
        const ids = Array.isArray(body.ticketIds) ? body.ticketIds : [];
        ids.forEach((id) => { queueState = queue.enqueue(String(id), mode); });
        return sendJson(res, 200, { queued: ids.length, queue: queueState, state: publicState() });
      }
      const dequeueMatch = url.pathname.match(/^\/api\/tickets\/([^/]+)\/dequeue$/);
      if (req.method === "POST" && dequeueMatch) {
        queueState = queue.cancel(dequeueMatch[1]);
        return sendJson(res, 200, { queue: queueState, state: publicState() });
      }
      if (req.method === "POST" && url.pathname === "/api/execute/stop") {
        queueState = queue.stop();
        return sendJson(res, 200, { queue: queueState, state: publicState() });
      }
      if (req.method === "GET" && url.pathname === "/api/sessions") {
        return sendJson(res, 200, { sessions: await listSessions(repoRoot) });
      }
      const epicMatch = url.pathname.match(/^\/api\/tickets\/([^/]+)\/epic$/);
      if (req.method === "POST" && epicMatch) {
        const body = await readJsonBody(req);
        const result = await writer.setEpic(repoRoot, stateBranch, epicMatch[1], body.epic ?? null, body.actor);
        await refresh({ doFetch: false });
        return sendJson(res, 200, { ...result, state: publicState() });
      }
      const assignMatch = url.pathname.match(/^\/api\/tickets\/([^/]+)\/assign$/);
      if (req.method === "POST" && assignMatch) {
        const body = await readJsonBody(req);
        const result = await writer.assignTicket(repoRoot, stateBranch, assignMatch[1], body.assignee ?? null, body.actor);
        await refresh({ doFetch: false });
        return sendJson(res, 200, { ...result, state: publicState() });
      }
      const stateMatch = url.pathname.match(/^\/api\/tickets\/([^/]+)\/state$/);
      if (req.method === "POST" && stateMatch) {
        const body = await readJsonBody(req);
        const session = await sessionFromBody(body, body.sessionId || body.actor);
        const result = await writer.setState(repoRoot, stateBranch, stateMatch[1], body.state, body.actor, session);
        await refresh({ doFetch: false });
        return sendJson(res, 200, { ...result, state: publicState() });
      }
      const renameMatch = url.pathname.match(/^\/api\/tickets\/([^/]+)\/rename$/);
      if (req.method === "POST" && renameMatch) {
        const body = await readJsonBody(req);
        const result = await writer.renameTicket(repoRoot, stateBranch, renameMatch[1], body.newId, body.actor, body.tags);
        await refresh({ doFetch: false });
        return sendJson(res, 200, { ...result, state: publicState() });
      }
      const getTicketMatch = url.pathname.match(/^\/api\/tickets\/([^/]+)$/);
      if (req.method === "GET" && getTicketMatch) {
        const t = (cache.tickets || []).find((x) => x.id === getTicketMatch[1]);
        if (!t) {
          res.writeHead(404);
          return res.end("not found");
        }
        return sendJson(res, 200, t);
      }
      const heartbeatMatch = url.pathname.match(/^\/api\/agents\/([^/]+)\/heartbeat$/);
      if (req.method === "POST" && heartbeatMatch) {
        const body = await readJsonBody(req);
        const tokens = await tokenUsage.sessionTokenUsage(body.transcriptPath).catch(() => null);
        const result = await writer.writeHeartbeat(repoRoot, stateBranch, {
          sessionId: heartbeatMatch[1], host: body.host, activeTicket: body.activeTicket, status: body.status,
          tokens, author: body.author,
        });
        await refresh({ doFetch: false });
        return sendJson(res, 200, { ...result, state: publicState() });
      }
      // The hook's one hot-path call: cheap (in-memory) gate check on every tool call, with an
      // actual git-committed heartbeat throttled to once a minute so PreToolUse stays fast.
      const checkinMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/checkin$/);
      if (req.method === "POST" && checkinMatch) {
        const sessionId = checkinMatch[1];
        const body = await readJsonBody(req);
        const now = Date.now();
        const owned = (cache.tickets || []).filter((t) => t.owner === sessionId);
        const blockedTicket = owned.find((t) => t.control && t.control !== "run");

        sessionLastCheckin.set(sessionId, now);
        const lastWrite = sessionLastHeartbeatWrite.get(sessionId) || 0;
        if (now - lastWrite > HEARTBEAT_WRITE_INTERVAL_MS) {
          sessionLastHeartbeatWrite.set(sessionId, now);
          try {
            // Transcript parsing only happens on this throttled (≤once/min) path, never on the
            // hot per-tool-call check above it — a growing transcript must stay cheap to re-read.
            const tokens = await tokenUsage.sessionTokenUsage(body.transcriptPath).catch(() => null);
            await writer.writeHeartbeat(repoRoot, stateBranch, {
              sessionId,
              host: body.host,
              activeTicket: owned[0]?.id ?? null,
              status: blockedTicket ? blockedTicket.control : "working",
              tokens,
            });
            // The same running total, written onto the ticket this session owns, so per-ticket
            // cost reflects the work as it happens instead of the gap between two ticket writes.
            // One owned ticket at a time is the model (ownership is exclusive); if a session
            // somehow owns several, only the first is charged rather than charging each of them
            // the same tokens.
            if (owned[0]) {
              await writer.touchTicketSession(repoRoot, stateBranch, owned[0].id, {
                sessionId, transcriptPath: body.transcriptPath, tokens: tokens?.totalTokens ?? null,
                author: agentAuthor(sessionId),
              });
            }
            await refresh({ doFetch: false });
          } catch (e) {
            console.error("heartbeat write failed:", e.message);
          }
        }

        return sendJson(res, 200, {
          blocked: Boolean(blockedTicket),
          reason: blockedTicket
            ? `Ticket "${blockedTicket.id}" is ${blockedTicket.control}: ${blockedTicket.intent}`
            : null,
        });
      }

      res.writeHead(404);
      res.end("not found");
    } catch (e) {
      console.error(e);
      sendJson(res, 500, { error: e.message });
    }
  });

  await refresh({ doFetch: true });

  await new Promise((resolve) => server.listen(port, host, resolve));
  return { server, port, stateBranch, stateBranchSource, remoteUrl, worktreePath };
}
