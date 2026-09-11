#!/usr/bin/env node
// Claude Code SessionStart hook — registers this session's presence immediately (status: idle,
// no ticket claimed yet) so it shows up in the Agents panel even before the first tool call.
// Side-effect only: SessionStart has no blocking mechanism, and none is needed here.
import { hostname } from "node:os";
import { gitIdentity } from "./identity.js";

const PORT = process.env.PEEPHOLE_PORT || 4173;

async function readStdin() {
  let input = "";
  for await (const chunk of process.stdin) input += chunk;
  return input;
}

async function main() {
  let payload;
  try {
    payload = JSON.parse(await readStdin());
  } catch {
    process.exit(0);
  }
  const sessionId = payload.session_id;
  if (!sessionId) process.exit(0);

  try {
    const author = await gitIdentity();
    await fetch(`http://localhost:${PORT}/api/agents/${encodeURIComponent(sessionId)}/heartbeat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        host: hostname(), status: "idle", activeTicket: null, transcriptPath: payload.transcript_path, author,
      }),
      signal: AbortSignal.timeout(1500),
    });
  } catch {
    // no dashboard running yet — nothing to report, session proceeds normally either way
  }
  process.exit(0);
}

main();
