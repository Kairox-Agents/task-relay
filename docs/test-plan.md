# Task-Relay — Comprehensive Test Plan

**Version:** 1.0
**Date:** 2026-04-13
**Scope:** Everything built (Phases 1–3 foundation) + everything planned (Phases 3–6)
**Principle:** Real behavior only. No mocks, no stubs. Real DB, real HTTP, real subprocesses, real filesystem.

---

## Testing Philosophy

1. **Real behavior only.** No mocks/stubs for anything we own. External services (Claude API, S3, Docker Hub) are the only acceptable test boundaries.
2. **Test behavior, not implementation.** Tests should verify *what happened*, not *how the code did it*.
3. **Every error path is a test.** If code has a try/catch, there must be a test that triggers the catch.
4. **E2E is king.** Unit tests verify components. E2E tests verify the system works. Both are required.
5. **Race conditions are real.** Concurrency bugs don't show up in sequential tests. We need parallel tests.
6. **Data survives crashes.** If the process dies mid-task, the DB must be in a consistent state.

---

## Part A: What's Built — Test Gaps & New Tests

### A1. Config System

**Files:** `src/config/schema.ts`, `src/config/loader.ts`, `src/config/defaults.ts`

#### Already Covered ✅
- Schema field validation (types, min/max, defaults)
- YAML loading from file
- Env var interpolation (`${VAR}`)
- Missing env var → error
- Merge with defaults
- Invalid config → rejection

#### Missing Tests ❌

| ID | Test | Why It Matters |
|----|------|----------------|
| CFG-01 | Config with ALL fields populated (no defaults) | Verify no field is silently ignored |
| CFG-02 | Config with ONLY required fields (max defaults) | Verify every default is correct |
| CFG-03 | `${VAR}` inside a string, not the whole value (e.g., `prefix-${VAR}-suffix`) | Partial interpolation |
| CFG-04 | `${VAR}` with default syntax `${VAR:-fallback}` | Default value when var missing |
| CFG-05 | Multiple `${VAR1}${VAR2}` in same value | Multi-interpolation |
| CFG-06 | Config file with unknown/extra fields | Should they be rejected or ignored? |
| CFG-07 | Config reload (if supported) | Hot reload correctness |
| CFG-08 | Empty config file (0 bytes) | Graceful error, not crash |
| CFG-09 | Config file with only comments | Graceful error |
| CFG-10 | Config file with malformed YAML | Error message quality |
| CFG-11 | `allowed_isolation: []` (empty = deny all?) | Edge case semantics |
| CFG-12 | `allowed_types: []` (empty = deny all?) | Edge case semantics |
| CFG-13 | `max_concurrent: 0` | Should reject, not silently allow |
| CFG-14 | `allowed_paths` with relative paths | Should reject relative paths |
| CFG-15 | Two API keys with same `id` | Should reject or warn |
| CFG-16 | API key with empty `key` field | Should reject |
| CFG-17 | Duplicate `allowed_keys` entries | Should deduplicate or reject |
| CFG-18 | `max_timeout_ms < default_timeout_ms` | Logic conflict |
| CFG-19 | `backup.enabled: true` but no endpoint | Should validate conditional requirements |
| CFG-20 | Very large config file (10MB) | Should handle without OOM |

---

### A2. Database Layer

**Files:** `src/db/database.ts`, `src/db/tasks.ts`, `src/db/migrations/001_initial.ts`

#### Already Covered ✅
- CRUD operations (create, getById, list, delete)
- Status updates (updateStatus, updateStartedAt, updateCompletedAt)
- Result updates (updateResult)
- Judge state updates (updateJudgeState)
- JSON deserialization (env, judge_history)
- List with filters (status, limit, offset)
- Archive old tasks
- Keep failed tasks during archive
- Get next pending (FIFO)
- Count by status

#### Missing Tests ❌

