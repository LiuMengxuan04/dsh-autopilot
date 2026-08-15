---
name: ralplan
description: "Run the Ralplan compatibility workflow: obtain independent planner, architect, and critic assessments, then converge on one evidence-backed execution plan without changing code. Use when the user explicitly says ralplan, asks for an oh-my-style consensus plan, or wants adversarial multi-agent planning before implementation."
---

# Ralplan

Treat Ralplan as consensus planning, not as a Ralph execution loop.

1. Inspect the repository and draft the objective, constraints, non-goals, acceptance criteria, and likely implementation seams.
2. Ask the human about decisions that cannot be established from the workspace.
3. During active Autopilot, create planner, architect, and critic tasks in the durable graph and dispatch them through `autopilot_delegate`. Outside Autopilot, use native DSH subagents for those perspectives and native `workflow` only when the explicit request and task size justify fan-out.
4. Keep reviewers read-only. Give them distinct questions and require file or behavior evidence, risks, and a concrete objection.
5. Compare the views, resolve disagreements from evidence, and retain any material unresolved dissent.
6. Return one dependency-ordered plan covering implementation ownership, compatibility, failure recovery, and criterion-by-criterion verification.

Do not call the native `ralph` tool, create an Autopilot lease, edit files, or broaden permissions during Ralplan unless the human separately authorizes those actions. A plan is complete only when another agent can execute it without reconstructing hidden assumptions.
