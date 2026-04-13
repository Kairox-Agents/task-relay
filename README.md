# Task-Relay

**Telegram Topic ID:** 232
**Created:** 2026-04-11
**Status:** Ready for implementation (spec v2.0)

## Overview

A lightweight local worker daemon (TypeScript/Node.js) that runs on your machine and lets remote agents, teammates, or services submit tasks for local execution over Tailscale. Turns manual tools like Claude Code into a callable endpoint with quality gates, backup, and graceful shutdown.

## Key Links & Resources

- **[Project Brief](docs/brief.md)** — Original project brief
- **[Implementation Spec](docs/implementation-spec.md)** — Full technical specification (v2.0)
- **[Architecture One-Pager](docs/one-pager.html)** — Visual architecture overview
- **[Research Landscape](docs/research-landscape.md)** — Agent-as-worker ecosystem research

## Quick Start

```bash
# Install via npm (planned)
npm install -g task-relay

# Start the daemon
task-relay start

# Submit a task via REST API
curl -X POST http://localhost:8080/tasks \
  -H "Authorization: Bearer $TASK_RELAY_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "type": "claude-code",
    "prompt": "Add unit tests for src/auth.ts",
    "working_dir": "/Users/philip/projects/myapp",
    "model": "sonnet",
    "isolation": "docker"
  }'
```

## Architecture (v2.0)

```
Agent → Tailscale → Task-Relay (HTTP daemon :8080)
                        ├── REST API (submit/status/stream)
                        ├── MCP Server (→ HTTP localhost)
                        ├── Executor: Docker mode (default)
                        │     └── Claude Code (via Claude Agent SDK)
                        ├── Executor: Host mode (opt-in)
                        ├── Executor: Worktree mode (v1.1)
                        ├── Shell executor (host only)
                        ├── Judge loop (v1.1): checks → judge → decision
                        ├── Backup: S3-compatible (log + full + traces)
                        └── Plugin hooks (Linear v1.1, Codex v1.1)
```

## Tech Stack

| Component | Technology |
|-----------|------------|
| Language | TypeScript / Node.js |
| HTTP Framework | Hono |
| Database | Better-SQLite3 (WAL mode) |
| Claude Code | Claude Agent SDK (primary) + CLI fallback |
| MCP | @modelcontextprotocol/sdk |
| Backup | @aws-sdk/client-s3 (S3-compatible) |
| Isolation | Docker (default), Host (opt-in), Worktree (v1.1) |
| Network | Tailscale |
| License | BSL 1.1 (→ Apache 2.0 after 3 years) |

## Key Features

### v1.0 (Planned)

- **REST API** — Submit, monitor, and stream task results
- **MCP Server** — Tool discovery for Claude, Cursor, and other MCP clients
- **Claude Code Executor** — Full Claude Code integration via SDK with hooks and budget tracking
- **Shell Executor** — Simple command execution for trusted tasks
- **Docker Isolation** — Container-per-task with resource limits
- **Task Queue** — Concurrency-limited execution (default: 1)
- **S3 Backup** — Incremental logs, full backups, and agent trace backup
- **Graceful Shutdown** — Clean shutdown with task completion
- **Task Retention** — Automatic pruning of old tasks

### v1.1 (Planned)

- **Judge Loop** — Deterministic checks (tests/lint/typecheck) + LLM judge + correction loop
- **Worktree Isolation** — Lightweight git-based isolation with review-gated merge
- **Cross-Model Review** — Different model for judging vs executing
- **Escalation Logic** — Automatic escalation when stuck or stuck in loops

## Implementation Status

- [x] Project brief
- [x] Architecture one-pager
- [x] Full implementation specification (v2.0)
- [x] Research: agent-as-worker landscape
- [x] Research: Claude Agent SDK integration
- [x] Spec reviewed and approved
- [ ] Phase 1: Core Daemon + REST API
- [ ] Phase 2: Claude Code Executor (SDK)
- [ ] Phase 3: Docker Isolation
- [ ] Phase 4: MCP Server
- [ ] Phase 5: Backup + Polish + Ship
- [ ] Phase 6: Judge Loop (v1.1)

## Configuration

Config file: `~/.task-relay/config.yaml`

```yaml
server:
  port: 8080
  bind: "0.0.0.0"

auth:
  api_keys:
    - id: "openclaw-agent"
      key: "${TASK_RELAY_API_KEY}"
      allowed_types: ["shell", "claude-code"]

execution:
  default_isolation: "docker"
  max_concurrent: 1

executors:
  claude-code:
    enabled: true
    default_model: "sonnet"
    judge_model: "haiku"  # v1.1
    default_budget_usd: 1.00

backup:
  enabled: true
  provider: "s3"
  endpoint: "https://s3.us-west-004.backblazeb2.com"
  bucket: "task-relay-backups"
```

## API Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/tasks` | Submit a new task |
| GET | `/tasks` | List all tasks |
| GET | `/tasks/:id` | Get task status |
| GET | `/tasks/:id/stream` | SSE stream of task events |
| DELETE | `/tasks/:id` | Cancel a task |
| GET | `/health` | Health check |
| GET | `/capabilities` | List available executors and models |

## License

Business Source License 1.1 (BSL 1.1)

- **Free for individuals** — Use, modify, and distribute freely
- **Commercial use requires license** — SaaS, hosted services, or multi-tenant deployments need a commercial license
- **Changes to Apache 2.0 after 3 years** — Starting April 13, 2029, this project converts to Apache 2.0

See [LICENSE](LICENSE) for details.

## Contributing

This is currently a solo project for Philip Bankier. Issues and PRs welcome, but no external contributors at this time.

## Contact

- **Telegram Topic:** Hunter AI - Workhorse (Topic 232)
- **GitHub:** [philipbankier/task-relay](https://github.com/philipbankier/task-relay)
