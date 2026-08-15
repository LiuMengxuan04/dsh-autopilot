---
name: design-document
description: Investigate and write an implementation-ready engineering design with repository evidence, alternatives, APIs, lifecycle and failure semantics, migration, security, testing, and an executable task graph. Use when the user requests a design doc, architecture proposal, RFC, ADR-quality plan, or a risky cross-cutting change that should be reviewed before implementation.
---

# Design Document

Produce a decision artifact that another engineer can implement without reconstructing hidden reasoning.

## Investigate first

Read repository instructions, architecture docs, public APIs, adjacent implementations, tests, and current deployment composition. Trace the real lifecycle from configuration through activation, persistence, failure, cleanup, and user-visible output. Use bounded subagents for independent seam or risk research, but verify their citations yourself.

Separate facts, constraints, assumptions, and open decisions. Cite repository paths or external primary sources near the claims they support. Never describe a capability as available merely because a sibling package exports it; show how the target composition loads and exercises it.

## Write the design

Include only sections that affect implementation:

- problem, scope, explicit non-goals, and acceptance criteria;
- current behavior and the missing capability;
- proposed services, providers, consumers, data types, and ownership;
- state machine, concurrency, cancellation, teardown, crash recovery, and idempotency;
- durable formats, versioning, limits, and migration or rollback;
- permission and trust effects, including what the design cannot enforce;
- alternatives with concrete tradeoffs;
- unit, integration, replay/E2E, and operational verification;
- phased task graph with dependencies and independently testable milestones.

Use a compact state diagram or table only when it makes transitions or ownership materially clearer. Do not include chronology, review narration, or speculative extension points without a present consumer.

## Review and hand off

Run the design through requirements, architecture, security, testing, and maintainability reviewers. Resolve contradictions in the document before implementation begins. Under Autopilot, preserve the approved design and task graph as evidence, use `autopilot_memory` for durable decisions, and create `autopilot_handoff` when execution will continue in another session. A design is complete only when decisions, remaining human choices, and verification commands are explicit.
