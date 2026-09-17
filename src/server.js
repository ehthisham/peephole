import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as git from "./git.js";
import { scan } from "./scan.js";
import { repoStats } from "./repoStats.js";
import * as writer from "./writer.js";
import * as tokenUsage from "./tokens.js";
import { createQueue, listSessions, attachInTerminal, safeSessionId, promptFor, stopSession } from "./execute.js";
import { DEFAULT_STATE_BRANCH } from "./schema.js";
import { resolveLedger } from "./ledger.js";
import { listProjects, rememberProject, forgetProject, validateRepo } from "./projects.js";
import { detectCoverage } from "./coverage.js";
import { ownershipMap } from "./ownership.js";

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
  // `peephole/<default>` first: that is this machine's own ledger branch, which is always at or
  // ahead of the remote, so a migration (or any config change) takes effect here immediately and
  // reaches teammates when it is pushed — rather than a local move appearing to do nothing.
  for (const ref of [`peephole/${fallback}`, `${remote}/${fallback}`, fallback]) {
    if (!(await git.refExists(repoRoot, ref))) continue;
    const declared = await git.declaredStateBranch(repoRoot, ref).catch(() => null);
    if (declared) return { branch: declared, source: ".peephole/config.yaml" };
    break;
  }
  // An existing ledger branch on the remote is the team's answer even before anyone's config
  // declares it — joining a repo must never start a second ledger beside the one in use.
  if (await git.refExists(repoRoot, `${remote}/${DEFAULT_STATE_BRANCH}`)) {
    return { branch: DEFAULT_STATE_BRANCH, source: "existing " + DEFAULT_STATE_BRANCH + " branch" };
  }
  // Nothing declared and nothing to join: a fresh setup gets the dedicated branch, created on
  // first write and shared on first push, instead of writing tickets onto a code branch.
  return { branch: DEFAULT_STATE_BRANCH, source: "new " + DEFAULT_STATE_BRANCH + " branch" };
}