| ID | Test | Why It Matters |
|----|------|----------------|
| DB-01 | **Migration idempotency** — run migration twice, verify no error and data intact | Production migrations run on every startup |
| DB-02 | **Concurrent writes from two DatabaseManager instances** (different processes) | WAL mode multi-process safety |
| DB-03 | **busy_timeout behavior** — lock contention under concurrent writes | Verify configured timeout works |
| DB-04 | **Schema enforcement** — insert row with wrong column types | Verify constraints work |
| DB-05 | **Empty JSON fields** — task with `env: {}`, `judge_history: []` | Round-trip correctness |
| DB-06 | **Null handling** — all nullable fields round-trip as `null`, not `undefined` | `null` vs `undefined` bugs are subtle |
| DB-07 | **Large JSON in env** — 1000 key-value pairs | Column size limits |
| DB-08 | **List ordering** — verify `list()` returns newest first consistently | Implicit ORDER BY assumption |
| DB-09 | **Count accuracy after concurrent create/delete** | Count must be exact |
| DB-10 | **Archive with exactly max_tasks boundary** | Off-by-one in retention |
| DB-11 | **getNextPending when multiple pending exist** — verify FIFO (oldest first) | Queue fairness |
| DB-12 | **getNextPending skips non-pending tasks** | Don't return running/completed |
| DB-13 | **updateResult with all null fields** | Partial result updates |
| DB-14 | **updateJudgeState with empty history** | Edge case |
| DB-15 | **DatabaseManager.close() then any operation** | Should throw, not silently fail |
| DB-16 | **Corrupt WAL recovery** — simulate WAL corruption | Crash recovery |
| DB-17 | **Task with special characters** — prompt with unicode, emojis, newlines | String encoding |
| DB-18 | **Very long prompt** — 100KB prompt text | Column limits, zod max |
| DB-19 | **Cost precision** — `cost_usd: 0.001234567` | Floating point handling |

---

### A3. Shell Executor

**File:** `src/executor/shell.ts`

#### Already Covered ✅
- Successful command execution
- Failed command (non-zero exit) + stderr capture
- Timeout
- Environment variable passing
- Output file writing
- Invalid command (nonexistent binary)
- Cancel running task

#### Missing Tests ❌

| ID | Test | Why It Matters |
|----|------|----------------|
| SH-01 | **Multi-line command** (`echo a && echo b && echo c`) | Compound commands |
| SH-02 | **Pipe** (`echo hello \| grep hello`) | Pipes |
| SH-03 | **Redirect** (`echo test > /tmp/file`) | Shell redirections |
| SH-04 | **Subshell** (`$(cat /etc/hostname)`) | Command substitution |
| SH-05 | **Special characters** — prompt with `$`, backticks, quotes, `!` | Shell injection surface |
| SH-06 | **Unicode output** — command that outputs emoji, CJK characters | Encoding |
| SH-07 | **Large output** — command that generates 10MB of stdout | Memory, truncation |
| SH-08 | **Binary output** — `cat /bin/ls` | Null bytes in output |
| SH-09 | **No output at all** — `true` (exit 0, no stdout/stderr) | Empty output handling |
| SH-10 | **Working dir doesn't exist** | Should fail with clear error |
| SH-11 | **Working dir is a file** (not a directory) | Edge case |
| SH-12 | **Working dir permission denied** | EACCES handling |
| SH-13 | **Cancel before process starts** (race) | Immediate cancel |
| SH-14 | **Cancel after process exits** (race) | Late cancel |
| SH-15 | **SIGKILL fallback** — process that ignores SIGTERM (`trap '' TERM`) | 2s SIGKILL timer |
| SH-16 | **Env with PATH override** | Security boundary |
| SH-17 | **Env with HOME override** | Security boundary |
| SH-18 | **Output path in non-existent directory** | Auto-mkdir behavior |
| SH-19 | **Concurrent shell executions** | Multiple processes simultaneously |
| SH-20 | **Process that daemonizes** (`nohup sleep 100 &`) | Orphan process handling |

---

### A4. Claude Code Executor

**File:** `src/executor/claude-code.ts`

#### Already Covered ✅
- getType/canHandle
- Handle structure (cancel + wait)
- Error when no API key
- Cancel during execution
- Docker isolation route (fails without docker)

#### Missing Tests ❌

