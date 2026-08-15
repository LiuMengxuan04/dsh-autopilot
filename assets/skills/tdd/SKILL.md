---
name: tdd
description: Develop behavior through a disciplined red-green-refactor loop with repository-native tests, narrow feedback, and end-to-end evidence. Use when the user requests TDD, test-first implementation, regression-first bug fixing, or a change whose behavior should be pinned before production code is altered.
---

# Test-Driven Development

Use tests to specify observable behavior, not to mirror implementation details.

## Establish the test surface

1. Read repository instructions and identify the smallest public or package-level surface that expresses the requested behavior.
2. Inspect existing test conventions, fixtures, helpers, and relevant end-to-end coverage.
3. State the behavior, failure behavior, and regression risk before editing.
4. Preserve unrelated changes and avoid broad snapshots when a focused assertion communicates the contract better.

## Red

Add one minimal test for the next behavior. Run the narrowest command that exercises it and confirm it fails for the expected reason. A syntax error, missing fixture, unrelated failure, or test that already passes is not a valid red state.

For a bug, reproduce the reported failure before changing production code. For behavior requiring external services, build a deterministic local or replay boundary when the repository supports one; do not fabricate a passing mock that skips the real integration seam.

## Green

Implement the smallest coherent change that makes the failing test pass while respecting repository architecture and permission policy. Run the focused test and inspect its actual output. Do not weaken the assertion, skip the case, or special-case the fixture to manufacture green.

## Refactor

Improve names, structure, and duplication only after green. Re-run the focused test after each meaningful refactor. Then run the relevant neighboring suite, static checks, and assembled end-to-end path in proportion to risk.

Use independent workers only for test-surface research or review; keep red-green ownership with one implementer to avoid concurrent edits invalidating the signal. During Autopilot, put delegated work in the durable graph and use `autopilot_delegate`; outside it, native DSH subagents or workflow may be used when justified. When a Goal or Autopilot run is active, maintain criterion-level evidence and let its completion policy decide the final state.
