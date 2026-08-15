---
name: security-review
description: Perform an authorization-bounded security review covering assets, trust boundaries, attack paths, permission checks, secret handling, supply-chain exposure, and safe remediation evidence. Use when the user requests a security audit, threat model, vulnerability review, permission review, or adversarial analysis of a code change.
---

# Security Review

Stay within the exact systems, repositories, accounts, and test environments the human authorized. Default to read-only analysis. Never exfiltrate secrets, attack third-party systems, disable safeguards, or treat an Autopilot lease as security authorization.

## Threat-model the change

1. Read repository security and contribution instructions.
2. Identify protected assets, actors, entry points, data flows, trust boundaries, persistence, and privileged operations.
3. State attacker capabilities and exclusions. Separate malicious input boundaries from trusted same-process values.
4. Trace authorization, authentication, validation, escaping, resource limits, logging, and teardown through the actual call path.

Inspect relevant dependency and configuration surfaces from local lockfiles and authoritative metadata. Use network lookup only when allowed and necessary; never transmit repository content, credentials, or private identifiers.

## Test safely

Prefer static evidence and deterministic local tests. Run proof-of-concept inputs only inside the authorized disposable workspace or test service, with bounded resources and no persistent harmful payload. Stop when validation would require production access, another person's data, new credentials, or destructive action.

For broad reviews, use independent threat, implementation, and test perspectives. During Autopilot, create durable review tasks and dispatch them through `autopilot_delegate`; direct native orchestration is denied. Outside Autopilot, use native DSH subagents and reserve `workflow` for an explicitly requested large audit. Give children the same scope and prohibit secret disclosure or external exploitation.

## Report

For each confirmed issue, provide severity, affected asset, prerequisite, attack path, impact, exact code evidence, and remediation with a verification method. Clearly label hypotheses that were not reproduced. Include positive controls only when they help explain why an apparent issue is contained.

Do not silently fix findings unless asked. If fixes are authorized under a Goal or Autopilot lease, preserve native DSH permission checks and require regression tests plus the configured completion verifier.