| ID | Test | Why It Matters |
|----|------|----------------|
| CC-01 | **CLI fallback path verification** — mock SDK failure, verify CLI is attempted | Fallback mechanism works |
| CC-02 | **buildSystemPrompt with acceptance_criteria** | Prompt construction |
| CC-03 | **buildSystemPrompt without acceptance_criteria** | Prompt construction |
| CC-04 | **CLI arg construction** — verify correct flags for all task options | CLI invocation correctness |
| CC-05 | **Cost parsing from CLI stream-json output** | Real stream-json parsing |
| CC-06 | **Cost parsing with malformed JSON** | Resilient parsing |
| CC-07 | **Model flag passed correctly** | Model selection |
| CC-08 | **Budget enforcement** — verify `--max-budget-usd` is passed | Budget cap |
| CC-09 | **Session ID format** — verify UUID format in `--session-id` | Claude requires UUID |
| CC-10 | **Cancel aborts SDK stream** | AbortController wired correctly |
| CC-11 | **Cancel kills CLI subprocess** | SIGTERM propagation |
| CC-12 | **Timeout kills CLI subprocess** | Timeout enforcement |
| CC-13 | **Output written to file** | File persistence |
| CC-14 | **Docker mode builds correct docker args** | Docker arg construction |
| CC-15 | **Docker mode with custom image** | Config-driven image selection |
| CC-16 | **Docker mode with custom resource limits** | memory/cpus passed through |
| CC-17 | **SDK import failure is caught** — `@anthropic-ai/claude-agent-sdk` not installed | Dynamic import error handling |
| CC-18 | **Both SDK and CLI fail** — verify error message combines both | Total failure path |

---

### A5. Docker Runner

**File:** `src/executor/docker.ts`

#### Already Covered ✅
- Argument builder correctness
- Graceful failure when docker not available

#### Missing Tests ❌

| ID | Test | Why It Matters |
|----|------|----------------|
| DK-01 | **docker not installed** — verify error message says "docker not found" | UX |
| DK-02 | **Image not found** — verify error mentions missing image | Debugging |
| DK-03 | **Volume mount correctness** — verify host path appears in container | Data isolation |
| DK-04 | **Working directory is /workspace** | Container working dir |
| DK-05 | **Network none** — container cannot reach internet | Network isolation |
| DK-06 | **Memory limit enforced** — container OOMs if exceeds | Resource limits |
| DK-07 | **Read-only filesystem** — container cannot write outside /workspace | Filesystem isolation |
| DK-08 | **Env vars passed to container** | Environment propagation |
| DK-09 | **Cancel sends SIGTERM to container** | Graceful stop |
| DK-10 | **Cancel SIGKILL fallback** — container ignores SIGTERM | Force kill |
| DK-11 | **Timeout enforcement** — container killed after timeout | Time-bounded execution |
| DK-12 | **Container cleanup on success** — `docker ps` shows no leftover containers | No resource leaks |
| DK-13 | **Container cleanup on failure** | No resource leaks on error |
| DK-14 | **Container cleanup on cancel** | No resource leaks on cancel |
| DK-15 | **Stdout/stderr separation** | Output capture |
| DK-16 | **Exit code propagation** | Container exit code → result |
| DK-17 | **`--rm` flag prevents container accumulation** | Cleanup verification |

Note: DK-03 through DK-17 require Docker to be installed. These should be gated behind a `describe.skipIf(!dockerAvailable)` check.

---

### A6. TaskQueue + ExecutorRegistry

**File:** `src/executor/queue.ts`, `src/executor/registry.ts`

#### Already Covered ✅
- Basic add/size/runningCount
- Queue full rejection
- task-ready event emission
- Clear pending tasks
- Registry register/get/findExecutor/getAll

#### Missing Tests ❌

| ID | Test | Why It Matters |
|----|------|----------------|
| QU-01 | **FIFO ordering** — add 3 tasks, verify they start in order | Queue fairness |
| QU-02 | **complete() triggers next task** — running task completes, next starts | The critical dequeue flow |
| QU-03 | **complete() with unknown ID** — no crash | Edge case |
| QU-04 | **Running count accuracy through lifecycle** — add → start → complete → verify count | State tracking |
| QU-05 | **Add same task ID twice** — second add should fail or be ignored | Deduplication |
| QU-06 | **Rapid add/complete cycles** — 20 tasks, 1 concurrent, all complete | Stress the queue |
| QU-07 | **clear() doesn't affect running tasks** | Running tasks are sacred |
| QU-08 | **Event emission correctness** — verify `task-ready` fires for each dequeued task | Event contract |
| QU-09 | **maxConcurrent=0** — no tasks start, all stay queued | Edge case config |
| QU-10 | **maxQueueSize=0** — no queuing, reject if running slot full | Edge case config |
| QU-11 | **Concurrent add() calls** — two adds at same instant | Thread safety (event loop) |

