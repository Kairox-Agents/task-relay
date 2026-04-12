# The full landscape of agent-as-worker infrastructure and supervisor/judge loops for coding agents

**The supervisor/judge loop pattern — plan → delegate → review → score → correct → repeat — already exists across dozens of projects, but no single tool combines remote task submission, multi-agent backend routing, and structured judge loops into the daemon architecture that Task-Relay envisions.** The ecosystem has exploded since late 2025: over 50 agent orchestration tools now exist, most using tmux + git worktrees as isolation primitives. The Ralph Loop has become standard vocabulary for iterative agent execution, and both Anthropic and OpenAI ship official SDKs for programmatic agent control (`claude -p` / Claude Agent SDK and `codex exec` / Codex SDK). Task-Relay's opportunity lies in being the missing coordination layer between these primitives — a persistent daemon accepting remote task submissions, routing to any CLI coding agent, and enforcing structured judge loops with escalation.

---

## Agent-as-worker projects already wrap every major coding CLI

The most directly relevant project is **coder/agentapi** (~1,200 stars), which wraps *any* terminal-based coding agent (Claude Code, Codex, Aider, Gemini CLI, Copilot, and 6 others) behind an HTTP API. It runs an in-memory terminal emulator, translates API calls into keystrokes, and exposes `POST /message`, `GET /status` ("stable"/"running"), and `GET /events` (SSE stream) endpoints with an OpenAPI schema. Usage is as simple as `agentapi server -- claude`. However, agentapi is a **stateless API proxy** — it has no queuing, scheduling, worker pools, or judge loops. Task-Relay would differentiate by adding all four.

Several other agent-as-service projects fill adjacent niches:

| Project | Stars | What it does | Gap Task-Relay fills |
|---------|-------|-------------|---------------------|
| **coder/agentapi** | ~1,200 | HTTP API wrapper for any CLI agent | No queuing, no judge loops |
| **claude-did-this/claude-hub** | — | Webhook→Docker→Claude Code for GitHub events | Webhook-only, no general task API |
| **SShadowS/aider-restapi** | — | REST API layer for Aider | Single-agent, Aider only |
| **disler/aider-mcp-server** | — | MCP server wrapping Aider for Claude Code | MCP-only, no HTTP, no queue |
| **phil65/agentpool** | — | YAML-configured multi-agent protocol bridge | Protocol unification, not execution |
| **desplega-ai/agent-swarm** | — | Lead/worker architecture in Docker containers | Heavier, Docker-required, Slack-driven |

