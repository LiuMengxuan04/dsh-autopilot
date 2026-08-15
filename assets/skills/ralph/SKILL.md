---
name: ralph
description: Run DSH's native Ralph workflow for explicit fresh-agent iterative execution, using the shared workspace as durable handoff and an independent parent verification pass. Use only when the human explicitly asks for Ralph, a Ralph loop, or repeated fresh-agent rounds.
---

# Ralph

Use the native `ralph` tool outside Autopilot. An active Autopilot run intentionally denies native Ralph because its rounds are not yet attributed to the durable task graph or subagent budget; ask the human to pause or stop that run before starting a separate native Ralph workflow. Do not emulate Ralph with a manual subagent loop.

## Prepare the objective

1. Confirm the human explicitly requested Ralph.
2. Inspect repository instructions and the current working tree.
3. Write one immutable, testable objective with constraints, non-goals, required evidence, and a bounded round count.
4. Ensure the workspace can carry durable handoff between fresh children through files, tests, and version-control state. Do not rely on conversation memory between rounds.

## Run

Call `ralph` once with the exact objective and appropriate `maxRounds`. Each native Ralph round starts a fresh child. Let the native workflow own round creation, cancellation, and handoff collection.

Do not use Ralph to obtain human approval, broaden permissions, access credentials, or make destructive changes outside the request. Do not retry a cancelled or failed run invisibly. Surface the native result and preserve the last durable handoff.

## Evaluate independently

Treat `complete`, `blocked`, and budget-limited outcomes as worker reports, not certification. The parent must inspect the final diff and run relevant checks. When DSH Autopilot is active, its fixed verifier and completion guard remain authoritative; call `autopilot_verify` only after independent evidence is complete.

If work remains, report the concrete remaining criteria and choose a new run only with continuing human authority. Do not rewrite the objective to make a partial result appear complete.
