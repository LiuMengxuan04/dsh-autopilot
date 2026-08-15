---
name: team-orchestration
description: Coordinate a bounded team of DSH subagents with explicit roles, dependencies, file ownership, progress collection, and parent-owned integration. Use when the user asks for a team, swarm, parallel agents, delegated implementation, or multi-specialist analysis.
---

# Team Orchestration

Use DSH subagents as the execution layer. Keep the parent responsible for task selection, shared state, integration, and the final claim. During an active Autopilot run, create the durable graph with `autopilot_plan` and dispatch only through `autopilot_delegate`; direct `subagent*`, `workflow`, `ralph`, and schedule creation are denied so work cannot bypass attribution or budgets.

## Build the team graph

1. Read repository instructions, active Goal or Autopilot state, and current changes.
2. Split the objective into tasks with inputs, outputs, dependencies, permitted files, and verification evidence.
3. Delegate only work that is independent enough to justify context and coordination cost.
4. Assign distinct roles from the work itself: researcher, implementer, test owner, reviewer, or integrator. Do not create decorative roles.

Outside Autopilot, use one or two native subagent calls for small teams and native `workflow` only for an explicitly requested larger pipeline. Inside Autopilot, represent each independent item as a durable task. Use `autopilot_delegate` for one-shot batches, `autopilot_team_*` for continuable workers and their durable mailbox, `autopilot_workflow_run` for deployment-owned fan-out/fan-in profiles, and `autopilot_ralph_*` for a bounded fresh-agent loop over one dependency-ready leaf. These surfaces share the run ledger and managed-start provenance; direct native subagent, workflow, Ralph, and schedule tools remain denied because they would bypass attribution.

## Prevent collisions

- Give mutable files one owner at a time.
- Keep shared types and cross-cutting integration with the parent or order them before dependent tasks.
- Tell every child that the workspace may change concurrently and to preserve unrelated edits.
- Require evidence and a precise handoff: files inspected or changed, checks run, failures, assumptions, and remaining work.
- Do not delegate human decisions, approvals, secrets, or authority boundaries.

## Integrate and review

Collect results at dependency boundaries. Inspect actual workspace state rather than trusting summaries. Resolve conflicting recommendations explicitly, run integration checks, and assign an independent reviewer for high-risk work. Cancel or re-scope redundant children when the graph changes.

Finish only when the parent can map every acceptance criterion to assembled evidence. Native Goal and DSH Autopilot own continuation and verifier-gated completion; team consensus does not override either.