---

### A7. TaskDaemon (CRITICAL — currently ZERO dedicated tests)

**File:** `src/executor/daemon.ts`

This is the orchestrator. Every other component feeds into it. It has no tests at all.

| ID | Test | Why It Matters |
|----|------|----------------|
| DA-01 | **Full lifecycle: pending → running → completed** | The happy path, end to end |
| DA-02 | **Full lifecycle: pending → running → failed** (non-zero exit) | Failure path |
| DA-03 | **Full lifecycle: pending → running → timeout** | Timeout path |
| DA-04 | **Cancel propagates: daemon.cancelTask() → executor.cancel()** | Cancel chain |
| DA-05 | **Cancel updates DB: status=cancelled, completed_at set** | Cancel persistence |
| DA-06 | **Executor not found → status=failed, error message** | Missing executor |
| DA-07 | **Executor throws mid-execution → status=failed, DB consistent** | Executor crash |
| DA-08 | **queue.complete() ALWAYS called, even on error** | This is critical. If it's not called, queue stalls forever |
| DA-09 | **Multiple sequential tasks: T1 completes → T2 starts → T2 completes** | Queue drain |
| DA-10 | **Shutdown with running task: waits for completion** | Graceful shutdown |
| DA-11 | **Shutdown with no running tasks: resolves immediately** | Fast shutdown |
| DA-12 | **DB update order: status → started_at → result → completed_at** | Timestamp consistency |
| DA-13 | **cost_usd persisted from executor result** | Cost tracking |
| DA-14 | **output_path persisted from executor result** | Output file reference |
| DA-15 | **started_at set before execution begins** | Timing accuracy |
| DA-16 | **completed_at set after execution ends** | Timing accuracy |
| DA-17 | **Concurrent task-ready events** — two events arrive while one is running | Race condition |
| DA-18 | **Task with isolation=docker routes to docker executor** | Routing correctness |
| DA-19 | **Task with isolation=host routes to host executor** | Routing correctness |

---

### A8. HTTP API (Integration Tests)

**Files:** `src/api/server.ts`, `src/api/routes/tasks.ts`, `src/api/routes/health.ts`, `src/api/routes/capabilities.ts`, `src/api/middleware/auth.ts`, `src/api/middleware/validation.ts`

#### Already Covered ✅
- POST /tasks (create, auth reject, schema reject, path reject, queue full)
- GET /tasks/:id (get, 404)
- GET /tasks (list, filter by status, pagination)
- DELETE /tasks/:id (cancel, 404)
- GET /health (healthy, no auth required)
- GET /capabilities
- Shell executor docker rejection

#### Missing Tests ❌

| ID | Test | Why It Matters |
|----|------|----------------|
| API-01 | **POST /tasks → GET /tasks/:id: verify full lifecycle** — submit, poll until completed, verify exit_code, output, cost_usd, timestamps | THE core E2E test |
| API-02 | **POST /tasks with failing command** — verify status=failed, error populated | Failure E2E |
| API-03 | **POST /tasks with timeout command** — verify status=timeout (or failed with timeout message) | Timeout E2E |
| API-04 | **DELETE running task → verify process actually dies** (not just DB update) | Real cancellation |
| API-05 | **Auth: Bearer token with extra whitespace** | Token parsing edge case |
| API-06 | **Auth: API key with allowed_types=["claude-code"] submitting shell task** | Type restriction enforcement |
| API-07 | **Auth: API key with allowed_isolation=["host"] submitting docker task** | Isolation restriction |
| API-08 | **Auth: Multiple API keys, each with different permissions** | Multi-key correctness |
| API-09 | **POST /tasks with env containing disallowed keys** | Env validation through API |
| API-10 | **POST /tasks with env containing allowed keys** | Env passing through API |
| API-11 | **POST /tasks with empty body** | Malformed request |
| API-12 | **POST /tasks with non-JSON body** | Content-type handling |
| API-13 | **POST /tasks with extra/unknown fields** | Strict validation |
| API-14 | **GET /tasks/:id for task that was just completed** — verify all fields present | Response completeness |
| API-15 | **GET /tasks with limit > total tasks** | Pagination edge case |
| API-16 | **GET /tasks with offset > total tasks** | Pagination edge case |
| API-17 | **DELETE already completed task** | Idempotency |
| API-18 | **DELETE non-existent task** — 404 |
| API-19 | **Concurrent POST /tasks (10 simultaneous)** | Concurrency |
| API-20 | **GET /tasks/:id/stream (SSE)** — verify initial status event, keep-alive | SSE endpoint |
| API-21 | **GET /tasks/:id/stream for non-existent task** — 404 via stream | SSE error handling |
| API-22 | **GET /tasks/:id/stream closes on task completion** | SSE lifecycle |
| API-23 | **Response headers** — CORS, Content-Type | Header correctness |
| API-24 | **404 for unknown routes** | Catch-all |
| API-25 | **POST /tasks with type=claude-code** — verify acceptance (even if executor fails) | Type routing |
| API-26 | **GET /capabilities returns registered executors** | Dynamic capability reporting |
| API-27 | **GET /health returns queue stats** | Queue visibility |
| API-28 | **Path traversal in working_dir** — `/tmp/../etc/passwd` | Security |
| API-29 | **Symlink in working_dir** — `/tmp/symlink_to_forbidden` | Security |
| API-30 | **Very long prompt (near 100KB limit)** | Input limits |

