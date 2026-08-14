# Testing

## Test strategy

Oh My DSH tests the smallest layer that can prove each responsibility, then finishes with a packed, keyless product path. Tests operate only in this repository and temporary directories; the sibling DSH checkout is a read-only build and dependency source.

| Layer | Command | Evidence |
|---|---|---|
| Type surface | `pnpm run typecheck` | Strict TypeScript compatibility with the pinned DSH packages. |
| Static quality | `pnpm run lint` | Source, test, and build-script lint rules. |
| Unit and coverage | `pnpm run test:coverage` | Lease transitions, timer segmentation, command parsing and transitions, guards, receipts, verifier pass/fail/error paths, and per-file coverage thresholds. |
| Build | `pnpm run build` | ESM runtime and declaration artifacts for every export and the doctor executable. |
| Package API | `pnpm exec publint` | Published manifest, export, type, and module resolution consistency. |
| Tarball | `pnpm pack --pack-destination .artifacts` | Only intended runtime, patch, documentation, license, and bundled-skill files ship. |
| Packed product E2E | `OH_MY_DSH_E2E_BROWSER_CHANNEL=msedge pnpm run test:e2e` | A packed tarball installs into a real DSH Web profile, runs a Host-only Cordis extension, and completes a deterministic two-round autonomous Goal through system Microsoft Edge. |

## Unit tests

Unit tests assemble real Cordis contexts around focused DSH capabilities and use fake clocks or controlled providers where time and external processes would make assertions nondeterministic.

The service suite covers deployment limit resolution, lease creation, transitions, active-time accounting, long timer segmentation, expiration, lifecycle disarm, cancellation, verification budgets, and dynamic-Package counters. The command suite covers every syntax form and human transition, including validation and rollback failures. The tool suite covers model context, completion guards, self-modification modes, successful-result receipts, status rendering, evidence validation, fixed-check execution, bounded output, repair rounds, completion, and infrastructure failure.

Coverage is configured against `src/**/*.ts` except the executable doctor wrapper. A missing branch is treated as an unproved behavior rather than averaged away at repository level.

## Packed E2E

The E2E test deliberately avoids a source-only composition:

1. build Oh My DSH and create an npm tarball;
2. create temporary workspace, session, Agent-home, and `DSH_HOME` directories;
3. install the tarball and DSH's deterministic replay provider through `dsh plugin --profile web add`;
4. inspect `dsh --dump-config` and run the packed doctor;
5. boot the real DSH Web profile on an OS-selected port with a test-only overlay that pins DSH's in-browser directory picker;
6. open the real browser application in the installed system Microsoft Edge channel, select the temporary workspace, and switch that empty session to DSH's shipped `cordis` preset;
7. enter `/autopilot start` through the command UI;
8. replay a Host-only `cordis_define` and `cordis_run`, invoke the dynamically registered proof tool, confirm the Package budget, then stop and undefine the Plugin;
9. write the proof artifact, finish the first Goal round, and call `autopilot_verify` in the second round;
10. run a deployment-fixed verifier command against the artifact;
11. assert two turns, nine model steps, exact tool order, no tool failure, dynamic tool output, Goal completion ordering, and persisted JSONL state;
12. terminate Web and remove the temporary tree.

The replay fixture requires no model API key and performs no network model request. `OH_MY_DSH_E2E_PRESERVE=1 pnpm run test:e2e` preserves the temporary tree and failure screenshot for diagnosis.

## Local setup

Place this repository beside a DSH checkout:

```text
code/
├── harness/
└── oh-my-dsh/
```

The development dependencies in `package.json` use `link:../harness/...`. Build DSH before testing a fresh clone:

```sh
cd ../harness
pnpm install --frozen-lockfile
pnpm run build
cd ../oh-my-dsh
pnpm install --frozen-lockfile
pnpm run test:coverage
pnpm run build
OH_MY_DSH_E2E_BROWSER_CHANNEL=msedge pnpm run test:e2e
```

The release acceptance path requires Microsoft Edge to be installed and selects its system channel explicitly:

```sh
OH_MY_DSH_E2E_BROWSER_CHANNEL=msedge pnpm run test:e2e
```

Plain `pnpm run test:e2e` uses Playwright Chromium as a developer fallback. It is useful for diagnosis but is not the release browser signal. Google Chrome can be selected similarly when needed:

```sh
OH_MY_DSH_E2E_BROWSER_CHANNEL=chrome pnpm run test:e2e
```

## Continuous integration

CI pins the exact DSH commit used for the alpha and checks out `harness` and `oh-my-dsh` as sibling directories. The quality job runs typecheck, lint, full per-file coverage, and build on Node `22.19.0` and Node `24`. The package E2E job runs on Node `24`, builds DSH including its Web frontend, installs Microsoft Edge for Playwright's system `msedge` channel, checks the published API and tarball contents, and executes the packed browser test.

Pinning makes a DSH compatibility change explicit. Updating the pin requires running the same local suite and reviewing any peer dependency change; CI must not follow DSH `master` implicitly.

## Failure diagnosis

- If installation fails to resolve `link:../harness`, verify the sibling directory and build DSH.
- If `doctor` reports a missing or duplicate row, inspect `dsh --profile <name> --dump-config` and the profile's `dsh.profile.bundles` list.
- If Web never becomes ready, inspect the captured child-process output for a Loader activation failure.
- If the Edge acceptance browser cannot launch, verify the system Edge installation and run with `OH_MY_DSH_E2E_BROWSER_CHANNEL=msedge`; CI provisions it with `pnpm exec playwright install --with-deps msedge`.
- If completion times out, preserve the E2E tree and inspect its session JSONL, replay cursor, verifier artifact, and failure screenshot.
- If a verifier test fails, distinguish a check verdict from verifier infrastructure failure: the former rearms a repair round, while the latter blocks the Goal and pauses the lease.
