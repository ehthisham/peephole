# Contributing to Peephole

Thanks for helping improve Peephole. It is two things in one repo: a **Node CLI + local board**
for tracking multi-agent AI work, and a **Claude Code plugin** that wires that workflow into a
session. Keep both working when you change either.

## Ground rules

- **Local-first stays local.** The server binds `127.0.0.1`, every sync travels as git commits on
  the ledger branch, and control changes go through the contributor's own git identity. Don't add a
  network channel, a shared daemon, or a bot credential without first opening an issue — that is
  Hosted Mode (Phase 7) and is deliberately deferred.
- **No secrets, ever.** No tokens, no absolute home paths in committed files. The blocks Peephole
  writes into a tracked repo must emit the bare `peephole` command with `--repo .` so they stay
  portable across machines.
- **Dogfood it.** Peephole tracks its own work in `.peephole/`. Before non-trivial work, create and
  claim a ticket on the board; advance its state as the work lands. See `CLAUDE.md`.

## Project layout

```
cli/peephole.js          CLI entry (serve, ticket, control, ledger, agent …)
src/                     board server + domain modules
  server.js              HTTP API + static board
  ledger.js  scan.js     the sparse ledger clone and ticket reader
  schema.js  writer.js   ticket schema + CLI-safe writes
  git.js  execute.js     git plumbing + ticket dispatch to live sessions
public/                  the board UI (index.html + app.js)
hooks/                   Claude Code hooks (session presence + stop/claim gate)
  hooks.json             the hook manifest the plugin ships
skills/peephole/         SKILL.md — the task-tracking workflow for any repo
commands/                /peephole-board and /peephole-ticket slash commands
.claude-plugin/          plugin.json, marketplace.json, icon.png
```

## Dev setup

Requires **Node 18+** and `git`.

```bash
npm install
node cli/peephole.js serve --repo . --port 4173   # board at http://localhost:4173
# optional: put `peephole` on your PATH for the committed blocks to run as-is
npm link        # or: npm i -g .
```

Run every CLI command **from the target repo's root**, so `--repo .` and `.peephole/` resolve to
that checkout.

## Verifying a change

There is no automated test suite yet. Verify by exercising the real surfaces:

1. **Plugin manifests** — must pass the official validator with no new warnings:
   ```bash
   claude plugin validate .
   ```
2. **Plugin load** — start a session with the plugin loaded and confirm the hooks fire, the skill
   triggers, and the commands run:
   ```bash
   claude --plugin-dir .
   ```
3. **Board + CLI** — run `serve`, then create → claim → advance a throwaway ticket and watch it move
   on the board. Check the self-check and **Fix it** still scaffold correctly on a fresh repo.

If you add logic worth guarding, a `*.test.js` and a `test` script are welcome — call it out in the
PR so reviewers know what it covers.

## Commits & pull requests

- Branch off `main`; keep PRs small and focused on one change.
- Write **why**, not just what, in the commit body — the board links tickets to the sessions that
  did the work, and the commit is the other half of that trail.
- Update `README.md` / `CLAUDE.md` when behavior or setup changes, and bump `version` in both
  `package.json` and `.claude-plugin/plugin.json` together for a user-visible release.
- Note any change to the HTTP API, the ticket schema, or the hook contract explicitly — those are
  the plugin's public surface.

## Reporting issues

Open an issue with: what you ran (the exact command and port), what you expected, what happened, and
your Node and Claude Code versions. For board problems, the startup line (it names the ledger branch
and whether a clone or the worktree fallback is in use) is the most useful single clue.