The official programmatic interfaces are **`claude -p`** (Claude Code's print/pipe mode with `--output-format stream-json`) and **`codex exec`** (with `--json` and `--full-auto`). The **Claude Agent SDK** (Python: `claude-agent-sdk`, TypeScript: `@anthropic-ai/claude-agent-sdk`) wraps a Claude Code subprocess internally and provides `query()` async iterators, session management, hooks, subagents, and a custom `Transport` class that could enable remote execution. The **Codex SDK** (`@openai/codex-sdk`) provides `startThread()` + `run()` for multi-turn programmatic control. **Task-Relay should use these SDKs as execution backends**, not shell out to CLI commands directly.

---

## The Ralph Loop established the iterative agent execution pattern

The single most referenced pattern in this space is the **Ralph Loop** (named after Ralph Wiggum), created by Geoffrey Huntley in January 2026. It has become standard industry vocabulary with **14,300+ GitHub stars** on the canonical `snarktank/ralph` repository. Ralph is a bash loop that repeatedly invokes a coding agent with the same prompt until all PRD items pass, using **git as the memory layer** — each iteration gets a fresh context window, avoiding "context rot."

The architecture is straightforward: `ralph-loop.sh` → invoke agent (`claude -p` or `codex exec`) → stream-parser detects signals → ROTATE at 80k tokens → fresh context. Two phases alternate: PLANNING (gap analysis, TODO list) and BUILDING (pick task, implement, test, commit). **"Backpressure" via tests, typechecks, and lints** acts as the quality gate — invalid work gets rejected. The exit condition is the agent outputting `<promise>COMPLETE</promise>`.

Multiple implementations now exist: **PageAI-Pro/ralph-loop** adds Docker sandboxing and `STEERING.md` for runtime interventions; **frankbria/ralph-claude-code** adds intelligent exit detection, dual-condition exit gates, rate limiting (100 calls/hr), and circuit breakers with 566 tests; **Vercel Labs** built `ralph-loop-agent`, an official SDK wrapper separating the "tool-calling loop" from the "task-completion loop" via a `verifyCompletion()` callback.

However, Ralph is **deliberately monolithic and single-agent**. Huntley explicitly argues against multi-agent coordination at this stage: *"While I was in SFO, everyone seemed to be trying to crack multi-agent, agent-to-agent communication and multiplexing. At this stage, it's not needed."* Task-Relay represents the next evolution — structured multi-agent delegation with quality gates that Ralph deliberately avoids.

---

## The plan-execute-review-score-correct pattern is fragmented across projects

The exact codex-handoff-skill pattern (plan → execute → review diff → score DONE/PARTIAL/MISSING → correction prompt → repeat up to N iterations) exists in fragments across multiple projects, but no single tool combines all elements:

**OpenPlanter** (`ShinMegamiBoson/OpenPlanter`) is the closest pure implementation. It's a recursive investigation agent with acceptance criteria and an **independent cheap judge model** (e.g., Haiku) for sub-agent delegation (max depth 4). When a parent delegates, it specifies acceptance criteria. Upon completion, a cheap judge evaluates → PASS/FAIL with feedback. The critical design principle: *"The agent that does the work should not be its sole verifier."* Implementation and verification must be **uncorrelated** — using the same model for both creates blind spots.

**Nightwire** (`HackingDave/nightwire`) implements three safety patterns most relevant to Task-Relay: (1) independent verification via a separate LLM context reviewing every code change, (2) baseline-relative quality gates comparing test snapshots before/after and only failing on *new* regressions, and (3) a **self-healing auto-fix loop** where failed verification triggers a fresh agent fix attempt, up to 2 retries. The auto-fix loop pattern with git checkpointing in `executor.py` (759 lines) is a production-tested reference for Task-Relay's correction loop.

**Hermes Agent** (`NousResearch/hermes-agent`, 22,300 stars) is actively building exactly this pattern through multiple GitHub issues. Issue #356 proposes adding `acceptance_criteria` to `delegate_task`, with an independent judge evaluating PASS/FAIL. Issue #406 adds independent code review before commit with baseline regression detection and auto-fix loops (up to 2 retries). This represents a major project converging on the same design Task-Relay needs.

**ARIS** (`wanshuiyin/Auto-claude-code-research-in-sleep`) implements cross-model executor+reviewer loops — Claude Code executes while Codex reviews. The key finding: *"Using Claude Code subagents for both execution and review tends to fall into local minima — the same model reviewing its own patterns creates blind spots. Going from 1→2 models is the biggest gain."*

The **Codex iterate-on-difficult-problems** official pattern provides the scoring framework: combine deterministic checks + LLM-as-judge, define stopping rules (e.g., "overall score AND LLM-judge average both above 90%"), and keep notes about loop progress comparing current vs. prior best. This **dual-threshold approach** is exactly what Task-Relay's judge should implement.

---

## Five orchestration frameworks directly compete with Task-Relay's vision

**Bernstein** (`chernistry/bernstein`) is the most architecturally aligned competitor. It decomposes goals into tasks, spawns agents in parallel git worktrees, runs a **"janitor" verification step** (tests pass, files exist, lint clean, types correct), merges verified work, and retries failed tasks or routes them to different models. Its key design choice: *"The orchestrator itself is deterministic Python code. Zero LLM tokens on scheduling."* It also features a contextual bandit router that learns optimal model/effort pairs, circuit breakers for misbehaving agents, and cross-model code review. Available via `pip install bernstein`.

**kodo** (`ikamensh/kodo`) uses a cheap API model (Gemini Flash, "fractions of a cent") as orchestrator directing Claude Code agents through work cycles, with independent architect + tester agents reviewing work before accepting. Its design insight is critical: *"CLI coding tools are built to solve problems themselves — they'll try to write code, micromanage agents. A plain API model stays in its lane as coordinator."* The `--improve` mode spins up agents to find bugs, aggregates findings, and makes a call (reject/fix/needs human).

**ComposioHQ/agent-orchestrator** (3,288 tests) manages fleets of coding agents in parallel with git worktree isolation, auto-handling of CI failures and reviewer comments. It's agent-agnostic, runtime-agnostic (tmux/Docker), and tracker-agnostic (GitHub/Linear) with 7 plugin slots and a reactive event model (`ci-failed → send-to-agent`). **Overstory** uses SQLite-based messaging (WAL mode, ~1-5ms) with 8 message types including escalation, a FIFO merge queue with 4-tier conflict resolution, and 11 pluggable runtime adapters. **metaswarm** is the most sophisticated, with 18 specialized agent personas, a 9-phase workflow with review gates, recursive orchestration ("swarm of swarms"), and JSONL knowledge bases for patterns and decisions.

None of these competitors implement the **remote task submission daemon** pattern that Task-Relay centers on. Most require local TUI interaction or are CI-triggered. Task-Relay's daemon architecture accepting remote API requests is genuinely novel in the coding-agent space.

---

## Claude and Codex both provide the infrastructure but not the supervisor loop

**Claude Code's subagent system** (Task tool) uses a hub-and-spoke model where the main agent spawns independent sub-agents with their own context windows, custom system prompts, and tool access. Only the final message returns to the parent. Built-in subagent types include Explore (read-only, Haiku), Plan (research), and general-purpose. Custom subagents can be defined as markdown files in `.claude/agents/` with YAML frontmatter. The `run_in_background` parameter enables background execution for long tasks. The experimental **Agent Teams** feature (`CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1`) coordinates multiple independent Claude Code sessions with shared task lists, dependency tracking, and peer-to-peer messaging.

**OpenAI Codex cloud** runs tasks in isolated sandboxed containers with repo checkout, cached state (up to 12 hours), and internet disabled by default. The App Server uses a **bidirectional JSON-RPC protocol over stdio** — the server can pause and ask the client for human approval before executing commands. Codex supports `codex mcp-server` mode, making it a callable MCP tool. The Agents SDK provides both `handoffs` (transfer conversation ownership) and `agents-as-tools` (bounded subtasks returning to caller) patterns. The experimental `codexTool()` bridges the Agents SDK to Codex for workspace operations.

**Neither platform has a first-class supervisor/judge pattern built in.** Both rely on human-in-the-loop approval. Task-Relay fills this gap by automating the judge role programmatically.

---

## MCP and async execution tools form the integration layer

**steipete/claude-code-mcp** (1,100 stars, 130 forks) is the most popular MCP wrapper, exposing a single `claude_code` tool that any MCP client (Cursor, Claude Desktop, Windsurf) can invoke — an "agent in your agent" pattern. **block/agent-task-queue** is a local task queuing MCP server by Block (Square) that prevents multiple agents from running expensive operations concurrently, using **SQLite for queue state** with deduplication (if Agent B requests the same build Agent A just started, B waits and gets the cached result).

**vasiliyk/claude-queue** is the closest async execution precedent to Task-Relay — a Python task queue for Claude Code with priorities, dependencies, and automatic rate limit monitoring against Claude Plan limits (5-hour/7-day quotas). **aannoo/hcom** (189 stars) enables inter-agent messaging across terminals with file edit collision detection, transcript reading, and **cross-device relay via MQTT** — directly relevant to Task-Relay's remote submission pattern.

For session management, **smtg-ai/claude-squad** manages multiple agent sessions in tmux workspaces with git worktree isolation, while **HKUDS/ClawTeam** uses an inbox/message system between agents with task boards and team templates. The **TASKS.md specification** defines a lightweight markdown-based task queue format with priority levels, claiming mechanisms, and dependencies that could serve as Task-Relay's interchange format.

---

## What the community is saying and where the debates lie

The community is sharply divided on multi-agent viability. **Cognition (Devin)** published "Don't Build Multi-Agents," warning that *"running multiple agents in collaboration only results in fragile systems"* due to conflicting decisions when parallel agents lack shared context. They note that even Claude Code's subagents only handle investigative work, never parallel coding.

**Addy Osmani** describes three tiers of orchestration: Tier 1 (Claude Code subagents, single terminal), Tier 2 (external orchestrators like Conductor and Claude Squad for 3-10 agents), and Tier 3 (cloud agents for async "close laptop" work). The key observation: *"The lead only sees green-reviewed code. It's like having a permanent CI quality gate built into the team itself."*

Quantitative data supports the value proposition: **multi-agent teams score 72.2% on SWE-bench Verified** versus ~65% for single agents using the same model. The gains come entirely from team structure, not better models, with reviewer agents checking coder output accounting for a **7.2% improvement**. The tradeoff is **15× more tokens consumed**.

The **Aviator blog** issues a critical warning: *"If you can't get consistent value from one agent, you'll get consistently amplified chaos from ten."* Gas Town users report **$200+/month API costs**. The consensus: spec-driven development wins over ad-hoc prompting.

---

## Synthesis: what's established, what's missing, and what Task-Relay should do

### Well-established patterns
The following patterns have broad adoption and multiple implementations: **fresh-context iteration** (Ralph Loop), **git worktree isolation** per agent, **`claude -p` / `codex exec` as headless execution**, **MCP for agent-as-tool wrapping**, and **SQLite-backed local queuing**. These are solved problems Task-Relay should adopt, not reinvent.

### What's genuinely missing
No existing project combines all of these: (1) a **persistent local daemon** accepting remote task submissions via API, (2) **multi-backend routing** to any CLI coding agent, (3) **structured supervisor/judge loops** with configurable scorecards and iteration limits, (4) **async execution with streaming results** and trace backup, and (5) **human escalation after N iterations**. Existing tools are either stateless proxies (agentapi), local-only queues (claude-queue), TUI session managers (claude-squad), or full orchestration frameworks requiring significant setup (Bernstein, metaswarm).

### Design decisions to reconsider

**Use a cheap API model as orchestrator, not a CLI agent.** kodo's insight is critical — CLI coding tools try to write code themselves when used as coordinators. A plain API call to Gemini Flash or Haiku for judging costs fractions of a cent and stays focused on coordination.

**Implement cross-model review by default.** ARIS demonstrates that same-model review creates blind spots. Task-Relay should default to a different (cheaper) model for judging than the one that executed the task.

**Make the orchestrator deterministic.** Bernstein's zero-LLM-token scheduling is the right approach — don't waste expensive tokens on task routing, queue management, or lifecycle transitions. Use LLM tokens only for the actual coding work and the judge evaluation.

**Support MCP as a first-class interface.** With block/agent-task-queue and steipete/claude-code-mcp proving that MCP-based agent coordination works, Task-Relay should expose itself as an MCP server so any MCP-compatible agent can submit tasks directly.

**Adopt the TASKS.md interchange format** for task definitions — agents already understand markdown, and the specification has built-in priority, dependency, and claiming semantics.

### Specific integration opportunities

- **Build on coder/agentapi** for the agent-wrapping layer rather than reimplementing terminal emulation
- **Use Claude Agent SDK's `Transport` abstraction** for remote execution rather than raw subprocess management  
- **Integrate block/agent-task-queue's deduplication logic** to prevent redundant expensive operations
- **Adopt hcom's MQTT relay** for cross-device remote task submission
- **Implement OpenPlanter's acceptance criteria pattern** for the judge loop — explicit criteria in the task definition, cheap model evaluation, PASS/FAIL with structured feedback
- **Support Codex's MCP server mode** (`codex mcp-server`) as a backend, enabling the Agents SDK orchestration pattern where Task-Relay acts as the supervisor wrapping Codex-as-MCP-tool
- **Use Ralph's `<promise>COMPLETE</promise>` signal pattern** for agent completion detection, with configurable exit conditions per backend

### The competitive landscape in one sentence
Task-Relay sits in a specific gap between stateless API proxies (agentapi), single-agent iteration loops (Ralph), and heavyweight orchestration frameworks (Bernstein, metaswarm) — it should be the **lightest possible daemon that turns any CLI coding agent into a remotely callable worker with structured quality gates**, without requiring Docker, Kubernetes, or complex configuration.