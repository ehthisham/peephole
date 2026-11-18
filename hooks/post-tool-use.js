#!/usr/bin/env node
// Claude Code PostToolUse hook. Runs after every tool call. Its one job: when an agent raises a pull
// request, notice the PR URL in the command's output and stamp it onto the ticket that session owns —
// so a PR an agent opened shows up on the board with no human linking it by hand.
//
// Cooperative, exactly like pre-tool-use.js: it never blocks and never fails the tool. No server, a
// timeout, no owned ticket, a ticket that already has a PR — all mean "do nothing", silently. The
// server side (onlyIfEmpty) guarantees it can fire on every later tool call without clobbering a
// human's link or churning a commit.
import { hostname } from "node:os";

const PORT = process.env.PEEPHOLE_PORT || 4173;
const TIMEOUT_MS = 800;

// A pull/merge request URL across the common hosts: GitHub (/pull/N), Bitbucket (/pull-requests/N),
// GitLab (/-/merge_requests/N or /merge_requests/N), Azure DevOps (/pullrequest/N). The leading
// [^\s"')]+ swallows the org/repo (and GitLab's /-/) between host and the kind segment.
const PR_URL_RE = /https?:\/\/[^\s"')<>]+\/(?:pull|pull-requests|pullrequest|merge_requests)\/\d+/i;

async function readStdin() {
  let input = "";
  for await (const chunk of process.stdin) input += chunk;
  return input;
}

/** Pulls text out of a tool_response that may be a string, {stdout,stderr}, or an array of content
 *  blocks — enough to cover how Bash results arrive without assuming one exact shape. */
function responseText(r) {
  if (!r) return "";
  if (typeof r === "string") return r;
  if (Array.isArray(r)) return r.map((b) => (b && (b.text || b.content)) || "").join("\n");
  return [r.stdout, r.stderr, r.output, r.text].filter((s) => typeof s === "string").join("\n");
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
  // Only shell calls open PRs; skip everything else so we never scan unrelated tool output.
  if (payload.tool_name !== "Bash") process.exit(0);

  const cmd = (payload.tool_input && payload.tool_input.command) || "";
  const haystack = `${cmd}\n${responseText(payload.tool_response)}`;
  const m = haystack.match(PR_URL_RE);
  if (!m) process.exit(0);

  try {
    await fetch(`http://localhost:${PORT}/api/sessions/${encodeURIComponent(sessionId)}/pr`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pr: m[0], host: hostname() }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch {
    // No dashboard, or it was slow — never our place to make noise or fail the tool.
  }
  process.exit(0);
}

main();
