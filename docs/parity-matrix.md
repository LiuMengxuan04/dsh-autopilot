# Capability parity matrix

This document fixes the reference revisions and defines what “migrate the oh-my feature set” means for DSH Autopilot. A feature may be implemented by this repository, composed from a public DSH capability, or rejected when it would weaken DSH permissions. Copying product names, personas, or implementation machinery is not a parity requirement; reproducing the user-visible behavior is.

Reference revisions:

- [oh-my-codex `e94437f`](https://github.com/Yeachan-Heo/oh-my-codex/tree/e94437fd141b4623d12a7c712d6f318e7aa47439)
- [oh-my-openagent `038ed0c`](https://github.com/code-yeongyu/oh-my-openagent/tree/038ed0cbbefe2b40677b63867aeea0d16bc303e0), formerly oh-my-opencode
- [DeepSeek Harness `47f9438`](https://github.com/deepseek-ai/deepseek-harness/tree/47f943859bef60e4160492346772ded9b24f765a), version `0.1.0-rc.5`, retained only as the audited feature-inventory baseline

The machine-readable companions are [`upstream-features.lock.json`](../upstream-features.lock.json) and [`capabilities.lock.json`](../capabilities.lock.json). The upstream inventory freezes the user-visible feature catalog and exact source files at the pinned revisions; it is independent of the exact DSH `0.1.0-rc.6` npm line used for runtime compatibility and packed tests. The capability ledger records how this project implements each feature and its current evidence status. A capability may serve several equivalent upstream features, but every inventory feature has exactly one capability mapping. A capability is complete only when its implementation and its failure/recovery acceptance paths have the required evidence; `unit-verified` and `packed-verified` are intentionally not synonyms for final parity. The `0.1.0-alpha.3` manifest is a release candidate state until an explicit npm publish succeeds.

## Inventory boundary

The pinned inventory contains 101 feature records: 51 from oh-my-codex and 50 from oh-my-openagent. The OMX set includes every previously audited workflow plus the pinned catalog's active `ai-slop-cleaner`, `ask`, `pipeline`, and `omx-setup` entries; retaining `omx-setup` keeps scoped setup behavior visible even though generic installer variants are otherwise outside the portable runtime boundary. Branding, telemetry, and implementation-private helper modules remain excluded.

Each citation names a source file, inclusive line range, human-readable locator, exact commit URL, and SHA-256 digest for the pinned file. `pnpm run capabilities:check` rejects an inventory feature that is deleted, duplicated, absent from the expected-ID manifest, mapped to an unknown capability, mapped to a capability that does not cite that upstream, or backed by an unpinned source URL. It also rejects empty evidence files, test evidence outside an existing `*.spec.ts`/packed E2E file, and unsupported capabilities without both a reason and a recognized category.

## Product boundary

DSH already owns the durable top-level Goal loop. DSH Autopilot does not duplicate it. The plugin starts where native Goal stops: task decomposition, durable run policy, orchestration, independent evaluation, auditable recovery, and controlled runtime extension.

| Area | oh-my behavior | DSH implementation | Required evidence |
|---|---|---|---|
| Long-running objective | Ralph, Autopilot, Goal, Ultragoal continue until a terminal state | Native DSH Goal and Goal Round Driver | Multi-round packed replay; pause and resume |
| Durable run control | Mode state, iteration counters, stale-loop cleanup, explicit resume | Plugin-owned run snapshot and append-only audit artifact, keyed by DSH session; activation remains process-local | Crash/reload replay; counters cannot reset on resume |
| Planning | Deep interview, ralplan/hyperplan, PRD and test plan | Bundled planning skills plus a typed task DAG with immutable started-task acceptance criteria | Plan creation, cycle rejection, split/reorder, blocked dependency |
| Parallel execution | Teams, background agents, dependency-aware dispatch, mailbox | Managed one-shot delegation, continuable Team mailboxes, and deployment-owned Workflow profiles share exact DAG claims, provenance, cancellation, and run-wide budgets | Parallel children, partial failure, cancellation, cold reconciliation, result attribution |
| Fresh-context repair | Ralph-style fresh iterations | Accounted bounded-leaf Ralph rounds persist handoff and evidence; the top-level Goal still completes only through the verifier | Failure then repair with fresh workers; pause/resume and round ceiling |
| Verification | Completion gate, QA loops, fresh evidence, review quorum | Fixed project checks plus fresh read-only evaluator subagents; all required gates must pass | Pass, fail, inconclusive, evaluator disagreement and attempt exhaustion |
| Review roles | Architecture, correctness, testing, security, performance and UX critics | Configurable evaluator roles routed through DSH subagents | At least correctness, tests and security quorum in packed replay |
| Project intelligence | Search, LSP, AST, web, browser and repository instruction discovery | Reuse DSH native tools and capabilities; bundled skills describe selection policy | Capability doctor and one assembled workflow using native tools |
| Context continuity | Compaction preservation, handoff, notepad/project memory and session retrieval | Native DSH session/compaction, durable sidecar reinjection, and bounded explicit workspace-keyed project memory with a structured run handoff; automatic conversational recall remains outside the current implementation | Compaction replay retains objective, DAG and active evidence; memory revisions and handoff survive restart and require explicit reads |
| Hooks and hygiene | Continuation, write-before-read, comment checks, recovery, notification hooks | Typed bounded lifecycle registry, DSH waterfalls, write-before-read readiness, reviewer checks, and disabled-by-default durable HTTPS completion notification | Timeout/error containment, monotonic deny, teardown drain, notification retry |
| Dynamic extension | On-demand MCP/skill/tool loading | Deployment-allowlisted skill MCP lifecycle plus optional managed Host-only Cordis versions with source audit, rollback, rehydration and two-phase removal | MCP mount/unmount; invalid Package denial; failed health rollback; terminal cleanup |
| Permissions | Autonomous mode after explicit user choice | Human lifecycle authorization plus DSH-native tool/Client policy; Host-only is a separate explicit same-process code trust decision | Permission-denial replay; Client-half approval remains native; Host warning is visible |
| Operations | Status, trace, doctor, cancel, resume and notifications | Lifecycle/status commands, bounded text/JSON audit tail, full bundle-row readiness doctor, durable internal audit, and optional HTTPS completion outbox | Start/status/pause/resume/stop/audit, corrupt-state diagnosis, notification retry |
| Visual status | HUD/team/status panels | Optional Client plugin over a public DSH projection after core parity | Real Web flow GIF and projection replay |

## Explicit non-equivalences

- tmux is not a required runtime. DSH subagents and workflows provide the execution relationship; a terminal renderer may be added later.
- Magic keywords are convenience aliases, not the protocol. Skills and `/autopilot` commands expose the same behavior with typed internal state.
- `approval_policy = "never"` means requests are denied, not silently approved. DSH Autopilot never interprets it as permission escalation.
- Host-only dynamic Cordis is already natively free of the Client approval flow in DSH. The plugin adds lifecycle accounting and rollback; it does not claim to bypass Client approval.
- Host-only code is not permission-non-escalating in the general sense. It shares the DSH process and may obtain reachable Host services through the Cordis context. Source scanning is cooperative policy, not containment.
- Client-bearing Cordis code always remains under DSH's native approval path.
- A model's completion statement is evidence, not a verdict.

## Completion audit

Before claiming parity, `node scripts/verify-capabilities.mjs --complete` must pass. Every status that the final gate treats as incomplete—including planned, implementing, native-only, unit-verified, and packed-verified—must become `verified` or an explicitly documented `unsupported` item with a security or platform reason. The final audit must include:

1. unit coverage for state, invariants, budgets and lifecycle disposal;
2. keyless packed Web replays for planning, parallel work, verification repair, restart recovery and Cordis rollback;
3. a real local model soak that operates on a disposable workspace without publishing or external production mutation;
4. a clean packed install into an isolated DSH profile;
5. a requirement-by-requirement evidence table linked from this document.
