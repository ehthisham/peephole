#!/usr/bin/env node
// Claude Code PreToolUse hook. Runs before every tool call (per the hook contract, matcher
// decides whether it's invoked at all — registered with matcher "*" by setupHooksLocal).
//
// Fails open on anything that isn't an explicit "paused/skipped/restart" answer from a running
// Peephole server: no server, a timeout, a bad response — all mean "allow", never "block". This
// is a cooperative check, not a supervisor with the power to kill a process it didn't launch.
import { hostname } from "node:os";

const PORT = process.env.PEEPHOLE_PORT || 4173;
const TIMEOUT_MS = 800;

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

  let res;
  try {
    res = await fetch(`http://localhost:${PORT}/api/sessions/${encodeURIComponent(sessionId)}/checkin`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ host: hostname() }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch {
    process.exit(0); // no dashboard running (or unreachable) — never block on our own account
  }
  if (!res.ok) process.exit(0);

  const data = await res.json().catch(() => ({ blocked: false }));
  if (data.blocked) {
    process.stdout.write(JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: `Peephole: ${data.reason}`,
      },
    }));
    process.exit(2);
  }
  process.exit(0);
}

main();
