# Autonomy and security

## Security claim

DSH Autopilot grants bounded authority to continue and coordinate one native DSH Goal. It does not grant a new operating-system sandbox, make generated code trustworthy, or approve Client code.

For ordinary model tools, DSH remains authoritative for filesystem, Shell, subprocess, network, credentials, tool availability, sandboxing, permissions, and approvals. Autopilot adds narrower state and policy checks on top: human lifecycle authorization, finite budgets, managed task attribution, controller-owned completion, and fail-closed recovery.

Managed Host-only Cordis is the important exception to simple “no privilege change” language. Enabling it deliberately authorizes generated JavaScript to run as a same-process Host plugin. That code may reach Host services that were not exposed as model tools. It must be treated as trusted application code, not as sandboxed model output.

## Authority planes

Autopilot coordinates several independent planes:

| Plane | Authority owner | Autopilot rule |
|---|---|---|
| Human lifecycle | Top-level DSH command input | Only `/autopilot start` and `resume` grant or extend a run |
| Goal continuation | DSH Goal service | Exact Goal id/revision and armed state must match the sidecar |
| Durable run state | Plugin storage domain | Append-only revisions, finite materialized budgets, fail-closed transitions |
| Project memory | Plugin storage domain and Agent workspace identity | Reads are explicit; mutation requires the exact active Goal/run pair and remains bounded |
| Workspace operations | DSH preset, permission, Shell, filesystem, and OS | Autopilot does not override denials or synthesize missing tools |
| Managed workers | DSH subagent providers | Claims and budgets precede dispatch; workers receive a positive tool allowlist; shipped unmanaged tool names are denied |
| Completion | Deployment checks and fresh reviewers | Model evidence is a candidate, never the verdict by itself |
| Host Cordis | DSH Host process | Disabled by default; explicit same-process trust when enabled |
| Client Cordis | DSH approval flow | Native approval remains authoritative |

An armed run requires both the live sidecar activation and the matching armed native Goal. A durable Goal alone is not Autopilot authority. A sidecar alone is not Goal authority.

## Human authorization and finite budgets

Only the top-level command plane can start, resume, pause, or stop Autopilot. The model has no tool that creates a lease, increases its limits, or turns a paused run into an active one.

The shipped policy is finite:

- 1,024 Goal rounds by default, with a 4,096-round deployment ceiling;
- seven active days by default, with a 30-day deployment ceiling;
- three verification attempts;
- eight dynamic Package versions;
- 128 total subagent starts and four concurrent managed workers;
- 256 durable tasks, 2,048 task attempts, and 4,096 task evidence records;
- 512 KiB per snapshot, 8,192 audit revisions, and 256 MiB of aggregate audit JSON;
- 256 Ki characters of retained dynamic Host source;
- Host self-modification off.

Paused time is not charged. Requested round or time values outside deployment limits fail before a run is authorized. Every execution and storage budget is copied into the durable run snapshot, so a process restart or weaker deployment configuration cannot reset or enlarge it.

Unbounded “never stop” operation is intentionally unsupported. A deployment may change finite ceilings, but the model cannot.

## Restart authorization

The shipped bundle sets `autoResume: true`. Starting a run therefore includes explicit human authorization for crash-only recovery while the sidecar remains in an eligible running or verifying phase. This is a meaningful operational choice: restarting DSH may resume the work without another click.

Recovery does not infer authority from a Goal. It requires all of the following:

- every recovery-critical service and function contribution has finished registering;
- the sidecar recorded automatic-recovery authorization;
- the phase is eligible and the active-time budget has not expired;
- the strictly folded DSH session contains the same active Goal;
- Goal revision and rounds still match when a live or cold-resumed Agent is acquired;
- a compare-and-set sidecar revision wins after interrupted tasks are settled;
- the original Agent preset can be preserved.

User pause, stop, exhausted time, `needs-attention`, a mismatched or silently disarmed Goal, a subagent-origin session, or Agent error prevents automatic continuation. A crash while a Ralph round or Workflow has an uncertain external effect also becomes `needs-attention`; only a provably safe durable boundary is retried. Recovery never overwrites a concurrent human lifecycle change. Set `autoResume: false` when every process restart must require `/autopilot resume`.

Autopilot is not an external watchdog. Nothing runs while the DSH host is stopped, and machine reboot recovery begins only when the configured DSH process starts again.

## Managed orchestration

