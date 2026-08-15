<p align="center">
  <img src="./assets/dsh-autopilot-logo.png" width="220" alt="Oh My DSH logo">
</p>

<h1 align="center">Oh My DSH</h1>

<p align="center">A durable control layer for long-running development work in DeepSeek Harness.</p>

<p align="center"><strong>(also known as DSH Autopilot · npm package: <code>dsh-autopilot</code>)</strong></p>

<p align="center">
  <a href="./README.zh-CN.md">简体中文</a> ·
  <a href="./docs/architecture.md">Architecture</a> ·
  <a href="./docs/autonomy-and-security.md">Security</a> ·
  <a href="./docs/testing.md">Testing</a>
</p>

DeepSeek Harness already knows how to keep a Goal moving. Oh My DSH adds the parts that become important when a task lasts longer than one model turn: a persistent task graph, bounded workers, fixed completion checks, recovery, and a final report that is not left to chance.

It stays on top of DSH rather than replacing it. The native Agent loop, Goal lifecycle, permissions, sessions, tools, and Cordis runtime remain in charge.

## Developer preview

`0.1.0-alpha.3` is a prerelease for developers testing DSH and its plugin system. DSH itself is still under active development. Public APIs, plugin composition, configuration, and stored state may change incompatibly between prerelease versions.

Use an isolated profile, keep backups of important work, and install the exact supported versions:

- DeepSeek Harness `0.1.0-rc.6`
- Cordis `4.0.1`
- Node.js `^22.19.0 || >=24.0.0`

This is an independent community project. It is not an official DeepSeek product.

## What it is for

Native Goal mode is a good fit when the job is simply “keep going.” Autopilot is useful when the job also needs a plan that survives restarts, dependency ordering, delegated work, evidence, and an explicit completion gate.

An Autopilot run provides:

- a durable lease with round, duration, verification, package, and worker limits;
- a requirements interview followed by a fixed three-role plan review;
- a persistent DAG with dependencies, attempts, blockers, and evidence;
- managed one-shot delegation, continuable Team workers, bounded Ralph loops, fixed Workflows, and Mission queues;
- frozen project checks and fresh read-only completion reviewers;
- recovery after compaction, Agent errors, plugin reloads, and process restarts;
- pause, resume, stop, audit, and completion records;
- a text dashboard for the Goal, DAG, workers, verification, budgets, and cleanup state.

When state cannot be reconciled safely, the run stops in `needs-attention` instead of guessing.

## Quick start

Install the prerelease from npm into an isolated DSH profile:

```sh
dsh plugin --profile web add dsh-autopilot@next
dsh --profile web --dump-config
dsh plugin --profile web exec dsh-autopilot doctor --profile web
```

Open a top-level DSH session in the project you want to change, then start a run:

```text
/autopilot start --rounds 256 --duration 2d Implement the requested change, add focused tests and documentation, run the repository checks, and report file-and-command evidence.
```

Autopilot commands are explicit. Bare `/autopilot` is not an alias for `status` or `start`.

```text
/autopilot status
/autopilot dashboard
/autopilot audit --limit 20
/autopilot pause
/autopilot resume [--duration 1d]
/autopilot stop
```

`pause` preserves the run but disarms its Goal and runtime. `resume` is a human action. `stop` revokes the run and clears the matching native Goal without deleting the DSH transcript or Autopilot audit history.

## The normal flow

1. Autopilot interviews the request and records the answers.
2. It writes a dependency graph and sends the plan through three fixed plan reviewers.
3. Ready tasks run locally or through managed workers. Each completed task must carry evidence.
4. Autopilot freezes the completion policy and runs the selected project checks.
5. Fresh read-only reviewers inspect the result. A failed gate opens a repair cycle; a passing gate completes the exact Goal and delivers the final report.

The shipped profile defaults to 1,024 Goal rounds and seven active days. Deployment ceilings are 4,096 rounds and 30 active days. Paused time does not consume the active-time lease. The profile also limits verification attempts, dynamic packages, subagent starts, and the size of each managed dispatch or reviewer fan-out.

Project-check discovery is finite and manifest-based. The selected checks, workspace, and relevant root-manifest hashes are frozen for the run. If a root manifest changes, verification reports the drift instead of silently selecting a different check set.

## Seeing the DAG

The dashboard is currently text-based; it is not a custom Web graph.

Run:

```text
/autopilot dashboard
```

The snapshot shows task dependencies and states alongside the Goal, workers, verification results, budgets, and outstanding cleanup. It is generated on request and does not open automatically when a run finishes.

Use `/autopilot status` when you need the complete machine-readable run view. Use `/autopilot audit --json` carefully: audit data can include objectives, evidence, findings, and trusted Host source.

## Security and authority

- Autopilot does not replace DSH permissions or native Goal ownership.
- Client Cordis code still goes through DSH's native approval flow.
- `selfModification` is `off` by default.
- `host-only` Cordis code runs inside the DSH process. The Cordis VM is not a security sandbox. Enable this mode only in a trusted, disposable, credential-free environment or behind operating-system isolation.
- Cleanup debt blocks later model work until managed resources are removed successfully.
- Recovery is at-least-once where DSH and Autopilot cannot share one transaction. A final report may be repeated after a crash between display and acknowledgement.
- Visual QA uses an exact origin allowlist; it is not a network sandbox.
- Delivery prepares bounded local worktrees and command plans. It does not silently commit, push, open, merge, or ship a pull request.

Read [Autonomy and security](./docs/autonomy-and-security.md) before enabling Host self-modification, external notifications, MCP servers, browser access, or delivery integrations.

## Build from source

```sh
git clone https://github.com/LiuMengxuan04/oh-my-dsh.git
cd oh-my-dsh
pnpm install --frozen-lockfile
pnpm run check
pnpm pack --pack-destination .artifacts
```

Install the generated tarball with `dsh plugin --profile web add <tarball>`.

The release checks are:

```sh
pnpm run capabilities:check
pnpm run typecheck
pnpm run lint
pnpm run test:coverage
pnpm run build
pnpm exec publint
DSH_AUTOPILOT_E2E_BROWSER_CHANNEL=msedge pnpm run test:e2e
```

See [Testing](./docs/testing.md) for the difference between unit, packed, and live-model evidence. The detailed implementation ledger lives in [`capabilities.lock.json`](./capabilities.lock.json).

To remove the plugin:

```sh
dsh plugin --profile web remove dsh-autopilot
dsh --profile web --dump-config
```

Removing the package does not erase existing DSH transcripts or Autopilot storage records.

## Inspiration

Oh My DSH is inspired by [oh-my-codex (OMX)](https://github.com/Yeachan-Heo/oh-my-codex), especially its emphasis on clarifying the task before execution, keeping long-running work durable, using specialist review, and making progress visible.

This repository is an independent implementation for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness). It is not affiliated with or endorsed by the OMX project. DSH remains the execution platform; Autopilot composes its public Goal, Agent, session, storage, subagent, Skill, and Cordis interfaces.

## License

[MIT](./LICENSE)
