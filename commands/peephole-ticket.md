---
description: Create and claim a Peephole ticket for the task described in the arguments.
allowed-tools: Bash
---

Create a Peephole ticket for this task, then claim it, before any work starts.

Task / intent: $ARGUMENTS

Steps:
1. Make sure the board is up (`curl -s http://127.0.0.1:4173/api/state`); if not, start it per the
   `/peephole-board` flow.
2. Create the ticket with a one-sentence intent (the *why*), from the repo root. Add
   `--risk irreversible` if the change is hard to undo. Pass `--transcript <your transcript_path>`:
   ```
   node "${CLAUDE_PLUGIN_ROOT}/cli/peephole.js" ticket new \
     --project "<this project>" --intent "$ARGUMENTS" \
     --transcript <your transcript_path> --port 4173
   ```
3. Claim the printed id with your session id and transcript:
   ```
   node "${CLAUDE_PLUGIN_ROOT}/cli/peephole.js" ticket claim <id> \
     --owner <your session id> --transcript <your transcript_path> --port 4173
   ```
4. Report the ticket id and that it is claimed (in-progress). If the claim is refused (ticket
   reserved for someone else), say so and stop — don't work it.

Then follow the `peephole` skill for advancing state and commenting as the work lands.
