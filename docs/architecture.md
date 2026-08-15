# Architecture

## Product boundary

DSH Autopilot is an out-of-tree DSH bundle. Its npm manifest exposes `cordis.patch.yml`, which inserts only namespaced additive Cordis rows. The bundle does not replace a DSH row, patch `agent-loop`, import private DSH source paths, or write into the DSH repository.

DSH remains authoritative for the top-level Agent, native Goal, Goal Round Driver, transcript, permissions, Shell execution, subagent providers, and Cordis Host runner. Autopilot composes those public capabilities and owns only its additional run-control state.

The distinction matters: native Goal is already the durable continuation engine. Autopilot is a durable sidecar and policy controller around that engine, not a second loop.

## Runtime rows

| Row | Module | Responsibility |
|---|---|---|
| `dsh-autopilot-service` | `dsh-autopilot/service` | Open the storage domain; own durable run transitions, budgets, timers, recovery, completion outbox, and lifecycle reconciliation. |
| `dsh-autopilot-recovery-coordinator` | `dsh-autopilot/recovery-coordinator` | Wait for every recovery-critical service and function contribution before starting cold recovery. |
| `dsh-autopilot-commands` | `dsh-autopilot/commands` | Expose the human-only `/autopilot` lifecycle, bounded audit-tail rendering, and native Goal plus sidecar coordination. |
| `dsh-autopilot-tools` | `dsh-autopilot/tools` | Expose status, planning, task, managed delegation, verification, policy guards, project checks, reviewers, and optional Cordis lifecycle tools. |
| `dsh-autopilot-workflows` | `dsh-autopilot/workflow-service` | Run deployment-owned bounded workflow profiles against exact ready DAG tasks, with cancellation and durable settlement. |
| `dsh-autopilot-team` | `dsh-autopilot/team-service` | Own continuable workers, exact child/message mailboxes, reports, interruption, and cold reconciliation. |
| `dsh-autopilot-ralph` | `dsh-autopilot/ralph-service` | Own bounded fresh-agent repair rounds for one ready leaf task without completing the top-level Goal. |
| `dsh-autopilot-missions` | `dsh-autopilot/mission-service` | Own file-backed sequential Mission summaries, task attempts, operator state, and append-only audit. |
| `dsh-autopilot-delivery` | `dsh-autopilot/delivery-service` | Own isolated Git worktrees, checkpoints, and human-authorized fixed delivery plans. |
| `dsh-autopilot-tool-delivery` | `dsh-autopilot/tool-delivery` | Expose the managed delivery lifecycle to an authorized Agent. |
| `dsh-autopilot-code-intelligence` | `dsh-autopilot/code-intelligence` | Expose bounded AST and hash-anchored code operations through DSH filesystem authority. |
| `dsh-autopilot-visual-qa` | `dsh-autopilot/visual-qa` | Capture exact-origin browser evidence and optional workspace-contained PNG comparisons. |
| `dsh-autopilot-notifications` | `dsh-autopilot/notification-service` | Own the disabled-by-default durable HTTPS completion-notification outbox. |
| `dsh-autopilot-lifecycle-hooks` | `dsh-autopilot/lifecycle-hooks` | Provide typed, bounded lifecycle observation and monotonic before-tool denial. |
| `dsh-autopilot-run-dashboard` | `dsh-autopilot/run-dashboard-service` | Provide a read-only Host dashboard assembled from the current durable service owners. |
| `dsh-autopilot-memory` | `dsh-autopilot/memory` | Open the bounded project-memory storage domain and own revisioned workspace-keyed records. |
| `dsh-autopilot-tool-memory` | `dsh-autopilot/tool-memory` | Expose explicit memory list/read/write/delete operations and durable run handoff creation. |
| `dsh-autopilot-prompt-rules` | `dsh-autopilot/prompt-rules` | Load bounded workspace rules and inject only those matched by explicitly visited paths. |
| `dsh-autopilot-custom-commands` | `dsh-autopilot/custom-commands` | Load bounded workspace commands that only direct human command turns may invoke. |
| `dsh-autopilot-skills` | `dsh-autopilot/skills` | Register the bundled skill catalog through DSH's public Skill service. |
| `dsh-autopilot-skill-mcp` | `dsh-autopilot/skill-mcp` | Mount skill-declared MCP servers only from deployment allowlists and scope them to the Agent lifecycle. |

