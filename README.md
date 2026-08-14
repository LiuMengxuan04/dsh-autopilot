# Oh My DSH

Bounded, verifier-gated autonomous development for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness).

Oh My DSH is an independent DSH bundle. Installing it adds four additive plugin rows to a selected profile; it does not patch, fork, or write into the DSH repository. Removing the bundle removes those contributions again.

The first alpha focuses on one dependable loop: a human authorizes a durable DSH Goal, the model may iterate for days instead of hours, deployment-fixed checks own completion, and a process restart always requires an explicit human resume.

## Status and compatibility

This repository is pre-release software. It is developed and tested against DSH `0.1.0-rc.5` and Cordis `4.0.1` on Node.js `^22.19.0` and `>=24.0.0`.

The default authorization is:

- 256 Goal rounds, with a deployment default ceiling of 1024 rounds;
- seven days of active lease time, with a deployment default ceiling of 30 days;
- at most three verification attempts and eight dynamic Packages per lease;
- Host-only dynamic Cordis self-extension.

Active time stops while a lease is paused. A duration is not an unattended process-lifetime promise: shutting down or restarting DSH leaves the durable Goal disarmed and removes the process-local lease.

## Install

The first alpha is installed from a prebuilt GitHub Release tarball or a tarball packed from a local checkout. The unscoped npm name `oh-my-dsh` belongs to an unrelated project; do not install it. The reserved package identity for this repository is `@liumengxuan04/oh-my-dsh`.

To install a GitHub Release artifact, download the `.tgz` attached to the release and pass that file to DSH. With `gh`:

```sh
mkdir -p .artifacts
gh release download v0.1.0-alpha.1 \
  --repo LiuMengxuan04/oh-my-dsh \
  --pattern 'liumengxuan04-oh-my-dsh-*.tgz' \
  --dir .artifacts
dsh plugin --profile web add ./.artifacts/liumengxuan04-oh-my-dsh-0.1.0-alpha.1.tgz
```

From this checkout, with the pinned DSH repository available at `../harness`, build and pack the artifact:

```sh
pnpm install --frozen-lockfile
pnpm pack --pack-destination .artifacts
dsh plugin --profile web add ./.artifacts/liumengxuan04-oh-my-dsh-0.1.0-alpha.1.tgz
dsh --profile web --dump-config
dsh plugin --profile web exec oh-my-dsh doctor --profile web
```

Installing the GitHub source repository directly is not supported: this TypeScript package intentionally has no git-install `prepare` path. Do not use a `github:`, `git+https:`, or repository-directory spec. Use a prebuilt `.tgz` so the installed code is the exact reviewed release artifact.

If the scoped package is published to a registry in a later release, the equivalent command will be:

```sh
dsh plugin --profile web add @liumengxuan04/oh-my-dsh@0.1.0-alpha.1
```

`doctor` checks the Node version and verifies that all four Oh My DSH rows occur exactly once in the resolved profile. It does not start an agent or call a model.

## Authorize and control a run

Start DSH, then enter these commands through a command-capable surface such as DSH Web:

```text
/autopilot start Build the requested feature and verify every acceptance criterion.
/autopilot start --rounds 512 --duration 14d Complete the migration and prove it is safe.
/autopilot status
/autopilot pause
/autopilot resume --duration 7d
/autopilot stop
```

`start` creates and arms a native durable Goal, then grants a process-local lease. `pause` freezes remaining active time and pauses the Goal. A same-process `resume` continues that remaining interval; after a restart, `resume` grants a new interval. `stop` revokes the current lease and pauses the Goal. Command inputs and Goal changes use DSH's native session records.

During an active run, the model receives:

- `get_autopilot`, which reports Goal, lease, verification, and dynamic-Package budgets;
- `autopilot_verify`, the only completion path while Autopilot is active;
- policy context that tells it to continue across Goal rounds until verification passes.

The verifier runs only deployment-authored shell commands. A model supplies a summary and evidence notes, but cannot replace the commands. A failed check starts a repair round; a passed set completes the native Goal.

## Configure

Later DSH patch layers may replace the bundle defaults. A DSH patch replaces a row's entire `config`, so restate every field for a row you override. For example, add this to `$DSH_HOME/profiles/web/cordis.patch.yml`:

```yaml
- id: oh-my-dsh-service
  config:
    defaultMaxGoalRounds: 512
    maxGoalRounds: 1024
    defaultMaxActiveMs: 1209600000 # 14 days
    maxActiveMs: 2592000000       # 30 days
    maxVerificationAttempts: 3
    maxDynamicPackages: 8
    selfModification: host-only

- id: oh-my-dsh-tools
  config:
    minimumEvidenceItems: 2
    maxOutputChars: 8000
    checks:
      - name: types
        command: pnpm run typecheck
        timeoutMs: 300000
      - name: focused-tests
        command: pnpm run test
        timeoutMs: 600000
```

Supported self-modification modes are:

- `off`: deny autonomous `cordis_define` and `cordis_run` calls;
- `host-only`: permit activation only for a Package defined without Client code during the current lease;
- `client-approved`: let DSH's native Client-bearing Package approval path decide.

Dynamic Cordis is available only when the session's DSH Agent preset contributes `cordis_define` and `cordis_run`; select DSH's shipped `cordis` preset when this capability is required. Oh My DSH does not add those tools to a preset.

Host-only requires no additional Oh My DSH approval for an eligible Host-only definition, but it grants no new authority: existing DSH tool availability, filesystem, shell, sandbox, credential, and permission policies still decide what the Host process can do. Client-half code continues through DSH's native approval path. Host-only is a cooperative policy enforced through tool guards and process-local receipts, and Cordis VM execution is not a security boundary. Read [Autonomy and security](docs/autonomy-and-security.md) before enabling self-extension in a sensitive workspace.

## Bundled skill

The package ships `assets/skills/autonomous-development/SKILL.md` and registers it through DSH's public Skill Service under provider name `oh-my-dsh`. It is available to compatible Agent presets without copying anything into the user's skill directories. Removing the bundle removes the registration.

## Uninstall

Pause or stop any live Autopilot run, stop the affected DSH process, and remove the bundle:

```sh
dsh plugin --profile web remove @liumengxuan04/oh-my-dsh
dsh --profile web --dump-config
```

Uninstalling removes the profile dependency and bundle layer. It does not delete native DSH session logs or Goals. A Goal that survived a prior shutdown remains durable and disarmed until a user handles it through DSH.

## Develop and test

This checkout expects a sibling `../harness` checkout at the DSH revision used by `package.json` development links.

```sh
pnpm install
pnpm run typecheck
pnpm run lint
pnpm run test:coverage
pnpm run build
pnpm exec publint
OH_MY_DSH_E2E_BROWSER_CHANNEL=msedge pnpm run test:e2e
```

The release acceptance E2E uses the installed system Microsoft Edge channel. It creates an isolated temporary `DSH_HOME`, installs the tarball into a real Web profile, selects DSH's `cordis` preset, drives `/autopilot start` through DSH Web, defines and runs a Host-only dynamic tool without extra approval, cleans it up, replays two Goal rounds, runs a fixed verifier, and checks durable completion. It never edits the sibling DSH checkout.

## Design documents

- [Architecture](docs/architecture.md)
- [Autonomy and security](docs/autonomy-and-security.md)
- [Testing](docs/testing.md)

## License

[MIT](LICENSE)
