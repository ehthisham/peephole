---
description: Start the Peephole board (if not already running) and show its URL.
allowed-tools: Bash
---

Start the Peephole dashboard for the current repo, unless it is already up.

1. Check whether a board is already running on port 4173:
   `curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:4173/api/state`
   - `200` → already running. Don't start a second copy.
2. If not running, start it in the background from the repo root:
   `PEEPHOLE_PORT=4173 node "${CLAUDE_PLUGIN_ROOT}/bin/peephole.js" serve --repo . --port 4173`
3. Report the board URL (http://127.0.0.1:4173) and a one-line count of open tickets from
   `.peephole/tickets/`.