The Host-only Cordis surface is optional. Core planning, delegation, and verification tools load without `dynamicCordisRunner`; `autopilot_cordis_apply` and `autopilot_cordis_remove` appear only while that DSH service is available.

All contributions use Cordis effects or event listeners, so normal bundle disposal retracts registrations and drains owned resources. Disposal is a lifecycle mechanism, not a security boundary for arbitrary Host code.

## Native Goal and durable sidecar

The two durable records have different owners and purposes:

| State | Owner | Persistence | Examples |
|---|---|---|---|
| Native Goal | DSH session log and Goal service | Session-durable | objective, phase, revision, activation history, rounds started, round ceiling |
| Autopilot run | `dsh_autopilot` storage domain | Durable append-only snapshots | authorization, active-time budget, frozen verification baseline, task DAG, attempts, evidence, subagent usage, verifier records, Cordis desired state, completion acknowledgement |
| Project memory | `dsh_autopilot_memory` storage domain | Durable revisioned records | normalized absolute workspace, logical key, value, tags, revision, timestamps |
| Live activation | `AutonomyService` runtime | Process-local and reconstructible | abort signal, segmented expiry timer, exact armed run/Goal association |
| Agent transcript | DSH session | Session-durable | commands, tool calls/results, model messages, native Goal events |
| Child execution | DSH subagent service | Provider-defined; result copied into sidecar | child session id, structured result, task settlement |
| Host Cordis contribution | DSH Host runner | Process-local; desired source is durable | Plugin, Package, and plugin-run ids for the current process |

The run-state format is versioned. The current `RUN_STATE_VERSION` is `10`; an incompatible or malformed row fails when the storage domain opens. Every mutation appends a complete post-mutation snapshot with a monotonically increasing revision. The initial plan freezes an explicit implementation, investigation, repair, performance, delivery, or planning intent before task dispatch. Materialized per-run limits bound tasks, attempts, evidence, dynamic Host source, each snapshot's UTF-8 bytes, revision count, and aggregate audit bytes. Limits are checked before a durable write; the in-memory byte counter and current-state cache advance only after that write succeeds. A new run generation is permitted only after the preceding generation is completed or revoked.

The append-only audit is not hidden model memory. `get_autopilot` and the system-prompt contribution project the current run state on each request. Project-memory values are also never injected automatically; the model must call `autopilot_memory` to read them. DSH's transcript remains the source of model conversation history.

## Explicit project memory and handoff

`autopilot_memory` stores bounded records under the Agent session's workspace. Logical keys are normalized and revisioned; writes and deletes may supply an expected revision for compare-and-set conflict detection. The shipped row permits 128 records per workspace and values up to 32,000 characters. Listing returns sorted metadata and at most a 200-character preview rather than every full value.

List and read operations require an Agent-backed workspace but may inspect existing records outside an active run. Write and delete operations additionally require the exact armed native Goal and running Autopilot pair. Project memory is an explicit engineering notebook, not ambient prompt context or a credential store.

`autopilot_handoff` writes `handoff:<run-id>:<generation>:<revision>`. It records a caller-supplied summary and next safe action together with exact Goal/run revisions, rounds, phase, budgets and usage, the frozen verification baseline, a bounded task/evidence projection, recent verification history, and managed Cordis logical versions and hashes. Running, paused, and attention states may be captured; the write never rearms work. Live timers, abort signals, child handles, terminal processes, and Host runtime ids are not included. A later agent must explicitly read the entry; it cannot authorize, resume, or complete work.

## Authorization pair and command saga

Execution authority exists only while both halves match:

- the sidecar is `running` or `verifying` and has the exact process-local activation;
- the native Goal has the same Goal id, remains `active`, and is armed.

`authorizedPair` enforces this conjunction. If either half drifts, Autopilot cancels current activity, disarms what it still owns, and attempts to persist `needs-attention`. Model mutation tools cannot continue under a half-authorized state.

`/autopilot start` is a fail-closed cross-store saga:

