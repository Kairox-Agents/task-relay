# Task-Relay — Project Context

**Last Updated:** 2026-04-16 14:03 UTC (Real-world E2E validated, 214/214 unit + 25/25 E2E)
**Telegram Topic ID:** 232
**Folder:** `projects/task-relay/`

## What It Is

A lightweight local worker daemon (TypeScript/Node.js) that runs on a user's machine and lets remote agents submit tasks for local execution over Tailscale.

## Current State

**Phase: Phase 4 COMPLETE ✅ — Ready for Phase 5 (Backup + Polish + Ship)**

**Test Coverage:**
- 214/214 unit/integration tests passing (18 files)
- 25/25 real-world E2E tests passing (4.9s) — `test/e2e/real-world.ts`
- Real-world E2E starts actual daemon subprocess, tests all endpoints end-to-end

✅ **Phase 1 Complete:** Config, DB, HTTP API, executor framework, shell executor, CLI
✅ **Phase 2 Complete:** ClaudeCodeExecutor (SDK + CLI fallback), budget/cancel/streaming
🚧 **Phase 3 Partial:** Docker runner utility done, needs Dockerfile + real host validation
✅ **Phase 4 Complete:** MCP server (5 tools, stdio → HTTP forwarding, registered as bin)

📋 **Phase 5: Backup + Polish + Ship** — S3 backup, retention, graceful shutdown, README, npm publish
📋 **Phase 6: Judge Loop (v1.1)** — Deterministic checks, LLM judge, correction loop

**GitHub:** https://github.com/Kairox-Agents/task-relay (clean, task-relay subtree only)

## Key Decisions

| Decision | Choice | Rationale |
|---|---|---|
| Network | Tailscale only | ACLs for access control |
| Task intake | REST API core + MCP thin adapter | MCP forwards to HTTP localhost, no shared DB |
| Isolation | Docker (default) + Host (opt-in) | Docker for safety, host for trusted agents |
| DB | Better-SQLite3 (WAL mode) | Embedded, multi-process safe |
| Auth | API key over Tailscale | Network + app layer |
| License | BSL 1.1 (3-year → Apache 2.0) | Individuals free, SaaS needs license |
| Codex CLI | Deferred from v1 | Flag info was inaccurate |
| Test philosophy | Real behavior only, no mocks | External services only acceptable boundary |

## Bugs Found & Fixed (7 total)

1. Queue.add() rejected valid tasks when maxQueueSize=0 + running slot available
2. Shell executor threw on sync spawn errors instead of returning result
3. DELETE /tasks/:id didn't call daemon.cancelTask() — cancel was DB-only
4. env validation errors thrown as raw Error (500) not ApiError (400)
5. Malformed JSON body threw SyntaxError (500) not ApiError (400)
6. Daemon wired through to API server for real cancellation
7. Claude-code executor not registered in test

## Real-World E2E Coverage (25 tests)

- Health check, capabilities
- Shell task: submit → execute → complete → get result
- Env vars, timeout enforcement, non-zero exit codes
- Task cancellation, CRUD operations
- Auth: wrong key, missing header
- Validation: invalid type, disallowed path/env, malformed JSON, isolation mismatch
- Concurrency (maxConcurrent=2), queue full rejection
- 404 handling, sanitized responses (no prompt leak)

## Architecture

```
Agent → Tailscale → Task-Relay (HTTP daemon :8080)
  ├── REST API (submit/status/stream)
  ├── MCP Server (stdio → HTTP localhost forwarding)
  ├── Shell executor (host only)
  ├── Claude Code executor (SDK + CLI fallback)
  ├── Docker executor (foundation, needs Dockerfile)
  └── Backup: S3-compatible (Phase 5)
```

## Files

- `docs/brief.md` — Original project brief
- `docs/implementation-spec.md` — Full implementation specification
- `docs/test-plan.md` — Test plan with P0-P3 priorities
- `test/e2e/real-world.ts` — Real-world E2E test suite (25 tests)
- `src/mcp/server.ts` — MCP server (5 tools, stdio transport)
