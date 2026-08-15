---
name: autonomous-development
description: Run a software-development objective through DSH Autopilot's bounded Autopilot, including iterative implementation, evidence gathering, fixed verification, repair rounds, pause/resume handling, and optional Host-only dynamic Cordis extension. Use when a user asks for long-running autonomous coding, asks the agent to continue until tests pass, invokes `/autopilot`, or needs a durable multi-round DSH Goal completed without model-owned approval or completion.
---

# Autonomous Development

Complete one inspectable workspace objective through the active DSH Goal. Treat the human lease, DSH permissions, and deployment-fixed verifier as independent constraints.

## Establish authorization

Call `get_autopilot` before starting work.

When `/autopilot start` invokes this skill, the human command has already created and armed the current Goal and lease. Never call `create_goal` from an Autopilot run. Read the existing Goal with `get_autopilot` and work against its exact objective.

If no active lease exists, state the exact command the human should run, for example:

```text
/autopilot start --rounds 1024 --duration 7d <testable objective>
```

Wait for the human command. Never simulate authorization, invoke a human command through a model tool, or infer a lease from a durable Goal.

If a Goal is durable but the lease is paused, revoked, exhausted, or waiting for reconciliation, summarize the observable state and ask the human to choose the next lifecycle command. A deployment-authorized crash recovery may rearm a still-running lease automatically; never infer recovery from the Goal alone.

## Execute the Goal

1. Inspect repository instructions, current changes, relevant architecture, and available checks.
2. Inspect `get_autopilot.verificationBaseline`. Project recipes and relevant root-manifest hashes are frozen before this first model step. If the objective requires changing a frozen `package.json`, `pyproject.toml`, `Cargo.toml`, or `go.mod`, stop and explain that the human must start a newly configured run with auto-discovery disabled and deployment-fixed checks; the current baseline cannot be rewritten by the model.
3. Classify the run as implementation, investigation, repair, performance, delivery, or planning, then restate the objective as concrete acceptance criteria without narrowing the user's request. Freeze that intent in the first `autopilot_plan` replacement; later task additions cannot silently change it.
4. Preserve unrelated user changes and secrets. Keep all work inside the authorized workspace and existing DSH permission mode.
5. Implement the smallest coherent increment that advances an acceptance criterion.
6. Run the narrowest useful check, inspect the actual result, and repair failures before expanding scope.
7. Re-read `get_autopilot` at meaningful milestones and before expensive work. Respect remaining rounds, active time, verification attempts, and dynamic-Package budget.
8. Continue across Goal rounds until every acceptance criterion has inspectable evidence.

Use `autopilot_memory` only for durable project facts that will help a later run. Reads are explicit and may be stale; verify them against the repository before acting. Writes require the current authorization and must not contain credentials, private user data, hidden reasoning, or unnecessary raw command output.

Do not stop merely because one model turn ends. Do stop for a missing human decision, exhausted authorization, destructive action outside the request, unavailable credential, or external approval that cannot be obtained safely.

## Extend Cordis only when needed

Prefer installed DSH capabilities. During a Host-only run, use `autopilot_cordis_apply` and `autopilot_cordis_remove`. These tools own the durable source hash, Package budget, activation inspection, update rollback, restart rehydration, and terminal cleanup. Do not call native `cordis_define`, `cordis_run`, `cordis_stop`, or `cordis_undefine` under this policy.

Define a dynamic Cordis Package only when it materially enables the current Goal, the active lease permits it, and the deployment exposes DSH's Host runner. Give it a stable lowercase `logicalId`; later versions reuse that identity.

For a Host Package that contributes a model tool, use the current DSH runtime form below. `execute` is a sibling of `output`; `output` must declare `schema` and `render`. Register through an effect so unload removes the tool.

```js
return {
  name: 'host-helper',
  inject: ['tools'],
  apply(ctx) {
    ctx.effect(() => harness.registerTool(ctx, harness.defineTool({
      name: 'host_helper',
      description: 'Perform one narrow operation for the active Goal.',
      parameters: {},
      output: {
        schema: { type: 'string' },
        render(_args, value) {
          return [{ type: 'text', text: value }]
        },
      },
      async execute() {
        return 'result'
      },
    })))
  },
}
```

Keep the output schema aligned with the value returned by `execute`. Do not replace the `output` declaration with a bare schema or place `execute` inside `output`.

Under `host-only`, pass only the Host function body to `autopilot_cordis_apply`. The wrapper records the immutable source before evaluation, verifies the active Package through the native runner, and rolls an unsuccessful update back to the preceding audited version. No additional DSH Autopilot approval is required because the human already opted into same-process Host code. This is a trust grant, not containment: generated code shares the DSH process and may obtain reachable Host services through the Cordis context, including authority that is not exposed as a model tool. Treat the Cordis VM, source scan, and forbidden-service list as execution, audit, and cooperative policy mechanisms, never as a security sandbox. Use Host extension only in an OS-isolated, disposable, credential-free deployment that can trust the generated source as an ordinary Host plugin.

Under `client-approved`, Client-bearing code is outside the Host-only wrapper and still uses DSH's native Cordis tools and approval UI when the current preset exposes them. Never represent approval as granted before DSH reports it. Under `off`, do not attempt definition or activation.

## Verify completion

Before verification:

- inspect the final diff and workspace status;
- run relevant focused tests and static checks;
- confirm every acceptance criterion has a concrete file, command result, or durable behavior as evidence;
- remove temporary debug artifacts that are not part of the requested result.

Call `autopilot_verify` with a concise summary and specific evidence. Do not call `update_goal` with `action: complete`; completion belongs to the verifier.

When verification fails, read each fixed-check result, repair the cause in the new Goal round, rerun useful focused checks, and submit again. Do not weaken tests, verifier configuration, or acceptance criteria to manufacture a pass.

When verifier infrastructure fails, report the blocked Goal and paused lease accurately. Do not claim completion.

## Hand off

For a pause, agent transfer, or approaching context limit, call `autopilot_handoff` with a concise recovery summary and the first safe next action. The exact Goal/run pair may be running or already paused/attention; writing the revision-addressed artifact never rearms it. The artifact records Goal/run revisions, budgets, graph, and verification policy but does not preserve live processes or grant the next agent authority.

After a passing verdict, report the outcome, key evidence, and any known non-goals. Mention no hidden reasoning and do not claim checks that were not run.
