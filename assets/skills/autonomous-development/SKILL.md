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
/autopilot start --rounds 256 --duration 7d <testable objective>
```

Wait for the human command. Never simulate authorization, invoke a human command through a model tool, or infer a lease from a durable Goal.

If a Goal is durable but the lease is absent or paused after restart, summarize the observable state and ask the human to run `/autopilot resume` with an appropriate duration.

## Execute the Goal

1. Inspect repository instructions, current changes, relevant architecture, and available checks.
2. Restate the objective as concrete acceptance criteria without narrowing the user's request.
3. Preserve unrelated user changes and secrets. Keep all work inside the authorized workspace and existing DSH permission mode.
4. Implement the smallest coherent increment that advances an acceptance criterion.
5. Run the narrowest useful check, inspect the actual result, and repair failures before expanding scope.
6. Re-read `get_autopilot` at meaningful milestones and before expensive work. Respect remaining rounds, active time, verification attempts, and dynamic-Package budget.
7. Continue across Goal rounds until every acceptance criterion has inspectable evidence.

Do not stop merely because one model turn ends. Do stop for a missing human decision, exhausted authorization, destructive action outside the request, unavailable credential, or external approval that cannot be obtained safely.

## Extend Cordis only when needed

Prefer installed DSH capabilities. Dynamic Cordis requires the current DSH Agent preset to provide `cordis_define` and `cordis_run`; recommend the shipped `cordis` preset when the user needs this capability. Do not imply that DSH Autopilot adds those tools to another preset.

Define a dynamic Cordis Package only when it materially enables the current Goal and the active lease permits it.

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

Under `host-only`, omit Client code and activate only the exact Package successfully defined in this lease. No additional DSH Autopilot approval is required for that eligible Host-only path, but it grants no additional authority. Treat the Cordis VM as an execution mechanism, not a sandbox. Do not use self-extension to widen filesystem, shell, network, credential, approval, or deployment permissions.

Under `client-approved`, let DSH's native Client approval flow decide. Never represent approval as granted before DSH reports it. Under `off`, do not attempt definition or activation.

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

After a passing verdict, report the outcome, key evidence, and any known non-goals. Mention no hidden reasoning and do not claim checks that were not run.
