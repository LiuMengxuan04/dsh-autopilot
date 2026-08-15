# Testing

## Evidence policy

DSH Autopilot separates implementation evidence from parity claims. A focused unit test can prove a state transition without proving the packed DSH Web product path. A packed replay can prove one assembled scenario without proving every recovery window. [`../capabilities.lock.json`](../capabilities.lock.json) records those distinctions explicitly.

The ordinary capability-ledger check validates schema, pinned references, unique ids, recognized statuses, evidence presence, and repository-relative evidence paths:

```sh
node scripts/verify-capabilities.mjs
```

The completion form is deliberately stricter:

```sh
node scripts/verify-capabilities.mjs --complete
```

`--complete` fails while any row remains planned, implementing, native-only, native-limited, unit-verified, packed-verified, or planned-after-core. It is a final parity gate, not an expected everyday green check for the current pre-release tree.

## Test layers

| Layer | Command | What it proves |
|---|---|---|
| Capability metadata | `node scripts/verify-capabilities.mjs` | The machine-readable comparison ledger is internally valid and its cited local evidence exists. |
| Type surface | `pnpm run typecheck` | Strict TypeScript compatibility with pinned DSH public packages. |
| Static quality | `pnpm run lint` | Source, tests, and scripts pass the configured oxlint rules. |
| Unit and coverage | `pnpm run test:coverage` | Focused state, lifecycle, orchestration, verification, recovery, and Cordis behavior; V8 coverage is configured at 100% per included source file. |
| Build | `pnpm run build` | ESM runtime and declaration artifacts for exports and the doctor executable. |
| Package API | `pnpm exec publint` | Manifest exports, module resolution, and declarations are publishable. |
| Tarball | `pnpm pack --pack-destination .artifacts` | The local artifact can be inspected and installed without publishing npm. |
| Packed Web E2E | `DSH_AUTOPILOT_E2E_BROWSER_CHANNEL=msedge pnpm run test:e2e` | A built tarball installs into an isolated real DSH Web profile and completes the deterministic scenario described below. |

`pnpm run check` currently composes typecheck, lint, unit coverage, build, and publint. It does not run the packed browser E2E or the final capability-completion gate.

No test command in this document publishes npm.

## Unit suites

Unit tests assemble real Cordis contexts around focused public DSH services. They use fake clocks, temporary storage domains, controlled Shell implementations, and deterministic subagent providers where external processes or model calls would make assertions unstable.

### Durable run and storage

`run-state.spec.ts` and `run-store.spec.ts` cover:

- versioned run-schema validation;
- generation and revision monotonicity;
- append-only audit folding and cache-after-write behavior;
- per-snapshot and aggregate audit-byte limits whose accounting advances only after a successful durable write;
- task, attempt, evidence, dynamic-source, snapshot-size, and revision-count ceilings;
- task DAG normalization, cycle and dependency rejection, and fail-closed exhaustion after five plan-hardening attempts;
- plan replacement/add/reorder rules;
- task attempts, interruption, blocker/failure reasons, and evidence requirements;
- finalization and completion-feedback invariants;
- serialized concurrent appends and corrupt-history rejection.

### Service and commands

`service.spec.ts` and `commands.spec.ts` cover:

- shipped and direct-service limit resolution;
- active-time accounting, segmented long timers, expiry, pause, resume, and revoke;
- start/resume/pause/stop cross-store failure windows and bounded text/JSON audit rendering;
- durable run-wide verifier, dynamic-Package, and subagent budgets;
- exact Goal/sidecar authorization and fail-closed drift handling;
- task claims and interrupted-attempt recovery;
- two-phase finalization, Goal-already-complete convergence, pending-feedback acknowledgement, failed report-turn redelivery, and Host-visible exhaustion fallback;
- post-commit notification failure containment;
- compaction continuation for the exact authorized run;
- Agent-error disarm and `needs-attention` persistence;
- stopped and other silently disarmed native Goal fail-closed reconciliation at Agent idle, plus exact budgeted max-token rearm;
- Loader-order-independent recovery readiness across every critical function contribution, human start/resume fail-loud behavior, and active-run disarm when the last contribution unloads;
- cold recovery compare-and-set races and preset preservation.

### Project memory and handoff

`memory.spec.ts` and `tool-memory.spec.ts` cover:

- workspace-keyed durable records, bounded values, keys, tags, and entry counts;
- sorted metadata listing with bounded previews and explicit full-value reads;
- serialized creation and compare-and-set write/delete conflict handling;
- mutation requiring the exact armed Goal and running Autopilot pair while explicit reads remain available after pause;
- workspace and Agent requirements;
- structured handoff capture of task reasons, evidence, verification history, and managed Cordis versions;
- rejection of missing authorization and empty handoff summaries.

### Managed delegation and reviewers

`orchestrator.spec.ts`, `evaluator.spec.ts`, and the corresponding tool tests cover:

