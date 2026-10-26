# The design doc as source of truth

When an agent writes the code, the design judgments that a human would have
left in the code have to live somewhere a human can read: the design doc. This
engine treats the doc as the spec every unit is built from, reviewed against,
and recovered from. The approach follows the Elephant-Goldfish Model (Dave
Rensin, Google): a context-rich session writes the doc; a zero-context
"Goldfish" proves the doc stands on its own before any code is written.

## When a unit needs a doc

| Intake | Doc |
|---|---|
| A plan from the brainstorm skill (has `Status: Approved` and a `## Detailed Implementation Plan`) | Use it, and still run the readiness Goldfish: approval is a human judgment, readiness is checked against today's code. |
| Any other plan or spec | Run the readiness Goldfish on it. If it has no file-level implementation plan, write one into the doc (or a companion doc next to it) before executing. |
| A prompt, bug, or ticket whose fix is a few lines in one or two files with no design choice | No doc (no-doc mode). The brief's root cause, file scope, and acceptance criteria stand in for the doc through review and integration; skip the drift check. |
| A prompt, bug, or ticket that touches more files, makes a design choice, or changes a schema, API, or data lifecycle | Write a short doc (below) after root-causing, and run the readiness Goldfish before executing. |

## Short design doc

Save to `docs/designs/<slug>.md` in the repository unless the repository keeps
designs somewhere else; it lands with the change.

```markdown
# [Change name]

- **Status:** Approved | Implementing | Implemented
- **Read with:** [repo-relative files a reader must open]

## Problem
[3-5 sentences. For a bug: the symptom, the reproduction, and the root cause
with file:line evidence.]

## Approach
[Plain-English description of the change and why it fixes the root cause.]

## Alternatives considered
- [Option] — rejected because [reason].

## Acceptance criteria
- AC-1: Given [...], when [...], then [...].

## Detailed Implementation Plan
### `path/to/file` (create | modify | delete)
- [Exact change: new types, signatures, fields, behavior.] — [why]
### Tests
- `path/to/test` — [case] → AC-n
### Verification
- [Exact commands from the project.]

## Implementation notes
[Appended during the build: agreed deviations from the plan and why.]
```

## Readiness Goldfish

A Goldfish must start with **no conversation context**. Use one of these, at
the reviewer tier, read-only:

- **Claude Code:** the Agent tool with `subagent_type: "Plan"` (it has no
  file-writing tools), as a new agent — never a fork or a resumed agent.
- **Codex or any host:** a separate CLI process, e.g.
  `codex exec --sandbox read-only --ephemeral --cd <worktree or repo>
  --output-last-message <answer file> - < <prompt file>`. Inside Codex, do
  not use an in-session spawn that inherits the conversation.

If neither is available, stop and tell the user; a review in the planning
context is not a Goldfish review. Give it only this prompt:

```
You are the engineer who will implement this design, with no history on this
project. You are read-only: do not create, edit, or delete any file, and do
not run commands that change the workspace. Read this document and every
existing project file it references:
  {DOC_PATH}
Files the document says to create will not exist yet; that is expected. For
those, check the parent directory and any file the document names as the
pattern to follow.

Question: does it contain everything you need to implement it correctly on
the first attempt, without asking anyone and without making a design decision
yourself (a schema, an API shape, a file location, a dependency, an
error-handling strategy, how an edge case behaves, which test proves a
criterion)?

List, each with a severity (blocker / major / nit) and the section:
1. Every decision the document leaves to you, with the options.
2. Every step too vague to execute.
3. Every file you would need to touch that is not listed, and every listed
   change that does not match what the file contains today.
4. Every acceptance criterion with no stated way to verify it.

If there are no blockers or majors, say exactly: READY_TO_IMPLEMENT
```

Each run ends in one of three outcomes:

- **ready** — the answer ends with `READY_TO_IMPLEMENT` and lists no blocker
  or major. Execute.
- **needs-revision** — blockers or majors listed. Fix them in the doc (ask the
  user only for real design decisions), commit the revision to the
  integration branch, and run a new Goldfish on it.
- **review-failed** — non-zero exit, empty answer, or an answer that ignores
  the format. Retry once; a second failure is reported to the user. It is
  never treated as ready.

Stop after two re-runs following the first round. If the doc is still not
ready, do not execute that unit: report the open findings and ask the user
how to proceed.

## Changing the doc mid-build

When an executor reports that the plan is wrong, decide which kind of change
it is:

- **Implementation correction** — the design stands; a detail was wrong (a
  path, a helper that already exists, a test location). Fix the doc's
  Detailed Implementation Plan, note it in `## Implementation notes`, commit,
  and run a new readiness Goldfish before re-briefing; a corrected path or
  helper can pull in files nobody reviewed. Only a purely editorial fix (a
  typo, wording) skips the re-run.
- **Design change** — it alters a recorded decision, an API or schema shape,
  data lifecycle, or an acceptance criterion. Ask the user before
  proceeding. On approval, update the authoritative sections (the decision,
  the plan entries, the criteria), note it in `## Implementation notes`,
  commit, re-run the readiness Goldfish on the revision, and re-brief only
  when it is ready.

The code never redefines the doc on its own authority.

## Drift check

After the final repairs at integration, compare the doc with the merged code
over the delivered scope (the phases this run built; later phases are not
drift): every owned file changed as described; nothing changed outside them
without an entry in `## Implementation notes`; every acceptance criterion in
scope has its test. Report divergences only. Fix the code to match the doc;
changing the doc to match the code is a design change and follows the rule
above. Set the status to `Implemented` only when the whole-product gate has
passed and the drift check is clean; a partial delivery stays `Implementing`
with the delivered phases noted.