1. validate requested rounds and duration against deployment ceilings;
2. create the native Goal;
3. immediately disarm it so no naked Goal round starts;
4. append the initial durable Autopilot run and arm its runtime lease;
5. resume the exact Goal revision.

If the sidecar never commits, the command clears the just-created Goal. If the sidecar commits but Goal activation fails, the run becomes `needs-attention` and both halves remain disarmed.

Pause and stop disarm the Goal synchronously before awaiting durable operations. Resume commits the sidecar transition before rearming the exact Goal. Cross-store failure never leaves an independently running native Goal.

The shipped bundle materializes these authorization limits into every new run:

| Budget | Default | Deployment ceiling or cap |
|---|---:|---:|
| Goal rounds | 1,024 | 4,096 |
| Active time | 7 days | 30 days |
| Verification attempts | 3 | 3 in the shipped bundle |
| Dynamic Package versions | 8 | 8 in the shipped bundle |
| Subagent starts | 128 | 128 in the shipped bundle |
| Concurrent managed workers | 4 | 4 in the shipped bundle |

Paused time is retained rather than charged. Node's maximum timer delay is shorter than the 30-day ceiling, so expiry is scheduled in bounded segments and rechecks durable remaining time before each segment.

## Durable task graph

An Autopilot run must create a plan before verification. A plan contains run-level acceptance criteria and one or more stable tasks. Every task has:

- a stable lowercase id;
- title, description, and task-specific acceptance criteria;
- dependency ids;
- pending, in-progress, blocked, failed, or completed status;
- an append-only attempt history;
- bounded inspectable evidence and an optional failure/blocker reason.

Plan replacement is allowed only before work starts. New tasks may be appended, including repair tasks that depend on completed work. Reordering changes stable dispatch/display order but not dependency meaning. Cycles, duplicate ids, missing dependencies, illegal transitions, and evidence-free completion are rejected.

Process loss or an Agent lifecycle interruption never leaves an attempt ambiguously running. Recovery or deliberate pause settles in-progress attempts as interrupted and returns retryable work to the graph with an auditable reason.

## Canonical flow and Missions

Each run begins at the durable `interview` stage. A bounded interview artifact records the requirements summary, decisions, and open questions before planning may begin. This is a pre-plan artifact and gate, not yet a turn-addressed interactive question-and-answer transcript. After a plan exists, fixed fresh read-only Metis, Momus, and Oracle reviewers must all return advice before execution opens. Each child receives a Host-supplied snapshot of the parent Goal, workspace, flow cursor, and available Autopilot tools; child-local Goal state and tool visibility are intentionally unavailable and cannot be used as evidence about the parent. A reviewer may return a concern only for a decisive defect that makes the plan unsafe, unexecutable, or unverifiable; optional refinements remain advice. The durable cursor records consecutive attempts and enters `needs-attention` after the fifth unsuccessful review instead of scheduling another planning round. The same cursor then enforces execution, code review, QA, and completed stages.

Mission is a separate sequential operator composed with that canonical flow. A workspace Markdown file contributes one prompt per nonempty line; headings and HTML comments are ignored, and list markers, numbering, and checkboxes are normalized. Planning creates one envelope task in the Autopilot DAG and a separate append-only Mission sidecar tied to the exact session, run generation, Goal, source hash, and audit ceilings. Resume starts fresh managed children in source order, charges the ordinary run-wide child budget, stores bounded structured outcomes and evidence, and settles the envelope only when the aggregate passes. Default execution stops after the first failure; continue-on-error is fixed at planning time. Operator `mark` and `rerun` transitions remain visible to the final verifier, which rejects any current Mission not in `passed`.

The upstream Mission workflow writes workspace `summary.json` and `ledger.jsonl` files. This DSH implementation uses its storage domain as the authority so lifecycle reconciliation and audit limits share the same Host-owned persistence model as other Autopilot sidecars. `/mission status` and `/mission audit`, plus the equivalent model tool actions, provide the operator-readable projection. The plan-sidecar write is a recoverable fail-closed saga rather than one transaction across DSH run storage and the Mission storage domain.

## Managed delegation and routing

