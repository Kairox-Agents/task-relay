# GroundCrew — Project Brief

You're taking over research, planning, and initial implementation for a new open source project.

Project: a lightweight local worker service that runs on a user's machine and lets remote agents, teammates, or services submit tasks for local execution. Think: turning manual tools like Claude Code / Codex-style workflows into a callable local execution node for an agent fleet.

Primary use cases:
- browser automation on a user-controlled machine
- local CLI / coding tasks
- filesystem operations
- access to authenticated local sessions
- delegated "do this task" execution for humans or agents

Your job:
1. research the design space
2. clarify product + technical requirements
3. define the MVP
4. propose architecture + security model
5. produce an implementation plan
6. start scaffolding code once the plan is solid

Constraints / preferences:
- local-first
- small, practical, hackable v1
- easy to run on a laptop/workstation
- usable by both humans and agents
- support task-based execution
- good logs / observability
- avoid over-engineering
- avoid pretending security is solved
- avoid requiring a big hosted backend in v1

Please start by delivering, in order:

1) Project framing memo
2) Minimum clarifying questions
3) Proposed architecture
4) MVP plan
5) Tech stack recommendation
6) Initial repo scaffolding

Key design questions to work through:
- Is v1 for solo power users, small teams, or agent-platform builders?
- Is this mainly a daemon, an RPC endpoint, or both?
- Should task intake be HTTP, queue-based, websocket/SSE, CLI, MCP, or hybrid?
- Should tasks be sync, async, or both?
- Should workers be standalone first, or coordinated?
- How should capabilities be declared?
- Should each task run in a subprocess, container, VM, or shared runtime?
- How do we wrap tools like coding agents, shell, and browser automation behind a common abstraction?
- How do we model inputs, outputs, logs, artifacts, status, retries, cancellation, and timeouts?
- What is the minimum viable auth / permission / secret-handling / sandboxing model?
- How do we prevent remote abuse of the local machine?

Bias toward:
- simple over clever
- observable over magical
- composable over monolithic
- local-first over cloud-dependent
- secure-enough defaults
- good ergonomics for agent callers

Suggested first response:
1. restate the project in your own words
2. propose the most plausible MVP
3. identify the 5 most important architecture decisions
4. identify the top risks
5. ask the minimum clarifying questions needed before planning

Possible naming vibe: developer tool / infrastructure / local worker node. Existing ideas included GroundCrew, Dockhand, Taskforge, Dispatchd, Harbor, GhostBox, NodeFoundry, Workdock.