---

### A9. Env Utility

**File:** `src/utils/env.ts`

#### Already Covered ✅
- Allowed paths (empty, matching, non-matching, trailing slashes, subdirectories)
- Env var validation (allowed keys, prefix, rejection, custom prefix)

#### Missing Tests ❌

| ID | Test | Why It Matters |
|----|------|----------------|
| ENV-01 | **Path traversal: `/allowed/../forbidden`** | Security bypass attempt |
| ENV-02 | **Symlink: allowed path → forbidden path** | Security bypass |
| ENV-03 | **Empty working_dir** | Edge case |
| ENV-04 | **Root path `/` as allowed** | Everything allowed? |
| ENV-05 | **Case sensitivity in paths** | Linux is case-sensitive |
| ENV-06 | **Env var with empty string value** | `{"KEY": ""}` |
| ENV-07 | **Env var with very long value (10KB)** | Size limits |
| ENV-08 | **Env var key that starts with allowed_prefix but is actually disallowed** | Prefix matching correctness |
| ENV-09 | **Empty allowed_keys list + allowed_prefix** | Config combination |

---

### A10. Docker Runner Utility

**File:** `src/executor/docker.ts`

(See DK tests above — same section)

---

## Part B: What's Planned — Test Requirements

### B1. Phase 3: Docker Isolation (Remaining Work)

**Needs:** Executor Dockerfile, config wiring, real container execution

| ID | Test | Why It Matters |
|----|------|----------------|
| D3-01 | **Dockerfile builds successfully** | Image exists |
| D3-02 | **Container has Claude CLI installed** | Runtime dependency |
| D3-03 | **Container has Node.js + SDK installed** | Runtime dependency |
| D3-04 | **Container runs as non-root user** | Security |
| D3-05 | **Container has minimal attack surface** — no apt, no curl, no package managers | Security |
| D3-06 | **Volume mount: host changes visible in container** | Bidirectional file sync |
| D3-07 | **Volume mount: container changes visible on host** | Output capture |
| D3-08 | **Config wiring: docker.image from config, not env** | Config-driven |
| D3-09 | **Config wiring: docker.memory, docker.cpus from config** | Config-driven |
| D3-10 | **Config wiring: docker.network from config** | Config-driven |
| D3-11 | **Claude Code executor in Docker: full E2E** — submit claude-code task with docker isolation, verify it runs inside container | THE Docker E2E test |
| D3-12 | **Docker not installed → clear error on task submission** | UX when Docker missing |
| D3-13 | **Image pull failure → clear error** | Missing image |
| D3-14 | **Container OOM → task fails with OOM message** | Resource limit enforcement |
| D3-15 | **Multiple sequential Docker tasks** — container per task, cleanup between | No state leakage |
| D3-16 | **Docker daemon not running → clear error** | Docker daemon down |

---

### B2. Phase 4: MCP Server

**Needs:** MCP server that translates stdio JSON-RPC → HTTP localhost

