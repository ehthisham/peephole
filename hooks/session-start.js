#!/usr/bin/env node
// Claude Code SessionStart hook — registers this session's presence immediately (status: idle,
// no ticket claimed yet) so it shows up in the Agents panel even before the first tool call.
// Side-effect only: SessionStart has no blocking mechanism, and none is needed here.
import { hostname } from "node:os";
import { gitIdentity } from "./identity.js";
import { markEnabledIfUnset } from "../src/enable.js";

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

  // Leave the per-developer opt-in mark (git config --local peephole.enabled true) in the repo this
  // session is running in, when unset — so a plain `git commit` from this developer is detectable by
  // a repo's hooks even with no board running. Best-effort; never blocks the session.
  try {
    await markEnabledIfUnset(payload.cwd || process.cwd());
  } catch {}

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