`autopilot_delegate` atomically claims dependency-ready tasks before starting children. The claim changes task state and charges the run-wide subagent budget in the same durable revision. A batch larger than the per-dispatch fan-out ceiling is rejected before any child starts. The same ceiling bounds each Workflow profile and reviewer fan-out; it is not a global live-child semaphore across simultaneous trusted Host services.

Each assignment selects a stable role. Deployment configuration may map that role to:

- a DSH subagent transport;
- an LLM provider and model;
- a worker persona;
- ordered fallback candidates.

Fallbacks are intentionally narrow. They run after infrastructure failures such as child startup rejection, result transport failure, `error`, or `max-tokens`. They do not retry around a structured semantic failure, blocker, refusal, invalid evidence, cancellation, or cleanup failure. Every additional candidate reserves another run-wide subagent start.

Workers receive only their claimed task, acceptance criteria, dependency context, and coordinator prompt. They must return a structured completed, failed, or blocked outcome. Completed work requires evidence. The parent settles results into the durable DAG in stable assignment order, and a settlement failure is returned as an explicit failed result rather than erasing the child outcome.

`autopilot_specialist` exposes a stable packaged catalog containing the named OMO agents, complementary OMX roles, and the eight OMO task categories. Listing is local. Consultation starts one fresh child through the same managed-start provenance, charges every route attempt to the durable subagent budget, and exposes only the intersection of the live tool catalog with a fixed read-only allowlist. Infrastructure failures may use deployment-authored task-route fallbacks; semantic advice, concern, blocker, invalid output, cancellation, or cleanup failure is not routed around. The catalog supplies personas and recommendations, not automatic intent activation or a complete role-specific implementation permission matrix.

While an Autopilot Goal is active, direct model calls to the shipped `subagent`, provider-specific `subagent_*`, `workflow`, `ralph`, and schedule-creation names are denied. Managed task workers receive a positive allowlist intersected with the live tool catalog, so arbitrary new or renamed tools remain absent. An Agent-scoped lifecycle observer also disarms the parent run when a DSH subagent start is not owned by the managed task or reviewer dispatcher, including starts behind renamed tools. Because `subagent/start` is published after a one-shot child exists, this observer cannot retract that child. These controls do not form a workflow or general Host-service admission seam for arbitrary trusted plugins. Native services remain available internally to the managed orchestrator.

Three additional managed paths share the same run identity and budget controls. Continuable Team workers use claim-before-start, exact child/message ledgers, structured reports, interruption, and cold reconciliation. Ralph runs bounded fresh one-shot rounds against a single ready leaf and preserves a durable handoff between rounds. Workflow profiles are deployment-owned scripts; the model may select a profile, task ids, and bounded JSON arguments, but cannot submit executable script source. Workflow children inherit the same managed-start provenance, and pause or stop records cancellation while still calling the engine's cancel and dispose methods.

## Delivery, code intelligence, and Visual QA

The delivery service creates a real Git worktree only after validating an exact armed run and repository identity. For an ordinary repository whose `.git` is a directory inside the workspace, the default controlled root is `.git/dsh-autopilot-worktrees/...`; this stays under DSH's workspace-write root without making the parent worktree dirty. Linked worktrees require an explicit absolute root and may require a wider deployment permission because their Git directory is outside the session workspace. Its own append-only ledger binds the worktree to session, run generation, Goal, checkpoints, model-reported verification observations, and cleanup. The model-facing tool may create, inspect, checkpoint, prepare a fixed delivery plan, or clean up. A checkpoint verdict is an observation supplied by the model, not an Autopilot verifier attestation, and the isolated worktree is not yet the canonical workspace of `autopilot_verify`. External commit, push, and PR execution remains fail-closed; the prepared plan is not authority to mutate a local or remote repository.

`autopilot_ast` uses a maintained AST engine for bounded language-aware search and rewrite. `autopilot_hashline` requires current content hashes before replacing lines, so a stale edit cannot silently overwrite changed bytes. Both resolve paths and containment through DSH filesystem authority rather than bypassing the active preset.