| ID | Test | Why It Matters |
|----|------|----------------|
| MCP-01 | **MCP server starts and responds to initialize** | Basic connectivity |
| MCP-02 | **MCP server lists tools correctly** | Tool discovery |
| MCP-03 | **submit_task tool creates a task via HTTP** | Core function |
| MCP-04 | **get_task tool returns task status** | Status query |
| MCP-05 | **list_tasks tool returns task list** | Task listing |
| MCP-06 | **cancel_task tool cancels a running task** | Cancellation |
| MCP-07 | **get_capabilities tool returns capabilities** | Capability query |
| MCP-08 | **MCP server returns error when HTTP daemon is not running** | Daemon dependency |
| MCP-09 | **MCP server handles malformed JSON-RPC** | Input validation |
| MCP-10 | **MCP server handles unknown method** | Method routing |
| MCP-11 | **MCP server handles missing parameters** | Parameter validation |
| MCP-12 | **MCP server auth — how does it authenticate?** | Auth mechanism |
| MCP-13 | **MCP server timeout — request takes too long** | Timeout handling |
| MCP-14 | **MCP server concurrent requests** | Concurrency |
| MCP-15 | **Full E2E: MCP submit → HTTP daemon → executor → MCP get result** | The full chain |

---

### B3. Phase 5: Backup + Polish + Ship

| ID | Test | Why It Matters |
|----|------|----------------|
| BAK-01 | **S3 backup uploads task log on completion** | Log backup |
| BAK-02 | **S3 full backup includes all tasks** | Full backup |
| BAK-03 | **S3 backup with empty task list** | Edge case |
| BAK-04 | **S3 backup with large task list (10K tasks)** | Scale |
| BAK-05 | **S3 backup fails gracefully (wrong credentials)** | Error handling |
| BAK-06 | **S3 backup fails gracefully (bucket not found)** | Error handling |
| BAK-07 | **Backup retries on transient failure** | Reliability |
| BAK-08 | **Agent trace backup — Claude session .jsonl file uploaded** | Trace capture |
| BAK-09 | **Retention: old tasks deleted after retention_days** | Data lifecycle |
| BAK-10 | **Retention: keeps failed tasks when configured** | Config respect |
| BAK-11 | **Graceful shutdown: SIGTERM → finish current task → exit** | Shutdown behavior |
| BAK-12 | **Graceful shutdown: SIGINT → same as SIGTERM** | Ctrl+C handling |
| BAK-13 | **Graceful shutdown timeout: force exit after N seconds** | Don't hang forever |
| BAK-14 | **PID file: created on start, cleaned up on exit** | Process management |
| BAK-15 | **PID file: stale PID file (previous crash) handled** | Crash recovery |
| BAK-16 | **CLI `start` command: starts daemon, prints URL** | UX |
| BAK-17 | **CLI `status` command: queries health endpoint** | Status check |
| BAK-18 | **CLI `config` command: shows current config** | Config visibility |
| BAK-19 | **npm package: `npx task-relay start` works** | Distribution |
| BAK-20 | **npm package: installs cleanly on fresh machine** | Fresh install |
| BAK-21 | **npm package: all dependencies resolve** | Dependency health |
| BAK-22 | **Log output: structured JSON (Pino)** | Log format |
| BAK-23 | **Log output: level filtering works** | Log filtering |
| BAK-24 | **README accuracy: every example works** | Docs quality |
| BAK-25 | **Version flag: `task-relay --version`** | Version reporting |

---

### B4. Phase 6: Judge Loop (v1.1)

