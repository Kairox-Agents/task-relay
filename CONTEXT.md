# GroundCrew — Project Context

**Last Updated:** 2026-04-11
**Telegram Topic ID:** 232
**Folder:** `projects/groundcrew/`

## Current State

Project just created. Starting dual-brain planning pipeline for the local worker service.

## What This Is

A lightweight local worker daemon that:
- Runs on a user's machine
- Accepts task submissions from remote agents/humans/services
- Executes: browser automation, CLI/coding tasks, filesystem ops, delegated execution
- Think: callable local execution node for an agent fleet

## Constraints / Preferences

- Local-first, small, practical, hackable v1
- Easy to run on laptop/workstation
- Usable by both humans and agents
- Good logs/observability
- No over-engineering, no fake security claims
- No big hosted backend in v1

## Planning Pipeline Status

- [ ] Step 1: Brainstorm (Claude)
- [ ] Step 2: Codex critique
- [ ] Step 3: Plan (Claude)
- [ ] Step 4: Codex sanity check
- [ ] Step 5: Route to executor

## Open Questions (from brief)

- Preferred implementation language?
- Target OSes?
- Is browser automation MVP-critical?
- Is coding-agent integration MVP-critical?
- LAN-only or internet-facing remote access?
- Central coordination in v1 or not?
- Preferred license?
- Security/threat-model bar?

## Key Decisions

_None yet._

## Recent Progress

- 2026-04-11: Project scaffolded as "GroundCrew" by mistake, renamed to Task-Relay
