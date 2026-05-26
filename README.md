# Jarvis Mission Control

**A Hermes-native mission control dashboard** — Kanban board, task hierarchy (subissues/delegation), Cloudflare Tunnel support, and Linear-style cards for supervising autonomous Hermes Agent work.

> Forked from [Agent-3-7/minions](https://github.com/Agent-3-7/minions) — all credit to the upstream Minions team for the underlying architecture.

## Demo

## Quick Start

**Prerequisites:** Node.js 18+ and [Hermes Agent](https://hermes-agent.nousresearch.com)

```bash
npx jarvis-mission-control
```

Open [http://localhost:6969](http://localhost:6969).

Local SQLite database is created on first run and state lives in `~/.minions/` (compatible with upstream Minions data).

Check the installed version:

```bash
npx jarvis-mission-control --version
```

The Settings page also shows the version of the running server.

## Features

- **Kanban board**: see every task at a glance: in progress, in review, done
- **Subissues & delegation**: create child tasks with parent context for multi-step workflows
- **Autonomous execution**: describe what you want in chat, walk away; the agent decides how to get it done
- **Automatic review queue**: successful agent runs move cards to ready for review
- **Live streaming**: watch tool calls, reasoning, and responses in real time
- **Human-in-the-loop**: agents propose completion; you verify and close. Nothing moves to done without your sign-off
- **Per-task model control**: override model and reasoning effort on any task
- **Scheduled Tasks**: create and manage recurring Hermes jobs, history, and output
- **File browser**: see files agents have created in the workspace directory
- **Cloudflare Tunnel ready**: loopback-bound by default, documented tunnel setup with Access protection
- **iOS compatible**: viewport-aware, SSE fallback with polling for mobile Safari
- **Local-first option**: self-host with SQLite, no account, and no cloud dependency. Your local data stays on your machine

## How It Works

Each task is a persistent Hermes root session. You talk to it, it works, and the board reflects where everything stands. Chat transcripts live in Hermes's session database; Jarvis Mission Control stores task metadata, status, subissue hierarchy, and per-task settings in a local SQLite database (`~/.minions/minions.db`).

## Who It's For

- **Hermes power users** juggling multiple sessions across projects
- **Indie founders** delegating research, ops, writing, and coding to their agent
- **Anyone running long-lived Hermes work** who needs to know what finished, what's stuck, and what needs attention

## Upstream Sync

This repository tracks upstream [Agent-3-7/minions](https://github.com/Agent-3-7/minions). See [docs/operations/upstream-sync.md](docs/operations/upstream-sync.md) for the sync workflow.

## Contributing

Contributions are welcome. Please open an issue first with the feature or change you have in mind and why it should be added. Once the approach is approved, create a PR. See [CLAUDE.md](CLAUDE.md) for architecture and development details.

## License

MIT — see [LICENSE](LICENSE).