| ID | Test | Why It Matters |
|----|------|----------------|
| JG-01 | **Single iteration (no acceptance_criteria) → skip judge** | Fast path |
| JG-02 | **Deterministic check: test_command passes → continue** | Check pass |
| JG-03 | **Deterministic check: test_command fails → FAIL, no LLM judge** | Check fail short-circuits |
| JG-04 | **Deterministic check: lint_command fails → FAIL** | Lint check |
| JG-05 | **Deterministic check: typecheck fails → FAIL** | Type check |
| JG-06 | **Deterministic check: command not found → skip** | Missing tool |
| JG-07 | **LLM judge: overall_score >= pass_threshold → PASS** | Score pass |
| JG-08 | **LLM judge: partial_threshold <= score < pass_threshold → PARTIAL** | Score partial |
| JG-09 | **LLM judge: score < partial_threshold → FAIL** | Score fail |
| JG-10 | **Judge iteration produces correction_prompt** | Loop continuation |
| JG-11 | **Max iterations reached → final_status from last iteration** | Loop termination |
| JG-12 | **Escalation triggered → escalated_at set** | Escalation path |
| JG-13 | **Declining scores detected → escalate** | Loop detection |
| JG-14 | **judge_history accumulates correctly across iterations** | History tracking |
| JG-15 | **judge_result populated on completion** | Final result |
| JG-16 | **Judge with null acceptance_criteria + max_iterations > 1 → reject** | Validation |
| JG-17 | **Judge model defaults to config default when not specified** | Default model |
| JG-18 | **Judge model override per task** | Custom model |
| JG-19 | **Full judge loop E2E: submit → execute → judge → correct → re-execute → judge → pass** | The whole loop |
| JG-20 | **Judge loop with deterministic pass + LLM pass** | Both checks pass |
| JG-21 | **Judge loop with deterministic pass + LLM fail → correction → pass** | Correction works |
| JG-22 | **Cost accumulation across judge iterations** | Multi-iteration cost |
| JG-23 | **Duration accumulation across judge iterations** | Multi-iteration timing |

---

## Part C: Cross-Cutting Test Categories

### C1. Security Tests

| ID | Test | Category |
|----|------|----------|
| SEC-01 | Path traversal in working_dir (`/tmp/../../../etc`) | Injection |
| SEC-02 | Symlink following in working_dir | Injection |
| SEC-03 | Shell injection in prompt (`rm -rf /`, `$(cat /etc/shadow)`) | Injection |
| SEC-04 | Env var injection (`PATH=/evil`, `HOME=/evil`) | Injection |
| SEC-05 | API key brute force (100 wrong keys) | Auth |
| SEC-06 | Auth header manipulation (missing Bearer, extra spaces, null bytes) | Auth |
| SEC-07 | Request body with null bytes | Input validation |
| SEC-08 | Request body with unicode normalization tricks | Input validation |
| SEC-09 | Very large request body (100MB) | DoS |
| SEC-10 | Very long URL path | DoS |
| SEC-11 | Concurrent connection limit | DoS |
| SEC-12 | Docker escape attempt from inside container | Isolation |
| SEC-13 | Container network access when `network: none` | Isolation |
| SEC-14 | Container filesystem access when `read_only: true` | Isolation |
| SEC-15 | API response doesn't leak internal paths/config | Info disclosure |

### C2. Reliability Tests

| ID | Test | Category |
|----|------|----------|
| REL-01 | **Process crash mid-task** — kill daemon, restart, verify DB state is consistent | Crash recovery |
| REL-02 | **Process crash with task in queue** — tasks should be recoverable | Crash recovery |
| REL-03 | **Disk full during task execution** — write fails gracefully | Resource exhaustion |
| REL-04 | **DB locked during concurrent writes** — WAL handles it | Concurrency |
| REL-05 | **Executor subprocess becomes zombie** — daemon doesn't hang | Process management |
| REL-06 | **1000 tasks submitted rapidly** — queue handles burst | Load |
| REL-07 | **Long-running stress test** — 100 tasks, sequential, verify all complete | Endurance |
| REL-08 | **Memory leak detection** — submit 100 tasks, check RSS doesn't grow unbounded | Memory |

### C3. Concurrency Tests

| ID | Test | Category |
|----|------|----------|
| CON-01 | **Two tasks submitted simultaneously** — only one runs at a time (maxConcurrent=1) | Concurrency |
| CON-02 | **Cancel and complete race** — cancel arrives same instant task completes | Race condition |
| CON-03 | **Submit while previous task completing** — queue drain + new add simultaneously | Race condition |
| CON-04 | **maxConcurrent=2** — verify two tasks run simultaneously | Parallel execution |
| CON-05 | **Shutdown during task submission** — submit arrives while shutdown in progress | Lifecycle race |

---

## Test Organization

