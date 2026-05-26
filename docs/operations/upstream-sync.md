# Upstream Sync

Jarvis Mission Control is forked from [Agent-3-7/minions](https://github.com/Agent-3-7/minions). This document describes the workflow for pulling upstream changes into the fork.

## Remote Setup

Verify that both remotes are configured:

```bash
git remote -v
```

Expected output:
```
origin    https://github.com/rewasa/jarvis-mission-control.git (fetch)
origin    https://github.com/rewasa/jarvis-mission-control.git (push)
upstream  https://github.com/Agent-3-7/minions.git (fetch)
upstream  https://github.com/Agent-3-7/minions.git (push)
```

If `upstream` is missing, add it:

```bash
git remote add upstream https://github.com/Agent-3-7/minions.git
```

## Sync Flow

```bash
# Fetch latest from both remotes
git fetch upstream
git fetch origin

# Switch to main and merge upstream
git checkout main
git merge upstream/main

# Resolve any conflicts
# ...

# Build to verify compatibility
npm run build

# Push fork's main
git push origin main
```

## Handling Conflicts

If `git merge upstream/main` produces conflicts:

1. Resolve each conflict file manually.
2. `git add <resolved-files>`
3. `git merge --continue`
4. Build and test: `npm run build`
5. Push: `git push origin main`

## When to Sync

- Before starting new feature work (to avoid diverging too far).
- When upstream releases a new version (check `git tag --list` on upstream).
- Periodically — at least once per month if active development is ongoing.

## Preserving Fork Identity

After syncing, ensure that fork-specific changes are preserved:

- `package.json` — name (`jarvis-mission-control`), version, description
- `README.md` — fork branding
- `docs/operations/` — upstream-sync and other operating docs
- `docs/deploy/` — tunnel/pm2 deployment docs (JMC-specific)
- `.env.example` — JMC-specific variables

A quick way to see fork-specific files after a merge:

```bash
git diff upstream/main -- package.json README.md docs/ .env.example
```

## Reset to Upstream (Nuclear Option)

If the fork has diverged significantly and you want to re-base cleanly:

```bash
git checkout main
git reset --hard upstream/main
git push origin main --force-with-lease
```

Then re-apply fork changes (package.json, README, docs) manually.
