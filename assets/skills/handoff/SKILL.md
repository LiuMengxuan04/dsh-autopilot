---
name: handoff
description: Produce a durable, restart-safe engineering handoff that captures objective, Goal and Autopilot state, workspace changes, evidence, failures, decisions, and exact next actions without exposing hidden reasoning. Use when pausing work, changing agents, approaching a context limit, recovering after restart, or transferring an unfinished long-running objective.
---

# Durable Handoff

Write a handoff that lets another agent resume from inspectable state. Autopilot sidecar authorization, budgets, task attempts, verification history, audited Cordis source versions, and explicit project-memory entries are durable; live abort signals, timers, Host runtime ids, terminal processes, and unaccounted child mailboxes are not. Project-memory values are not injected automatically. Do not claim that a workflow, terminal process, or child mailbox survives restart unless the active DSH capability explicitly guarantees it.

## Capture authoritative state

1. Read native `get_goal` and `get_autopilot` state when available. Record exact ids, revisions, phases, budgets, the frozen verification baseline and manifest hashes, and pause or resume requirements.
2. Inspect the working tree and list changed, untracked, generated, and unrelated user-owned files separately.
3. Record acceptance criteria with complete, partial, failed, or untouched status and concrete evidence.
4. Capture commands actually run, exit outcomes, important diagnostics, and any environment prerequisite without copying credentials.
5. List durable Cordis logical ids, source hashes, active audited versions, diagnostics, and cleanup or rollback state. Label Plugin, Package, and run ids as process-local observations rather than restart-stable identities.
6. List active or completed subagents and workflows only from observable DSH state. Do not invent messages or results.

## Write the recovery path

Provide, in this order:

- exact objective and non-goals;
- current Goal and Autopilot authorization state;
- repository and workspace state;
- completed work and evidence;
- failed attempts and why they remain relevant;
- settled decisions and explicit assumptions;
- remaining work in dependency order;
- the first safe resume action, whether crash-only auto-resume is authorized, and any required human command or approval;
- final verification still required.

Use concise conclusions, not chain-of-thought or hidden deliberation. Omit secrets and redact sensitive values while preserving the variable or credential name needed for recovery.

When an exact Goal and Autopilot run exists and `autopilot_handoff` is available, call it with both a concise recovery `summary` and one concrete `nextAction`. This is also valid after a human pause or fail-closed attention transition; it does not rearm work. Retain its revision-addressed project-memory key so the next agent can explicitly read it with `autopilot_memory`. The tool adds exact Goal/run revisions, rounds, budgets and usage, the frozen verification baseline, bounded task evidence, recent verification history, and managed Cordis versions; do not duplicate sensitive raw data in the summary.

If the tool is unavailable, write a workspace handoff file only when the user requested a durable artifact or repository convention requires one; otherwise return the handoff in the response. A handoff pauses or transfers work but does not complete the Goal, pass `autopilot_verify`, preserve live processes, or broaden the next agent's authority.
