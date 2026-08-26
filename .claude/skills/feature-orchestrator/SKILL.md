---
name: "feature-orchestrator"
description: "Runs the full Spec Kit workflow for a feature end-to-end (specify → clarify → plan → checklist → tasks → analyze → implement → converge), stopping at every decision point to ask the user rather than assuming scope, answers, or which optional skills to run."
argument-hint: "Optionally describe the feature to build; you'll be asked for anything missing"
compatibility: "Requires spec-kit project structure with .specify/ directory and the speckit-* skills installed"
metadata:
  author: "custom"
  source: "feature-orchestrator"
user-invocable: true
disable-model-invocation: false
---

## User Input

```text
$ARGUMENTS
```

## Purpose

Drive one feature through the full Spec Kit SDD cycle — specify, (optionally) clarify, plan,
(optionally) checklist, tasks, (optionally) analyze, implement, (optionally) converge — invoking
each underlying `speckit-*` skill in order. This skill is a sequencer, not a decision-maker: every
fork below is resolved by asking the user, never by picking the option that "seems right."

## Hard rule: never assume

At no point should you:
- Invent or scope the feature yourself if the user hasn't described it.
- Decide on the user's behalf whether to run an optional skill (`speckit-clarify`,
  `speckit-checklist`, `speckit-analyze`, `speckit-converge`).
- Silently proceed from one stage to the next because the previous one "looked successful."
- Answer a clarification question, checklist focus, or gate approval yourself instead of asking.

Every question below MUST be put to the user explicitly — use the `AskUserQuestion` tool when
available (multiple-choice for yes/no or option-style decisions), or ask directly in chat and wait
for a reply otherwise. Do not continue past a question until the user has answered it.

## Stage 0 — Constitution check

Check whether `.specify/memory/constitution.md` exists and is actually filled in (not just
unresolved `[PLACEHOLDER]` tokens from the template). If it's missing or still a template, ask the
user whether they want to run `speckit-constitution` before starting this feature. Respect their
answer either way; if they decline, note the gap in the final summary rather than blocking.

## Stage 1 — speckit-specify

If `$ARGUMENTS` is empty and no feature description has been given in the conversation, ask the
user to describe the feature — do not guess scope or requirements. Once you have a description,
invoke `speckit-specify` with it.

## Stage 2 — speckit-clarify (optional)

Ask: "Run `speckit-clarify` to resolve ambiguities in the spec before planning? (recommended if
anything in the spec feels underspecified)". Wait for an explicit yes/no.
- Yes → invoke `speckit-clarify` and let it run its own question flow with the user.
- No → continue, and record this as skipped in the final summary.

## Gate — review the spec

Show the user a short summary of what `speckit-specify` (and `speckit-clarify`, if run) produced.
Ask them to explicitly choose: approve and move to planning, request changes to the spec first, or
stop here. Do not move on based on your own judgment that the spec looks complete.

## Stage 3 — speckit-plan

Once the user has approved the spec, invoke `speckit-plan`.

## Stage 4 — speckit-checklist (optional)

Ask: "Generate a quality checklist for this plan with `speckit-checklist`? (optional)".
- Yes → ask the user what the checklist should focus on (`speckit-checklist` needs user-supplied
  requirements — do not invent them yourself), then invoke it with that input.
- No → continue, and record this as skipped.

## Gate — review the plan

Ask the user to explicitly approve moving to task generation, request changes to the plan, or
stop. Do not auto-approve.

## Stage 5 — speckit-tasks

Once approved, invoke `speckit-tasks`.

## Stage 6 — speckit-analyze (optional)

Ask: "Run `speckit-analyze` for a cross-artifact consistency check across spec/plan/tasks before
implementing? (optional, recommended)".
- Yes → invoke `speckit-analyze`, surface its report, and ask the user whether to fix any flagged
  issues before continuing or proceed anyway. Do not decide this yourself.
- No → continue, and record this as skipped.

## Gate — implementation is a real, hard-to-reverse step

`speckit-implement` writes and executes real code changes. Before invoking it, explicitly confirm
with the user that they want to proceed now, as opposed to stopping to review `tasks.md` by hand
first. Never auto-proceed into implementation just because the previous stage succeeded.

## Stage 7 — speckit-implement

Once confirmed, invoke `speckit-implement`.

## Stage 8 — speckit-converge (optional)

After implementation finishes, ask: "Run `speckit-converge` to check the codebase against
spec/plan/tasks and append any remaining work as new tasks?".
- Yes → invoke `speckit-converge`. If it appends new tasks, ask the user whether they want to loop
  back into `speckit-implement` for the new tasks or stop here — do not assume either answer.
- No → continue to the final summary.

## Final summary

Report, in one short section:
- Which stages ran and which were skipped, and why (per the user's actual answers — not your
  inference).
- Any open items worth flagging: constitution not ratified, clarify/checklist/analyze skipped,
  or converge finding remaining work not yet implemented.

Note: `speckit-taskstoissues` (converting tasks to GitHub issues) is not part of this flow. If the
user wants that instead of or in addition to `speckit-implement`, ask them explicitly rather than
substituting it in on their behalf.
