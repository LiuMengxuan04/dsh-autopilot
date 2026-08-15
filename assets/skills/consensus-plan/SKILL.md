---
name: consensus-plan
description: Build a repository-grounded implementation plan by combining independent architecture, implementation, and verification critiques into one explicit decision record. Use when the user asks for consensus planning, Ralplan-style planning, a multi-agent plan, or a high-confidence plan before code changes.
---

# Consensus Plan

Create one actionable plan, not a collection of unranked agent opinions. Keep the workspace read-only unless the user also asks for implementation.

## Frame the decision

1. Inspect repository instructions, relevant architecture, existing extension points, tests, and current changes.
2. State the objective, constraints, non-goals, unknowns, and proposed acceptance evidence.
3. Resolve human-owned product or authorization decisions with the human before seeking agent consensus.

## Gather independent views

During an active Autopilot run, encode independent planning views as durable tasks and use `autopilot_delegate`; direct native orchestration is denied. Outside Autopilot, use DSH's native subagent capability for one or two focused reviews, and use native `workflow` only when the user explicitly requested multi-agent planning and three or more independent views materially help.

Give each reviewer a distinct responsibility, such as:

- architecture and compatibility;
- implementation sequence and ownership;
- testing, failure modes, and operational recovery;
- security and permission effects.

Require every reviewer to cite inspected files or concrete runtime behavior, distinguish facts from inferences, and identify the strongest objection to the draft. Do not let reviewers edit overlapping files or infer additional authority.

## Synthesize

Reconcile disagreements against repository evidence and the user's constraints. Record material dissent when evidence does not settle it. Produce:

- selected design and rejected alternatives with concise reasons;
- dependency-ordered implementation steps with exact surfaces;
- migration, rollback, and recovery behavior where relevant;
- unit, integration, and end-to-end verification mapped to acceptance criteria;
- risks, unresolved human decisions, and explicit non-goals.

Use native Goal only when a human has authorized a long-running planning objective. Do not invoke native Ralph: Ralplan-style consensus is a planning workflow, while Ralph is fresh-agent iterative execution.