`autopilot_visual_qa` starts a bounded browser run only for an exact active run generation. Page requests, redirects, later navigation, and WebSockets must match deployment-owned exact origins; service workers are disabled. Screenshots exist only in a Host temporary directory and are removed after success, failure, timeout, cancellation, terminal run state, or plugin disposal. Optional reference PNGs must resolve inside the DSH workspace. The result stores hashes, dimensions, byte counts, assertions, and exact run identity rather than a temporary Host path. This is evidence collection, not a browser or network sandbox.

The default origin set contains only no-port localhost values. Deployments that test a development server must configure its exact origin including the port. Browser launch also requires either an installed Playwright Chromium binary or an explicit installed system `channel`/`executablePath`; doctor reports both omissions without substituting a broader origin or browser choice.

## Skills, rules, MCP, and lifecycle hooks

Bundled Skills are validated Markdown artifacts registered through DSH's Skill service. Workspace prompt rules and file commands use separate bounded loaders: rules match only paths explicitly visited in the current turn, while custom commands run only from direct human command input. Neither surface grants Shell or Goal authority by itself.

A Skill may declare an MCP server id, but an Agent mount occurs only when that id and its stdio executable or HTTP origin match deployment policy. Mounts are deduplicated, Agent-scoped, and removed on pause, revoke, Agent disposal, startup failure, or bundle reload. The MCP server remains trusted deployment code; allowlisting is not confinement.

The lifecycle-hook service exposes typed run-mutation, session-start, pre-step, before-tool, after-tool, turn-stopping, and Agent-error events. Handlers receive immutable summaries without Agent or prompt-injection handles. Before-tool decisions are monotonic: a hook can deny but cannot approve a call rejected elsewhere. Per-handler timeouts, a deployment failure policy, stable priority ordering, and abort-and-drain disposal keep the extension registry bounded. A handler that ignores cancellation and outlives its timeout is quarantined and unregistered, so it cannot accumulate another invocation or block service disposal; JavaScript cannot forcibly terminate that one already-running Promise.

Completion notifications use a separate durable HTTPS outbox. It is disabled by default, accepts only deployment-owned endpoints and safe fixed payload fields, carries no model-visible secret headers, retries with bounded state, and provides at-least-once rather than exactly-once delivery.

## Verification and repair

`autopilot_verify` accepts a model summary and evidence list, but the model does not choose commands, reviewer roles, routes, or completion semantics. Verification requires a complete, evidenced task graph.

The gate runs in this order:

Before the first model step, Autopilot freezes the project-verification decision. It records the canonical workspace, the exact finite project recipe specs, and SHA-256 for every supported root manifest used by discovery. If discovery is disabled, there is no workspace, or no supported project/check exists, it instead persists an explicit `reviewer-only` baseline and reason. Concurrent first-step preparation converges on one identical durable baseline.

`autopilot_verify` then:

1. persists the candidate and increments the durable verification-attempt counter;
2. disarms the native Goal while verification runs;
3. validates the frozen workspace identity, runs deployment-fixed checks plus the frozen project recipes through DSH Shell, and validates the manifests again;
4. reserves reviewer subagent budget and supplies those deterministic records to every configured fresh read-only code-review lane;
5. only when every reviewer passes, enters QA and validates the frozen manifests once more, closing the review-time mutation window;
6. aggregates conservatively: any failed check, reviewer failure, inconclusive verdict, or reviewer infrastructure error prevents completion;
7. persists the full bounded record.

Automatic project discovery recognizes fixed recipes rather than executing arbitrary manifest text. It supports JavaScript `check`, `typecheck`, `lint`, `test`, and `build` scripts, declared Python pytest/Ruff/mypy tools, Cargo check/test, and Go vet/test. Operators may add explicit fixed commands or select finite recipe ids. Unavailable explicit recipes fail loud. Verification and restart never rediscover project recipes from model-edited manifests.

Deletion, replacement, unreadability, type change, or any byte change in a frozen `package.json`, `pyproject.toml`, `Cargo.toml`, or `go.mod` becomes the deterministic failed check `project/verification-baseline`. The current recovery action is to restore the original bytes and retry. A task expected to change one of those manifests must disable discovery before start and use deployment-fixed checks, which are not stored in the manifest baseline.

