import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as git from "./git.js";
import { scan } from "./scan.js";
import { repoStats } from "./repoStats.js";
import * as writer from "./writer.js";
import * as tokenUsage from "./tokens.js";
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

export async function startServer(repoRoot, { port = 4173, remote = "origin" } = {}) {
  const stateBranch = await git.defaultRemoteBranch(repoRoot, remote);
  const remoteUrl = await git.remoteUrl(repoRoot, remote);
  const { worktreePath, localBranch } = await git.ensureWorktree(repoRoot, stateBranch, remote);

  let cache = { config: null, tickets: [], agents: [], issues: [], lastFetchedAt: null, unpushed: 0, coverage: null };
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
      hookConfigured: hookConfigured(),
      autoFetch,
      ...cache,
    };
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
    // Coverage is a live-filesystem check (a test-run artifact, not committed — see
    // coverage.js), and `go tool cover` shells out, so it's only recomputed on a real
    // fetch cycle (Pull latest / auto-fetch), never on the heartbeat/ticket-write refreshes
    // that fire as often as once a minute per session — those just carry the last value forward.
    const coverage = doFetch
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
        const binPath = path.join(__dirname, "..", "bin", "peephole.js");
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
        const result = await writer.setControl(repoRoot, stateBranch, controlMatch[1], body.control);
        await refresh({ doFetch: false });
        return sendJson(res, 200, { ...result, state: publicState() });
      }
      if (req.method === "POST" && url.pathname === "/api/tickets") {
        const body = await readJsonBody(req);
        const id = body.id || slugify(body.intent || "ticket");
        const result = await writer.createTicket(repoRoot, stateBranch, { ...body, id });
        await refresh({ doFetch: false });
        return sendJson(res, 200, { ...result, state: publicState() });
      }
      const claimMatch = url.pathname.match(/^\/api\/tickets\/([^/]+)\/claim$/);
      if (req.method === "POST" && claimMatch) {
        const body = await readJsonBody(req);
        const result = await writer.claimTicket(repoRoot, stateBranch, claimMatch[1], body.owner, body.actor);
        await refresh({ doFetch: false });
        return sendJson(res, 200, { ...result, state: publicState() });
      }
      const stateMatch = url.pathname.match(/^\/api\/tickets\/([^/]+)\/state$/);
      if (req.method === "POST" && stateMatch) {
        const body = await readJsonBody(req);
        const result = await writer.setState(repoRoot, stateBranch, stateMatch[1], body.state, body.actor);
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

  await new Promise((resolve) => server.listen(port, resolve));
  return { server, port, stateBranch, remoteUrl, worktreePath };
}