An active run denies direct model calls to the shipped `subagent`, provider-specific `subagent_*`, native `workflow`, native `ralph`, and schedule-creation names. Managed workers also receive a positive deployment tool allowlist, so a newly installed or renamed orchestration tool does not appear by accident. An Agent-scoped lifecycle observer disarms the parent run and fails closed on any DSH subagent start not attributed to managed task, reviewer, Team, Ralph, or Workflow dispatch, including starts behind renamed tools. Since the event is emitted only after a one-shot child is published, the observer cannot retract that child. This is not a universal Host-service admission hook. Models use the Autopilot-managed delegation, Team, Ralph, or fixed Workflow tools, which:

1. admits only dependency-ready task ids;
2. atomically marks tasks in progress and charges the durable subagent budget;
3. applies the configured per-dispatch fan-out ceiling;
4. gives each child a bounded task and structured output schema;
5. records child identity, evidence, blocker, or failure in the task graph;
6. disposes the one-shot child.

Provider/model fallbacks are not a way to shop for a favorable answer. They are tried only after an infrastructure failure. A semantic failure, refusal, blocker, invalid evidence, cancellation, or cleanup failure is retained, and reviewer findings are never routed around.

Direct `autopilot_specialist` consultations are fresh, read-only children. They use packaged persona ids, the managed-start observer, the same durable subagent counter, and a fixed positive observation-tool allowlist. The category catalog recommends specialists but does not automatically route the root Agent or grant a specialist an implementation tool. Editing remains task-owned through the ordinary managed execution paths.

The canonical flow prevents an executable plan before a durable interview summary and prevents execution before the fixed Metis, Momus, and Oracle plan-hardening quorum passes. Only a decisive safety, execution, or verification defect may return the plan to planning; five consecutive unsuccessful reviews disarm the run and persist `needs-attention`. Mission execution adds no authority: its imported file must resolve through DSH filesystem containment, each prompt is charged as a managed fresh child, and the final verifier rejects a Mission with failed, blocked, skipped, running, review-required, or attention state. Mission prompt text and evidence are retained in the plugin storage domain and appear in audit output, so files should not contain credentials or private data that does not need to be persisted.

Subagents still inherit whatever workspace and service authority their DSH provider grants. Autopilot attribution and budgets are coordination controls, not OS isolation.

`maxConcurrentSubagents` is currently enforced per managed dispatch, Workflow profile, or reviewer fan-out. The run-wide hard limit is `maxSubagents`, which counts every reserved start across those surfaces and infrastructure fallbacks. The former is not a single global semaphore across independently running trusted Host services; deployments that require a strict process-wide live-child cap must enforce it in their subagent provider as well.

Lifecycle Hook handlers receive immutable run/tool summaries without Agent, message, prompt-injection, or completion authority. A before-tool hook may only add a denial; it cannot turn an existing denial into permission. Deployment timeouts and handler failures are contained according to fixed policy. A handler that ignores cancellation is quarantined after its timeout and cannot receive another event or block disposal, although JavaScript cannot forcibly terminate its already-running Promise. This registry is an extension point for trusted Host plugins, not a sandbox.

Skill-declared MCP servers are disabled unless their deployment id, stdio executable, or HTTP origin matches a fixed allowlist. Mounts are Agent-scoped and are retracted on pause, revoke, disposal, or bundle reload. MCP tools still carry whatever authority the configured server has, so allowlisting a server is a deployment trust decision.

Visual QA permits only exact configured HTTP(S) origins, maps WebSocket origins to the matching HTTP(S) policy, disables service workers, bounds steps and screenshot bytes, and removes Host temporary files on every lifecycle path. These checks reduce accidental navigation; they are not a network sandbox, because the browser process and allowed origin may still reach other resources through mechanisms outside the page policy.

For an ordinary repository whose `.git` directory is inside the workspace, delivery worktrees default below `.git/dsh-autopilot-worktrees`; DSH's workspace-write policy can address them, while Git omits them from the parent worktree status. Linked worktrees need an explicit deployment root and may need wider permission. Delivery checkpoint verdicts are model-reported observations, not independent verifier attestations, and `autopilot_verify` continues to inspect the session workspace rather than the isolated worktree. The generated local/remote argv is only a plan: this bundle never executes its commit, push, or pull-request operations, and a human must independently inspect the worktree before authorizing any delivery.

## Project memory and handoff data

The project-memory service is a bounded durable notebook keyed by the normalized absolute workspace from the Agent session. `autopilot_memory` never injects values into model context automatically. List and read operations require an Agent-backed workspace; write and delete operations also require the exact armed Goal and running Autopilot pair. Optional expected revisions prevent a stale writer from silently replacing or deleting a newer record.

`autopilot_handoff` writes a bounded, revision-addressed snapshot of exact Goal/run state, rounds, budgets and usage, the frozen verification baseline, task evidence, recent verification history, managed Cordis source hashes, and the caller's next safe action. It may capture paused or attention state but remains a transfer artifact, not new authorization: it cannot resume a Goal, preserve a child process, or complete verification.

