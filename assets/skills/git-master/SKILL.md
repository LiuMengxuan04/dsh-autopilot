---
name: git-master
description: Inspect Git history, design atomic commits, separate mixed working-tree changes, resolve rebase conflicts, and prepare human-authorized delivery without losing user work. Use for commit planning or creation, history archaeology, blame and regression searches, branch cleanup, rebase or conflict resolution, commit-message quality, and push or pull-request preparation.
---

# Git Master

Treat the repository as shared state. Preserve unrelated changes, keep history reviewable, and separate local preparation from external mutation.

## Establish authority and state

1. Read repository instructions and the user's exact Git request.
2. Inspect `git status --short --branch`, the unstaged diff, the staged diff, recent history, remotes, and relevant branch relationships.
3. Identify which edits belong to the current objective. Never stage, rewrite, discard, or attribute an unrelated change merely because it is present.
4. Distinguish read-only archaeology, local history mutation, and external mutation. A request to inspect or implement does not authorize commit, rebase, push, force-push, or pull-request creation.

During an active Autopilot run, keep implementation and verification in the durable task graph. Use `autopilot_delivery` for isolated worktree state and a fixed delivery plan when available. A prepared plan is evidence for a human decision; it is not authorization to execute its commands.

## Investigate history

Start with the narrowest query that can answer the question:

- use `git log -- <path>` and `git show <commit> -- <path>` for file evolution;
- use `git log -S<string>` for added or removed literals and `git log -G<regex>` for changed matching lines;
- use `git blame -L` only after identifying the relevant range, then inspect the originating commit rather than treating blame as intent;
- use `git range-diff` to compare rewritten series and `git merge-base` to define a review range.

Report the commit, affected paths, and evidence. Do not infer motivation that the commit message or patch does not support.

## Build atomic commits

1. Group changes by one coherent behavior or maintenance purpose. Keep generated artifacts with their source change when repository policy requires them.
2. Stage explicit paths or hunks. Avoid broad staging when the worktree contains unrelated edits.
3. Re-read `git diff --cached --stat` and `git diff --cached`. Reject accidental files, secrets, debug output, and unrelated formatting.
4. Run checks proportionate to the staged behavior and confirm repository-required generated files are current.
5. Write an imperative subject that names the observable change; add a body only for durable rationale, migration, risk, or verification facts.
6. Create a new commit only when the human request authorizes it. Do not amend, bypass hooks, change author identity, or sign with unavailable credentials unless explicitly requested.

After committing, verify the new commit and ensure all remaining worktree changes are understood. A clean status is not a goal when it would require absorbing someone else's work.

## Rebase and resolve conflicts

Before rewriting history, confirm the target, upstream, published status, and whether the human authorized the rewrite. Prefer an isolated worktree for risky integration.

For each conflict:

1. read the base, current side, incoming side, and surrounding callers or tests;
2. preserve the intended behavior of both changes when compatible;
3. resolve the file deliberately, inspect the complete resulting diff, and run focused checks;
4. continue only after every conflict marker and semantic ambiguity is resolved.

Abort and report when product intent is ambiguous, credentials are needed, the branch moved unexpectedly, or unrelated user changes would be endangered. Never use destructive reset or raw force-push as a shortcut.

## Prepare external delivery

Push, force-push, pull-request creation, merge, release, and publication are external mutations. Require a direct, current human instruction for the exact repository and branch. Re-check the remote tip immediately before acting. If a rewritten published branch must be updated, use `--force-with-lease`, abort on remote movement, and report the old and new tips.

Prefer returning an inspectable delivery plan when execution authority is absent. Include the commit series, verification evidence, target remote and branch, pull-request title and body, and the exact next human-owned action.

## Report

State what was inspected or changed, the commit or range identities, checks run, remaining worktree state, conflicts or risks, and whether any external action was intentionally left unexecuted. Never claim a commit, push, or pull request exists without reading the resulting repository or remote state.
