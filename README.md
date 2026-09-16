# Peephole — Local Mode

Local-first live status interface into multi-agent AI work. Reads `.peephole/**` straight out of a
git repo (no server, no auth, no bot credential) and writes control changes back through your own
git identity. See the [project plan](../peephole-plan) for the full design.

## Adding Peephole to a repo

Peephole is a separate checkout that serves any number of repos — nothing is installed into the
repo you are tracking, and the repo gains no dependency on this one. What lands in your repo is
data (`.peephole/`) plus two documentation sections; what stays on your machine is the hook wiring
and a git worktree.

### A repo that has never used it

```
cd ~/workx/peephole
node bin/peephole.js serve --repo /path/to/your-repo --port 4173
```

The board opens on a self-check listing what is missing. **Fix it** creates all of it in one local
commit, on the peephole-owned branch inside your repo:

| what | where | committed? |
|---|---|---|
| `config.yaml`, `tickets/`, `agents/` | `.peephole/` in your repo | yes |
| ticket convention for agents | `CLAUDE.md`, between `peephole:start`/`peephole:end` | yes |
| how to open the board | `README.md`, same markers | yes |
| SessionStart / PreToolUse / SessionEnd hooks | `.claude/settings.local.json` | **no — per machine** |
| the working copy writes go through | `.peephole-worktree/` | no — add it to `.gitignore` |

Then click **Push to remote** to share it. Nothing reaches the remote before that.

The hooks are what make the board live: they report each session, enforce pause/skip before every
tool call, and attach token usage. They are written with absolute paths to *this* peephole
checkout, which is why they are per-machine and not committed.

### A repo somebody has already set up

Your teammate's `.peephole/` arrives with a normal `git pull`; the board is not part of it. Get
your own copy of Peephole and point it at the repo:

```
git clone <peephole repo> ~/workx/peephole && cd ~/workx/peephole && npm install
node bin/peephole.js serve --repo /path/to/the-repo --port 4173
```

Every ticket is already there — it is committed repo content. The self-check will still report a
missing hook setup, because `.claude/settings.local.json` is per machine; **Fix it** wires your
own hooks and creates nothing else.

### Notes

- One port per repo — run a second `serve` with `--port 4174` to watch another.
- Requires Node 18+ and a git remote; the board reads the remote's default branch (see
  **Where the files live**).
- The server listens on `127.0.0.1` only. See **Executing tickets** before exposing it.

## Several projects, one board

The project name in the header is a menu. Every repo you have ever served is in it — the list is
built by running the board against a repo, so there is no separate "add project" step, and it is
kept in `~/.peephole/projects.json`, outside every repo it lists (one developer's local paths have
no business travelling to another machine in a git repo).

Switching re-points the whole board: ledger, tickets, coverage, agents, queue. Anything queued for
execution is cancelled first — dispatching it against another repo would run a ticket in the wrong
codebase. A project whose checkout has moved is shown, disabled, rather than hidden.

## Where the ledger is checked out

Peephole keeps its own sparse clone of the repo at `~/.peephole/ledgers/<slug>`, on the ledger
branch, with only `.peephole/` checked out — measured on a real repo: 120 files and 512 KB, against
37 MB for a full worktree. Nothing is added to your repo, and whatever your own checkout is doing
(dirty, mid-rebase, on another branch) is irrelevant to the board.

It falls back to `<repo>/.peephole-worktree` when a clone cannot serve, and the board says which is
in use and why:

- the repo has no remote to clone from
- the ledger branch has never been pushed, so there is nothing to clone yet
- the worktree still holds unpushed ledger commits — switching would show a board missing them

Pushing a ledger branch for the first time moves the ledger out of the repo on the next fetch, with
no restart.

## Moving an existing ledger to its own branch

```
node bin/peephole.js ledger move --repo /path/to/repo --to peephole-state [--push]
```

The target branch is created FROM the current ledger branch, so tickets travel as commits with
their full history, comments and all; the old branch is left exactly as it was, and pointing
`stateBranch` back at it restores the previous board. The command prints the ticket count before
and after and names anything that failed to make the trip. Both branches end up declaring the new
home, so teammates follow automatically once it is pushed.

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
- **Autosync** — on a timer (minutes, configurable): pushes the waiting ledger commits, then
  fetches and re-reads. The push happens only if every waiting file is under `.peephole/`; anything
  else and it refuses and says so, since the state branch may be an ordinary code branch and an
  unattended push of somebody's code is not something a toggle should be able to do.
- **Self-check** — flags a missing `config.yaml` / `tickets/` / `agents/` (and a missing
  CLAUDE.md / README.md pointer) as a plain issues list; **Fix it** scaffolds exactly what's
  missing and commits locally.
- **Control** — Run / Pause / Skip per ticket, written to that ticket's `control` field
  and committed locally; every write appends to the ticket's `history`.
- **Agents panel** — reads `.peephole/agents/*.json` heartbeats, marks a session `stale` once its
  heartbeat goes quiet for 5+ minutes.

## Executing tickets

Select proposed tickets with the ✓ on their card, then **Execute** one (▷) or the whole selection
from the toolbar. Peephole hands each ticket to a live Claude session in the repo — resuming an
idle one where possible, starting a background session only when the repo has none, and holding
the queue while every session is busy. The ticket is claimed and moved to in-progress at dispatch.

Each dispatch asks which permission mode the agent runs with. `plan` and `acceptEdits` are always
available. `bypassPermissions` — an agent that may run **any** tool, unattended, in your repo — is
refused unless the server was started with `PEEPHOLE_ALLOW_BYPASS=1`.

The server listens on `127.0.0.1` only. Every endpoint is unauthenticated and they create tickets,
push branches and start agents, so exposing the port means handing all of that to anyone who can
reach it; `--host 0.0.0.0` exists but prints a warning, and turning it on together with
`PEEPHOLE_ALLOW_BYPASS=1` is remote code execution by design.

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

### Which branch the ledger lives on

A fresh setup puts the ledger on its own branch, **`peephole-state`**, created from the remote's
default on the first write and shared on the first push. A dedicated branch keeps ticket commits
out of the code history and gives a team one obvious place for them, so nobody starts a second
ledger on a branch of their own. (Not simply `peephole`: the worktree's local branch is
`peephole/<stateBranch>`, and git cannot hold both `refs/heads/peephole` and `refs/heads/peephole/…`.)

Resolved in this order: `--branch` on the command line, then `stateBranch` in the repo's committed
`.peephole/config.yaml`, then an existing `peephole-state` branch on the remote, then a new one.
A repo set up before this — whose config names a code branch — keeps reading that branch.

Declare it in `config.yaml` and keep it generic — `main`, or a dedicated `peephole` branch. The
last resort is whatever a git host happens to report as default, which is not necessarily stable: a
repo whose default is set to a feature branch pins the entire ticket ledger to that branch, and
when it merges and is deleted the tickets leave the default line with it. It is also per-machine —
if `git remote show` fails (offline, no auth) each machine falls back to its own checked-out branch
and quietly reads a different board. A board resolved that way says so in the startup line and
marks the branch in the header.

Changing `stateBranch` later points the board at a different branch; it does not move the tickets.
Merge or cherry-pick `.peephole/` onto the new branch first, or the board opens empty.

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
