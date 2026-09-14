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
  const { stateBranch, remoteUrl } = await startServer(repoRoot, { port, remote: args.remote || "origin" });
  console.log(`peephole watching ${repoRoot}`);
  console.log(`  remote:       ${remoteUrl || "(none)"}`);
  console.log(`  state branch: ${stateBranch}`);
  console.log(`  dashboard:    http://localhost:${port}`);
}

async function cmdTicketNew(argv) {
  const args = parseArgs(argv);
  const port = requirePort(args);
  if (!args.project || !args.intent) {
    console.error('usage: peephole ticket new --project <p> --intent "<text>" [--id <id>] [--acceptance "<text>"] [--risk reversible|irreversible] [--owner <sessionId>] [--transcript <path>] [--port 4173]');
    process.exit(1);
  }
  const id = args.id || slugify(args.intent);
  const result = await apiCall(port, "POST", "/api/tickets", {
    id,
    project: args.project,
    intent: args.intent,
    acceptance: args.acceptance || "",
    risk: args.risk || "reversible",
    owner: args.owner || null,
    assignee: args.assignee && args.assignee !== true ? String(args.assignee) : null,
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

async function cmdTicketAdvance(argv) {
  const id = argv[0];
  const args = parseArgs(argv.slice(1));
  const port = requirePort(args);
  if (!id || !args.state) {
    console.error("usage: peephole ticket advance <id> --state <proposed|in-progress|built|verified|shipped|closed> [--transcript <path>] [--port 4173]");
    process.exit(1);
  }
  const result = await apiCall(port, "POST", `/api/tickets/${encodeURIComponent(id)}/state`, { state: args.state, actor: args.actor, sessionId: args.actor, transcriptPath: args.transcript || null });
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
  if (cmd === "ticket" && argv[1] === "advance") return cmdTicketAdvance(argv.slice(2));
  if (cmd === "ticket" && argv[1] === "rename") return cmdTicketRename(argv.slice(2));
  if (cmd === "agent" && argv[1] === "heartbeat") return cmdAgentHeartbeat(argv.slice(2));
  if (cmd === "control" && argv[1] === "check") return cmdControlCheck(argv.slice(2));

  console.error(
    "Usage:\n" +
    "  peephole serve [--repo <path>] [--port 4173]\n" +
    '  peephole ticket new --project <p> --intent "<text>" [--id <id>] [--acceptance "<text>"] [--risk reversible|irreversible] [--owner <sessionId>]\n' +
    "  peephole ticket claim <id> --owner <sessionId>\n" +
    "  peephole ticket unclaim <id>  # return to proposed, in-progress only\n" +
    '  peephole ticket assign <id> --to "<person>" | --clear  # reserve it; only that person can claim\n' +
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
