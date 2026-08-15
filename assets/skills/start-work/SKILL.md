---
name: start-work
description: Execute an approved engineering plan from clean repository orientation through dependency-aware implementation, verification, isolated local delivery preparation, and handoff. Use when the user says start work, implement the plan, ship the approved design, prepare a pull request, or continue a previously planned Autopilot objective.
---

# Start Work

Turn an approved plan into verified local artifacts while keeping external delivery under human control.

## Admit the plan

1. Read repository instructions and inspect the worktree before editing.
2. Confirm the objective, acceptance criteria, approved plan, branch policy, and permission scope.
3. Reconcile existing Autopilot, Goal, task, Team, Ralph, delivery, and handoff state instead of starting duplicate work.
4. Stop for an unresolved product choice, destructive action, credential, external production mutation, or Client-side Cordis approval.

Under Autopilot, materialize the plan with `autopilot_plan`; use `autopilot_task` for later graph changes and `autopilot_delegate` for bounded one-shot work. Use `autopilot_team_start` for a task that benefits from a durable mailbox and `autopilot_ralph_start` for a bounded fresh-context repair loop. Every worker owns exact task ids and returns inspectable evidence; the parent owns integration.

## Implement and integrate

Keep parallel file ownership disjoint. Re-read shared files before integrating because workers may share the same workspace. Run focused checks after each coherent change and preserve unrelated user edits. Record blockers rather than silently shrinking acceptance criteria.

Use `autopilot_delivery` to create an isolated Git worktree when the plan or repository policy benefits from it. Checkpoint verifier and handoff evidence against the exact Autopilot run generation. The delivery service may prepare fixed local commit, push, and pull-request argv for human inspection, but it never executes commit, push, or PR creation.

## Verify and prepare delivery

1. Run the frozen deterministic project checks.
2. Inspect the final diff and repository status.
3. Submit criterion-level evidence through `autopilot_verify`; repair every actionable finding and verify again.
4. Prepare a local delivery plan only after verification passes.
5. Report files changed, commands run, remaining risk, local worktree/artifact location, and the exact human-owned next action.

Never claim success from a worker report, a prepared delivery command, or a green subset. Never push, open a pull request, publish, deploy, or elevate permission unless the human separately authorizes that external action. Before pausing, store durable decisions with `autopilot_memory` and write an `autopilot_handoff` with the next safe action.
