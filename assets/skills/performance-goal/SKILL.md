---
name: performance-goal
description: Improve a system against an explicit performance target through reproducible baselines, profiling, isolated changes, regression checks, and independent verification. Use for latency, throughput, memory, startup, bundle-size, token, cost, or other measurable optimization objectives, especially during a long Autopilot run.
---

# Performance Goal

Optimize a measured system, not a proxy chosen after seeing the result.

## Freeze the measurement contract

1. Name the user-visible metric, target, workload, warmup, sample count, environment, and allowed tradeoffs.
2. Capture a clean baseline and retain the exact command plus raw output artifact.
3. Identify correctness and resource regressions that must remain green.
4. If the target or workload is ambiguous, obtain the human decision before optimizing.

Do not compare results from materially different machines, dependencies, datasets, build modes, or thermal states without labeling the difference. Do not remove work, validation, durability, or security merely to improve a number.

## Execute bounded hypotheses

Under Autopilot, encode profiling, candidate changes, and benchmark repetitions as tasks with dependencies and acceptance criteria. Delegate independent profiling or implementation candidates with `autopilot_delegate`; keep benchmark methodology and final integration with the parent. Use `autopilot_ralph_start` only for a bounded fresh-agent loop on one candidate.

For every candidate:

1. Profile before editing and identify the suspected bottleneck.
2. Make one coherent change.
3. Run correctness checks first, then the same benchmark as the baseline.
4. Record median and dispersion or the repository's established statistic, not only the best run.
5. Revert or reject regressions and inconclusive changes instead of stacking them.

Use a worktree through `autopilot_delivery` when alternative implementations require isolation. Never commit, push, or open a pull request through an autonomous delivery plan; the tool only prepares inspectable local argv and artifacts.

## Verify the result

Re-run the final benchmark from a clean build, compare to the frozen baseline, and report absolute and relative change plus confidence limits where meaningful. Include correctness tests, profiling evidence, and any tradeoffs. Call `autopilot_verify` only after the target and all non-regression criteria are satisfied; independent reviewers may reject benchmark leakage or unsupported attribution.
