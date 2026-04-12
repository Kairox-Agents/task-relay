# Task-Relay — Implementation Specification

**Version:** 1.0-draft
**Date:** 2026-04-12
**Status:** Pre-implementation

---

## 1. Product Definition

### What Task-Relay IS
A single-process Node.js daemon that runs on a user's machine, accepts task submissions over HTTP from agents on the same Tailscale network, and executes them locally using installed CLI tools. v1 supports Claude Code and shell executors. Codex CLI support is deferred (flag information was inaccurate and needs fresh research).

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

type TaskType = "shell" | "claude-code"; // "codex" deferred — needs fresh flag research
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
7. If `type: "shell"` and `isolation: "docker"` → reject with 400 (shell executor has no Docker mode)
8. Max 100 queued tasks (configurable). Reject with 429 if exceeded.

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
    "claude-code": { "available": true, "version": "2.1.81" }
  },
  "queue": { "running": 0, "queued": 0, "max_concurrent": 1 }
}
```

#### `GET /capabilities` — What this worker can do (no auth required)
Response (200):
```json
{
  "task_types": ["shell", "claude-code"],
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
The MCP server does NOT access the SQLite database directly. Instead, it submits tasks to the HTTP daemon via `localhost:8080`. This eliminates all concurrency issues (no shared DB, no file locking, no busy_timeout needed).

If the HTTP daemon is not running when the MCP server starts, the MCP server returns an error to the MCP client.

The MCP server is a thin transport adapter: it receives MCP tool calls over stdio and translates them into HTTP requests to the local daemon.

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

### Shell Executor (Host mode only)
- Spawns: `bash -c "{prompt}"` in `working_dir`
- No Docker variant for shell. If `type: "shell"` + `isolation: "docker"` is submitted, reject with 400 validation error.
- Passes `env` as environment variables
- **Security note:** shell executor runs arbitrary commands as the current user. Only enable for trusted API keys. Restrict via `allowed_types` on API key config.

### Claude Code Executor

**Host mode:**
```bash
claude -p "{prompt}" \
  --output-format stream-json \
  --verbose \
  --dangerously-skip-permissions \
  --max-budget-usd {max_budget_usd} \
  --model {model} \
  --session-id {task_id}
```

Notes:
- `--session-id {task_id}` — uses the task UUID as the Claude session ID. This makes the session transcript findable at a deterministic path for trace backup (see §8.5).
- Do NOT use `--no-session-persistence` — it prevents the `.jsonl` session transcript from being written to disk, which breaks trace backup.
- `--verbose` is REQUIRED with `--output-format stream-json` or output fails silently.
- The session transcript is written to `~/.claude/projects/{cwd-dashed}/{task_id}.jsonl` where `{cwd-dashed}` is the working directory with `/` replaced by `-`.

**Docker mode:**
```bash
docker run --rm \
  -v {working_dir}:/workspace \
  -w /workspace \
  --network none \
  -e ANTHROPIC_API_KEY \
  --memory 2g \
  --cpus 1 \
  task-relay/executor:latest \
  claude -p "{prompt}" \
    --output-format stream-json \
    --verbose \
    --dangerously-skip-permissions \
    --max-budget-usd {max_budget_usd} \
    --model {model} \
    --session-id {task_id}
```

Parsing: stdout is NDJSON. Events are `system`, `assistant`, `result`. We extract:
- `result` event → final output, cost, duration
- `assistant` events → streamed as SSE `log` events
- Exit code from process

**Gotchas (from agent-cli-skills):**
- Nested `claude -p` calls produce empty output — documented, not our problem to solve
- `--system-prompt` replaces (not appends) default — we don't use it
- `--json-schema` for structured output — not in v1

### Codex Executor (DEFERRED)

Codex CLI integration is deferred from v1. Reason: the flag information in the original spec was inaccurate. Verified issues:
- `--ephemeral` flag does not exist in Codex v0.41.0
- `--full-auto` and `--dangerously-bypass-approvals-and-sandbox` are mutually exclusive (not complementary)
- Needs fresh `codex exec --help` research against the latest version before implementation

When Codex support is added, a new executor module will be created following the same Executor interface. No changes to the core architecture needed.

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

### unified executor (v1)
```dockerfile
FROM node:20-slim
RUN npm install -g @anthropic-ai/claude-code
WORKDIR /workspace
# Entrypoint is set per-task via docker run command
```

Decision: single image for v1 with Claude Code only. Codex added when its executor is implemented.

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
      allowed_types: ["shell", "claude-code"]       # optional
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
  # codex: deferred — needs fresh flag research before implementation

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
  output: "~/.task-relay/logs/daemon.log"
  max_size_mb: 100
  max_files: 5

# Database
database:
  path: "~/.task-relay/tasks.db"
```

### Environment Variables (not in config file)
- `ANTHROPIC_API_KEY` — For Claude Code executor
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
- Location: `~/.claude/projects/{cwd-dashed}/{session-uuid}.jsonl`
- Where `{cwd-dashed}` is the working directory with `/` replaced by `-` (e.g., `/Users/philip/projects/myapp` → `-Users-philip-projects-myapp`)
- The session UUID is set via `--session-id {task_id}` flag on the `claude -p` command
- Therefore the path is deterministic: `~/.claude/projects/{cwd-dashed}/{task_id}.jsonl`
- Content: Full conversation history — prompts, tool calls, responses, file edits, errors
- Format: One JSON object per line
- Only written when `--no-session-persistence` is NOT used (we don't use it)
- Three files are created per session: `.jsonl` (transcript), `todos/{uuid}-agent-{uuid}.json`, `debug/{uuid}.txt`. Only the `.jsonl` is the full conversation transcript.

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
1. The Claude executor uses `--session-id {task_id}` flag (verified: works with UUID format)
2. After each `claude-code` task completes, the transcript is at a known path: `~/.claude/projects/{cwd-dashed}/{task_id}.jsonl`
3. The `cwd-dashed` string is computed by replacing `/` with `-` in the task's `working_dir`
4. Copy to S3: `traces/{task_id}/claude-session.jsonl`
5. Also copy the debug file if it exists: `~/.claude/debug/{task_id}.txt` → `traces/{task_id}/claude-debug.txt`

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
      claude_dir: "~/.claude"          # Base Claude config directory
      upload_session: true             # Copy session .jsonl after task
      upload_debug: true               # Copy debug file after task
      # OTel export (v1.1, not implemented in v1)
      # otel_enabled: false
      # otel_endpoint: "http://localhost:4318"
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
    └── {task-id}/
        ├── claude-session.jsonl   # Claude Code full session transcript
        ├── claude-debug.txt       # Claude Code debug log (optional)
        └── exec-output.jsonl      # Already captured by task-relay
```

### Trace Backup Flow

```
Task completes
    │
    ├── type == "claude-code"?
    │   ├── Compute path: ~/.claude/projects/{cwd-dashed}/{task_id}.jsonl
    │   ├── Copy .jsonl to S3: traces/{task_id}/claude-session.jsonl
    │   ├── Copy debug: ~/.claude/debug/{task_id}.txt → traces/{task_id}/claude-debug.txt
    │   └── (v1.1: also export OTel data if configured)
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

### Phase 2: Claude Code Executor
**Duration estimate:** 1-2 days

Tasks:
1. Executor interface + registry
2. Claude Code executor: subprocess spawning, stream-json parsing, cost extraction
3. `--session-id {task_id}` for deterministic session transcript paths
4. Budget enforcement (kill task if budget exceeded, based on CLI-reported cost)
5. Timeout enforcement (kill after timeout_ms)
6. Model validation (reject unknown models against allowed list)
7. Tests with mocked CLI output

**Deliverable:** Can submit tasks of type `claude-code`. Full lifecycle working.

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
3. HTTP client that forwards requests to localhost daemon
4. CLI: `npx task-relay mcp` (starts MCP server instead of HTTP daemon)
5. Tests

**Deliverable:** Claude Desktop / Cursor can discover and call Task-Relay tools.

### Phase 5: Backup + Polish + Ship
**Duration estimate:** 2-3 days

Tasks:
1. S3 client wrapper
2. Incremental log backup job
3. Full backup job with rotation
4. Agent trace backup: Claude session transcript copy + debug file copy
5. Config for backup schedule, S3 credentials, and trace sources
6. `task-relay backup` CLI command (manual trigger)
7. `task-relay restore` CLI command
8. Structured logging throughout (pino)
9. Task retention policy: prune tasks older than `retention.max_age_days` on startup and daily
10. Graceful shutdown: on SIGTERM, wait up to 30s for running task to complete, then kill. Persist queued tasks in DB, resume on restart.
11. README: installation, quickstart, config reference, API reference
12. GitHub Actions CI (lint, test, build)
13. npm package setup (bin entries, files whitelist)
14. LICENSE file (BSL 1.1)
15. Tag v0.1.0

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
16. **Codex CLI** — deferred from v1. Flag information was inaccurate (`--ephemeral` doesn't exist, `--full-auto` and `--dangerously-bypass-approvals-and-sandbox` are mutually exclusive). Needs fresh research before implementation.
17. **Auto-update** — manual npm update

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

---

## 16. Graceful Shutdown

### SIGTERM handling
1. Stop accepting new HTTP requests (return 503)
2. Wait up to 30 seconds for the current running task to complete
3. If task still running after 30s: send SIGTERM to subprocess / `docker stop`, wait 10s, SIGKILL
4. Persist all queued task statuses to SQLite
5. Exit process

### Restart behavior
- On startup, check SQLite for tasks in `running` status (leftover from unclean shutdown)
- Set those to `failed` with error "daemon restarted during execution"
- Re-queue any tasks that were in `queued` status

---

## 17. Task Retention

### Config
```yaml
retention:
  max_age_days: 90         # Delete tasks older than this
  max_tasks: 10000         # Keep at most this many completed tasks
  prune_on_startup: true   # Run cleanup on daemon start
  prune_interval_hours: 24 # Run cleanup periodically
```

### Behavior
- Prune deletes tasks with terminal status (`completed`, `failed`, `cancelled`, `timeout`) older than `max_age_days`
- If more than `max_tasks` terminal tasks exist, delete oldest first
- Running and queued tasks are never pruned
- Associated output files (referenced by `output_path`) are also deleted
- S3 backups are NOT affected (separate retention managed by backup rotation)