- atomic claims before child start;
- fan-out concurrency and stable fan-in settlement;
- role-based subagent transport, provider, model, and persona routing;
- infrastructure-only ordered fallbacks and budget charging;
- refusal, cancellation, semantic failure, invalid structured output, and cleanup failure without fallback abuse;
- five default independent reviewer lanes;
- read-only reviewer tool restrictions;
- Host-supplied parent execution facts without child-local Goal or tool-registry leakage;
- conservative verdict aggregation and reviewer disagreement;
- direct unmanaged orchestration denial during an active run.

`team-*.spec.ts`, `ralph-*.spec.ts`, and `workflow-*.spec.ts` additionally cover:

- continuable child claim-before-start, exact child/message identity, follow-up, structured report settlement, orphan containment, pause interruption, and cold reconciliation;
- fresh Ralph rounds with durable handoff, evidence, total-round ceiling, pause/resume, unknown-child fail-close, and no direct top-level Goal completion;
- deployment-owned Workflow profiles, exact DAG claims, structured fan-out outcomes, managed child provenance, total-Agent limits, partial failure, and pause/start cancellation races;
- per-run audit-record and audit-byte ceilings across each worker ledger.

### Delivery, code intelligence, browser, MCP, and hooks

Focused suites cover:

- real workspace-contained `.git` worktrees, repository/run binding, model-reported checkpoints, fixed non-executing delivery plans, conflict/dirty observations, cleanup, and fail-closed external delivery;
- AST search/rewrite and hash-anchored edits with DSH filesystem containment and stale-content rejection;
- Visual QA exact HTTP(S) and WebSocket origins, redirect/subresource policy, disabled service workers, bounded screenshots, reference-PNG containment, timeout/cancellation, and complete temporary-file cleanup;
- skill-declared MCP parsing, deployment allowlists, Agent-scoped mounting, deduplication, startup rollback, pause/revoke/disposal teardown, and HMR;
- lifecycle-hook priority, FIFO ordering, monotonic before-tool denial, handler timeout/error policy, registration disposal, and abort-and-drain shutdown;
- completion-notification policy, safe bounded payloads, durable retry, HMR/restart recovery, and disabled-by-default operation.

### Project checks and completion gate

`check-discovery.spec.ts` and `tools.spec.ts` cover:

- finite JavaScript, Python, Rust, and Go recipe discovery;
- first-step baseline freezing with canonical workspace, exact recipe specs, and root-manifest SHA-256;
- baseline reuse across verification/restart and deterministic failure on manifest deletion, replacement, or byte drift;
- root-manifest canonicalization, file-size and symlink checks, and arbitrary-string rejection;
- explicit recipe availability and maximum-count failures;
- fixed Shell checks in the Agent workspace with bounded output and sandbox metadata;
- incomplete-plan rejection before verification;
- `reviewer-only` baseline reasons for disabled discovery, missing workspace, unsupported project, or no supported recipe;
- deterministic records available to reviewers before their dispatch;
- reviewer pass/fail/inconclusive/error handling;
- repair-round rearm and verifier-attempt exhaustion;
- final-response deferral and failed acknowledgement retry.

### Dynamic Cordis

`dynamic-cordis.spec.ts` and tool policy tests cover:

- optional Host runner availability;
- durable source hashing and immutable logical versions;
- define, run, inspect, update, rollback, and failed rollback;
- waiting-service and missing-active-Package rejection;
- two-phase removal and retryable cleanup failure;
- restart rehydration, interrupted apply/remove settlement, stale runtime replacement, and source-hash mismatch;
- native Client-approved flow remaining under DSH approval;
- Package budget concurrency and cleanup of tracked native Host definitions.

These tests prove lifecycle code and cooperative policy checks. They do not prove that arbitrary Host JavaScript is contained; the architecture explicitly rejects that security claim.

### Skills and packaging surface

`skills.spec.ts`, `index.spec.ts`, and doctor tests cover stable catalog discovery, frontmatter validation, effect-scoped registration, public exports, and resolved-profile readiness diagnostics. Doctor tests include every required enabled and unique bundle row/module, valid automatic/manual recovery policy, long-run minimums, verification configuration, required service providers, dynamic-runner requirements, Visual QA exact-origin and browser provisioning, malformed YAML, and warning/failure rendering. Auto-discovery without `checks` or `projectChecks`, the no-port Visual QA origin defaults, and unspecified browser provisioning are warning-only readiness states; warnings preserve exit code zero.

## Packed DSH Web E2E

The current packed replay proves one user-visible path, not the whole parity matrix. It performs these steps:

