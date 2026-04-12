# Task-Relay — Project Context

**Last Updated:** 2026-04-12
**Telegram Topic ID:** 232
**Folder:** `projects/task-relay/`

## What It Is

A lightweight local worker daemon (TypeScript/Node.js) that runs on a user's machine and lets remote agents submit tasks for local execution. Think: turning Claude Code into a callable endpoint over Tailscale.

## Current State

**Phase: Spec audited and corrected. Ready for implementation approval.**

v1 scope: Claude Code + shell executors only. Codex CLI deferred (inaccurate flag info).

## Key Decisions (All Resolved)

| Decision | Choice | Rationale |
|---|---|---|
| Target user | Solo user, own machines | Philip's MacBook Pro on Tailscale |
| Network | Tailscale only | All machines on Tailscale, ACLs for access control |
| Language | TypeScript / Node.js | Best agent tooling ecosystem, npm distribution |
| Task intake | REST API + MCP Server | REST = core transport, MCP = thin adapter via localhost HTTP |
| Isolation | Docker (default) + Host (opt-in) | Docker for safe defaults, host for trusted agents |
| Concurrency | 1 concurrent agent task | Start simple, increase later |
| Browser | Browserbase + Firecrawl (v1.1) | Zero local risk, Playwright last resort v2 |
| Auth | API key over Tailscale | Tailscale = network, API key = app |
| License | BSL 1.1 (3-year change) | Individuals free, SaaS needs license, → Apache 2.0 |
| Coordination | Linear plugin (v1.1) | Core is task-in→result-out, Linear is plugin via webhooks |
| Package name | task-relay | npm: `npx task-relay start` |
| DB | Better-SQLite3 (WAL mode) | Embedded, verified multi-process safe with WAL + busy_timeout |
| Backup | S3-compatible object storage | Backblaze B2 primary, supports AWS S3/MinIO/R2/Wasabi |
| Agent traces | Per-task backup to S3 | Claude: session transcripts + debug via --session-id (path verified) |
| Codex CLI | Deferred from v1 | --ephemeral doesn't exist, --full-auto/--dangerously-bypass are mutually exclusive |
| MCP architecture | MCP server → HTTP localhost | No shared DB access, eliminates concurrency issues |

## Architecture

```
Agent → Tailscale → Task-Relay (HTTP daemon :8080)
                        ├── REST API (submit/status/stream)
                        ├── MCP Server (→ HTTP localhost, not direct DB)
                        ├── Executor: Docker mode (default)
                        │     └── Claude Code (claude -p --session-id {task_id} --output-format stream-json --verbose)
                        ├── Executor: Host mode (opt-in, subprocess)
                        ├── Shell executor (host only, no Docker mode)
                        ├── Backup: S3-compatible (log + full + agent traces)
                        └── Plugin hooks (Linear v1.1, Codex v1.1)
```

## CLI Integration (verified)

- **Claude Code:** `claude -p "prompt" --output-format stream-json --verbose --dangerously-skip-permissions --max-budget-usd 1.00 --session-id {task_id}`
  - `--session-id` must be UUID format (verified)
  - `--verbose` REQUIRED with stream-json or output fails silently
  - Do NOT use `--no-session-persistence` — prevents .jsonl trace backup
  - Session transcript path: `~/.claude/projects/{cwd-dashed}/{task_id}.jsonl` (verified)
  - `{cwd-dashed}` = working_dir with `/` replaced by `-` (verified)
- **Codex CLI:** DEFERRED — flag info was inaccurate. Needs fresh research.

## Implementation Plan (5 phases)

1. **Core Daemon + REST API** — HTTP server, task model, SQLite (WAL), auth, shell executor
2. **Claude Code Executor** — subprocess, stream-json parsing, --session-id, budget/timeout
3. **Docker Isolation** — Dockerfile, container-per-task, volume mounting, resource limits
4. **MCP Server** — stdio transport → HTTP localhost forwarding, tool definitions
5. **Backup + Polish + Ship** — S3 (log/full/traces), retention, graceful shutdown, docs, npm publish, BSL 1.1

## Files

- `docs/brief.md` — Original project brief
- `docs/implementation-spec.md` — Full implementation specification (v1.1 — audited)
- `docs/one-pager.html` — Visual architecture one-pager (published as GitHub gist)
- `README.md` — Project overview

## Key References

- [agent-cli-skills](https://github.com/philipbankier/agent-cli-skills) — CLI comparison matrix, automation patterns
- [MCP SDK](https://github.com/anthropics/model-context-protocol) — For MCP server implementation
- [Hono](https://github.com/honojs/hono) — HTTP framework
- [better-sqlite3](https://github.com/WiseLibs/better-sqlite3) — WAL mode docs, performance guide
