---
name: code-review
description: Review a repository change for correctness, regressions, lifecycle flaws, compatibility, maintainability, and missing verification, reporting evidence-ranked findings without silently editing code. Use when the user asks for a code review, PR review, diff audit, bug hunt, or independent implementation assessment.
---

# Code Review

Review the requested change as read-only work unless the human also asks for fixes.

## Orient

1. Read repository instructions and determine the exact review range, base, and working-tree state.
2. Read the complete changed files and relevant callers, tests, public types, configuration, and lifecycle code.
3. Identify the intended behavior from the user request and current documentation rather than inferring it from the patch alone.

## Analyze

Prioritize defects that can change observable behavior:

- incorrect state transitions, concurrency, teardown, retry, or error handling;
- permission or trust-boundary mistakes;
- lost data, incompatible persistence, or broken public behavior;
- incomplete validation at external or durable inputs;
- tests that miss the changed acceptance path;
- unnecessary complexity only when it creates a concrete maintenance or correctness risk.

Use independent specialist passes when the diff is broad. During Autopilot, represent them as durable review tasks and dispatch through `autopilot_delegate`; direct native orchestration is denied. Outside Autopilot, use native DSH subagents, and use `workflow` only when the user explicitly requested a large multi-agent review. Deduplicate findings and verify each against the actual code before reporting it.

## Report

Lead with findings ordered by severity. For each finding, provide a concise title, exact file and line, triggering scenario, observable impact, and the smallest useful remediation direction. Distinguish confirmed defects from questions or residual risks. Then list assumptions and a short verification summary.

If no actionable defect is found, say so directly and name the important surfaces inspected and checks run. Do not claim the code is bug-free. Do not call `autopilot_verify`, complete a Goal, or mutate the patch merely because review finished.
