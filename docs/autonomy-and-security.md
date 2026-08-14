# Autonomy and security

## Security claim

Oh My DSH grants bounded permission to continue a native DSH Goal. It does not grant new filesystem, process, network, credential, or Client execution authority. Those decisions remain with the installed DSH profile and its sandbox, permission, approval, and tool policies.

The bundle is designed to fail closed across process lifecycles: a durable Goal may survive, but unattended execution authorization does not.

## Human authorization

Only the human command plane starts or resumes a lease. A model cannot invoke `/autopilot start`, create a lease through a model tool, increase its own limits, or convert a stopped process into an unattended restart.

The command validates requests against deployment policy:

- the default Goal limit is 256 rounds and the default deployment ceiling is 1024;
- the default active lease is seven days and the default deployment ceiling is 30 days;
- only active time is charged, so an intentional pause does not consume the lease;
- a verifier attempt budget and dynamic-Package budget bound repeated privileged operations.

Operators may configure smaller limits for higher-risk workspaces. A larger deployment limit is an explicit configuration decision, not a model decision.

## Restart behavior

Leases, timers, abort controllers, verification counters, and dynamic-Package receipts live only in the current DSH process. Disposal disarms the matching active Goal. A fresh process can load the durable Goal from the DSH Session, but it has no lease and cannot arm the Goal automatically.

A human must inspect the workspace and run `/autopilot resume`, optionally choosing a new duration. This is intentionally not a cross-process daemon, watchdog, scheduled task, or background service.

If a deployment needs unattended reboot recovery, add a separately authenticated orchestration service with an explicit durable lease protocol. Do not infer permission from the presence of a durable Goal.

## Verifier ownership

Completion is not self-attested. During an active lease, a tool guard rejects direct `update_goal complete` calls. The only completion path is `autopilot_verify`.

The model supplies a concise summary and inspectable evidence notes. Deployment configuration supplies all shell command strings and timeouts. The verifier executes those fixed commands in the Agent workspace, records bounded results in the native tool transcript, and completes the native Goal only when every check passes.

This prevents prompt content from replacing acceptance checks, but it does not make weak checks strong. Operators must choose checks that cover the actual objective. Avoid commands that read secrets, mutate production, deploy, publish, or contact external systems unless those effects are independently authorized and expected.

## Dynamic Cordis policy

Dynamic Cordis exists only for a session whose DSH Agent preset supplies `cordis_define` and `cordis_run`. Use DSH's shipped `cordis` preset when autonomous extension is required. Oh My DSH does not add these tools to `standard`, `code`, or another preset and cannot exercise a tool absent from the current Agent composition.

### Host-only mode

Host-only mode is the default. It permits an active model to define Host code and activate only a Package that was successfully defined without Client code during the same Agent's current lease. Successful definitions consume the configured dynamic-Package budget.

An eligible Host-only definition requires no additional Oh My DSH approval. This removes no native control and grants no new capability: the definition can use only tools and Host authority the selected DSH composition already exposes.

Enforcement uses DSH tool guards, atomic in-flight budget reservations, and successful-result accounting. It is cooperative policy inside one trusted host process. It reduces accidental policy expansion; it is not a containment mechanism for malicious JavaScript.

The Cordis VM is not a security boundary. Host code can exercise whatever capabilities the surrounding DSH process and operating system expose. Keep DSH's sandbox and permission modes enabled, restrict credentials, run sensitive work in an isolated operating-system environment, and review tool availability before authorizing a long lease.

### Client-bearing Packages

Host-only mode rejects definitions that include Client code. `client-approved` does not silently approve Client execution: it leaves DSH's native Client-bearing Package approval path in control. `off` denies autonomous definitions and activation entirely. None of the modes can synthesize missing Cordis tools or bypass the preset that owns them.

Oh My DSH never patches or bypasses DSH approval internals. If the active DSH version cannot safely approve a requested Client path, the operation must remain unavailable.

### Receipt scope

A successful Host-only definition produces a process-local receipt keyed by Agent, lease ID, plugin ID, and Package ID. `cordis_run` must match that receipt. Failed definitions, definitions from another lease or Agent, and definitions from an earlier process do not authorize activation.

Stopping or undefining a dynamic Package is still handled by DSH's native tools. Oh My DSH does not make dynamic Packages durable.

## Operational guidance

Before authorizing a lease:

1. preserve or commit important workspace changes;
2. inspect the profile's tool, filesystem, shell, network, credential, and approval configuration;
3. set fixed verifier checks that match the acceptance criteria;
4. choose the smallest adequate duration and round budget;
5. use `selfModification: off` unless dynamic Cordis extension is needed;
6. avoid production credentials and deployment access in the Agent process.

During a run, use `/autopilot status` to inspect remaining time, phase, rounds, verifier attempts, and Package count. Use `/autopilot pause` before manual intervention. Use `/autopilot stop` to revoke the lease.

After an unexpected shutdown, inspect native session history and workspace changes before resuming. Do not treat a surviving Goal as evidence that the previous lease is still valid.

## Trust boundaries and non-goals

Oh My DSH assumes DSH and installed Host plugins are trusted application code. It validates human command values, configuration, model tool JSON, durable Goal identity, and successful dynamic-tool results at the corresponding interfaces. It does not attempt to defend a host process from its own code.

The first alpha does not claim:

- sandboxing of Cordis VM or arbitrary Host JavaScript;
- safety of deployment-authored verifier commands;
- automatic recovery after process or machine restart;
- approval-free Client code execution;
- durability of leases or dynamic Packages;
- independent semantic judgment of whether an objective is complete.
