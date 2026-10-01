---
name: brainstorm
description: "Use when the user says \"brainstorm\", \"let's brainstorm\", \"help me think through this idea\", \"flesh out this idea\", \"interview me about\", or wants to explore an idea before building it. Runs a one-question-at-a-time interview, expands and pressure-tests the idea, and produces an actionable plan with acceptance criteria."
---

# Brainstorm a Plan

Run an interactive brainstorm that moves through six named phases: **Seed,
Discovery, Exploration, Expansion, Flush-Out Loop, and Crystallize**. The goal
is to understand an idea through a structured interview, resolve every
accepted concept down to real decisions, and produce a plan that can be both
built and validated.

`<state>` below means the host harness's own state directory, relative to the
current working directory: `.claude/` when Claude Code is running this,
`.Codex/` under Codex. Resolve it once at the start of the session and keep it;
a paused brainstorm resumes under the harness whose directory holds its draft
and transcript. If both exist, the one holding a draft for this brainstorm wins.

## Reference files

Read these when the step that needs them comes up, not up front:

| File | Read it when |
|------|--------------|
| [references/records.md](references/records.md) | Creating the draft or transcript, or writing an acceptance criterion or decision-log entry. Holds the draft format, transcript format, AC rules, and decision-log format. |
| [references/second-opinion.md](references/second-opinion.md) | Any second-opinion call: the availability check, idea contribution in Phases 3–4, the completeness critic in 4.5, and the plan reviewer in Phase 5. Holds the exact `codex exec` invocation and the prompts. |
| [references/coverage-lenses.md](references/coverage-lenses.md) | Starting Phase 4.5 Step 2, and when briefing the completeness critic. |
| [references/package-research.md](references/package-research.md) | A library, framework, or tool comes up in any phase, and before writing the plan. |
| [references/plan-document.md](references/plan-document.md) | Phase 5 Steps 1 and 4 (outline and plan sections) and Step 7 (handoff prompt). |
| [references/example-session.md](references/example-session.md) | You want to see a whole session end to end, including the Flush-Out Loop. |

## Core rules

1. **Ask with `AskUserQuestion`.** It takes up to 4 questions per call, each
   with 2–4 options plus the free-text "Other" answer it adds automatically.
   Structured questions keep answers unambiguous and easy to log.
2. **Match question batching to the phase.** In Seed, Discovery, and
   Exploration, put one question in each call, because each answer shapes the
   next question. In Expansion, the Flush-Out Loop, and plan review, batch up
   to 4 related, independent questions per call; ask a question on its own when
   it is high-impact, irreversible, or its options depend on another answer.
3. **Let the user set the pace.** When there seems to be enough information,
   offer to go deeper or move on, and wait for the user to choose Crystallize.
   The user knows better than you whether the idea has been explored enough.
4. **Announce each phase** by name and number, e.g. "**Phase 2: Discovery**",
   so the user always knows where the session is.
5. **Be bold in Expansion.** Ambitious, unexpected ideas are what the phase is
   for; safe incremental ones the user has usually already thought of.
6. **Adapt everything.** Question topics, plan sections, and suggestion
   categories follow the subject. Not every brainstorm is about software.
7. **Verify packages against current sources.** Training data goes stale on
   versions, deprecations, and security advisories, so check with WebSearch and
   WebFetch whenever a library or tool comes up (see package-research.md).
8. **Keep the transcript current.** Append to `<state>/brainstorms/transcript.md`
   after every interaction, so an interrupted session loses nothing and the
   final plan can be checked against it.
9. **Prefer rigor to speed.** The value of this skill is what it forces into
   the open. A plan is done when the core surface is mapped, the coverage lenses
   have been applied, and every behavioral decision has an acceptance
   criterion; it is not done because the user is tired of questions.
10. **Give every behavioral decision an acceptance criterion.** When a decision
    describes how the thing behaves (not a name or a preference), record a
    testable `Given / When / Then` criterion so the plan can be validated.
11. **Use the Coverage Lenses in the Flush-Out Loop.** They are the systematic
    checklist that finds edge cases and missing core functionality; ad-hoc
    intuition about "what else to ask" reliably misses them.

## Startup

**Resume check.** If `<state>/brainstorms/draft.md` exists, read it and the
transcript next to it, take the topic and phase from the draft's frontmatter,
and ask: "I found an in-progress brainstorm about '[topic]'. What would you
like to do?" with **Resume** (continue in the recorded phase) and **Start
fresh** (delete the draft and transcript). On resume, load everything and go
to the recorded phase.