The default reviewer lanes are requirements, code quality, security, testing, and architecture. Every lane is required; “quorum” here means the complete configured independent set, not majority voting. Fresh children receive the exact parent Goal id, workspace, controller invariants, and safe observation-tool list from the Host. Child-local Goal state and tool visibility are intentionally unrelated to the parent and cannot make a review inconclusive by themselves. Reviewer routes support the same infrastructure-only fallback rule as workers, and each extra attempt consumes subagent budget.

A `fail` or `inconclusive` record returns the sidecar to `running`, rearms the same native Goal, concludes the current turn, and exposes findings to the repair round. Reviewer or verifier infrastructure errors pause the run and fail closed. Exhausted verification budget blocks further attempts.

## Two-phase completion and feedback outbox

A passing verifier does not write both durable systems and user feedback as one assumed-atomic action. Completion is split into recoverable phases:

```mermaid
flowchart LR
    V["Checks and reviewers pass"] --> R["Persist sidecar: finalizing"]
    R --> G["Complete exact native Goal"]
    G --> C["Persist sidecar: completed, report pending"]
    C --> F["Defer or recover final-report follow-up"]
    F --> M["Observe assistant/message"]
    M --> A["Persist completion-reported"]
```

The `finalizing` row contains the passing verification record. Recovery may therefore distinguish these crash windows:

- sidecar reserved, Goal still active: complete the exact Goal and continue;
- Goal already complete, sidecar still finalizing: converge the sidecar without rerunning checks;
- sidecar complete but feedback unacknowledged: inject the completion follow-up again;
- Goal identity or phase disagrees: persist `needs-attention` instead of guessing.

Feedback delivery is at least once. A failed claimed report turn is persisted and the deterministic notice is redelivered up to three times. Exhaustion appends and flushes a Host-visible plugin status message and records a durable notified marker, so completion still has a visible outcome without fabricating an assistant answer. A crash after external display but before the acknowledgement write may cause a duplicate model notice. The implementation does not claim exactly-once messaging without an upstream idempotent delivery seam.

## Compaction and cold recovery

The shipped patch sets `autoResume: true`. This records the original human authorization for crash-only recovery; it does not turn Autopilot into an external daemon. Loader rows may initialize concurrently, so the recovery coordinator waits for every required service seat and explicit commands, tools, Skills, MCP, Team, Ralph, Workflow, Visual QA, code-intelligence, memory, and delivery contribution before it starts the cold scan. Patch order is not treated as readiness evidence. Human start and resume commands reject a nonempty readiness set before mutating either persistence plane. Loss of the last live critical contribution during an active run disarms the exact Goal and records attention; re-registration never grants authority by itself.

During same-process DSH compaction, the service keeps the exact live activation, verifies the durable run and active Goal, and rearms only the matching disarmed Goal. A mismatch or rearm failure disarms runtime authority and records `needs-attention`. The next system-prompt contribution carries a bounded checkpoint of the objective, task ids and statuses, and latest verifier findings; `get_autopilot` returns the complete durable evidence and verification history.

When a DSH process starts and optional session-persistence services are present, the recovery scanner:

1. reads the latest sidecar row for each session;
2. inspects and strictly folds the DSH session Goal for every current run, including safe and terminal sidecar phases;
3. completes an interrupted human command or converges a paused, revoked, exhausted, attention, finalizing, or completed sidecar with the exact Goal state;
4. rejects subagent-origin sessions and mismatched Goal identity or phase;
5. borrows a live Agent or resumes a cold Agent while preserving its recorded preset only for work that remains eligible to run or deliver completion feedback;
6. rechecks live Goal revision and round count;
7. settles interrupted task attempts;
8. compare-and-set rearms only the exact eligible running or verifying run and Goal.

Publication races prefer an already-live winner and never dispose a borrowed Agent. A failed cold resume or cleanup is recorded as attention when possible. Active-time expiry during downtime prevents automatic activation.

An `agent/error` event immediately disarms runtime authority and persists `needs-attention`; it is not treated as a reason to silently retry. Agent-idle reconciliation prevents the sidecar from remaining falsely armed when the native Goal was silently disarmed. A root `max-tokens` ending is automatically rearmed only when the exact running sidecar/runtime/Goal still match, the Goal remains active, and its native round budget has room; the authoritative pair is checked again after rearm. An aborted turn, Goal-driver failure, identity drift, or exhausted round budget records attention instead. Deliberate `/autopilot pause` and `/autopilot stop` are never undone by recovery. With `autoResume: false`, process restart requires a new human `/autopilot resume`.

