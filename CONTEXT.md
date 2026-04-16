# Task-Relay — Project Context

**Last Updated:** 2026-04-16 14:50 UTC (Phase 5 Backup foundation complete, pending S3 test)
**Telegram Topic ID:** 232
**Folder:** `projects/task-relay/`

## What It Is

A lightweight local worker daemon (TypeScript/Node.js) that runs on a user's machine and lets remote agents submit tasks for local execution over Tailscale.

## Current State

**Phase: Phase 5 IN PROGRESS 🚧 — Backup system implemented, needs S3 connectivity test**

✅ **Phase 1 Complete:** Config, DB, HTTP API, executor framework, shell executor, CLI
✅ **Phase 2 Complete:** ClaudeCodeExecutor (SDK + CLI fallback), budget/cancel/streaming
🚧 **Phase 3 Partial:** Docker runner utility done, needs Dockerfile + real host validation
✅ **Phase 4 Complete:** MCP server (5 tools, stdio → HTTP forwarding, registered as bin)
🚧 **Phase 5 Partial:** Backup system implemented, needs S3 connectivity test
📋 **Phase 6:** Judge Loop (v1.1) — Deterministic checks, LLM judge, correction loop

**Test Coverage:**
- 214/214 unit/integration tests passing (18 files)
- 25/25 real-world E2E tests passing (4.9s)
- 9 backup unit tests written (pending vitest run due to node_modules issues)

**GitHub:** https://github.com/Kairox-Agents/task-relay

## Phase 5 Progress (Backup + Polish + Ship)

### Implemented ✅
- **S3 Client** (`src/backup/s3-client.ts`): AWS SDK v3, supports Backblaze B2, AWS S3, MinIO, Cloudflare R2, Wasabi
- **Backup Manager** (`src/backup/manager.ts`): Log, full, and trace backups
- **Incremental log backup**: Tasks since last timestamp → NDJSON → S3
- **Full backup**: SQLite checkpoint → gzip → S3
- **Agent trace backup**: Claude Code session `.jsonl` → S3 (per-task)
- **Retention enforcement**: Cleanup old backups by date
- **State persistence**: `~/.task-relay/backup-state.json`
- **Graceful shutdown**: Flush pending traces on stop
- **Daemon integration**: Backup on claude-code task completion
- **CLI integration**: Initialize and start backup manager

### Pending ⏳
- **S3 connectivity test**: Requires real credentials (AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY)
- **Vitest runner tests**: node_modules install issue in current environment
- **Polish items**: README, docs, npm publish preparation

### Backup Config
```yaml
backup:
  enabled: true
  provider: "s3"
  endpoint: "https://s3.us-west-004.backblazeb2.com"  # or AWS/MinIO/R2
  bucket: "task-relay-backups"
  region: "us-west-004"
  log_interval_ms: 300000      # 5 minutes
  full_interval_hours: 24      # Daily
  retention_days: 30
```

## Key Decisions

| Decision | Choice | Rationale |
|---|---|---|
| Network | Tailscale only | ACLs for access control |
| Task intake | REST API core + MCP thin adapter | MCP forwards to HTTP localhost |
| Isolation | Docker (default) + Host (opt-in) | Docker for safety, host for trusted |
| DB | Better-SQLite3 (WAL mode) | Embedded, multi-process safe |
| Auth | API key over Tailscale | Network + app layer |
| License | BSL 1.1 (3-year → Apache 2.0) | Individuals free, SaaS needs license |
| Backup | S3-compatible | Backblaze B2 primary, AWS/MinIO/R2/Wasabi supported |

## Bugs Found & Fixed (7 total)

1. Queue.add() rejected valid tasks when maxQueueSize=0 + running slot available
2. Shell executor threw on sync spawn errors instead of returning result
3. DELETE /tasks/:id didn't call daemon.cancelTask() — cancel was DB-only
4. env validation errors thrown as raw Error (500) not ApiError (400)
5. Malformed JSON body threw SyntaxError (500) not ApiError (400)
6. Daemon wired through to API server for real cancellation
7. Claude-code executor not registered in test

## Architecture

```
Agent → Tailscale → Task-Relay (HTTP daemon :8080)
  ├── REST API (submit/status/stream)
  ├── MCP Server (stdio → HTTP localhost forwarding)
  ├── Shell executor (host only)
  ├── Claude Code executor (SDK + CLI fallback)
  ├── Docker executor (foundation, needs Dockerfile)
  ├── Backup Manager
  │   ├── Log backup (incremental → S3)
  │   ├── Full backup (DB snapshot → S3)
  │   └── Trace backup (Claude sessions → S3)
  └── Retention (cleanup old tasks/backups)
```

## Files

- `docs/brief.md` — Original project brief
- `docs/implementation-spec.md` — Full implementation specification
- `docs/test-plan.md` — Test plan with P0-P3 priorities
- `test/e2e/real-world.ts` — Real-world E2E test suite (25 tests, 25/25 passing)
- `src/mcp/server.ts` — MCP server (5 tools, stdio transport)
- `src/backup/s3-client.ts` — S3 client (AWS SDK v3)
- `src/backup/manager.ts` — Backup manager (log/full/trace)
- `test/backup/manager.test.ts` — Backup manager tests (9 tests)