**Second-opinion mode.** Before Phase 1, or on resuming a draft whose
frontmatter has no `codexMode`, ask once how a second model should take part.
The second opinion comes from the Codex CLI (`codex exec`), which is a
different model family when Claude hosts the session and tends to catch blind
spots same-family review rubber-stamps.

| Option | `codexMode` | Effect |
|--------|-------------|--------|
| Both review and idea contribution (Recommended) | `review+ideas` | Codex adds ideas in Exploration and Expansion and is the critic and plan reviewer. |
| Review only | `review` | Codex is the critic and plan reviewer; ideas come from you alone. |
| Idea contribution only | `ideas` | Codex adds ideas; a fresh-context subagent reviews. |
| Off | `off` | No Codex calls; a fresh-context subagent reviews. |

Record the choice as `codexMode` in the draft frontmatter and read it from
there on resume. Before the first Codex call, run the availability check in
second-opinion.md; if Codex is missing or logged out, say so and offer to fall
back to a subagent rather than proceeding silently.

**Arguments.** Text after `/brainstorm` arrives as `$ARGUMENTS` and seeds the
topic. If it is empty, Phase 1 asks for the topic.

## Phase 1: Seed

Goal: capture the initial idea.

- With a topic: restate your understanding briefly and ask one clarifying
  question to confirm direction.
- Without one: ask "What would you like to brainstorm?" with broad options
  (a new feature or product; a technical architecture or system design; a
  process or workflow; something else), then follow up for specifics.

Then create `<state>/brainstorms/draft.md` and `transcript.md` in the formats
from records.md, and log the seed exchange.

## Phase 2: Discovery

Goal: understand goals, context, and motivation.

- One question per call. Choose topics for this subject: goals and outcomes,
  audience, what prompted the idea, prior art, must-haves, success criteria.
- If the topic touches the current project, have an `Explore` subagent (Agent
  tool) scan the codebase for relevant patterns and the tech stack, and ground
  your questions in what it finds.
- Ask whether there are docs, files, or references you should read.
- After each answer, append the Q&A under `## Discovery` in the draft, update
  `phase`, and log the exchange and any research in the transcript.

## Phase 3: Exploration

Goal: dig into constraints, alternatives, tradeoffs, dependencies, risks, and
non-goals.

