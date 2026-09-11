#!/usr/bin/env node
// Claude Code SessionEnd hook — marks this session's heartbeat "stopped" so the Agents panel
// reads as a clean exit rather than waiting 5+ minutes to fall back to "stale".
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
    await fetch(`http://localhost:${PORT}/api/agents/${encodeURIComponent(sessionId)}/heartbeat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: "stopped" }),
      signal: AbortSignal.timeout(1500),
    });
  } catch {
    // no dashboard running — nothing to report
  }
  process.exit(0);
}

main();
