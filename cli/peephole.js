#!/usr/bin/env node
import path from "node:path";
import { startServer } from "../src/server.js";
import { gitIdentity } from "../hooks/identity.js";

/** The identity a claim is checked against when a ticket is assigned: whatever `--author` says,
 *  else this machine's global git identity — the same one the SessionStart hook reports, so the
 *  CLI and the hook can never disagree about who a session belongs to. */
async function resolveAuthor(args) {
  if (args.author && args.author !== true) return { name: String(args.author), email: null };
  return gitIdentity();
}

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith("--")) {
        args[key] = next;
        i++;
      } else {
        args[key] = true;
      }
    } else {
      args._.push(a);
    }
  }
  return args;
}

function slugify(text, maxLen = 48) {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, maxLen).replace(/-+$/, "");
}

async function apiCall(port, method, apiPath, body) {
  const res = await fetch(`http://localhost:${port}${apiPath}`, {
    method,
    headers: body !== undefined ? { "Content-Type": "application/json" } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status} from ${apiPath}`);
  return data;
}

function requirePort(args) {
  return Number(args.port) || 4173;
}

async function cmdServe(argv) {
  const args = parseArgs(argv);
  const repoRoot = path.resolve(args.repo || process.cwd());
  const port = requirePort(args);
  // Loopback unless asked otherwise: every endpoint is unauthenticated, and they create tickets,
  // push branches and start agents. `--host 0.0.0.0` exposes all of that to the network.
  const host = args.host && args.host !== true ? String(args.host) : "127.0.0.1";
  const branch = args.branch && args.branch !== true ? String(args.branch) : null;
  const { stateBranch, stateBranchSource, remoteUrl } = await startServer(repoRoot, {
    port, remote: args.remote || "origin", host, branch,
  });
  console.log(`peephole watching ${repoRoot}`);
  console.log(`  remote:       ${remoteUrl || "(none)"}`);
  console.log(`  state branch: ${stateBranch} (${stateBranchSource})`);
  if (stateBranchSource === "remote default") {
    console.log("                 not declared in .peephole/config.yaml — every machine resolves this on its own;");
    console.log("                 set stateBranch there (or pass --branch) to pin the ledger to one branch");
  }
  console.log(`  dashboard:    http://localhost:${port}`);
  if (host !== "127.0.0.1" && host !== "localhost") {
    console.log(`  WARNING:      listening on ${host} — anyone who can reach this port can write tickets and start agents`);
  }
  if (process.env.PEEPHOLE_ALLOW_BYPASS === "1") {
    console.log("  WARNING:      PEEPHOLE_ALLOW_BYPASS=1 — dispatched agents may run any tool unattended");
  }
}

async function cmdTicketNew(argv) {
  const args = parseArgs(argv);
  const port = requirePort(args);
  if (!args.project || !args.intent) {
    console.error('usage: peephole ticket new --project <p> --intent "<text>" [--title "<headline>"] [--id <id>] [--acceptance "<text>"] [--risk reversible|irreversible] [--priority low|normal|high|urgent] [--owner <sessionId>] [--epic "<epic>"] [--transcript <path>] [--port 4173]');
    process.exit(1);
  }
  const id = args.id || slugify(args.title && args.title !== true ? String(args.title) : args.intent);
  const result = await apiCall(port, "POST", "/api/tickets", {
    id,
    project: args.project,
    title: args.title && args.title !== true ? String(args.title) : "",
    intent: args.intent,
    acceptance: args.acceptance || "",
    risk: args.risk || "reversible",
    priority: args.priority && args.priority !== true ? String(args.priority) : null,
    type: args.type && args.type !== true ? String(args.type) : null,
    owner: args.owner || null,
    assignee: args.assignee && args.assignee !== true ? String(args.assignee) : null,
    epic: args.epic && args.epic !== true ? String(args.epic) : null,
    transcriptPath: args.transcript || null,
    author: await resolveAuthor(args),
  });
  console.log(`created "${id}" (${result.ticket.state})${result.unpushed ? ` — ${result.unpushed} unpushed` : ""}`);
}

async function cmdTicketClaim(argv) {
  const id = argv[0];
  const args = parseArgs(argv.slice(1));
  const port = requirePort(args);
  if (!id || !args.owner) {
    console.error("usage: peephole ticket claim <id> --owner <sessionId> [--transcript <path>] [--author <name>] [--port 4173]");
    process.exit(1);
  }
  const result = await apiCall(port, "POST", `/api/tickets/${encodeURIComponent(id)}/claim`, {
    owner: args.owner, transcriptPath: args.transcript || null, author: await resolveAuthor(args),
  });
  if (!result.claimed) {
    console.error(`not claimed: ${result.reason}`);
    process.exit(1);
  }
  console.log(`claimed "${id}" as ${args.owner} (${result.ticket.state})`);
}

async function cmdTicketUnclaim(argv) {
  const id = argv[0];
  const args = parseArgs(argv.slice(1));
  const port = requirePort(args);
  if (!id) {
    console.error("usage: peephole ticket unclaim <id> [--actor <who>] [--port 4173]");
    process.exit(1);
  }
  const result = await apiCall(port, "POST", `/api/tickets/${encodeURIComponent(id)}/unclaim`, { actor: args.actor });
  console.log(`unclaimed "${id}" -> ${result.ticket.state}`);
}

async function cmdTicketAssign(argv) {
  const id = argv[0];
  const args = parseArgs(argv.slice(1));
  const port = requirePort(args);
  const clearing = args.clear === true || args.to === "none";
  if (!id || (!args.to && !clearing)) {
    console.error('usage: peephole ticket assign <id> --to "<person>" | --clear [--actor <who>] [--port 4173]');
    process.exit(1);
  }
  const assignee = clearing ? null : String(args.to);
  const result = await apiCall(port, "POST", `/api/tickets/${encodeURIComponent(id)}/assign`, { assignee, actor: args.actor });
  console.log(`"${id}" assigned -> ${result.ticket.assignee || "unassigned"}`);
}

async function cmdTicketEpic(argv) {
  const id = argv[0];
  const args = parseArgs(argv.slice(1));
  const port = requirePort(args);
  const clearing = args.clear === true || args.to === "none";
  if (!id || (!args.to && !clearing)) {
    console.error('usage: peephole ticket epic <id> --to "<epic>" | --clear [--port 4173]');
    process.exit(1);
  }
  const result = await apiCall(port, "POST", `/api/tickets/${encodeURIComponent(id)}/epic`, {
    epic: clearing ? null : String(args.to), actor: args.actor,
  });
  console.log(`"${id}" epic -> ${result.ticket.epic || "none"}`);
}

async function cmdLedgerMove(argv) {
  const args = parseArgs(argv);
  const repoRoot = path.resolve(args.repo || process.cwd());
  const to = args.to && args.to !== true ? String(args.to) : "peephole-state";
  const { migrateLedger } = await import("../src/writer.js");
  const git = await import("../src/git.js");
  const from = args.from && args.from !== true
    ? String(args.from)
    : (await git.declaredStateBranch(repoRoot, await git.defaultRemoteBranch(repoRoot))) || (await git.defaultRemoteBranch(repoRoot));

  console.log(`moving the ledger: ${from} -> ${to}`);
  const r = await migrateLedger(repoRoot, from, to, { push: args.push === true });
  console.log(`  tickets before: ${r.ticketsBefore}`);
  console.log(`  tickets after:  ${r.ticketsAfter}${r.missing.length ? ` (MISSING: ${r.missing.join(", ")})` : ""}`);
  console.log(`  commit:         ${r.sha || "(nothing to commit)"}`);
  console.log(`  pushed:         ${r.pushed ? `yes -> origin/${to}` : "no — run with --push, or use Push to remote"}`);
  console.log(`  old branch:     ${from} left untouched; point stateBranch back at it to undo`);
  console.log("Restart the board to pick up the new branch.");
}

async function cmdTicketComment(argv) {
  const id = argv[0];
  const args = parseArgs(argv.slice(1));
  const port = requirePort(args);
  if (!id || !args.text || args.text === true) {
    console.error('usage: peephole ticket comment <id> --text "<comment>" [--author <who>] [--port 4173]');
    process.exit(1);
  }
  const author = args.author && args.author !== true ? String(args.author) : (await resolveAuthor(args))?.name;
  const result = await apiCall(port, "POST", `/api/tickets/${encodeURIComponent(id)}/comments`, {
    text: String(args.text), author,
  });
  const comments = (result.ticket && result.ticket.comments) || [];
  console.log(`commented on "${id}" (${comments.length} comment${comments.length === 1 ? "" : "s"})`);
}

async function cmdTicketRisk(argv) {
  const id = argv[0];
  const args = parseArgs(argv.slice(1));
  const port = requirePort(args);
  if (!id || !args.to) {
    console.error("usage: peephole ticket risk <id> --to <reversible|irreversible> [--port 4173]");
    process.exit(1);
  }
  const result = await apiCall(port, "POST", `/api/tickets/${encodeURIComponent(id)}/risk`, { risk: String(args.to), actor: args.actor });
  console.log(`"${id}" risk -> ${result.ticket.risk}`);
}

async function cmdTicketTitle(argv) {
  const id = argv[0];
  const args = parseArgs(argv.slice(1));
  const port = requirePort(args);
  const clearing = args.clear === true;
  if (!id || (!args.to && !clearing)) {
    console.error('usage: peephole ticket title <id> --to "<title>" | --clear [--port 4173]');
    process.exit(1);
  }
  const result = await apiCall(port, "POST", `/api/tickets/${encodeURIComponent(id)}/title`, {
    title: clearing ? "" : String(args.to), actor: args.actor,
  });
  console.log(`"${id}" title -> ${result.ticket.title || "(none — falls back to intent)"}`);
}

async function cmdTicketType(argv) {
  const id = argv[0];
  const args = parseArgs(argv.slice(1));
  const port = requirePort(args);
  if (!id || !args.to) {
    console.error("usage: peephole ticket type <id> --to <feature|bug|chore> [--port 4173]");
    process.exit(1);
  }
  const result = await apiCall(port, "POST", `/api/tickets/${encodeURIComponent(id)}/type`, { type: String(args.to), actor: args.actor });
  console.log(`"${id}" type -> ${result.ticket.type}`);
}

async function cmdTicketPriority(argv) {
  const id = argv[0];
  const args = parseArgs(argv.slice(1));
  const port = requirePort(args);
  if (!id || !args.to) {
    console.error("usage: peephole ticket priority <id> --to <low|normal|high|urgent> [--port 4173]");
    process.exit(1);
  }
  const result = await apiCall(port, "POST", `/api/tickets/${encodeURIComponent(id)}/priority`, { priority: String(args.to), actor: args.actor });
  console.log(`"${id}" priority -> ${result.ticket.priority}`);
}

async function cmdTicketAdvance(argv) {
  const id = argv[0];
  const args = parseArgs(argv.slice(1));
  const port = requirePort(args);
  if (!id || !args.state) {
    console.error("usage: peephole ticket advance <id> --state <proposed|in-progress|built|verified|shipped|closed> [--transcript <path>] [--port 4173]");
    process.exit(1);
  }
  // Default the actor to this machine's git identity. Without it the history recorded the literal
  // string "agent" — 63 of 65 finished tickets on a real board say exactly that, which is why none
  // of them can be attributed to anybody. Nothing can recover a name that was never written down;
  // all that can be fixed is writing it from now on.
  const who = args.actor && args.actor !== true ? String(args.actor) : (await resolveAuthor(args))?.name;
  const result = await apiCall(port, "POST", `/api/tickets/${encodeURIComponent(id)}/state`, {
    state: args.state, actor: who, sessionId: args.owner || args.actor, transcriptPath: args.transcript || null,
  });
  console.log(`"${id}" -> ${result.ticket.state}`);
}

async function cmdTicketRename(argv) {
  const id = argv[0];
  const args = parseArgs(argv.slice(1));
  const port = requirePort(args);
  if (!id || !args.to) {
    console.error("usage: peephole ticket rename <id> --to <new-id> [--port 4173]");
    process.exit(1);
  }
  const result = await apiCall(port, "POST", `/api/tickets/${encodeURIComponent(id)}/rename`, { newId: args.to, actor: args.actor });
  console.log(`"${result.oldId}" -> "${result.newId}"`);
}

async function cmdAgentHeartbeat(argv) {
  const args = parseArgs(argv);
  const port = requirePort(args);
  if (!args.session) {
    console.error("usage: peephole agent heartbeat --session <id> [--ticket <id>] [--status working|idle|paused|stopped] [--port 4173]");
    process.exit(1);
  }
  await apiCall(port, "POST", `/api/agents/${encodeURIComponent(args.session)}/heartbeat`, {
    host: args.host,
    activeTicket: args.ticket || null,
    status: args.status || "working",
  });
  console.log(`heartbeat sent for ${args.session}`);
}

async function cmdControlCheck(argv) {
  const id = argv[0];
  const args = parseArgs(argv.slice(1));
  const port = requirePort(args);
  if (!id) {
    console.error("usage: peephole control check <id> [--port 4173]");
    process.exit(1);
  }
  let ticket;
  try {
    ticket = await apiCall(port, "GET", `/api/tickets/${encodeURIComponent(id)}`);
  } catch (e) {
    console.error(`peephole: could not reach dashboard on port ${port} (${e.message}) — allowing by default`);
    process.exit(0);
  }
  console.log(ticket.control);
  process.exit(ticket.control === "run" ? 0 : 1);
}

async function main() {
  const argv = process.argv.slice(2);
  const cmd = argv[0] || "serve";

  if (cmd === "serve") return cmdServe(argv.slice(1));
  if (cmd === "ticket" && argv[1] === "new") return cmdTicketNew(argv.slice(2));
  if (cmd === "ticket" && argv[1] === "claim") return cmdTicketClaim(argv.slice(2));
  if (cmd === "ticket" && argv[1] === "unclaim") return cmdTicketUnclaim(argv.slice(2));
  if (cmd === "ticket" && argv[1] === "assign") return cmdTicketAssign(argv.slice(2));
  if (cmd === "ticket" && argv[1] === "epic") return cmdTicketEpic(argv.slice(2));
  if (cmd === "ticket" && argv[1] === "risk") return cmdTicketRisk(argv.slice(2));
  if (cmd === "ticket" && argv[1] === "priority") return cmdTicketPriority(argv.slice(2));
  if (cmd === "ticket" && argv[1] === "type") return cmdTicketType(argv.slice(2));
  if (cmd === "ticket" && argv[1] === "title") return cmdTicketTitle(argv.slice(2));
  if (cmd === "ticket" && argv[1] === "comment") return cmdTicketComment(argv.slice(2));
  if (cmd === "ledger" && argv[1] === "move") return cmdLedgerMove(argv.slice(2));
  if (cmd === "ticket" && argv[1] === "advance") return cmdTicketAdvance(argv.slice(2));
  if (cmd === "ticket" && argv[1] === "rename") return cmdTicketRename(argv.slice(2));
  if (cmd === "agent" && argv[1] === "heartbeat") return cmdAgentHeartbeat(argv.slice(2));
  if (cmd === "control" && argv[1] === "check") return cmdControlCheck(argv.slice(2));

  console.error(
    "Usage:\n" +
    "  peephole serve [--repo <path>] [--port 4173] [--host 127.0.0.1] [--branch <state branch>]\n" +
    '  peephole ticket new --project <p> --intent "<text>" [--title "<headline>"] [--id <id>] [--acceptance "<text>"] [--risk reversible|irreversible] [--priority low|normal|high|urgent] [--owner <sessionId>]\n' +
    "  peephole ticket claim <id> --owner <sessionId>\n" +
    "  peephole ticket unclaim <id>  # return to proposed, in-progress only\n" +
    '  peephole ticket assign <id> --to "<person>" | --clear  # reserve it; only that person can claim\n' +
    '  peephole ticket epic <id> --to "<epic>" | --clear      # file it under an epic\n' +
    "  peephole ticket risk <id> --to <reversible|irreversible>\n" +
    "  peephole ticket priority <id> --to <low|normal|high|urgent>\n" +
    "  peephole ticket type <id> --to <feature|bug|chore>\n" +
    '  peephole ticket title <id> --to "<title>" | --clear  # short headline, falls back to intent\n' +
    '  peephole ticket comment <id> --text "<comment>"\n' +
    '  peephole ledger move --repo <path> [--to peephole-state] [--push]  # carry the ledger to its own branch\n' +
    "  peephole ticket advance <id> --state <proposed|in-progress|built|verified|shipped|closed>\n" +
    "  peephole ticket rename <id> --to <new-id>\n" +
    "  peephole agent heartbeat --session <id> [--ticket <id>] [--status working|idle|paused|stopped]\n" +
    "  peephole control check <id>\n",
  );
  process.exit(1);
}

main().catch((e) => {
  console.error("peephole failed:", e.message);
  process.exit(1);
});
