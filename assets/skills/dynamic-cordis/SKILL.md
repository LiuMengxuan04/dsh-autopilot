---
name: dynamic-cordis
description: Discover, define, activate, diagnose, update, recover, roll back, and clean up a Host-only DSH Cordis Package through Autopilot's durable wrapper and the native runner. Use when an authorized objective needs a narrow runtime capability that installed DSH plugins do not provide, or when an audited temporary Cordis Package must be repaired or versioned.
---

# Dynamic Cordis

Use Autopilot's Host-only tools as an audited wrapper around DSH's native Cordis runner. The wrapper adds durable intent, source hashing, activation inspection, rollback, restart rehydration, and cleanup; it does not replace the runner or bypass Client approval. Enabling this mode does authorize generated code as a same-process Host plugin and can expose reachable Host services beyond the ordinary model-tool surface.

## Confirm eligibility

1. Prefer installed DSH tools and plugins.
2. Call `get_autopilot` and respect `selfModification`, remaining Package budget, lease phase, exact Goal, and existing `dynamicExtensions` rows.
3. Under `host-only`, require `autopilot_cordis_apply` and `autopilot_cordis_remove`. The deployment supplies the native runner; the current Agent does not need direct mutation tools.
4. Treat the Cordis VM as an execution mechanism, not a security sandbox. Host code can resolve reachable services through the Cordis context. Continue only when the deployment is OS-isolated and the generated source is trusted as same-process application code.

Under Autopilot `host-only`, an eligible Host-only Package can be defined and activated without an additional Autopilot approval because the human already selected that same-process trust policy. The source scan and forbidden-service names catch simple mistakes only; computed access, aliases, reflection, or an indirectly privileged service can evade them. Client code still follows DSH's native approval flow. Under `client-approved`, direct native Cordis tools may be used only when the current preset exposes them, and the native approval result remains authoritative. Under `off`, do not define or run a Package.

## Discover before defining

1. Inspect installed DSH capabilities before proposing a new leaf tool or service. If native Cordis inspection tools are visible, use them read-only; do not guess services, events, tools, slots, or method fields.
2. Read `get_autopilot.dynamicExtensions` before updating, repairing, or removing an existing logical extension.
3. Define the smallest Host-only capability that solves the objective. Never place Client code in `autopilot_cordis_apply`.
4. Give each capability a stable `logicalId`; use a new immutable version under the same id for updates.

Register every contribution through Cordis effects so unload removes it. For a Host model tool, use `harness.defineTool`; declare `output.schema` and `output.render`, and keep `execute` as their sibling with a value matching the schema.

## Activate and verify

1. Call `autopilot_cordis_apply` with `logicalId`, `name`, `purpose`, and the plain Host function body.
2. Require a `running` result and retain the returned source hash and process-local runtime ids as evidence.
3. Exercise the contributed behavior. A successful activation receipt is not a semantic test of the new capability.
4. Submit a corrected immutable version under the same `logicalId` when behavior is wrong. The wrapper restores the preceding active version if update or health inspection fails.
5. Call `autopilot_cordis_remove` when the capability is no longer needed. Pausing, revoking, completion, and expiry also retract runtime contributions while retaining the source audit.

For Client-bearing work under `client-approved`, use native tools only when exposed and authorized; if DSH returns `awaiting-approval`, explain the required human action and stop retrying. Keep evidence for durable intent, activation, behavior, cleanup, and remaining Package budget. Dynamic success is not Goal completion; the parent still owns end-to-end verification.