Memory and handoff values are not secret storage. Records persist in the DSH storage domain, survive restart, and may be read later by any session that has the same workspace identity and the memory tool. They are not automatically redacted. Do not store credentials, tokens, private user data, raw command output containing secrets, or unnecessary Host source. Uninstalling the bundle does not by itself erase already persisted records.

## Verifier ownership and command risk

During an active run, direct native Goal completion or blocking is denied. A completion candidate must pass `autopilot_verify` after the durable task graph is complete with evidence.

The model supplies a summary and evidence references. Deployment configuration supplies deterministic command strings, timeouts, project-recipe selection, reviewer roles, and routes. Before the first model step, automatic discovery chooses only finite built-in recipes from root manifests; it does not execute arbitrary model-selected or manifest-derived shell text. The canonical workspace, exact recipe specs, and manifest hashes are durably frozen so later model edits or restart cannot silently select a weaker check set.

Verification checks the frozen manifest bytes before and after command execution. Any change becomes a deterministic failure. This also rejects legitimate manifest edits: if the authorized task must modify `package.json`, `pyproject.toml`, `Cargo.toml`, or `go.mod`, the operator must disable auto-discovery before starting and provide fixed deployment checks instead. Fixed `checks` are deployment policy and are not frozen from workspace content.

Deterministic checks run first so every configured fresh code reviewer receives controller-owned check records instead of relying on the model's summary alone. Every check and reviewer must pass. A failed or inconclusive outcome returns findings to a repair round; verifier infrastructure errors pause the run. The verification-attempt counter is durable.

Deployment-authored checks are trusted code executed by DSH Shell. Autopilot prevents the model from changing them, but it cannot make a destructive command safe. Do not configure checks that publish packages, deploy production, rotate credentials, mutate remote systems, or read secrets unless those effects are independently intended and authorized.

Reviewers are another model-based evidence source. Independence and role separation reduce self-attestation risk, but they do not prove semantic correctness or compensate for weak acceptance criteria.

## Completion and duplicate-delivery risk

Completion reserves a passing verifier record before updating the native Goal, then records `completed` with a pending feedback flag. Only a nonempty assistant message from the claimed completed report turn acknowledges delivery. Aborted, errored, max-token, and empty report turns persist a failed attempt and redeliver the same deterministic notice up to three times. Exhaustion appends and flushes a Host-visible plugin status message with the passed-verification result and audit recovery instruction; it does not fabricate an assistant answer. Cold recovery can converge an interrupted finalization, redeliver an unacknowledged completion notice, or finish an interrupted exhaustion fallback.

This design is at least once, not exactly once. A crash after the user interface displays the final response but before the acknowledgement write may cause a duplicate completion notice. Consumers must treat the notice id as a deduplication hint rather than assume a single delivery.

## Host-only Cordis is trusted code execution

### Safe default

`selfModification: off` is the shipped default. Keep it off in ordinary or sensitive profiles.

When it is off, Autopilot denies dynamic Cordis definition and activation during the run. Core planning, delegation, verification, and recovery do not require Host self-modification.

### What enabling `host-only` means

Setting `selfModification: host-only` authorizes the model to submit an async JavaScript function body to `autopilot_cordis_apply`. DSH evaluates the returned Cordis Plugin in its Host process. The wrapper provides lifecycle correctness:

- durable source and SHA-256 before evaluation;
- immutable logical versions and Package-budget accounting;
- activation and waiting-service inspection;
- rollback to the preceding audited version after an unsuccessful update;
- source-hash verification and rehydration after eligible restart;
- two-phase removal and retryable cleanup state;
- fail-closed pause or attention state when rollback or cleanup cannot be confirmed.

These are audit and recovery controls. They are **not confinement**.

### What it does not isolate

The Cordis VM is an execution mechanism, not a security boundary. Host code receives a Cordis context in the same process as DSH and may directly resolve reachable Host services through APIs such as `ctx.get`. Depending on the installed profile, those services may expose filesystem, Shell, subprocess, network, credentials, Agent control, persistence, approval, or other application authority.

The wrapper scans source text for configured forbidden service names. That scan can catch straightforward mistakes, but it is not a JavaScript capability sandbox, reference monitor, or adversarial-code defense. Indirect property access, computed strings, aliases, reflective APIs, imported code, or other JavaScript techniques can evade textual scanning. A generated plugin may also consume authority through a seemingly benign service that itself exposes privileged methods.

Therefore:

> Enabling `host-only` is equivalent to trusting the generated source as a same-process DSH Host plugin.