export async function startServer(initialRepoRoot, { port = 4173, remote = "origin", host = DEFAULT_HOST, branch = null } = {}) {
  const peepholeBin = path.join(__dirname, "..", "bin", "peephole.js");
  // Everything about "which project is open" is mutable: one server serves whichever repo is
  // selected, rather than one server per repo on a port the user has to remember. The queue and
  // the request handlers close over these bindings, so a switch re-points them all at once.
  /**
   * One project's world: its ledger, cache, queue, autosync timer and SSE subscribers. Each open
   * project gets its own, so two browser tabs can watch two repos at once — previously the server
   * held exactly one set of these and "switching" mutated it under everyone, meaning a second tab
   * silently repointed the first.
   */
  const projects = new Map();

  async function createProject(initialRoot, { branch: branchArg = null } = {}) {
    let repoRoot = initialRoot;
    let branchOverride = branchArg;
    let stateBranch;
    let stateBranchSource;
    let remoteUrl;
    let ledger;
    let worktreePath;
    let localBranch;
    let gitUser;

    async function openProject(nextRepoRoot) {
      repoRoot = nextRepoRoot;
      const resolved = await resolveStateBranch(repoRoot, remote, branchOverride);
      stateBranch = resolved.branch;
      stateBranchSource = resolved.source;
      remoteUrl = await git.remoteUrl(repoRoot, remote);
      // The ledger may live outside the repo (a sparse clone) or inside it (the worktree fallback);
      // everything below reads and writes through whichever was resolved.
      ledger = await resolveLedger(repoRoot, stateBranch, { remote, fetch: true });
      worktreePath = ledger.path;
      localBranch = ledger.localBranch;
      // The identity a UI-created ticket's "created by" defaults to — this machine's configured git
      // identity, resolved through .mailmap so it matches the Members panel's naming.
      const rawGitUser = await git.gitUser(repoRoot);
      gitUser = rawGitUser.name && rawGitUser.email
        ? await git.checkMailmap(repoRoot, rawGitUser.name, rawGitUser.email)
        : rawGitUser;
      await rememberProject(repoRoot, { remoteUrl, stateBranch });
    }

    await openProject(initialRepoRoot);

    let cache = { config: null, tickets: [], agents: [], issues: [], lastFetchedAt: null, unpushed: 0, coverage: null };
    let queueState = { pending: [], running: null, lastError: null };
    let lastCoverageStamp = null;
    // The ownership map shells out to `git log` over a year of history — 2.3s on a real repo — so
    // it is recomputed only when the checkout's HEAD actually moves, never per request.
    let ownership = null;
    let ownershipSha = null;
    // publicState() is synchronous, so the menu is refreshed alongside every state refresh rather
    // than read from disk on each request.
    let knownProjects = [];
    // Dispatching a ticket claims it for the session that is about to work it, then re-reads, so the
    // board shows in-progress before the agent's first tool call rather than after it.
    const queue = createQueue({
      repoRoot,
      binPath: peepholeBin,
      port,
      // Reading the ticket the board already has avoids a git round trip just to check whether a
      // dispatch is still appropriate.
      readTicket: (ticketId) => (cache.tickets || []).find((t) => t.id === ticketId) || null,
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
    let autoFetch = { enabled: false, intervalMinutes: 5, push: false, lastPushAt: null, lastPushError: null };
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
        // The project's own name, as its committed config declares it — NOT the directory name. The
        // board filters tickets by project, and a checkout whose folder is named differently from the
        // project (a clone into `work/`, a second checkout) had every ticket filtered out as
        // belonging to "another project", leaving an empty board and no hint why.
        project: (cache.config && cache.config.project) || path.basename(repoRoot),
        remoteUrl,
        remote,
        stateBranch,
        stateBranchSource,
        checkoutBranch: cache.checkoutBranch ?? null,
        hooksInstalled: cache.hooksInstalled ?? false,
      ownership,
        ledger: { kind: ledger.kind, path: ledger.path, reason: ledger.reason },
        projects: knownProjects,
        stateBranchOnRemote: cache.stateBranchOnRemote ?? true,
        repoRoot,
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
        // Re-resolve rather than assume: pushing a ledger branch for the first time is exactly when
        // the clone becomes possible, and nobody should have to restart the board to get it.
        ledger = await resolveLedger(repoRoot, stateBranch, { remote });
        worktreePath = ledger.path;
        localBranch = ledger.localBranch;
      }
      const [state, stats] = await Promise.all([
        // Tickets come from the ledger branch — that is the shared record.
        scan(ledger.kind === "clone" ? ledger.path : repoRoot, localBranch, { repoRoot }),
        // Code stats come from the developer's own checkout (HEAD), not the ledger. They describe
        // the code someone is actually working on: lines, languages, commits, contributors, last
        // commit. Reading them at the ledger branch was tolerable only while that branch WAS the
        // code branch; on a dedicated ledger branch they would describe a snapshot taken when the
        // branch was created and drift further from the work with every commit.
        repoStats(repoRoot, "HEAD").catch((e) => {
          console.error("repoStats failed:", e.message);
          return null;
        }),
      ]);
      const unpushed = await git.unpushedCount(worktreePath, localBranch, stateBranch, remote).catch(() => 0);
      // The developer's own checkout — NOT where the tickets live. Coverage is read from this
      // working tree, so the figure on the board is whatever this person's branch last produced;
      // two teammates on different branches see the same tickets and different coverage.
      const checkoutBranch = await git.currentBranch(repoRoot).catch(() => null);
    const sha = await git.headSha(repoRoot).catch(() => null);
    if (sha && sha !== ownershipSha) {
      const next = await ownershipMap(repoRoot).catch((e) => {
        console.error("ownership map failed:", e.message);
        return null;
      });
      if (next) { ownership = next; ownershipSha = sha; }
    }
      const stateBranchOnRemote = await git.remoteBranchExists(repoRoot, stateBranch, remote).catch(() => true);
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
      knownProjects = await listProjects().catch(() => knownProjects);
    if (doFetch) queue.refreshWorkers().catch(() => {});
      cache = { ...state, stats: enrichedStats, coverage, checkoutBranch, stateBranchOnRemote, lastFetchedAt: new Date().toISOString(), unpushed };
      broadcast();
      return cache;
    }

    /**
     * Pushes the waiting ledger commits, but only after proving they ARE ledger commits: every path
     * in the pending range must sit under `.peephole/`. The state branch can be an ordinary code
     * branch (that is still the default for repos set up before the dedicated branch existed), and
     * an unattended push of somebody's code — or of a commit that rode along on that branch — is not
     * something a toggle should be able to do.
     */
    async function autoPush() {
      const pending = await git.unpushedCount(worktreePath, localBranch, stateBranch, remote).catch(() => 0);
      if (pending === 0) return;
      const paths = await git.pendingPaths(worktreePath, localBranch, stateBranch, remote).catch(() => null);
      const foreign = (paths || []).filter((f) => !f.startsWith(".peephole/"));
      if (paths === null || foreign.length) {
        autoFetch.lastPushError = foreign.length
          ? `not pushed — ${foreign.length} non-ledger file(s) waiting, e.g. ${foreign[0]}`
          : "not pushed — could not read what is waiting";
        return;
      }
      await writer.push(repoRoot, stateBranch);
      autoFetch.lastPushAt = new Date().toISOString();
      autoFetch.lastPushError = null;
    }

    async function syncTick() {
      try {
        if (autoFetch.push) await autoPush();
      } catch (e) {
        autoFetch.lastPushError = e.message;
        console.error("auto-push failed:", e.message);
      }
      // Fetch after pushing, so the refresh that follows sees the branch as it now stands and the
      // unpushed banner clears in the same tick rather than one interval later.
      await refresh({ doFetch: true }).catch((e) => console.error("auto-fetch failed:", e.message));
    }

    function setAutoFetch(enabled, intervalMinutes, push) {
      autoFetch = {
        ...autoFetch,
        enabled,
        intervalMinutes: Math.max(1, Number(intervalMinutes) || 5),
        push: push === undefined ? autoFetch.push : Boolean(push),
      };
      if (autoFetchTimer) clearInterval(autoFetchTimer);
      autoFetchTimer = null;
      if (autoFetch.enabled) {
        autoFetchTimer = setInterval(() => {
          syncTick().catch((e) => console.error("autosync failed:", e.message));
        }, autoFetch.intervalMinutes * 60 * 1000);
        if (autoFetchTimer.unref) autoFetchTimer.unref();
        // Run once immediately: a toggle that does nothing for five minutes reads as broken.
        syncTick().catch((e) => console.error("autosync failed:", e.message));
      }
      broadcast();
    }


    await openProject(initialRoot);
    await refresh({ doFetch: false }).catch((e) => console.error("initial refresh failed:", e.message));

    return {
      get repoRoot() { return repoRoot; },
      get stateBranch() { return stateBranch; },
      get worktreePath() { return worktreePath; },
      get localBranch() { return localBranch; },
      get ledger() { return ledger; },
      get gitUser() { return gitUser; },
      get remoteUrl() { return remoteUrl; },
      get cache() { return cache; },
      get queueState() { return queueState; },
      set queueState(v) { queueState = v; },
      queue,
      sseClients,
      sessionLastCheckin,
      sessionLastHeartbeatWrite,
      HEARTBEAT_WRITE_INTERVAL_MS,
      publicState,
      refresh,
      setAutoFetch,
      sessionFromBody,
      agentAuthor,
      peepholeBin,
    };
  }

  const repoRootOf = (ctx) => ctx.repoRoot;
  const stateBranchOf = (ctx) => ctx.stateBranch;

  /** The project a request is about: `?project=<repoRoot>`, else the one the server was started on.
   *  Contexts are built once and kept, so switching back to a project is instant and its queue and
   *  autosync setting survive the trip. */
  async function contextFor(url) {
    const asked = url.searchParams.get("project");
    const root = asked ? path.resolve(asked) : initialRepoRoot;
    if (!projects.has(root)) {
      const check = await validateRepo(root);
      if (!check.ok) throw Object.assign(new Error(check.error), { statusCode: 400 });
      projects.set(root, await createProject(check.repoRoot, { branch: root === initialRepoRoot ? branch : null }));
    }
    return projects.get(root);
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
      // Static assets are project-independent; resolving a context for them would build a project
      // just to serve app.js.
      if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/app.js")) {
        return serveStatic(res, path.join(publicDir, url.pathname === "/" ? "index.html" : "app.js"));
      }
      const ctx = await contextFor(url);
      if (req.method === "GET" && url.pathname === "/api/state") {
        return sendJson(res, 200, ctx.publicState());
      }
      if (req.method === "GET" && url.pathname === "/api/standards") {
        const content = await git.showFile(ctx.repoRoot, ctx.localBranch, "ENGINEERING-STANDARDS-GO.md");
        return sendJson(res, 200, { content });
      }
      if (req.method === "GET" && url.pathname === "/api/events") {
        res.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
        });
        res.write(`data: ${JSON.stringify({ type: "state", payload: ctx.publicState() })}\n\n`);
        ctx.sseClients.add(res);
        const ping = setInterval(() => res.write(": ping\n\n"), 20000);
        req.on("close", () => {
          clearInterval(ping);
          ctx.sseClients.delete(res);
        });
        return;
      }
      if (req.method === "POST" && url.pathname === "/api/pull") {
        await ctx.refresh({ doFetch: true });
        return sendJson(res, 200, ctx.publicState());
      }
      if (req.method === "POST" && (url.pathname === "/api/autofetch" || url.pathname === "/api/autosync")) {
        const body = await readJsonBody(req);
        // /api/autosync sets both halves; /api/autofetch stays for anything still calling it and
        // leaves the push setting alone.
        const push = url.pathname === "/api/autosync" ? body.push !== false : undefined;
        ctx.setAutoFetch(Boolean(body.enabled), body.intervalMinutes, push);
        return sendJson(res, 200, ctx.publicState());
      }
      if (req.method === "POST" && url.pathname === "/api/scaffold") {
        const binPath = ctx.peepholeBin;
        const result = await writer.scaffold(ctx.repoRoot, ctx.stateBranch, {
          projectName: path.basename(ctx.repoRoot),
          remoteUrl: ctx.publicState().remoteUrl,
          issues: ctx.cache.issues,
          peepholeCmd: `peephole serve --repo . --port ${port}`,
          peepholeBin: binPath,
          port,
        });
        await ctx.refresh({ doFetch: false });
        return sendJson(res, 200, { ...result, state: ctx.publicState() });
      }
      if (req.method === "POST" && url.pathname === "/api/push") {
        await writer.push(ctx.repoRoot, ctx.stateBranch);
        await ctx.refresh({ doFetch: true });
        return sendJson(res, 200, { pushed: true, state: ctx.publicState() });
      }
      const controlMatch = url.pathname.match(/^\/api\/tickets\/([^/]+)\/control$/);
      if (req.method === "POST" && controlMatch) {
        const body = await readJsonBody(req);
        const result = await writer.setControl(
          ctx.repoRoot, ctx.stateBranch, controlMatch[1], body.control,
          body.actor || (ctx.gitUser && ctx.gitUser.name) || "peephole-ui", body.note,
        );
        // Dropping the selection is not enough on its own: a ticket already sitting in the ctx.queue
        // would still be dispatched when a worker frees up.
        if (body.control !== "run") ctx.queueState = ctx.queue.cancel(controlMatch[1]);
        await ctx.refresh({ doFetch: false });
        return sendJson(res, 200, { ...result, state: ctx.publicState() });
      }
      if (req.method === "POST" && url.pathname === "/api/tickets") {
        const body = await readJsonBody(req);
        const id = body.id || slugify(body.intent || "ticket");
        const session = await ctx.sessionFromBody(body, body.owner || body.createdBy || body.actor);
        const result = await writer.createTicket(ctx.repoRoot, ctx.stateBranch, { ...body, id, session });
        await ctx.refresh({ doFetch: false });
        return sendJson(res, 200, { ...result, state: ctx.publicState() });
      }
      const claimMatch = url.pathname.match(/^\/api\/tickets\/([^/]+)\/claim$/);
      if (req.method === "POST" && claimMatch) {
        const body = await readJsonBody(req);
        const session = await ctx.sessionFromBody(body, body.owner);
        const result = await writer.claimTicket(ctx.repoRoot, ctx.stateBranch, claimMatch[1], body.owner, body.actor, session);
        await ctx.refresh({ doFetch: false });
        return sendJson(res, 200, { ...result, state: ctx.publicState() });
      }
      const unclaimMatch = url.pathname.match(/^\/api\/tickets\/([^/]+)\/unclaim$/);
      if (req.method === "POST" && unclaimMatch) {
        const body = await readJsonBody(req);
        const result = await writer.unclaimTicket(ctx.repoRoot, ctx.stateBranch, unclaimMatch[1], body.actor);
        await ctx.refresh({ doFetch: false });
        return sendJson(res, 200, { ...result, state: ctx.publicState() });
      }
      const riskMatch = url.pathname.match(/^\/api\/tickets\/([^/]+)\/risk$/);
      if (req.method === "POST" && riskMatch) {
        const body = await readJsonBody(req);
        const result = await writer.setRisk(
          ctx.repoRoot, ctx.stateBranch, riskMatch[1], body.risk,
          body.actor || (ctx.gitUser && ctx.gitUser.name) || "peephole-ui",
        );
        await ctx.refresh({ doFetch: false });
        return sendJson(res, 200, { ...result, state: ctx.publicState() });
      }
      const commentMatch = url.pathname.match(/^\/api\/tickets\/([^/]+)\/comments$/);
      if (req.method === "POST" && commentMatch) {
        const body = await readJsonBody(req);
        // Authorship defaults to this machine's git identity, so a comment is attributable without
        // the UI having to ask who is typing.
        const author = body.author || (ctx.gitUser && ctx.gitUser.name) || "peephole-ui";
        const result = await writer.addComment(ctx.repoRoot, ctx.stateBranch, commentMatch[1], body.text, author);
        await ctx.refresh({ doFetch: false });
        return sendJson(res, 200, { ...result, state: ctx.publicState() });
      }
      const selectMatch = url.pathname.match(/^\/api\/tickets\/([^/]+)\/selected$/);
      if (req.method === "POST" && selectMatch) {
        const body = await readJsonBody(req);
        const result = await writer.setSelected(ctx.repoRoot, ctx.stateBranch, selectMatch[1], body.selected, body.actor);
        await ctx.refresh({ doFetch: false });
        return sendJson(res, 200, { ...result, state: ctx.publicState() });
      }
      const executeMatch = url.pathname.match(/^\/api\/tickets\/([^/]+)\/execute$/);
      if (req.method === "POST" && executeMatch) {
        const body = await readJsonBody(req);
        if (body.permissionMode === BYPASS_MODE && !bypassAllowed) return sendJson(res, 403, { error: BYPASS_REFUSED });
        const mode = PERMISSION_MODES.includes(body.permissionMode) ? body.permissionMode : "acceptEdits";
        const launch = ["terminal", "existing"].includes(body.launch) ? body.launch : "background";
        // Rejected at the boundary as well as inside the queue: this value came from a free-text
        // box and ends up on a command line, so it is checked where it arrives, not only where it
        // is used.
        const sessionId = body.sessionId ? safeSessionId(body.sessionId) : null;
        if (launch === "existing" && !sessionId) {
          return sendJson(res, 400, {
            error: body.sessionId ? "that is not a session id" : "pick a session, or paste a session id",
          });
        }
        ctx.queueState = ctx.queue.enqueue(executeMatch[1], mode, launch, sessionId);
        return sendJson(res, 200, { queued: true, queue: ctx.queueState, state: ctx.publicState() });
      }
      if (req.method === "POST" && url.pathname === "/api/execute") {
        const body = await readJsonBody(req);
        if (body.permissionMode === BYPASS_MODE && !bypassAllowed) return sendJson(res, 403, { error: BYPASS_REFUSED });
        const mode = PERMISSION_MODES.includes(body.permissionMode) ? body.permissionMode : "acceptEdits";
        // Lane order, not click order: "run the selected ones" means the order they are read in.
        const ids = Array.isArray(body.ticketIds) ? body.ticketIds : [];
        const batchLaunch = ["terminal", "existing"].includes(body.launch) ? body.launch : "background";
        const batchSession = body.sessionId ? safeSessionId(body.sessionId) : null;
        if (batchLaunch === "existing" && !batchSession) {
          return sendJson(res, 400, { error: "pick a session, or paste a valid session id" });
        }
        ids.forEach((id) => { ctx.queueState = ctx.queue.enqueue(String(id), mode, batchLaunch, batchSession); });
        return sendJson(res, 200, { queued: ids.length, queue: ctx.queueState, state: ctx.publicState() });
      }
      const attachMatch = url.pathname.match(/^\/api\/tickets\/([^/]+)\/attach$/);
      if (req.method === "POST" && attachMatch) {
        const ticket = (ctx.cache.tickets || []).find((t) => t.id === attachMatch[1]);
        // Whatever session is on the ticket: the one the queue dispatched, or the one a developer
        // claimed it with. A ticket owned by a person's name has no session to open.
        const sessionId = ticket && ticket.owner && /^[0-9a-f-]{20,}$/i.test(ticket.owner) ? ticket.owner : null;
        if (!sessionId) {
          return sendJson(res, 400, { error: "no session on this ticket to open" });
        }
        const result = await attachInTerminal(ctx.repoRoot, sessionId);
        return sendJson(res, result.opened ? 200 : 400, { ...result, sessionId });
      }
      const handoffMatch = url.pathname.match(/^\/api\/tickets\/([^/]+)\/handoff$/);
      if (req.method === "POST" && handoffMatch) {
        const body = await readJsonBody(req);
        const sessionId = safeSessionId(body.sessionId);
        if (!sessionId) return sendJson(res, 400, { error: "that is not a session id" });
        const ticket = (ctx.cache.tickets || []).find((t) => t.id === handoffMatch[1]);
        if (!ticket) return sendJson(res, 404, { error: "ticket not found" });

        const sessions = await listSessions(ctx.repoRoot);
        const session = sessions.find((s) => s.sessionId === sessionId) || null;
        const prompt = promptFor(ticket, { binPath: ctx.peepholeBin, port });

        // Claim it for the session that is about to work it, so the board matches reality whichever
        // way the prompt gets there. Already claimed by that same session is fine — claimTicket
        // treats a re-claim as a no-op.
        let claimed = null;
        try {
          const result = await writer.claimTicket(repoRootOf(ctx), stateBranchOf(ctx), ticket.id, sessionId, "peephole-handoff", {
            sessionId, transcriptPath: null, tokens: null, author: ctx.gitUser && ctx.gitUser.name ? ctx.gitUser : null,
          });
          claimed = result && result.claimed !== false;
          if (!claimed) return sendJson(res, 409, { error: (result && result.reason) || "could not claim", prompt });
          await ctx.refresh({ doFetch: false });
        } catch (e) {
          return sendJson(res, 500, { error: e.message, prompt });
        }

        // A BACKGROUND session can be opened here: `claude attach` takes it over in a new terminal.
        // An INTERACTIVE one cannot — it is already bound to a terminal somebody has open, and
        // attach answers "No job matching <id>". Nothing can inject a message into it, so the
        // honest help is to hand over the prompt for that window.
        if (session && session.kind === "background") {
          const opened = await attachInTerminal(ctx.repoRoot, sessionId);
          return sendJson(res, 200, { mode: "attached", opened: opened.opened, command: opened.command, prompt, sessionId });
        }
        return sendJson(res, 200, {
          mode: "paste",
          reason: session
            ? "that session is interactive — it is already attached to its own terminal, so paste this into that window"
            : "that session is not running here — paste this into the window it is running in",
          prompt,
          sessionId,
        });
      }
      const chatMatch = url.pathname.match(/^\/api\/tickets\/([^/]+)\/chat$/);
      if (req.method === "POST" && chatMatch) {
        const body = await readJsonBody(req);
        // Conversations default to `plan`: the point is to think about the ticket, and a chat that
        // can edit files is just a dispatch with a friendlier prompt.
        const mode = PERMISSION_MODES.includes(body.permissionMode) ? body.permissionMode : "plan";
        if (mode === BYPASS_MODE && !bypassAllowed) return sendJson(res, 403, { error: BYPASS_REFUSED });
        const result = await ctx.queue.startChat(chatMatch[1], mode);
        ctx.queueState = ctx.queue.state();
        return sendJson(res, result.started ? 200 : 400, { ...result, queue: ctx.queueState, state: ctx.publicState() });
      }
      const dequeueMatch = url.pathname.match(/^\/api\/tickets\/([^/]+)\/dequeue$/);
      if (req.method === "POST" && dequeueMatch) {
        ctx.queueState = ctx.queue.cancel(dequeueMatch[1]);
        return sendJson(res, 200, { queue: ctx.queueState, state: ctx.publicState() });
      }
      if (req.method === "POST" && url.pathname === "/api/execute/continue") {
        const body = await readJsonBody(req);
        ctx.queueState = ctx.queue.setAutoContinue(body.autoContinue !== false);
        return sendJson(res, 200, { queue: ctx.queueState, state: ctx.publicState() });
      }
      if (req.method === "POST" && url.pathname === "/api/execute/stop") {
        ctx.queueState = ctx.queue.stop();
        return sendJson(res, 200, { queue: ctx.queueState, state: ctx.publicState() });
      }
      if (req.method === "GET" && url.pathname === "/api/projects") {
        return sendJson(res, 200, { projects: await listProjects(), active: ctx.repoRoot });
      }
      // Switching and adding are the same server-side act now: make sure the project exists and is
      // registered, and hand back its state. The CHOICE of project lives in the browser tab (it
      // sends ?project=), so one tab changing project cannot repoint another — which is what
      // switching used to do, by mutating the single active project every client shared.
      if (req.method === "POST" && (url.pathname === "/api/projects/switch" || url.pathname === "/api/projects/add")) {
        const body = await readJsonBody(req);
        const check = await validateRepo(String(body.repoRoot || ""));
        if (!check.ok) return sendJson(res, 400, { error: check.error });
        const target = await contextFor(new URL(`http://localhost:${port}/?project=${encodeURIComponent(check.repoRoot)}`));
        // Registration happens when a context is CREATED, so a project that was forgotten but whose
        // context is still cached would never come back to the menu — adding it again looked like it
        // did nothing until the server restarted. Registering here makes add idempotent.
        const shown = target.publicState();
        await rememberProject(check.repoRoot, { remoteUrl: shown.remoteUrl, stateBranch: shown.stateBranch });
        // The self-check in the response tells the UI whether this repo still needs scaffolding —
        // that IS the per-project setup, and it is the same one an existing project gets.
        return sendJson(res, 200, shown);
      }
      if (req.method === "POST" && url.pathname === "/api/projects/forget") {
        const body = await readJsonBody(req);
        await forgetProject(String(body.repoRoot || ""));
        return sendJson(res, 200, { projects: await listProjects(), active: ctx.repoRoot });
      }
      const workerStopMatch = url.pathname.match(/^\/api\/worker\/([^/]+)\/stop$/);
      if (req.method === "POST" && workerStopMatch) {
        const id = safeSessionId(workerStopMatch[1]);
        if (!id) return sendJson(res, 400, { error: "that is not a session id" });
        // `claude stop` ends the turn and keeps the conversation: `claude attach <id>` still opens
        // it afterwards. Stopping a worker is not destroying its history.
        try {
          await stopSession(id);
        } catch (e) {
          return sendJson(res, 500, { error: e.message });
        }
        await ctx.queue.refreshWorkers().catch(() => {});
        ctx.queueState = ctx.queue.state();
        return sendJson(res, 200, { stopped: id, queue: ctx.queueState, state: ctx.publicState() });
      }
      const workerAttachMatch = url.pathname.match(/^\/api\/worker\/([^/]+)\/attach$/);
      if (req.method === "POST" && workerAttachMatch) {
        const id = safeSessionId(workerAttachMatch[1]);
        if (!id) return sendJson(res, 400, { error: "that is not a session id" });
        const opened = await attachInTerminal(ctx.repoRoot, id);
        return sendJson(res, opened.opened ? 200 : 400, opened);
      }
      if (req.method === "POST" && url.pathname === "/api/worker") {
        const body = await readJsonBody(req);
        const mode = PERMISSION_MODES.includes(body.permissionMode) ? body.permissionMode : "acceptEdits";
        if (mode === BYPASS_MODE && !bypassAllowed) return sendJson(res, 403, { error: BYPASS_REFUSED });
        const result = await ctx.queue.startWorker(mode, body.attach !== false);
        await ctx.queue.refreshWorkers().catch(() => {});
        ctx.queueState = ctx.queue.state();
        return sendJson(res, result.started ? 200 : 400, { ...result, queue: ctx.queueState, state: ctx.publicState() });
      }
      if (req.method === "GET" && url.pathname === "/api/sessions") {
        // Every live session, not only this repo's: a developer may want to hand a ticket to the
        // session they already have open one directory up. `reach` says how tightly each one fits
        // this repo, so the picker can sort and label rather than hide.
        const scoped = await listSessions(ctx.repoRoot);
        const all = await listSessions("/");
        const known = new Set(scoped.map((s) => s.sessionId));
        return sendJson(res, 200, {
          sessions: [
            ...scoped.map((s) => ({ ...s, inThisRepo: true })),
            ...all.filter((s) => !known.has(s.sessionId)).map((s) => ({ ...s, inThisRepo: false })),
          ],
        });
      }
      const epicMatch = url.pathname.match(/^\/api\/tickets\/([^/]+)\/epic$/);
      if (req.method === "POST" && epicMatch) {
        const body = await readJsonBody(req);
        const result = await writer.setEpic(ctx.repoRoot, ctx.stateBranch, epicMatch[1], body.epic ?? null, body.actor);
        await ctx.refresh({ doFetch: false });
        return sendJson(res, 200, { ...result, state: ctx.publicState() });
      }
      const assignMatch = url.pathname.match(/^\/api\/tickets\/([^/]+)\/assign$/);
      if (req.method === "POST" && assignMatch) {
        const body = await readJsonBody(req);
        const result = await writer.assignTicket(ctx.repoRoot, ctx.stateBranch, assignMatch[1], body.assignee ?? null, body.actor);
        await ctx.refresh({ doFetch: false });
        return sendJson(res, 200, { ...result, state: ctx.publicState() });
      }
      const stateMatch = url.pathname.match(/^\/api\/tickets\/([^/]+)\/state$/);
      if (req.method === "POST" && stateMatch) {
        const body = await readJsonBody(req);
        const session = await ctx.sessionFromBody(body, body.sessionId || body.actor);
        const result = await writer.setState(ctx.repoRoot, ctx.stateBranch, stateMatch[1], body.state, body.actor, session);
        await ctx.refresh({ doFetch: false });
        return sendJson(res, 200, { ...result, state: ctx.publicState() });
      }
      const renameMatch = url.pathname.match(/^\/api\/tickets\/([^/]+)\/rename$/);
      if (req.method === "POST" && renameMatch) {
        const body = await readJsonBody(req);
        const result = await writer.renameTicket(ctx.repoRoot, ctx.stateBranch, renameMatch[1], body.newId, body.actor, body.tags);
        await ctx.refresh({ doFetch: false });
        return sendJson(res, 200, { ...result, state: ctx.publicState() });
      }
      const getTicketMatch = url.pathname.match(/^\/api\/tickets\/([^/]+)$/);
      if (req.method === "GET" && getTicketMatch) {
        const t = (ctx.cache.tickets || []).find((x) => x.id === getTicketMatch[1]);
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
        const result = await writer.writeHeartbeat(ctx.repoRoot, ctx.stateBranch, {
          sessionId: heartbeatMatch[1], host: body.host, activeTicket: body.activeTicket, status: body.status,
          tokens, author: body.author,
        });
        await ctx.refresh({ doFetch: false });
        return sendJson(res, 200, { ...result, state: ctx.publicState() });
      }
      // The hook's one hot-path call: cheap (in-memory) gate check on every tool call, with an
      // actual git-committed heartbeat throttled to once a minute so PreToolUse stays fast.
      const checkinMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/checkin$/);
      if (req.method === "POST" && checkinMatch) {
        const sessionId = checkinMatch[1];
        const body = await readJsonBody(req);
        const now = Date.now();
        const owned = (ctx.cache.tickets || []).filter((t) => t.owner === sessionId);
        const blockedTicket = owned.find((t) => t.control && t.control !== "run");

        ctx.sessionLastCheckin.set(sessionId, now);
        const lastWrite = ctx.sessionLastHeartbeatWrite.get(sessionId) || 0;
        if (now - lastWrite > ctx.HEARTBEAT_WRITE_INTERVAL_MS) {
          ctx.sessionLastHeartbeatWrite.set(sessionId, now);
          try {
            // Transcript parsing only happens on this throttled (≤once/min) path, never on the
            // hot per-tool-call check above it — a growing transcript must stay cheap to re-read.
            const tokens = await tokenUsage.sessionTokenUsage(body.transcriptPath).catch(() => null);
            await writer.writeHeartbeat(ctx.repoRoot, ctx.stateBranch, {
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
              await writer.touchTicketSession(ctx.repoRoot, ctx.stateBranch, owned[0].id, {
                sessionId, transcriptPath: body.transcriptPath, tokens: tokens?.totalTokens ?? null,
                author: ctx.agentAuthor(sessionId),
              });
            }
            await ctx.refresh({ doFetch: false });
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
      if (e && e.statusCode) return sendJson(res, e.statusCode, { error: e.message });
      console.error(e);
      sendJson(res, 500, { error: e.message });
    }
  });

  // Build the project the server was started on up front, so `serve --repo X` still fails loudly
  // and immediately on a bad path rather than on the first request.
  const initial = await contextFor(new URL(`http://localhost:${port}/`));
  await initial.refresh({ doFetch: true }).catch((e) => console.error("initial fetch failed:", e.message));

  await new Promise((resolve) => server.listen(port, host, resolve));
  return {
    server,
    port,
    stateBranch: initial.stateBranch,
    stateBranchSource: initial.publicState().stateBranchSource,
    remoteUrl: initial.publicState().remoteUrl,
    worktreePath: initial.worktreePath,
  };
}
