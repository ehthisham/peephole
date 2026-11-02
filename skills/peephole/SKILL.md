---
name: peephole
description: Track AI-executed work in a Peephole repo (a repo with a `.peephole/` directory or a live board on :4173). Use before starting non-trivial work and at real milestones — create/claim a ticket before coding, advance its state as work lands (in-progress → built → verified → shipped), check for stop signals, and comment findings. Triggers on "peephole", "ticket", "the board", "claim/advance a ticket", or any task in a repo that tracks work under `.peephole/`.
---

# Peephole task tracking

Every non-trivial task in a Peephole-tracked repo lands on the board **first** — create and
claim a ticket before coding, not after. The board (an HTTP server + dashboard) must be running
for the commands to work; they talk to it over `--port`.

The CLI ships with this plugin. Invoke it as:

```
node "${CLAUDE_PLUGIN_ROOT}/bin/peephole.js" <args>
```

If a `peephole` binary is already on PATH (installed via `npm i -g .` in the peephole repo), use
that instead — same arguments. Run every command **from the target repo's root** so `--repo .`
and `.peephole/` resolve to that checkout.

## Start the board (once, if not already up)

```
node "${CLAUDE_PLUGIN_ROOT}/bin/peephole.js" serve --repo . --port 4173
```

Start it in the background. If it is already running, reuse it — don't start a second copy on the
same port.

## Before starting work

1. **Find or create a ticket.** Check `.peephole/tickets/*.md` for one matching the task. If none,
   create it (don't hand-write YAML — the CLI keeps the schema valid). Add `--risk irreversible`
   for a hard-to-undo change. Prints the ticket id.
   ```
   node "${CLAUDE_PLUGIN_ROOT}/bin/peephole.js" ticket new \
     --project "<this project>" --intent "<one sentence, the why>" \
     --transcript <your transcript_path> --port 4173
   ```
2. **Claim it** before coding — sets state to in-progress, records you as owner. A ticket reserved
   for someone else (its `assignee`) refuses your claim; pick another rather than working it.
   ```
   node "${CLAUDE_PLUGIN_ROOT}/bin/peephole.js" ticket claim <id> \
     --owner <your session id> --transcript <your transcript_path> --port 4173
   ```

Always pass `--transcript` (your own `transcript_path`, visible in session context/hook payloads)
on `new`, `claim`, and `advance`. It links the ticket to the chat that did the work and lets the
board compute token cost automatically (`ticket.sessions[]`). Skip it and the ticket is
provenance-free.

## While working

3. **Check for a stop signal** before continuing a claimed ticket. Exit 0 = proceed; nonzero =
   `pause`/`skip`/`restart` — stop and say why. (This plugin's PreToolUse hook already checks this
   automatically before every tool call; the manual command is the fallback.)
   ```
   node "${CLAUDE_PLUGIN_ROOT}/bin/peephole.js" control check <id> --port 4173
   ```
4. **Advance state** at real milestones — never hand-edit it. Only move forward
   (proposed → in-progress → built → verified → shipped) or to `closed`; never backward, never
   delete a ticket file. Code merged → `built`; tests/verification done → `verified`; live →
   `shipped`.
   ```
   node "${CLAUDE_PLUGIN_ROOT}/bin/peephole.js" ticket advance <id> \
     --state <in-progress|built|verified|shipped|closed> \
     --transcript <your transcript_path> --port 4173
   ```
5. **Comment** findings/decisions on the ticket rather than narrating them only in chat:
   ```
   node "${CLAUDE_PLUGIN_ROOT}/bin/peephole.js" ticket comment <id> --text "<comment>" --port 4173
   ```

## Ticket body shape

Write the body as two sections only — **What it does** + **Acceptance criteria** — plain prose.
For shipped work, "what it does" is the mechanism (a real code snippet or a file permalink) and
"acceptance criteria" is what proves it (tests, verified behavior). Never narrate the edit itself
("Corrected on…", "Found by the audit"); say what's true now. The *that it changed* belongs in
`history`, which the CLI maintains.

## Other verbs

`ticket unclaim | assign --to "<person>" | epic --to "<epic>" | risk --to <reversible|irreversible>
| rename --to <new-id>`, `agent heartbeat`, `ledger` moves. Run any verb with no args to see its
usage line. Push board state to its state branch with `curl -X POST http://127.0.0.1:4173/api/push`.
