# Task-Relay — Implementation Specification

**Version:** 1.0-draft
**Date:** 2026-04-12
**Status:** Pre-implementation

---

## 1. Product Definition

### What Task-Relay IS
A single-process Node.js daemon that runs on a user's machine, accepts task submissions over HTTP from agents on the same Tailscale network, and executes them locally using installed CLI tools (Claude Code, Codex CLI, shell). It returns structured results.

### What Task-Relay IS NOT (explicit anti-scope)
- ❌ NOT a multi-machine orchestrator or fleet manager
- ❌ NOT a hosted service or cloud product
- ❌ NOT a CI/CD runner (no webhooks from GitHub, no pipeline DSL)
- ❌ NOT a sandbox escape prevention system (Docker is best-effort isolation)
- ❌ NOT a real-time collaboration tool
- ❌ NOT an agent framework (it doesn't host agents, it accepts tasks FROM agents)
- ❌ NOT a replacement for Claude Code or Codex CLI (it wraps them)
- ❌ NOT a browser automation tool (v1.1+)
- ❌ NOT a job scheduler (no cron-like scheduling of tasks)
- ❌ NOT a secret manager (secrets live in env vars or config, task-relay passes them through)
- ❌ NOT a multi-tenant system (one user, one machine per daemon instance)

### Target User (v1)
Philip Bankier. Solo developer running the daemon on his MacBook Pro on Tailscale. Submitting tasks from his agent fleet (OpenClaw, Claude, Codex, custom scripts).

---

## 2. Task Model

### Task Schema

```typescript
interface Task {
  id: string;                    // UUID v4
  type: TaskType;                // "shell" | "claude-code" | "codex"
  status: TaskStatus;            // see status enum below
  created_at: string;            // ISO 8601
  started_at: string | null;
  completed_at: string | null;
  creator: string;               // API key ID that submitted the task
  
  // Input
  prompt: string;                // The task instruction
  working_dir: string;           // Absolute path, must be within allowed paths
  env: Record<string, string>;   // Extra env vars (keys must be allowlisted or prefixed TASK_)
  timeout_ms: number;            // Max execution time, default 300000 (5 min)
  max_budget_usd: number | null; // USD budget cap (claude-code only)
  isolation: "docker" | "host";  // Override default isolation mode
  model: string | null;          // Model override (agent-specific)
  
  // Output
  exit_code: number | null;
  stdout: string | null;         // Truncated to 1MB
  stderr: string | null;         // Truncated to 1MB
  output_path: string | null;    // Path to full output file if truncated
  artifacts: string[];           // File paths produced by the task
  cost_usd: number | null;       // Actual cost if available
  duration_ms: number | null;
  error: string | null;          // Human-readable error message
}

type TaskType = "shell" | "claude-code" | "codex";
type TaskStatus = "queued" | "running" | "completed" | "failed" | "cancelled" | "timeout";
```

### Task Status Flow

```
queued → running → completed
                 → failed
                 → timeout
                 → cancelled
```

- `queued`: Task accepted, waiting for executor slot (max 1 concurrent)
- `running`: Executor subprocess/container has started
- `completed`: Executor exited with code 0
- `failed`: Executor exited with non-zero code OR executor crashed
- `timeout`: Killed after timeout_ms elapsed
- `cancelled`: User requested cancellation via DELETE /tasks/:id

### Validation Rules

1. `prompt` must be non-empty, max 100KB
2. `working_dir` must be an absolute path within `allowed_paths` from config
3. `env` keys must start with `TASK_` OR be in `allowed_env_keys` config
4. `timeout_ms` range: 1000 to 3600000 (1s to 1h), default 300000
5. `type` must be one of the enabled executors in config
6. If `isolation: "host"` requested but `allow_host: false` in config → reject with 403
7. Max 100 queued tasks (configurable). Reject with 429 if exceeded.

---

## 3. API Specification

### Base URL
`http://{tailscale-ip}:8080` (no TLS — Tailscale handles encryption)

### Authentication
All endpoints require header: `Authorization: Bearer {api_key}`

API keys are defined in config. Each key has:
- `id`: Human-readable label (e.g., "openclaw-agent", "test-script")
- `key`: The actual secret string
- `allowed_types`: Array of TaskType this key can submit (optional, defaults to all)
- `allowed_isolation`: Array of isolation modes this key can use (optional)

### Endpoints

#### `POST /tasks` — Submit a task
Request:
```json
{
  "type": "claude-code",
  "prompt": "Fix the failing tests in src/auth.test.ts",
  "working_dir": "/Users/philip/projects/myapp",
  "timeout_ms": 300000,
  "max_budget_usd": 1.00,
  "isolation": "docker",
  "env": { "TASK_BRANCH": "feature/auth" },
  "model": "sonnet"
}
```

Response (201):
```json
{
  "id": "a1b2c3d4-...",
  "status": "queued",
  "type": "claude-code",
  "created_at": "2026-04-12T03:00:00Z",
  "position": 0
}
```

Errors:
- 400: Validation failure (invalid type, path outside allowed_paths, etc.)
- 401: Missing or invalid API key
- 403: API key not allowed for this task type or isolation mode
- 429: Queue full
- 503: Daemon unhealthy (executor stuck, disk full, etc.)

#### `GET /tasks/:id` — Get task status and result
Response (200):
```json
{
  "id": "a1b2c3d4-...",
  "type": "claude-code",
  "status": "completed",
  "created_at": "2026-04-12T03:00:00Z",
  "started_at": "2026-04-12T03:00:01Z",
  "completed_at": "2026-04-12T03:02:34Z",
  "exit_code": 0,
  "stdout": "I've fixed the failing tests...",
  "stderr": null,
  "cost_usd": 0.34,
  "duration_ms": 153000,
  "artifacts": ["/Users/philip/projects/myapp/src/auth.ts"],
  "error": null
}
```

#### `GET /tasks` — List tasks
Query params: `?status=running&limit=20&before={cursor}`

Response (200):
```json
{
  "tasks": [...],
  "next_cursor": "abc123",
  "has_more": false
}
```

#### `GET /tasks/:id/stream` — SSE stream of task events
Headers: `Accept: text/event-stream`

Events:
```
event: status
data: {"status": "running", "started_at": "..."}

event: log
data: {"stream": "stdout", "text": "Analyzing test file...", "timestamp": "..."}

event: log
data: {"stream": "stderr", "text": "warning: ...", "timestamp": "..."}

event: result
data: {"status": "completed", "exit_code": 0, "duration_ms": 153000}

event: error
data: {"status": "failed", "error": "executor crashed: OOM"}
```

Stream closes when task reaches a terminal state.

#### `DELETE /tasks/:id` — Cancel a task
Only works for tasks in `queued` or `running` status.
- If `queued`: removes from queue, status → `cancelled`
- If `running`: sends SIGTERM to subprocess (host) or `docker stop` (docker), waits 10s, then SIGKILL

Response (200): `{ "status": "cancelled" }`
Error (409): Task already in terminal state

#### `GET /health` — Health check (no auth required)
Response (200):
```json
{
  "status": "ok",
  "uptime_ms": 86400000,
  "version": "0.1.0",
  "executors": {
    "shell": { "available": true },
    "claude-code": { "available": true, "version": "2.1.81" },
    "codex": { "available": true, "version": "0.114.0" }
  },
  "queue": { "running": 0, "queued": 0, "max_concurrent": 1 }
}
```

#### `GET /capabilities` — What this worker can do (no auth required)
Response (200):
```json
{
  "task_types": ["shell", "claude-code", "codex"],
  "isolation_modes": ["docker", "host"],
  "default_isolation": "docker",
  "allowed_paths": ["/Users/philip/projects"],
  "max_timeout_ms": 3600000,
  "default_timeout_ms": 300000
}
```

---

## 4. MCP Server

### Transport
stdio (stdin/stdout). Launched as a subprocess by MCP clients (Claude Desktop, Cursor, etc.).

The MCP server is a separate entry point from the HTTP daemon. They share the same task logic but the MCP server doesn't listen on HTTP — it speaks JSON-RPC over stdio.

### Tools Exposed

| Tool | Description | Parameters |
|------|-------------|------------|
| `submit_task` | Submit a task for execution | `type`, `prompt`, `working_dir`, `timeout_ms?`, `isolation?`, `env?`, `model?`, `max_budget_usd?` |
| `get_task` | Get task status and result | `task_id` |
| `list_tasks` | List recent tasks | `status?`, `limit?` |
| `cancel_task` | Cancel a running or queued task | `task_id` |
| `get_capabilities` | See what this worker supports | (none) |

### Architecture Note
The MCP server communicates with the same SQLite DB. It can run alongside the HTTP daemon or standalone. When standalone, it handles task execution itself. When alongside, it submits to the same queue.

For v1: MCP server runs as a separate process, talks to the same SQLite DB. Only one process runs executors at a time (file lock on DB).

---

## 5. Executor Interface

### Contract

```typescript
interface Executor {
  name: string;
  type: TaskType;
  
  // Check if this executor is available (CLI installed, etc.)
  isAvailable(): Promise<{ available: boolean; version?: string; error?: string }>;
  
  // Execute a task. Returns a handle for streaming/cancellation.
  execute(task: Task, options: ExecutorOptions): Promise<ExecutorHandle>;
}

interface ExecutorOptions {
  isolation: "docker" | "host";
  workingDir: string;
  env: Record<string, string>;
  timeoutMs: number;
  onStdout: (chunk: string) => void;
  onStderr: (chunk: string) => void;
  abortSignal: AbortSignal;
}

interface ExecutorHandle {
  pid: number;
  wait(): Promise<ExecutorResult>;
  kill(signal?: string): Promise<void>;
}

interface ExecutorResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  costUsd: number | null;
  artifacts: string[];
  durationMs: number;
}
```

### Shell Executor (Host only)
- Spawns: `bash -c "{prompt}"` in `working_dir`
- No Docker variant for shell (use claude-code/codex docker mode for sandboxed shell)
- Passes `env` as environment variables

### Claude Code Executor

**Host mode:**
```bash
claude -p "{prompt}" \
  --output-format stream-json \
  --dangerously-skip-permissions \
  --max-budget-usd {max_budget_usd} \
  --model {model} \
  --no-session-persistence \
  --verbose
```

**Docker mode:**
```bash
docker run --rm \
  -v {working_dir}:/workspace \
  --network none \
  -e ANTHROPIC_API_KEY \
  --memory 2g \
  --cpus 1 \
  task-relay/claude-executor:latest \
  claude -p "{prompt}" --output-format stream-json --dangerously-skip-permissions ...
```

Parsing: stdout is NDJSON. Events are `system`, `assistant`, `result`. We extract:
- `result` event → final output, cost, duration
- `assistant` events → streamed as SSE `log` events
- Exit code from process

**Gotchas (from agent-cli-skills):**
- Nested `claude -p` calls produce empty output — documented, not our problem to solve
- `--system-prompt` replaces (not appends) default — we don't use it
- `--json-schema` for structured output — not in v1

### Codex Executor

**Host mode:**
```bash
codex exec "{prompt}" \
  --full-auto \
  --json \
  --model {model}
```

**Docker mode:**
```bash
docker run --rm \
  -v {working_dir}:/workspace \
  -e OPENAI_API_KEY \
  --network none \
  --memory 2g \
  --cpus 1 \
  task-relay/codex-executor:latest \
  codex exec "{prompt}" --full-auto --json ...
```

Parsing: stdout is JSONL. Events are `thread.started`, `turn.started`, `item.completed`, `turn.completed`. We extract:
- `item.completed` events → streamed as SSE `log` events
- Final output from last `turn.completed`
- Exit code from process

**Gotchas:**
- `codex exec` defaults to `danger-full-access` sandbox — always explicit about sandbox mode
- Session resume (`--last`) is NOT used in v1 — each task is stateless
- `-o` flag for output capture — we capture stdout directly instead

---

## 6. Docker Images

### claude-executor
```dockerfile
FROM node:20-slim
RUN npm install -g @anthropic-ai/claude-code
WORKDIR /workspace
ENTRYPOINT ["claude"]
```

### codex-executor
```dockerfile
FROM node:20-slim
RUN npm install -g @openai/codex
WORKDIR /workspace
ENTRYPOINT ["codex"]
```

### unified executor (v1 choice — simpler)
```dockerfile
FROM node:20-slim
RUN npm install -g @anthropic-ai/claude-code @openai/codex
WORKDIR /workspace
# Entrypoint is set per-task via docker run command
```

Decision: single image for v1. Simpler to build, update, and distribute. ~500MB.

Container constraints (configurable):
- `--memory`: default 2g
- `--cpus`: default 1
- `--network`: default none (can enable per-task with flag)
- `--read-only`: true (writes go to mounted /workspace)
- `--security-opt no-new-privileges`

---

## 7. Configuration

### Config file: `~/.task-relay/config.yaml`

```yaml
# Server
server:
  port: 8080
  bind: "0.0.0.0"  # Listen on all interfaces (Tailscale handles access)

# API Keys
auth:
  api_keys:
    - id: "openclaw-agent"
      key: "${TASK_RELAY_API_KEY}"  # Env var reference
      allowed_types: ["shell", "claude-code", "codex"]  # optional
      allowed_isolation: ["host", "docker"]              # optional
    - id: "test-script"
      key: "${TASK_RELAY_TEST_KEY}"
      allowed_types: ["shell"]
      allowed_isolation: ["docker"]

# Execution
execution:
  default_isolation: "docker"  # "docker" or "host"
  allow_host: true             # If false, host mode is rejected for all tasks
  max_concurrent: 1            # Max simultaneous tasks
  max_queue_size: 100
  default_timeout_ms: 300000   # 5 minutes
  max_timeout_ms: 3600000      # 1 hour
  
# Paths the daemon is allowed to access
paths:
  allowed:
    - "/Users/philip/projects"
  # Tasks can only set working_dir within these paths

# Environment variables tasks are allowed to set/pass
env:
  allowed_prefix: "TASK_"      # Env vars with this prefix are always allowed
  allowed_keys:                 # Explicitly allowed keys
    - "NODE_ENV"
    - "GIT_BRANCH"

# Executor-specific config
executors:
  shell:
    enabled: true
  claude-code:
    enabled: true
    default_model: "sonnet"
    default_budget_usd: 1.00
    max_budget_usd: 5.00
    # API key comes from ANTHROPIC_API_KEY env var (not in config)
  codex:
    enabled: true
    default_model: null  # Use Codex default
    # API key comes from OPENAI_API_KEY env var

# Docker (only matters if isolation: docker)
docker:
  image: "task-relay/executor:latest"
  build_image_on_start: true   # Build if not found
  memory: "2g"
  cpus: 1
  network: "none"              # "none" or "bridge"
  read_only: true

# Backup
backup:
  enabled: true
  provider: "s3"               # "s3" (any S3-compatible)
  endpoint: "https://s3.us-west-004.backblazeb2.com"  # Backblaze B2
  # endpoint: "https://s3.amazonaws.com"               # AWS S3
  # endpoint: "http://localhost:9000"                   # MinIO
  bucket: "task-relay-backups"
  region: "us-west-004"
  # Credentials from env: AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY
  
  log_backup:
    enabled: true
    interval_minutes: 15
    prefix: "logs/"
    
  full_backup:
    enabled: true
    schedule: "0 2 * * *"      # Cron: 2am daily
    prefix: "backups/"
    keep_count: 30              # Keep last 30 full backups
    include_artifacts: true

# Logging
logging:
  level: "info"                 # "debug" | "info" | "warn" | "error"
  format: "json"                # "json" | "text"
  output: "/var/log/task-relay/daemon.log"
  max_size_mb: 100
  max_files: 5

# Database
database:
  path: "~/.task-relay/tasks.db"
```

### Environment Variables (not in config file)
- `ANTHROPIC_API_KEY` — For Claude Code executor
- `OPENAI_API_KEY` — For Codex executor
- `AWS_ACCESS_KEY_ID` — For S3 backups
- `AWS_SECRET_ACCESS_KEY` — For S3 backups
- `TASK_RELAY_API_KEY` — Referenced in config via `${...}` syntax
- `TASK_RELAY_CONFIG` — Override config file path

---

## 8. Backup System

Task-Relay backs up three categories of data:
1. **Task logs** — task-relay's own structured event data (incremental)
2. **Full snapshots** — SQLite DB + config + artifacts (periodic)
3. **Agent traces** — raw session transcripts and OTel data from Claude Code / Codex (per-task)

All three go to the same S3-compatible bucket with different prefixes.

### Log Backup (Incremental)
- Tracks last backup timestamp in `~/.task-relay/backup-state.json`
- Queries SQLite for tasks/events created after that timestamp
- Writes NDJSON file: one line per event
- Uploads to: `s3://{bucket}/logs/{date}/{timestamp}.ndjson`
- On success, updates backup-state.json

### Full Backup
- Stops accepting new tasks momentarily (drains current task)
- SQLite checkpoint + copy
- Creates tar.gz containing:
  - `tasks.db` (SQLite snapshot)
  - `config.yaml` (sanitized — no API keys)
  - `artifacts/` (symlinks resolved, files copied)
- Uploads to: `s3://{bucket}/backups/{date}.tar.gz`
- Lists objects with prefix, deletes oldest if count > keep_count
- Resumes task acceptance

### Restore
Manual process (not automated in v1):
1. `task-relay restore --from s3://bucket/backups/2026-04-12.tar.gz`
2. Downloads and extracts to `~/.task-relay/`
3. User restarts daemon

---

## 8.5. Agent Trace Backup

### Why
When agents execute tasks via Claude Code or Codex, they produce rich trace data — session transcripts, tool calls, model interactions. This data is valuable for debugging, auditing, cost analysis, and replay. It exists on the local machine in CLI-specific directories and can be lost if not backed up.

### Claude Code Traces

**Source 1: Session transcripts**
- Location: `~/.claude/projects/{project-hash}/sessions/{session-id}.jsonl`
- Content: Full conversation history — prompts, tool calls, responses, file edits, errors
- Format: One JSON object per line
- Always written by Claude Code, no configuration needed
- Path is deterministic: project hash is SHA-256 of the working directory path

**Source 2: OpenTelemetry export**
- Built into Claude Code (no plugins needed)
- Three signals:
  - **Metrics:** token counts, cost, sessions, lines of code, tool decisions
  - **Log events:** structured records per prompt, API request, API error, tool result
  - **Traces (beta):** spans per interaction, model request, tool call, hook execution
- Enabled via environment variables on the `claude -p` subprocess:
  ```
  CLAUDE_CODE_ENABLE_TELEMETRY=1
  OTEL_TRACES_EXPORTER=otlp
  OTEL_METRICS_EXPORTER=otlp
  OTEL_LOGS_EXPORTER=otlp
  OTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf
  OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318
  ```

**Implementation for Claude traces:**
1. After each `claude-code` task completes, locate the session transcript in `~/.claude/projects/`
2. Copy to S3: `traces/{task_id}/claude-session.jsonl`
3. For OTel: set OTEL env vars on the subprocess. Options:
   - **Simple (v1):** Point at a local OTLP collector sidecar that writes to files → upload to S3
   - **Simpler (v1 fallback):** Use `OTEL_TRACES_EXPORTER=console` piped to a file, upload that file
   - **Later:** Direct OTLP export to a hosted observability backend (Honeycomb, Datadog, etc.)
4. Decision: **Start with session transcript file copy only.** It's the richest data source and requires zero OTel configuration. Add OTel export as a config option in v1.1.

### Codex CLI Traces

**Source 1: Execution log files**
- Location: `~/.codex/log/codex-tui.log` (TUI mode)
- Location: configurable via `-c log_dir=...`
- Controlled by `RUST_LOG` env var (default: `codex_core=info,codex_tui=info,codex_rmcp_client=info`)
- Format: Plain text Rust log output (not structured JSON)

**Source 2: JSON exec output**
- The `--json` flag on `codex exec` emits JSONL events to stdout
- Events: `thread.started`, `turn.started`, `item.completed`, `turn.completed`
- **We already capture this** as part of task execution — it's stored in the task DB and included in log backups

**Source 3: Session state**
- Codex stores session data for `resume --last` / `resume --all`
- Location: `~/.codex/` (internal Rust binary format, not human-readable)
- Not useful for external backup without Codex itself

**Implementation for Codex traces:**
1. After each `codex` task completes, copy `~/.codex/log/` files to S3: `traces/{task_id}/codex-logs/`
2. The JSONL exec output is already captured in task-relay's DB — included in regular log backups
3. No OTel support exists for Codex — this is the best we can do
4. Set `RUST_LOG=info` on the subprocess to ensure reasonable log detail

### Config Addition

```yaml
# In config.yaml, under backup:
backup:
  traces:
    enabled: true
    # Claude Code session transcript backup
    claude_code:
      enabled: true
      sessions_dir: "~/.claude/projects"  # Where Claude stores sessions
      upload_session: true                 # Copy session .jsonl after task
      # OTel export (v1.1, not implemented in v1)
      # otel_enabled: false
      # otel_endpoint: "http://localhost:4318"
    # Codex trace backup
    codex:
      enabled: true
      log_dir: "~/.codex/log"
      upload_logs: true                    # Copy log files after task
      rust_log: "info"                     # RUST_LOG level for subprocess
```

### S3 Layout

```
s3://{bucket}/
├── logs/                          # Task-relay structured logs (incremental)
│   └── 2026-04-12/
│       └── 1712880000.ndjson
├── backups/                       # Full DB snapshots
│   ├── 2026-04-11.tar.gz
│   └── 2026-04-12.tar.gz
└── traces/                        # Agent trace data (per-task)
    ├── {task-id-1}/
    │   ├── claude-session.jsonl   # Claude Code full session transcript
    │   └── exec-output.jsonl      # Already captured by task-relay
    ├── {task-id-2}/
    │   ├── codex-logs/
    │   │   └── codex-tui.log      # Codex log file
    │   └── exec-output.jsonl      # Already captured by task-relay
    └── {task-id-3}/
        └── exec-output.jsonl      # Shell task (no extra trace data)
```

### Trace Backup Flow

```
Task completes
    │
    ├── type == "claude-code"?
    │   ├── Find latest session file in ~/.claude/projects/{hash}/sessions/
    │   ├── Copy to S3: traces/{task_id}/claude-session.jsonl
    │   └── (v1.1: also export OTel data if configured)
    │
    ├── type == "codex"?
    │   ├── Copy ~/.codex/log/codex-tui.log to S3: traces/{task_id}/codex-logs/
    │   └── (exec JSONL already in DB backup)
    │
    └── type == "shell"?
        └── (no extra trace data — output already in DB backup)
```

### Failure Handling
- Trace backup failure does NOT affect task result delivery
- If S3 upload fails, log a warning and continue
- Retry trace uploads on next backup cycle (trace files remain on disk until successfully uploaded)
- Never block task execution on trace backup

---

## 9. Project Structure

```
task-relay/
├── src/
│   ├── index.ts                 # CLI entry point
│   ├── daemon.ts                # Main daemon orchestrator
│   ├── config/
│   │   ├── schema.ts            # Config type definitions + validation (zod)
│   │   ├── loader.ts            # YAML loading + env var interpolation
│   │   └── defaults.ts          # Default config values
│   ├── api/
│   │   ├── server.ts            # Hono HTTP server setup
│   │   ├── routes/
│   │   │   ├── tasks.ts         # POST/GET/DELETE /tasks
│   │   │   ├── stream.ts        # GET /tasks/:id/stream (SSE)
│   │   │   ├── health.ts        # GET /health
│   │   │   └── capabilities.ts  # GET /capabilities
│   │   ├── middleware/
│   │   │   ├── auth.ts          # API key validation
│   │   │   └── validation.ts    # Request body validation
│   │   └── errors.ts            # Standard error responses
│   ├── db/
│   │   ├── database.ts          # SQLite connection + migrations
│   │   ├── tasks.ts             # Task CRUD operations
│   │   └── migrations/
│   │       └── 001_initial.ts   # Schema migration
│   ├── executor/
│   │   ├── types.ts             # Executor interface + result types
│   │   ├── registry.ts          # Executor registration + discovery
│   │   ├── queue.ts             # Concurrency-limited task queue
│   │   ├── shell.ts             # Shell executor
│   │   ├── claude-code.ts       # Claude Code executor
│   │   ├── codex.ts             # Codex CLI executor
│   │   └── docker.ts            # Docker isolation wrapper
│   ├── mcp/
│   │   ├── server.ts            # MCP server entry point
│   │   └── tools.ts             # Tool definitions + handlers
│   ├── backup/
│   │   ├── manager.ts           # Backup orchestrator
│   │   ├── log-backup.ts        # Incremental log backup
│   │   ├── full-backup.ts       # Full backup
│   │   ├── trace-backup.ts      # Agent trace backup (Claude sessions + Codex logs)
│   │   └── s3-client.ts         # S3 operations wrapper
│   └── utils/
│       ├── logger.ts            # Structured logging (pino)
│       └── env.ts               # Env var helpers
├── docker/
│   └── Dockerfile               # Unified executor image
├── test/
│   ├── executor/
│   │   ├── shell.test.ts
│   │   ├── claude-code.test.ts
│   │   ├── codex.test.ts
│   │   └── docker.test.ts
│   ├── api/
│   │   ├── tasks.test.ts
│   │   └── health.test.ts
│   ├── backup/
│   │   ├── log-backup.test.ts
│   │   ├── full-backup.test.ts
│   │   └── trace-backup.test.ts
│   └── fixtures/
│       └── test-config.yaml
├── package.json
├── tsconfig.json
├── pnpm-lock.yaml
├── LICENSE                      # BSL 1.1
├── README.md
└── .github/
    └── workflows/
        └── ci.yml
```

---

## 10. Dependencies

### Runtime
| Package | Purpose | Why this one |
|---------|---------|-------------|
| `hono` | HTTP framework | Fast, lightweight, typed. Overkill frameworks add nothing here. |
| `better-sqlite3` | Task database | Synchronous, embedded, zero-config. Perfect for single-process daemon. |
| `zod` | Config + request validation | Industry standard, great DX |
| `pino` | Structured logging | Fast, JSON by default, good ecosystem |
| `@aws-sdk/client-s3` | S3 backups | Official SDK, S3-compatible |
| `@modelcontextprotocol/sdk` | MCP server | Official MCP SDK |
| `yaml` | Config parsing | Lightweight YAML parser |
| `uuid` | Task IDs | Standard UUID v4 |
| `dockerode` | Docker API | Node.js Docker client for container management |

### Dev
| Package | Purpose |
|---------|---------|
| `typescript` | Compile |
| `vitest` | Tests |
| `tsx` | Dev runner |
| `prettier` | Formatting |

---

## 11. Implementation Phases (Detailed)

### Phase 1: Core Daemon + REST API
**Duration estimate:** 2-3 days

Tasks:
1. Project scaffolding: package.json, tsconfig, eslint, prettier, vitest
2. Config system: schema.ts (zod), loader.ts (YAML + env vars), defaults
3. Database: SQLite schema, migration system, task CRUD
4. HTTP server: Hono setup, auth middleware, error handling
5. Routes: POST /tasks, GET /tasks/:id, GET /tasks, DELETE /tasks/:id, GET /health, GET /capabilities
6. Shell executor (host mode only)
7. Task queue: in-process queue with max_concurrent=1
8. SSE streaming for task events
9. CLI: `npx task-relay start` and `npx task-relay status`
10. Basic tests

**Deliverable:** Can submit shell tasks via REST API, get results, stream logs. No Docker, no agent executors yet.

### Phase 2: Agent Executors
**Duration estimate:** 2-3 days

Tasks:
1. Executor interface + registry
2. Claude Code executor: subprocess spawning, stream-json parsing, cost extraction
3. Codex executor: subprocess spawning, JSONL parsing
4. Budget enforcement (kill task if budget exceeded, based on CLI-reported cost)
5. Timeout enforcement (kill after timeout_ms)
6. Model validation (reject unknown models)
7. Tests with mocked CLI output

**Deliverable:** Can submit tasks of type `claude-code` and `codex`. Full lifecycle working.

### Phase 3: Docker Isolation
**Duration estimate:** 1-2 days

Tasks:
1. Dockerfile for unified executor image
2. `dockerode` integration: create/start/stop/remove containers
3. Volume mounting, env passing, resource limits
4. Docker executor wrapper (delegates to shell/claude-code/codex inside container)
5. Image build script (`task-relay build-image`)
6. Per-task isolation mode selection
7. Graceful container shutdown on task cancel/timeout
8. Tests (requires Docker)

**Deliverable:** Tasks run in Docker containers by default. Host mode works for trusted callers.

### Phase 4: MCP Server
**Duration estimate:** 1-2 days

Tasks:
1. MCP server entry point (stdio transport)
2. Tool definitions: submit_task, get_task, list_tasks, cancel_task, get_capabilities
3. Shared SQLite access (file locking)
4. CLI: `npx task-relay mcp` (starts MCP server instead of HTTP daemon)
5. Tests

**Deliverable:** Claude Desktop / Cursor can discover and call Task-Relay tools.

### Phase 5: Backup + Polish + Ship
**Duration estimate:** 2-3 days

Tasks:
1. S3 client wrapper
2. Incremental log backup job
3. Full backup job with rotation
4. Agent trace backup: Claude session transcript copy + Codex log copy
5. Config for backup schedule, S3 credentials, and trace sources
6. `task-relay backup` CLI command (manual trigger)
7. `task-relay restore` CLI command
7. Structured logging throughout (pino)
8. README: installation, quickstart, config reference, API reference
9. GitHub Actions CI (lint, test, build)
10. npm package setup (bin entries, files whitelist)
11. LICENSE file (BSL 1.1)
12. Tag v0.1.0

**Deliverable:** Publishable npm package with docs and CI.

---

## 12. Error Handling Strategy

### Executor Errors
| Error | Handling |
|-------|----------|
| CLI not installed | Task fails immediately, error = "claude-code not found. Install: npm i -g @anthropic-ai/claude-code" |
| API key missing | Task fails immediately, error = "ANTHROPIC_API_KEY not set" |
| OOM kill | Task status → `failed`, error = "executor killed (OOM)" |
| Timeout | SIGTERM → wait 10s → SIGKILL. Status → `timeout` |
| Docker daemon not running | Task fails, error = "Docker daemon not running" for docker mode. Suggest host mode. |
| Container pull failure | Task fails, error = "Failed to pull image task-relay/executor:latest" |
| Non-zero exit code | Status → `failed`, exit_code preserved |
| Stdout/stderr > 1MB | Truncated in DB, full output written to `output_path` file |

### API Errors
All errors follow: `{ "error": { "code": "VALIDATION_ERROR", "message": "..." } }`

Standard codes:
- `UNAUTHORIZED` (401)
- `FORBIDDEN` (403)
- `NOT_FOUND` (404)
- `VALIDATION_ERROR` (400)
- `QUEUE_FULL` (429)
- `INTERNAL_ERROR` (500)
- `SERVICE_UNAVAILABLE` (503)

---

## 13. Security Threat Model (Honest Assessment)

### What v1 protects against
- **Network-level:** Tailscale ACLs limit who can reach the daemon
- **Application-level:** API keys limit which agents can submit tasks
- **Isolation:** Docker mode limits filesystem/network access per task
- **Path restriction:** Tasks can only work within configured `allowed_paths`
- **Budget:** Cost caps prevent runaway LLM spending

### What v1 does NOT protect against
- **Malicious prompt injection:** A crafted task could instruct Claude/Codex to do harmful things within the container. We don't inspect or filter prompts.
- **Container escape:** Docker is not a security boundary against determined attackers. If you don't trust the agent, don't give it task-relay access.
- **Credential leakage:** API keys for Anthropic/OpenAI are passed into containers. A malicious task could exfiltrate them (mitigated by `--network none` in Docker mode).
- **Resource exhaustion:** A task could consume all CPU/memory despite limits. Limits are best-effort.
- **Supply chain:** We don't verify CLI tool integrity. If `@anthropic-ai/claude-code` is compromised, we're compromised.

### For Philip's use case (trusted agents on own machine)
This is fine. The daemon exists to make his machine callable, not to protect it from untrusted code.

---

## 14. Not In v1 (Explicit List)

These are explicitly deferred. Not "nice to have later" — they are NOT being built:

1. **Webhook/Linear integration** — task-relay creates tickets, updates on completion
2. **Browser automation** — Browserbase, Firecrawl, Playwright
3. **Multi-machine coordination** — fleet management, task routing
4. **User accounts / multi-tenant** — one user per daemon
5. **Task scheduling** — cron-like recurring tasks
6. **Web UI** — management dashboard
7. **Artifact storage** — beyond local filesystem paths in results
8. **Task dependencies** — "run B after A completes"
9. **Secret management** — beyond env vars
10. **Rate limiting** — beyond queue size limit
11. **Metrics/telemetry** — beyond structured logs
12. **Plugin system** — beyond hardcoded executors
13. **WebSocket** — SSE is sufficient
14. **Session persistence for agents** — each task is stateless
15. **Gemini CLI** — can be added later as another executor
16. **Auto-update** — manual npm update

---

## 15. CLI Commands

```
task-relay start              # Start daemon (HTTP server + executor)
task-relay status             # Check daemon health
task-relay stop               # Graceful shutdown
task-relay mcp                # Start MCP server (stdio, for Claude/Cursor)
task-relay build-image        # Build Docker executor image
task-relay backup             # Trigger manual backup
task-relay restore --from URL # Restore from backup
task-relay config validate    # Validate config file
task-relay config show        # Show resolved config (sanitized)
```
