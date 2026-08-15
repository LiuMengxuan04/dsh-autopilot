---
name: deep-interview
description: Turn an ambiguous product, architecture, or implementation request into an executable requirements brief through focused human questions and repository-grounded discovery. Use when the user asks for a deep interview, requirements interview, clarification-first workflow, or when consequential unknowns would materially change the implementation.
---

# Deep Interview

Resolve consequential uncertainty with the human before beginning implementation. Keep discovery read-only unless the user separately authorizes edits.

## Establish the known state

1. Read the user's request, repository instructions, relevant documentation, and nearby implementation.
2. Separate facts established by the workspace from assumptions and genuine product decisions.
3. Identify only uncertainties that can change scope, architecture, compatibility, safety, acceptance criteria, or user experience.

Use DSH's native `ask_user_question` tool when it is available. Otherwise ask in the ordinary response. Never delegate a human preference or authorization decision to a subagent.

## Interview efficiently

- Ask one high-information question at a time.
- Provide two or three mutually exclusive options when the decision space is known.
- Put the recommended option first and state its concrete tradeoff.
- Use a free-form question when preset choices would conceal important possibilities.
- Do not ask for facts that repository inspection can answer.
- Follow an answer when it exposes a new consequential dependency; otherwise advance to the next unresolved decision.

Cover the relevant parts of this checklist without turning it into a questionnaire: desired outcome, users and entry points, non-goals, existing behavior, compatibility, data and lifecycle, failure handling, permissions, performance, observability, tests, rollout, and completion evidence.

## Produce the brief

Finish when every remaining uncertainty is either immaterial, explicitly deferred, or recorded as an assumption. Summarize:

- the outcome and non-goals;
- observable behavior and failure behavior;
- constraints and preserved compatibility;
- acceptance criteria with verification evidence;
- settled decisions, assumptions, and explicitly deferred questions;
- an implementation sequence with dependencies.

Do not create a DSH Goal, start Autopilot, call Ralph, or mutate files merely to conduct the interview. If the user then authorizes implementation, use native DSH Goal and DSH Autopilot according to their own authorization and verification rules.