It is inaccurate to say that this mode “does not expand authority.” It may expose Host service authority beyond the model's ordinary tool list. The human policy choice and Package budget bound when and how often this occurs; they do not sandbox the code.

Use `host-only` only when all of these are true:

1. the DSH profile and workspace are disposable or strongly isolated at the OS/container/VM level;
2. production credentials, deployment tokens, personal data, and sensitive mounts are absent;
3. outbound network and process authority are restricted outside the Cordis process;
4. generated source and its purpose are acceptable as trusted plugin code;
5. failure to unload is tolerable until the host process is terminated;
6. the configured Package budget is appropriate.

If any condition is false, keep self-modification off and implement the required capability as a reviewed ordinary plugin outside the Autopilot run.

### Cleanup limitations

Autopilot attempts to retract managed Host contributions on removal, pause, revoke, completion, exhaustion, Agent disposal, and bundle disposal. Cleanup is required before completion. A failed teardown keeps process-local cleanup debt across tools-row HMR, disarms the matching Goal, and denies later model steps and tool calls until a retry confirms removal. When the sidecar remains writable, the failure also records durable attention or pending-removal state.

No in-process teardown protocol can defend the host from already-malicious same-process code. Such code may interfere with cleanup, mutate unrelated state, or keep its own references. Terminating the isolated host process is the reliable containment action.

## Client-bearing Cordis remains native approval

`host-only` rejects Client code. Under `client-approved`, native Cordis tools may be used only if the active DSH preset exposes them. DSH's own Client-bearing approval state remains authoritative:

- `awaiting-approval` means a human decision is still required;
- denial remains denial;
- Autopilot does not retry around or reinterpret approval;
- Package budget accounting does not imply approval;
- the plugin does not patch DSH approval internals.

Approval-free arbitrary Client execution is explicitly unsupported.

## Fail-closed lifecycle behavior

Autopilot uses `needs-attention` when continuing would require guessing which durable source is authoritative. Examples include:

- native Goal id, phase, activation, or revision differs from the sidecar;
- a start/resume saga commits only one half;
- cold recovery cannot preserve the recorded preset or exact Goal;
- an Agent loop reports an error;
- dynamic update rollback or removal cannot be confirmed;
- finalization finds a changed Goal;
- durable mutation fails after an external side effect.

The controller disarms live activity before or while recording attention. If the attention write itself fails, the disarmed runtime and logged error remain safer than silently continuing.

Post-commit observer failures are logged after the durable append and do not turn a committed mutation into a false caller-visible “write failed” rollback.

## Operational checklist

Before starting a long run:

1. preserve important user changes and inspect the working tree;
2. use a dedicated DSH profile with the smallest filesystem, Shell, network, and credential authority;
3. decide explicitly whether process-restart auto-resume is acceptable;
4. keep `selfModification: off` unless same-process generated-code trust is acceptable;
5. configure deterministic checks that match the objective and have no unintended external side effects;
6. review subagent providers, model routes, fallbacks, total starts, and concurrency;
7. choose a lower round or duration budget when the task does not need the shipped maximum;
8. keep project memory and handoff summaries free of credentials and unnecessary sensitive data;
9. avoid production credentials and deployment access.

During a run:

- use `/autopilot status`, `/autopilot audit`, and `get_autopilot` to inspect remaining budgets, immutable transition history, and task state;
- read project-memory entries explicitly and treat their contents as untrusted, possibly stale project notes rather than current authorization;
- treat `/autopilot audit --json` as potentially sensitive because it returns complete stored snapshots, including objective text, evidence, findings, and audited Host source; it is bounded but not redacted;
- pause before manual intervention;
- investigate `needs-attention` rather than repeatedly resuming;
- treat reviewer and check output as evidence, not infallible truth;
- terminate an isolated host process if untrusted Host code may still be active.

After restart or completion:

- inspect native session history, sidecar phase, interrupted attempts, verification record, and feedback status;
- verify dynamic extensions are removed or intentionally rehydrated;
- tolerate and deduplicate a repeated final notice;
- do not treat a surviving Goal by itself as current authorization.

## Explicit non-goals

The current project does not claim:

- a security sandbox for Cordis VM or arbitrary Host JavaScript;
- exactly-once completion messaging;
- safety of deployment-authored verifier commands;
- semantic proof beyond the configured checks and reviewer evidence;
- authority to bypass DSH Client approval;
- an external reboot daemon or scheduler;
- automatic conversational-memory parity or exactly-once external notifications;
- a browser/network sandbox or confinement of allowlisted MCP servers;
- an unbounded never-stop mode.

Capability status, including security-driven unsupported rows, is recorded in [`../capabilities.lock.json`](../capabilities.lock.json).
