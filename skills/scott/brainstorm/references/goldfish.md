# The Goldfish Gate

The plan reviewer in Phase 5 Step 5 checks the plan against the transcript: did
the plan capture what was said? That reviewer has the whole conversation, so it
cannot tell whether the plan stands on its own. The Goldfish gate answers the
other question: can someone with **no memory of this session** understand and
build from the plan alone?

The idea comes from the Elephant-Goldfish Model (Dave Rensin, Google): the
Elephant is the long, context-rich session that wrote the plan; a Goldfish is a
brand-new session that knows only what is put in front of it. "Feed the
Elephant; test it against the Goldfish." A plan that passes is a plan an
implementer, a crashed session, or a future maintainer can pick up cold.

## Isolation rules

Each Goldfish gets **only**:

- the absolute path of the plan, and
- permission to read the project files the plan references (and to search the
  codebase where its prompt says so).

It never gets the transcript, the draft, the decision log, or a summary of the
conversation, and its prompt tells it not to open anything under
`<state>/brainstorms/`. Do not paraphrase or "help" in the prompt; the prompt
text below is the whole briefing. Run every Goldfish read-only.

**Backend.** A Goldfish must start with no conversation context and must
not be able to write.

- When `codexMode` includes `review`, run each Goldfish as a separate
  `codex exec` process exactly as in second-opinion.md (read-only sandbox,
  `--ephemeral`, prompt from a file, answer from `--output-last-message`),
  with its own pair of scratch files (`goldfish-<name>-prompt.md` /
  `goldfish-<name>.md`) so they can run in parallel.
- Otherwise, use the host's own fresh agent. In Claude Code: the Agent tool
  with `subagent_type: "Plan"` (it has no file-writing tools), as a new agent
  per Goldfish — never a fork or a resumed agent. In Codex as host: an
  in-session spawn that inherits no conversation turns; if the host cannot
  guarantee that, ask the user whether to allow `codex exec` for the gate
  rather than calling it despite `codexMode: off`.

If no zero-context backend is available, say so and stop the gate; a review
in this session is not a Goldfish review. The same failure rules apply: a
non-zero exit, an empty answer, or an answer that ignores the format is a
failed call, never a pass.

## Which Goldfish to run

| Goldfish | Runs when | Reads |
|----------|-----------|-------|
| Comprehension | Always | Whole plan |
| Zoom-out | Software plans in an existing codebase; optional otherwise | Whole plan, plus codebase search |
| Implementation readiness | The plan has a Detailed Implementation Plan section | Whole plan, plus the files it lists |

Run the applicable ones in parallel. For non-software brainstorms run only
Comprehension, with "implement" read as "carry out".

## Comprehension prompt

```
You are a Goldfish: a fresh reader with no history on this project. Read this
plan, and every existing project file it references, and nothing else
(files the plan says to create will not exist yet):
  {PLAN_PATH}
Do not open anything under {STATE_DIR}/brainstorms/. You are read-only: do
not create, edit, or delete any file.

Then answer, in this order:
1. In 3-5 plain sentences: what is this plan trying to accomplish, and why?
2. How does the existing system (or situation) work today, as it relates to
   this plan? If the plan does not tell you, say "The plan does not say."
3. The core flows the finished thing must support, as a short list.
4. Every term, component, system, or prerequisite the plan uses without
   defining or linking it.
5. Every place you had to guess. For each: the section, what you guessed, and
   what the plan should state instead.

For items 4 and 5 give a severity per finding: blocker (an implementer would
build the wrong thing), major (an implementer would have to stop and ask), or
nit. Do not praise the plan. Every gap you find makes you more useful.
```

**Scoring the comprehension answer.** You (the Elephant) compare answers 1-3
with what the transcript and draft actually say. Every place the Goldfish
misread the goal, got the current system wrong, or missed a core flow is a
finding, even if the Goldfish did not flag it: the plan is missing the context
that would have prevented the misreading. Record each as a `blocker` or `major`
finding alongside the Goldfish's own list.

## Zoom-out prompt