Cold recovery automatically requeues only work whose durable boundary proves that no external child effect is uncertain. A process loss while a managed Ralph round or Workflow is claiming, starting, running, or settling is recorded as `needs-attention` and requires human inspection before resume. This is intentionally narrower than silently replaying a child that may already have changed the workspace.

Compaction continuity covers authoritative Goal and sidecar state. Project-memory and handoff records survive independently in their own domain and remain explicit reads. Team mailboxes persist exact child and message identities, but the implementation does not claim arbitrary conversational-memory continuity.

## Managed Host-only Cordis lifecycle

Managed Host Cordis is disabled by default with `selfModification: off`. When the operator explicitly selects `host-only` and the DSH Host runner exists, native Cordis mutation tools are denied during the active run and the model uses the wrapper tools.

Apply is a durable-intent-first protocol:

1. validate logical identity and compute SHA-256 over the exact Host source;
2. reject obvious references to configured authority-bearing service names;
3. persist a new immutable version as `applying` and charge the Package budget;
4. define and run through the native Host runner;
5. inspect that the exact Package is active and not waiting for unavailable services;
6. persist it as `active`, superseding the prior logical version;
7. on update failure, undefine the failed runtime and replay the preceding audited active source;
8. persist failure and pause when rollback cannot be confirmed.

Removal is also two phase: mark matching desired versions `removing`, retract the live Plugin, then persist `removed`. Failed retraction stays `removing`, records a reason, and pauses or marks the run for attention so a later recovery can retry. Paused, revoked, completed, exhausted, and disposed runs attempt to retract owned contributions.

Rehydration verifies the durable source hash, resolves the latest active or interrupted version, replaces stale runtime versions, and settles interrupted apply/remove operations before the next model step.

These controls improve auditability and lifecycle correctness. They do not isolate generated code. The Cordis VM shares the DSH process; Host code can use the Cordis context to reach Host services. Text scanning and `forbiddenDynamicServices` are cooperative policy checks and can be bypassed by adversarial JavaScript. Enabling `host-only` is an explicit decision to trust same-process generated code. See [Autonomy and security](autonomy-and-security.md).

`client-approved` is a different path. Native Cordis tools remain subject to the current preset, DSH permissions, and DSH's Client-bearing approval result. Autopilot does not convert `awaiting-approval` into success.

## Distribution and compatibility

The package ships built ESM entry points, type declarations, the namespaced Cordis patch, capability locks, bundled skills, documentation, and license. No install script edits DSH or a workspace. The diagnostic executable resolves the selected profile through `dsh --dump-config` and reports Node support; every required enabled and unique bundle row/module; long-run and automatic/manual recovery policy; verification readiness; Visual QA origin/browser readiness; required service providers; and conditional dynamic-runner availability. Failed diagnostics produce a nonzero exit code. Warning-only states include auto-discovery without a deployment-fixed `checks` or `projectChecks` selection, no-port Visual QA origin defaults, and unspecified browser provisioning; they remain visible in successful output.

`/autopilot audit [--limit N] [--json]` exposes at most 200 immutable sidecar records from the current session. Text output shows time, revision, operation, phase, and run id; JSON returns the complete bounded records, including persisted objective, task/evidence, verification, and dynamic Host source fields. It performs no secret redaction and must be reviewed before sharing. Completion notification is a separate disabled-by-default durable HTTPS outbox with a deployment allowlist and at-least-once semantics.

The alpha.3 manifest targets the exact DSH `0.1.0-rc.6` npm package line, Cordis `4.0.1`, and the declared Node engine range. Its development and packed-test graph installs entirely from the registry; a DeepSeek Harness source checkout is not part of the package build. The manifest version describes release preparation and does not claim that the working tree has already been published.

Capability completeness is tracked in [`../capabilities.lock.json`](../capabilities.lock.json). Unit-tested source is not automatically called packed-verified, and planned/native-only rows are not counted as migrated parity.
