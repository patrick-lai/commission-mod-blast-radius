# Blast radius

A built-in [CommissionAI](https://github.com/patrick-lai) mod (protocol 3). Shows what a destructive command would touch, under its permission card.

When an agent asks to run something the daemon already classifies as destructive, the worker measures it with read-only probes inside the thread's worktree and adds the result to the card: files and size for `rm`, uncommitted changes for `git reset --hard`, `checkout .` and `restore .`, a dry run for `git clean`, dropped remote commits for force pushes, and the target of database drop or reset tools. The command itself never runs; a probe that fails shows "Couldn't measure this one."

## Rules it follows
- It only adds beside a core surface; with it off, crashed or outdated, the app looks and behaves exactly as without it.
- It never allows, rejects or delays anything, and never saves anything without a button the person presses.

## Develop
```sh
node --test 'mods/blast-radius/test/*.test.mjs'
COMMISSION_MODS_DIR=$PWD/mods   # point a dev daemon at this checkout; edits show on the next event or refresh
```
Node 20 or newer, no npm dependencies. The contract (manifest, worker protocol, hooks, capabilities, slots) is in CommissionAI's `docs/mods.md`, section "Protocol 3".

## Ship
CommissionAI registers this repository as a built-in pack and follows its head: push to `main` and every install picks it up within a day, without an app release.