1. build this repository and create a local npm tarball;
2. create disposable workspace, `DSH_HOME`, Agent home, and session directories;
3. install the tarball and DSH replay provider through the real plugin CLI;
4. inspect `dsh --dump-config` and run the packed `doctor` executable;
5. start a real DSH Web profile on an OS-selected port;
6. drive the real directory picker and session UI in Playwright;
7. select DSH's `cordis` preset and submit `/autopilot start` through the command UI;
8. record the canonical interview, create a durable plan, pass the fixed Metis/Momus/Oracle plan review, and start its task;
9. apply, exercise, and remove one managed Host-only Cordis extension;
10. write an intentionally incorrect proof artifact and complete the task with evidence;
11. run a deployment-fixed check that fails, supply its record to a fresh deterministic code reviewer, persist the finding, and enter a second Goal round;
12. append a repair task, pass the fixed plan review for the repair cycle, correct the artifact, and resubmit verification;
13. pass the deployment-fixed check, supply its record to a second fresh deterministic code reviewer, and complete only after both pass;
14. emit the deferred final user-facing response;
15. assert tool order, repair ordering, no tool error, dynamic cleanup state, Goal completion, final-feedback ordering, and persisted session JSONL.

The replay makes no model API request and needs no model API key. The E2E overlay deliberately uses one deterministic acceptance reviewer instead of the five default lanes so the fixture stays bounded. Default-lane behavior is covered in unit tests.

The current packed E2E does **not** yet prove cold process recovery, compaction, managed delegation fallback, every reviewer role, project-memory/handoff tools, cleanup failure recovery, or duplicate completion-delivery handling in a real Web restart. Those paths have focused tests and remain subject to the capability status recorded in the lock file. Do not describe them as packed-verified until an assembled replay exists.

Preserve artifacts after failure with:

```sh
DSH_AUTOPILOT_E2E_PRESERVE=1 \
DSH_AUTOPILOT_E2E_BROWSER_CHANNEL=msedge \
pnpm run test:e2e
```

The test prints the preserved temporary root. Inspect `failure.png`, Web child output, the workspace artifact, session JSONL, replay cursor/state, and the DSH storage-domain files.

## Local setup

The development graph uses the exact DSH `0.1.0-rc.6` npm release. A fresh clone does not require a DeepSeek Harness source checkout:

```sh
pnpm install --frozen-lockfile
node scripts/verify-capabilities.mjs
pnpm run typecheck
pnpm run lint
pnpm run test:coverage
pnpm run build
pnpm exec publint
```

[`pnpm-workspace.yaml`](../pnpm-workspace.yaml) explicitly permits the DSH subprocess helper, `node-pty`, and `koffi` lifecycle scripts required by supported runtime paths. It explicitly denies the unused Google provider and protobuf lifecycle scripts. An unreviewed new dependency script remains a hard install failure instead of being accepted implicitly.

Create and inspect the same local artifact that will be installed in a test profile:

```sh
mkdir -p .artifacts
pnpm pack --pack-destination .artifacts
tar -tzf .artifacts/dsh-autopilot-0.1.0-alpha.3.tgz
```

The manifest filename reflects the current package version and does not mean the current working tree was published.

## Browser channels

The release-style local browser signal uses the installed system Microsoft Edge channel:

```sh
DSH_AUTOPILOT_E2E_BROWSER_CHANNEL=msedge pnpm run test:e2e
```

Plain `pnpm run test:e2e` uses Playwright Chromium as a developer fallback. Google Chrome may be selected with `DSH_AUTOPILOT_E2E_BROWSER_CHANNEL=chrome`. A browser launch failure is an environment failure, not evidence about Autopilot behavior.

## Continuous integration

CI installs the exact DSH `0.1.0-rc.6` package graph from npm. The quality matrix runs on Node `22.19.0` and Node `24`; the package job validates publint and tarball contents, then runs the packed browser path through the registry-installed DSH Web CLI on system Edge with Node `24`.

CI configuration describes intended gates for committed branches. It does not prove an uncommitted local working tree is green. Report only commands actually run and their observed results.

## Failure diagnosis

- If registry installation fails, verify that the configured npm registry exposes every exact `@deepseek-ai/dsh*` `0.1.0-rc.6` package and that the lockfile is unchanged.
- If the storage domain fails to open, inspect the reported run-state version or corrupt audit row; do not delete durable state merely to hide an incompatibility.
- If `doctor` fails, read every diagnostic rather than only the summary. Inspect exact row identity, resolved long-run and `autoResume` policy, verification configuration, required service providers, dynamic-runner requirements, and the profile's `dsh --dump-config` output.
- If project discovery fails, distinguish an unavailable explicitly selected recipe from an empty auto-discovered workspace.
- If a worker or reviewer fails, distinguish semantic output from retryable transport/model infrastructure failure; only the latter may use a fallback.
- If verification pauses, distinguish deterministic failure, reviewer fail/inconclusive, reviewer infrastructure error, and exhausted attempt budget.
- If completion has no final response, inspect sidecar `finalizing`, `completed`, and `completionReported` state plus the session's assistant messages.
- If cold recovery stops in `needs-attention`, compare the sidecar Goal id/revision/phase with the strictly folded DSH session before considering resume.
- If Host cleanup fails, terminate the isolated DSH process when necessary; in-process cleanup is not containment for untrusted code.
- If the final capability gate fails, read each reported status. Do not convert planned or locally tested behavior to verified without its required evidence.
