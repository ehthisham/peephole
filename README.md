# Peephole — Local Mode

Local-first live status interface into multi-agent AI work. Reads `.peephole/**` straight out of a
git repo (no server, no auth, no bot credential) and writes control changes back through your own
git identity. See the [project plan](../peephole-plan) for the full design.

## Enable it on a new project

No per-project install — this one checkout of `peephole` serves any repo via `--repo`:

```
cd ~/workx/peephole
node bin/peephole.js serve --repo /path/to/other-repo --port 4174   # pick a free port
```

Open the printed `http://localhost:<port>` link. First run shows an issues list (missing
`config.yaml` / `tickets/` / `agents/` / CLAUDE.md and README pointers) — click **Fix it** once to
scaffold all of it and commit locally. That includes a `<!-- peephole:start -->` section in
`CLAUDE.md` (so any agent working the repo discovers the ticket convention on its own) and one in
`README.md` (the exact command above, so a human opening the repo finds the live board). Push when
ready.

## Run it (already set up)

```
node bin/peephole.js serve --repo /path/to/your/repo --port 4173
```

Then open http://localhost:4173.

Writes (scaffold, control changes) land in a dedicated worktree at
`<repo>/.peephole-worktree`, on a local branch named `peephole/<stateBranch>` — your own
checkout, branch, and uncommitted changes are never touched. Nothing is pushed to the remote until
you click **Push to remote** and confirm.

## What it does

- **Pull latest** — `git fetch` + re-read, on demand.
- **Auto-fetch** — same, on a timer (minutes, configurable), for when no webhook/hook exists yet.
- **Self-check** — flags a missing `config.yaml` / `tickets/` / `agents/` (and a missing
  CLAUDE.md / README.md pointer) as a plain issues list; **Fix it** scaffolds exactly what's
  missing and commits locally.
- **Control** — Run / Pause / Skip / Restart per ticket, written to that ticket's `control` field
  and committed locally; every write appends to the ticket's `history`.
- **Agents panel** — reads `.peephole/agents/*.json` heartbeats, marks a session `stale` once its
  heartbeat goes quiet for 5+ minutes.

## Not yet built

- The Claude Code hook that makes `control` self-enforcing on an agent session (Phase 4 in the plan).
- Bitbucket branch/PR/CI/deploy enrichment (Phase 5).
- Hosted Mode — a shared always-on instance with auth (Phase 7) — deliberately deferred.
