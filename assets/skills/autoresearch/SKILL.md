---
name: autoresearch
description: Run a bounded, evidence-driven research loop that turns an uncertain engineering question into hypotheses, reproducible experiments, findings, and a verifier-audited conclusion. Use when the user asks for autoresearch, comparative investigation, benchmark-led exploration, root-cause research, or repeated experiments whose result must survive long Autopilot runs.
---

# Autoresearch

Treat research as a falsifiable task graph, not an open-ended browsing session.

## Establish the question

1. Restate the decision the research must support and list concrete success criteria.
2. Inspect repository instructions, existing measurements, prior decisions, and relevant implementation before proposing experiments.
3. Record assumptions and at least one plausible alternative hypothesis.
4. Define the budget: datasets or fixtures, commands, trials, elapsed time, and stopping conditions. Never enlarge an active Autopilot lease.

## Build the experiment graph

Under Autopilot, use `autopilot_plan` for hypotheses and dependency-aware experiments. Give each experiment one controlled change, an observable metric, a baseline, and a reproducible evidence path. Use `autopilot_delegate` for independent literature, code, or measurement lanes; use `autopilot_team_start` only when a lane needs a durable multi-message conversation. Keep integration and interpretation with the parent.

Do not let one worker both invent a hypothesis and certify it. Preserve negative results. Reject an experiment whose setup changed in unrecorded ways, whose sample is too small for the claim, or whose output cannot be reconstructed.

## Iterate

After each batch:

1. Compare results to the baseline and hypothesis.
2. Record raw artifact locations, exact commands, environment facts, and a concise interpretation.
3. Add or reorder tasks only when evidence changes the next useful question.
4. Stop a repeated line of inquiry when it reaches the declared retry or evidence ceiling.

Use `autopilot_ralph_start` for a bounded fresh-context implementation/measurement loop attached to one exact task; it is a leaf activity, never a second coordinator. Store durable cross-session facts with `autopilot_memory` and create an explicit `autopilot_handoff` before pausing.

## Conclude

State what the evidence supports, what it disproves, remaining uncertainty, and the recommended decision. Re-run the winning experiment from a clean state when feasible. During Autopilot, submit the complete evidence through `autopilot_verify`; the independent reviewer quorum, not the researcher, decides completion.
