# Task-Relay — Project Context

**Last Updated:** 2026-04-15 20:08 UTC (Phase 4 complete, 214/214 tests passing, MCP server ready)
**Telegram Topic ID:** 232
**Folder:** `projects/task-relay/`

## What It Is

A lightweight local worker daemon (TypeScript/Node.js) that runs on a user's machine and lets remote agents submit tasks for local execution. Think: turning Claude Code into a callable endpoint over Tailscale.

## Current State

**Phase: Phase 4 COMPLETE ✅ — 214/214 tests passing. Phase 5 (Backup + Ship) next**

✅ **Real-World E2E Tests:** 25/25 passed (4.9s)
- Starts actual daemon subprocess
- Tests all API endpoints, executors, auth, validation
- Tests concurrency, cancellation, error handling, queue management

✅ **Phase 1 Complete:**
- Config system (zod schema, YAML loader, env var interpolation)
- Database (SQLite WAL mode, migrations, task CRUD)
- HTTP API (Hono server, auth/validation middleware, routes)
- Executor framework (types, registry, queue, shell executor)
- TaskDaemon (orchestrates execution, handles status updates)
- CLI (start/status/config commands)
- Daemon starts successfully, handles graceful shutdown

✅ **Phase 2 Complete:**
- ClaudeCodeExecutor with SDK primary + CLI fallback
- SDK: query() with permissionMode, streaming, cost tracking via total_cost_usd
- CLI: claude -p with stream-json, session-id, budget, model
- Cancel via AbortController (SDK) and SIGTERM (CLI)
- System prompt builder with acceptance_criteria
- Registered in CLI when config enables claude-code

🚧 **Phase 3 Partial:**
- Docker runner utility added (src/executor/docker.ts)
- ClaudeCodeExecutor routes isolation: 'docker' through container execution
- Shell executor explicitly rejected for non-host isolation
- Graceful failure path verified when docker is unavailable
- Still needs: Dockerfile, config wiring, real container validation

✅ **Phase 4 Complete:**
- MCP server (src/mcp/server.ts): stdio transport, 5 tools
- Tools: submit_task, get_task, list_tasks, cancel_task, get_capabilities
- Forwards all calls to HTTP daemon via localhost
- Env: TASK_RELAY_URL, TASK_RELAY_API_KEY
- Registered as `task-relay-mcp` bin entry

📋 **Phase 5: Backup + Polish + Ship**
📋 **Phase 6: Judge Loop (v1.1)**
- config: schema (14), loader (7), edge-cases (6)
- db: tasks (19), edge-cases (16)
- executor: shell (22), claude-code (7), docker (2), queue (16), queue-drain (11), daemon (14)
- api: integration (17), sse-and-misc (10)
- e2e: lifecycle (15), concurrency (5)
- security: auth-injection (13)
- utils: env (11)

Bugs found and fixed during testing:
- Queue.add() rejected valid tasks when maxQueueSize=0 + running slot available
- Shell executor threw on sync spawn errors (ENOTDIR) instead of returning result
- DELETE /tasks/:id didn't call daemon.cancelTask() — cancel was DB-only
- env validation errors thrown as raw Error (500) not ApiError (400)
- Malformed JSON body threw SyntaxError (500) not ApiError (400)
- Daemon wired through to API server for real cancellation

## Key Decisions (All Resolved)

| Decision | Choice | Rationale |
|---|---|---|
| Target user | Solo user, own machines | Philip's MacBook Pro on Tailscale |
| Network | Tailscale only | All machines on Tailscale, ACLs for access control |
| Language | TypeScript / Node.js | Best agent tooling ecosystem, npm distribution |
| Task intake | REST API + MCP Server | REST = core transport, MCP = thin adapter via localhost HTTP |
| Isolation | Docker (default) + Host (opt-in) + Worktree (v1.1) | Docker for safe defaults, host for trusted agents, worktree for lighter isolation |
| Concurrency | 1 concurrent agent task | Start simple, increase later |
| Browser | Browserbase + Firecrawl (v1.1) | Zero local risk, Playwright last resort v2 |
| Auth | API key over Tailscale | Tailscale = network, API key = app |
| License | BSL 1.1 (3-year change) | Individuals free, SaaS needs license, → Apache 2.0 |
| Coordination | Linear plugin (v1.1) | Core is task-in→result-out, Linear is plugin via webhooks |
| Package name | task-relay | npm: `npx task-relay start` |
| DB | Better-SQLite3 (WAL mode) | Embedded, verified multi-process safe with WAL + busy_timeout |
| Backup | S3-compatible object storage | Backblaze B2 primary, supports AWS S3/MinIO/R2/Wasabi |
| Agent traces | Per-task backup to S3 | Claude: session transcripts + debug via SDK/CLI |
| Judge loop | Planned v1.1 | Deterministic checks + LLM judge + correction loop + escalation |
| Codex CLI | Deferred from v1 | --ephemeral doesn't exist, --full-auto/--dangerously-bypass are mutually exclusive |
| MCP architecture | MCP server → HTTP localhost | No shared DB access, eliminates concurrency issues |

## Architecture (v2.0)

```
Agent → Tailscale → Task-Relay (HTTP daemon :8080)
                        ├── REST API (submit/status/stream)
                        ├── MCP Server (→ HTTP localhost, not direct DB)
                        ├── Executor: Docker mode (default)
                        │     └── Claude Code (via Claude Agent SDK, CLI fallback)
                        ├── Executor: Host mode (opt-in, SDK)
                        ├── Executor: Worktree mode (v1.1)
                        ├── Shell executor (host only, no Docker mode)
                        ├── Judge loop (v1.1): deterministic checks → LLM judge → decision → correct/escalate
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

## Implementation Plan (6 phases)

1. **Core Daemon + REST API** ✅ Scaffolding done, 🚧 integration in progress — HTTP server, task model, SQLite (WAL), auth, shell executor
2. **Claude Code Executor** 📋 — Claude Agent SDK (primary) + CLI fallback, hooks, session tracking, budget/timeout
3. **Docker Isolation** 📋 — Dockerfile, container-per-task, volume mounting, resource limits
4. **MCP Server** — stdio transport → HTTP localhost forwarding, tool definitions
5. **Backup + Polish + Ship** — S3 (log/full/traces), retention, graceful shutdown, docs, npm publish, BSL 1.1
6. **Judge Loop (v1.1)** — Deterministic checks, LLM judge, decision engine, worktree isolation, escalation logic

## Files

- `docs/brief.md` — Original project brief
- `docs/implementation-spec.md` — Full implementation specification (v2.0 — with SDK, judge loop, worktree)
- `docs/research-landscape.md` — Agent-as-worker landscape research
- `docs/one-pager.html` — Visual architecture one-pager (published as GitHub gist)
- `README.md` — Project overview

## Key References

- [agent-cli-skills](https://github.com/philipbankier/agent-cli-skills) — CLI comparison matrix, automation patterns
- [MCP SDK](https://github.com/anthropics/model-context-protocol) — For MCP server implementation
- [Hono](https://github.com/honojs/hono) — HTTP framework
- [better-sqlite3](https://github.com/WiseLibs/better-sqlite3) — WAL mode docs, performance guide