```
test/
├── unit/                        # Component-level, real behavior
│   ├── config/
│   │   ├── schema.test.ts       # CFG tests
│   │   └── loader.test.ts       # CFG tests
│   ├── db/
│   │   └── tasks.test.ts        # DB tests
│   ├── executor/
│   │   ├── shell.test.ts        # SH tests
│   │   ├── claude-code.test.ts  # CC tests
│   │   ├── docker.test.ts       # DK tests
│   │   ├── queue.test.ts        # QU tests
│   │   └── daemon.test.ts       # DA tests (NEW)
│   ├── api/
│   │   ├── auth.test.ts         # API auth tests
│   │   └── validation.test.ts   # API validation tests
│   └── utils/
│       └── env.test.ts          # ENV tests
│
├── integration/                 # Multi-component interaction
│   ├── api.test.ts              # API integration (existing, expanded)
│   ├── daemon.test.ts           # Daemon + DB + Executor integration
│   └── docker.test.ts           # Docker executor integration (gated)
│
├── e2e/                         # Full system tests
│   ├── lifecycle.test.ts        # Submit → execute → verify result
│   ├── cancel.test.ts           # Submit → cancel → verify death
│   ├── queue-stress.test.ts     # Rapid submissions, sequential execution
│   └── crash-recovery.test.ts   # Kill daemon, restart, verify state
│
├── security/                    # Security-focused tests
│   ├── injection.test.ts        # Path traversal, shell injection
│   ├── auth.test.ts             # Auth edge cases
│   └── isolation.test.ts        # Docker isolation verification
│
└── planned/                     # Tests for planned features
    ├── mcp.test.ts              # Phase 4: MCP server
    ├── backup.test.ts           # Phase 5: S3 backup
    └── judge.test.ts            # Phase 6: Judge loop
```

---

## Priority Order

### P0 — Must have before shipping Phase 1–3
1. **DA tests** (A7) — daemon.test.ts, 19 tests — ZERO coverage today
2. **API E2E lifecycle** (API-01 through API-04) — the happy path
3. **Queue drain** (QU-02, QU-06) — complete() triggers next
4. **Security** (SEC-01 through SEC-06) — injection + auth
5. **Shell executor gaps** (SH-01 through SH-20) — the most exercised executor

### P1 — Must have before shipping
1. **DB edge cases** (DB-01, DB-06, DB-15, DB-16) — crash recovery
2. **Config edge cases** (CFG-06 through CFG-20) — config robustness
3. **Concurrency** (CON-01 through CON-05) — race conditions
4. **Cancel propagation** (API-04, DA-04, DA-05) — real cancel E2E
5. **SSE streaming** (API-20 through API-22) — stream lifecycle

### P2 — Should have, polish before ship
1. **Remaining DB tests** (DB-02 through DB-19)
2. **Remaining API tests** (API-05 through API-30)
3. **Docker integration** (DK-03 through DK-17) — requires Docker
4. **Reliability** (REL-01 through REL-08) — stress + crash

### P3 — Nice to have, post-ship hardening
1. **Security deep** (SEC-07 through SEC-15)
2. **Load testing** (REL-06, REL-07, REL-08)
3. **Full env utility** (ENV-01 through ENV-09)

---

## Summary

| Area | Existing Tests | Missing Tests | Total Needed |
|------|---------------|---------------|--------------|
| Config (A1) | 21 | 20 | 41 |
| Database (A2) | 17 | 19 | 36 |
| Shell Executor (A3) | 9 | 20 | 29 |
| Claude Code (A4) | 6 | 18 | 24 |
| Docker Runner (A5) | 2 | 17 | 19 |
| Queue/Registry (A6) | 16 | 11 | 27 |
| **TaskDaemon (A7)** | **0** | **19** | **19** |
| HTTP API (A8) | 17 | 30 | 47 |
| Env Utility (A9) | 11 | 9 | 20 |
| **Subtotal (Built)** | **99** | **163** | **262** |
| Docker Phase 3 (B1) | — | 16 | 16 |
| MCP Server (B2) | — | 15 | 15 |
| Backup+Ship (B3) | — | 25 | 25 |
| Judge Loop (B4) | — | 23 | 23 |
| Security (C1) | — | 15 | 15 |
| Reliability (C2) | — | 8 | 8 |
| Concurrency (C3) | — | 5 | 5 |
| **Subtotal (Planned)** | — | **107** | **107** |
| **Grand Total** | **99** | **270** | **369** |

**Current: 103 tests passing. Target: ~369 tests for full coverage of built + planned features.**

The biggest gap is the TaskDaemon — zero tests for the component that orchestrates everything. That's the first thing to fix.
