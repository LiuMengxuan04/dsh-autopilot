# Changelog

## 0.1.0-alpha.3

This prerelease stabilizes the current DSH Autopilot feature set on DeepSeek Harness `0.1.0-rc.6` and Cordis `4.0.1`.

### Added

- Durable Autopilot authorization, budgets, task DAGs, canonical interview and plan-review stages, verification repair cycles, completion delivery, and crash recovery.
- Managed one-shot delegation, continuable Team workers, bounded Ralph loops, fixed Workflow profiles, Mission queues, and read-only specialist consultations.
- Host-only dynamic Cordis lifecycle management with source auditing, health checks, rollback, restart rehydration, and cleanup debt.
- Project checks, independent reviewer gates, memory and handoff tools, prompt rules, custom commands, packaged skills, Skill MCP lifecycle, lifecycle hooks, notifications, delivery worktrees, code intelligence, Visual QA, doctor, audit, and a read-only run dashboard.

### Changed

- All DSH peer and development dependencies now use the registry-published `0.1.0-rc.6` line; a sibling Harness checkout is no longer required.
- Autopilot execution now requires the canonical interview, durable plan, and fixed Metis/Momus/Oracle plan review before tasks may run. Repair plans pass through the same review gate.
- Consecutive plan-hardening failures are capped at five; exhaustion disarms the run and records `needs-attention` instead of continuing indefinitely.
- Fresh plan and completion reviewers receive Host-supplied parent execution facts and cannot mistake their isolated child Goal or tool registry for the parent run.
- Frozen project and deployment checks run before completion review, so fresh reviewers receive controller-owned deterministic records.
- Self-modification is disabled by default. Host-only dynamic Cordis remains an explicitly trusted same-process mode and never bypasses Client approval.

### Verification

- The unit suite contains 1,215 tests with 100% statement, branch, function, and line coverage for included source files.
- The packed DSH Web replay covers the canonical plan gates, managed Host-only Cordis lifecycle, failed verification, repair, fresh review, Goal completion, persistence, and final user feedback.
- The release tarball passes `publint`, installs in a fresh npm project, loads every public JavaScript export, and starts the packaged doctor CLI.

### Known limitations

- This alpha does not claim complete oh-my-codex or oh-my-openagent parity. `pnpm run capabilities:complete` intentionally remains red while the capability ledger contains planned, implementing, native-limited, unit-verified, or packed-verified rows.
- Several integrations are deployment-configured or narrower than their upstream counterparts. The exact status and evidence are recorded in `capabilities.lock.json` and `docs/parity-matrix.md`.
- Completion feedback is recoverable and at-least-once, not exactly-once. Host-only dynamic Cordis is not a security sandbox.
