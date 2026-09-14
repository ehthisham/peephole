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
- **Control** — Run / Pause / Skip per ticket, written to that ticket's `control` field
  and committed locally; every write appends to the ticket's `history`.
- **Agents panel** — reads `.peephole/agents/*.json` heartbeats, marks a session `stale` once its
  heartbeat goes quiet for 5+ minutes.

## Where the files live

Two directories with the same name, in the repo being watched — they are the same tracked path
seen from two checkouts:

- `<repo>/.peephole/` — your own branch's copy of the ticket files. Tracked and committed like any
  other source. The board never reads it; it is whatever reached your branch the last time these
  files were merged into it, so it is normally behind.
- `<repo>/.peephole-worktree/` — a git worktree (a second checkout of the same repo, sharing its
  one `.git` object store) permanently on the branch `peephole/<stateBranch>`. Every ticket write
  happens here, which is why your own checkout, branch and uncommitted changes are never touched.
  Its `.peephole/` is the live one the board reads.

Your branch catches up only after **Push to remote** and a pull — until then the board is ahead of
your `<repo>/.peephole/`.

Add `.peephole-worktree/` to the watched repo's `.gitignore`. Git does not ignore a nested worktree
on its own, so it shows up as untracked and one `git add -A` would commit the whole duplicate tree.

## Removing it from a repo

Stop the server first (the worktree is in use while it runs), then, in the watched repo:

```
git worktree remove --force .peephole-worktree     # the checkout AND its registration
git branch -D peephole/<stateBranch>               # the local state branch (e.g. peephole/main)
```

Deleting the folder by hand is not enough — the registration lives in `.git/worktrees/`, and git
will keep reporting a broken worktree until `git worktree remove` (or `git worktree prune`) clears
it.

That leaves the ticket data itself, which is ordinary tracked content. To remove that too:

```
git rm -r .peephole && git commit -m "Remove Peephole ticket data"
git push origin <stateBranch>                      # if the branch was already shared
git push origin --delete peephole/<stateBranch>    # only if that branch was ever pushed
```

Finally, unwire the per-machine bits, none of which are in the repo's history:

- `.claude/settings.local.json` — drop the hook entries pointing at `peephole/hooks/`.
- `CLAUDE.md` and `README.md` — delete the `<!-- peephole:start -->` … `<!-- peephole:end -->`
  sections the scaffold added.

Peephole's own checkout is untouched by all of this: it stores nothing about the repos it watches.

## Not yet built

- The Claude Code hook that makes `control` self-enforcing on an agent session (Phase 4 in the plan).
- Bitbucket branch/PR/CI/deploy enrichment (Phase 5).
- Hosted Mode — a shared always-on instance with auth (Phase 7) — deliberately deferred.
