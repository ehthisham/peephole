# peephole — working notes

<!-- peephole:start v=2 -->
## Working with Peephole (task tracking)

Requires the `peephole` CLI on your PATH — install it once from the peephole repo (`npm i -g .`
in that clone, or `npm link`). Run every command below **from this repo's root**, so the
`--repo .` and `.peephole/` paths resolve to this checkout on any machine.

This repo tracks AI-executed work in `.peephole/`. The dashboard must be running for the
commands below to work — start it once in the background if it isn't already:
`peephole serve --repo . --port 4173`

Before starting non-trivial work:

1. Check `.peephole/tickets/*.md` for a ticket matching the task. If none exists, create one —
   **before** starting the work, not after — don't hand-write the YAML, use the CLI so the schema
   is always valid:
   ```
   peephole ticket new --project "<this project>" --intent "<one sentence, the why>" --transcript <your transcript_path> --port 4173
   ```
   Add `--risk irreversible` if the change is hard to undo. This prints the ticket id it chose.
2. Claim it before you start work — sets state to in-progress and records you as owner:
   ```
   peephole ticket claim <id> --owner <your session id> --transcript <your transcript_path> --port 4173
   ```
   A ticket can be reserved for one person (`assignee` in its frontmatter, set from the board or
   with `peephole ticket assign <id> --to "<person>"`). If it is, this claim is REFUSED for anyone
   else — the CLI sends your machine's git identity automatically and the server matches it
   against the assignee. Don't work a ticket whose claim was refused; pick another.

   Always pass `--transcript` (your own `transcript_path`, visible in your session context/hook
   payloads) on both of the above and on `ticket advance`. It's the only thing that links a ticket
   back to the actual chat that did the work — token usage is computed from it automatically and
   stored on the ticket (`ticket.sessions[]`). Skip it and the ticket is provenance-free: a record
   that work happened, with no way to trace which conversation produced it or what it cost.
3. Before continuing work on a claimed ticket, check whether you've been told to stop:
   ```
   peephole control check <id> --port 4173
   ```
   Exit code 0 means proceed; nonzero means `pause`/`skip`/`restart` — stop and say why rather
   than pushing through. (If `.claude/settings.local.json` has Peephole's hooks wired in, this is
   already checked automatically before every tool call — the manual command is the fallback for
   when it isn't.)
4. As the work actually progresses, advance `state` — never hand-edit it, use the CLI:
   ```
   peephole ticket advance <id> --state <in-progress|built|verified|shipped|closed> --transcript <your transcript_path> --port 4173
   ```
   Only ever move forward (proposed → in-progress → built → verified → shipped) or to `closed` —
   never backward, never delete a ticket file. Do this at real milestones (code merged → `built`;
   tests/verification done → `verified`; live → `shipped`), not speculatively.
5. If a ticket must be hand-edited directly, keep every frontmatter field the CLI would have set
   (id, project, intent, acceptance, state, risk, blockedOn, control, owner, branch, pr, estimate,
   createdAt, updatedAt, history) — a missing field or an invalid state/risk/control value makes
   the dashboard reject the file.
6. Write the ticket body as **What it does** + **Acceptance criteria** — two clear sections, plain
   readable prose, nothing else. For a shipped feature, "what it does" is the mechanism (a real code
   snippet or a permalink to the file, not just a citation in prose) and "acceptance criteria" is
   what proves it works (tests, verified behavior). Never narrate the edit itself — no "Enriched
   on...", "Corrected 2026-...", "Found by the audit", "this ticket now...". If something changed,
   say what's true now; the *that it changed* belongs in `history`, not the body.

View the live board: `peephole serve --repo . --port 4173`
<!-- peephole:end -->