```
You are a Goldfish: a skeptical architect with no history on this project.
Read this plan and every existing project file it references:
  {PLAN_PATH}
Do not open anything under {STATE_DIR}/brainstorms/. You are read-only: do
not create, edit, or delete any file. You may search the
codebase at {PROJECT_ROOT}.

Find where the plan is more complicated than the problem needs:
- Features, options, or abstractions built for speculative future needs.
- New utilities, modules, or dependencies where something in the codebase or
  the platform already does the job. Search before claiming; cite file paths.
- Optimizations (caching, queues, sharding) with no stated bottleneck.
- Fixes that patch a symptom instead of the root cause.
- New logic placed in the wrong layer, or that breaks an existing pattern.

For each finding: severity (blocker / major / nit), the plan section, what is
over-built or misplaced, and the simpler alternative with evidence. Do not
praise the plan.
```

## Implementation-readiness prompt

```
You are a Goldfish: the engineer who will implement this plan, with no history
on this project. Read this plan and every existing project file it references:
  {PLAN_PATH}
Do not open anything under {STATE_DIR}/brainstorms/. You are read-only: do
not create, edit, or delete any file. Files the plan says to
create will not exist yet; that is expected. For those, check the parent
directory and any file the plan names as the pattern to follow.

Question: does this plan contain everything you need to implement it correctly
on the first attempt, without asking anyone and without making a design
decision yourself?

The plan fails wherever you would have to decide something: a schema, an API
shape or signature, a file location, a dependency, an error-handling strategy,
a migration step, how an edge case behaves, or which test proves a criterion.

List:
1. Every decision the plan leaves to you, with the section and the options you
   would be choosing between.
2. Every step too vague to execute ("update the service", "handle errors").
3. Every file you would need to touch that the Detailed Implementation Plan
   does not list, and every listed file whose described change does not match
   what the file actually contains today.
4. Every acceptance criterion with no stated way to verify it.
5. Phases that would leave the code unbuildable or untestable.

Severity per finding: blocker / major / nit. If there are no blockers or
majors, say exactly: READY_TO_IMPLEMENT
```

## Resolving findings

Pool the findings from every Goldfish (and, in the same pass, the plan
reviewer's gaps). Before showing anything to the user, classify each one
yourself, using what the Elephant knows:

- **Propose fix** — the finding is real. Write the exact plan change.
- **Contest** — the finding is wrong: the plan already covers it, or it rests
  on a misreading of the code. Cite the plan section or the file that shows it.
  A contested finding that the Goldfish could only have avoided by knowing the
  conversation is not contested: the plan is missing that context, so fix it.
- **Design decision** — the fix needs a choice only the user can make.

Apply `Propose fix` items for blockers and majors directly and log them. Route
`Design decision` items to the user in batches of up to 4 (recommended option
first, plus "Not sure — recommend one"). Show contested items and nit fixes in
one summary the user can overrule. Log every finding and its classification in
the transcript.

## Stopping

A pass counts only for the plan revision it read. After a round that changed
the plan, re-run every applicable reviewer (the transcript reviewer and each
Goldfish that applies) on the revised plan, each with a fresh context (never
resume a previous Goldfish). A round whose only changes were nit fixes does
not need a re-run. The gate passes when every applicable reviewer's latest run
is against the final revision and reports no blocker or
major (the readiness Goldfish says `READY_TO_IMPLEMENT`; the transcript
reviewer says `PLAN_COMPLETE`). A round whose findings are all nits is a pass.

The budget is shared by the transcript reviewer and the Goldfish: at most
**two re-run rounds** after the first. Record the round number in the draft
frontmatter (`reviewRound`) so a resumed session keeps the count. If the
budget runs out, list what remains under the plan's Open questions, set
`**Readiness:** open findings` in the plan header, and tell the user. Keep the
draft, transcript, and review files until readiness is resolved: Phase 5's
cleanup step is skipped while findings are open. More rounds need the user's go-ahead.

Contested findings do not consume rounds by being re-raised: if a re-run
repeats a finding you already contested and the user upheld the contest,
note it and do not count it as open.
