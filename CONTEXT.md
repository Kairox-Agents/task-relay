# Task-Relay — Project Context

**Last Updated:** 2026-04-12
**Telegram Topic ID:** 232
**Folder:** `projects/task-relay/`

## What It Is

A lightweight local worker daemon (TypeScript/Node.js) that runs on a user's machine and lets remote agents submit tasks for local execution. Think: turning Claude Code / Codex CLI into callable endpoints over Tailscale.

## Current State

**Phase: Planning complete, awaiting implementation approval.**

All architecture decisions resolved. One-pager updated with full details.

## Key Decisions (All Resolved)

| Decision | Choice | Rationale |
|---|---|---|
| Target user | Solo user, own machines | Philip's MacBook Pro on Tailscale |
| Network | Tailscale only | All machines on Tailscale, ACLs for access control |
| Language | TypeScript / Node.js | Best agent tooling ecosystem, npm distribution |
| Task intake | REST API + MCP Server | REST = core transport, MCP = thin adapter for agent discovery |
| Isolation | Docker (default) + Host (opt-in) | Docker for safe defaults, host for trusted agents |
| Concurrency | 1 concurrent agent task | Start simple, increase later |
| Browser | Browserbase + Firecrawl (v1.1) | Zero local risk, Playwright last resort v2 |
| Auth | API key over Tailscale | Tailscale = network, API key = app |
| License | BSL 1.1 (3-year change) | Individuals free, SaaS needs license, → Apache 2.0 |
| Coordination | Linear plugin (v1.1) | Core is task-in→result-out, Linear is plugin via webhooks |
| Package name | task-relay | npm: `npx task-relay start` |
| DB | Better-SQLite3 | Embedded, zero deps, good for task state |

## Architecture

```
Agent → Tailscale → Task-Relay (HTTP daemon :8080)
                        ├── REST API (submit/status/stream)
                        ├── MCP Server (agent discovery)
                        ├── Executor: Docker mode (default)
                        │     ├── Claude Code (claude -p --output-format stream-json)
                        │     └── Codex CLI (codex exec --full-auto --json)
                        ├── Executor: Host mode (opt-in, subprocess)
                        ├── Shell executor
                        └── Plugin hooks (Linear v1.1)
```

## CLI Integration (from agent-cli-skills research)

- **Claude Code v2.1.81:** `claude -p "prompt" --output-format stream-json --dangerously-skip-permissions --max-budget-usd 1.00`
  - NDJSON streaming, JSON schema output, tool whitelisting
  - No native sandbox → Docker mode important
- **Codex CLI v0.114.0:** `codex exec "prompt" --full-auto --json`
  - JSONL event stream, session resume, built-in sandboxes
  - AGENTS.md cross-tool config

## Implementation Plan (5 phases)

1. **Core Daemon + REST API** — HTTP server, task model, SQLite, auth, shell executor
2. **Agent Executors** — Claude Code + Codex executors, concurrency queue, budget limits
3. **Docker Isolation** — Container-per-task, Dockerfile, volume mounting, network isolation
4. **MCP Server** — MCP adapter over stdio, tool definitions, capability discovery
5. **Polish + Docs + Ship** — Config, logging, README, npm publish, CI, BSL 1.1 license

## Files

- `docs/brief.md` — Original project brief
- `docs/one-pager.html` — Visual architecture one-pager (published as GitHub gist)
- `README.md` — Project overview

## Key References

- [agent-cli-skills](https://github.com/philipbankier/agent-cli-skills) — CLI comparison matrix, automation patterns
- [MCP SDK](https://github.com/anthropics/model-context-protocol) — For MCP server implementation
- [Hono](https://github.com/honojs/hono) — HTTP framework