- One question per call; topics follow from Discovery.
- If `codexMode` includes `ideas`: once, after 2–3 exploration answers have
  made the problem's shape clear, ask Codex for angles you have not raised (the
  idea-contribution call in second-opinion.md, with the Exploration values).
  Offer the useful ones as a multi-select question ("Codex flagged these angles
  I hadn't asked about — which are worth exploring?"), then ask follow-ups for
  the accepted ones.
- After each answer, append under `## Exploration` and log in the transcript,
  including the full Codex response and which angles were accepted.

## Phase 4: Expansion

Goal: elevate the idea with bold, creative suggestions.

- Each round, draft 3–4 bold ideas of your own, each grounded in something
  specific from earlier phases. If `codexMode` includes `ideas`, make the
  Expansion idea-contribution call in parallel, then merge, de-duplicate, and
  tag each idea `[host]`, `[codex]`, or `[both]` in its option description.
- Present the round as multi-select questions of up to 4 options each; use a
  second question in the same call when there are more than 4 ideas.
- After each round, ask whether to see more ideas or move on to flushing out
  the plan.
- Log accepted and declined ideas (with tags) under `## Expansion` and in the
  transcript.

## Phase 4.5: Flush-Out Loop

Goal: map the full functional surface, then drive every accepted concept
through the Coverage Lenses so hidden sub-decisions are resolved and
acceptance criteria exist before the plan is written.

Run at least one full pass of Steps 1–5 every time, even when the brainstorm
feels done. Earlier phases map the interesting parts of an idea, not its whole
surface, and most "we never thought about that" surprises during
implementation trace back to a flow that was never mapped or a concept that
was accepted without being examined.

**Step 1 — Surface Map.** Record under `## Surface Map` in the draft, using the
codebase as ground truth where relevant:

1. Actors and roles, including guests, admins, background jobs, and external
   systems where they apply.
2. Core flows as short verb phrases with IDs (`FLOW-1`, …). Enumerate across
   primary user, admin/ops, background/scheduled, recovery/error,
   onboarding/setup, and teardown/lifecycle flows; aim for breadth here.
3. Entities and state: what is created, read, updated, deleted, or persisted,
   and who owns it.
4. Boundaries: what this does not do, and what it depends on.
5. Accepted-concepts inventory: every concept accepted in any phase
   (constraints, non-goals, requirements, Expansion ideas), each with an ID
   (`CON-1`, …) and marked accepted, deferred, or rejected.

Show the map and ask "Is anything missing or mis-scoped?" (looks complete /
missing flows or actors / some of this is out of scope). Reconcile before
moving on.

**Step 2 — Lens pass.** Pick a depth tier and record it: **Light** (small,
low-risk, or non-software; apply the lenses that obviously matter),
**Standard** (default; walk all lenses, route only real design decisions to
the user), or **Deep** (high-risk, security-sensitive, or architecturally
central; walk every lens for every item). Read coverage-lenses.md, then for
every inventory concept and every core flow consider each lens and classify
what it exposes:

- `blocker` — would block or mislead an implementer; resolve before Crystallize.
- `important` — a real design decision affecting behavior or UX; ask the user.
- `implementation-default` — an obvious default with no design consequence;
  resolve it yourself and record the default.
- `N/A` — the lens does not apply; say so rather than skipping it silently.

Record the open sub-decisions with their class and IDs under
`## Flush-Out Pass` before resolving them, so the backlog survives an
interruption.

**Step 3 — Resolve.** Ask about `blocker` and `important` items, batching per
rule 2. Put the recommended option first and include a "Not sure — recommend
one" option; when asked, recommend with reasoning, then confirm. Read the
relevant code first when a concept touches it, so options reflect reality.
After each answer, record the decision-log entry (choice, alternatives,
rationale) and, for behavior, an acceptance criterion (formats in
records.md). If an answer contradicts an earlier decision or an existing
mechanic, record the replacement and fix the conflicting notes. Expect scope to
change; new concepts go back into the Surface Map and through the lenses.

**Step 4 — Completeness critic.** Ask a critic for the top unresolved gaps,
ambiguities, and contradictions that would block or mislead an implementer
(dispatch and prompt in second-opinion.md: Codex when `codexMode` includes
`review`, otherwise a fresh-context subagent). Resolve technical gaps yourself
with recorded defaults; route real design decisions to the user in batches of
up to 4; add acceptance criteria for any newly resolved behavior.

**Step 5 — Loop until dry.** Ask whether anything else needs flushing out
("Looks fully flushed out — crystallize" / "More to flush out"). Repeat Steps
2–5 until the user says it is done and the critic reports no high-severity
gaps.

## Phase 5: Crystallize

Goal: write the plan and validate it against the transcript.

1. **Confirm the outline.** Show the planned section headings with a one-line
   summary each (see plan-document.md). Options: "Looks good, write it" /
   "Adjust the outline" / "More to flush out" (returns to Phase 4.5).
2. **Choose where to save it:** `<state>/plans/`, a `docs/` or `plans/` folder
   in the project, or a custom path.
3. **Research before writing.** Run package-research.md for every library,
   framework, or tool discussed; carry verified versions, compatibility notes,
   and advisories into the plan, and flag anything the brainstorm assumed that
   is no longer true.
4. **Write the plan** with sections that fit the subject, including the
   mandatory ones listed in plan-document.md, and keep the `FLOW`/`CON`/`DEC`/`AC`
   IDs. The plan covers the what and the why — behavior, architecture at a high
   level, edge cases, acceptance criteria — and leaves code-level how to the
   implementer.
5. **Review loop.** Send the transcript and plan to the plan reviewer
   (second-opinion.md). If it returns `PLAN_COMPLETE`, move on. Otherwise
   present its gaps in batches of up to 4 questions, each with "Yes, add this" /
   "No, skip this" / "Modify the suggestion"; apply the approved additions, log
   everything, and review again. Repeat until `PLAN_COMPLETE`; most plans
   converge in one or two rounds. An errored or empty review is not a pass.
6. **Summarize** the plan in chat and say it was validated against the
   session transcript.
7. **Next step.** Offer "Begin implementation" (read the plan and start) or
   "Generate a handoff prompt" (a copy-paste block; contents in
   plan-document.md).
8. **Clean up.** Delete `<state>/brainstorms/draft.md`, `transcript.md`, and
   any `second-opinion*.md` scratch files there.
