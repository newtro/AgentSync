# Second Opinions: Codex and Fresh-Context Subagents

Three places in the brainstorm ask a second model to look at the work:

| Call | Phase | Who answers |
|------|-------|-------------|
| Idea contribution | 3 (once) and 4 (every round) | Codex, only when `codexMode` is `ideas` or `review+ideas` |
| Completeness critic | 4.5 Step 4 | Codex when `codexMode` is `review` or `review+ideas`, otherwise a subagent |
| Plan reviewer | 5 Step 5 (every round) | Codex when `codexMode` is `review` or `review+ideas`, otherwise a subagent |

Every call gets file paths, not pasted content, so the second model reads the
transcript and draft or plan itself. Use absolute paths.

## Backend: Codex CLI

Codex runs through the installed `codex` CLI on the user's subscription.

**Availability check** (once, before the first Codex call of the session):

```sh
codex --version && codex login status
```

If the command is missing or the status is not logged in, tell the user and
ask whether to fall back to a subagent for the session (or switch `codexMode`
to `off`). Do not continue as if Codex had answered.

**Invocation.** Write the prompt to a file, then run Codex read-only so it can
open the referenced files but cannot change anything:

```sh
codex exec \
  --sandbox read-only \
  --ephemeral \
  --skip-git-repo-check \
  --cd "<project root, or the current directory>" \
  --output-last-message "<state>/brainstorms/second-opinion.md" \
  - < "<state>/brainstorms/second-opinion-prompt.md"
```

- Allow several minutes; give the shell call a long timeout (up to 10 minutes)
  rather than treating a slow response as a failure.
- Read the answer from the `--output-last-message` file. Both scratch files are
  overwritten on each call and deleted at cleanup.
- A non-zero exit, an empty answer file, or an answer that ignores the
  requested format is a failed call. Log it, tell the user, and either retry
  once, fall back to a subagent for this call, or ask how to proceed. A failed
  review is never a `PLAN_COMPLETE`.
- When Codex is itself the host harness, this is still a fresh context but not
  a different model family; that is acceptable, and a subagent works equally
  well.

## Backend: fresh-context subagent

Use the Agent tool with `subagent_type: "general-purpose"`. The subagent starts
without this conversation, which is the point: it judges the documents, not
the discussion you remember. Give it the same prompt, with absolute paths, and
ask it to return only the requested format.

## Idea-contribution prompt

Fill in `{TOPIC}` from the draft frontmatter and `{PHASE}` / `{GUIDANCE}` from
the table below.

```
You are contributing ideas to an interactive brainstorm about: {TOPIC}

Read these two files first; they hold the full session so far:
- Transcript: {TRANSCRIPT_PATH}
- Draft: {DRAFT_PATH}

Current phase: {PHASE}

Generate 4-6 bold, specific, non-obvious ideas suited to this phase. Ground
each one in something from the transcript (a stated goal, a constraint, or a
prior decision). Skip generic suggestions the user has plainly already
considered, and skip anything already accepted or declined in the draft.

{GUIDANCE}

Output only a numbered list, no preamble or summary. For each item:
1. **Headline** — one concrete, specific sentence.
   Why it fits: 1-2 sentences pointing at the transcript context.
```

| Phase | `{PHASE}` | `{GUIDANCE}` |
|-------|-----------|--------------|
| Exploration | Exploration — surfacing alternative angles, tradeoffs, and considerations | Focus on angles, tradeoffs, constraints, edge cases, or non-goals the user has not been asked about yet but that matter for this kind of project. Name the failure mode or decision each one unlocks. |
| Expansion | Expansion — bold ideas that stretch the original vision | Suggest features, capabilities, monetization angles, differentiation plays, or stretch goals that go beyond the obvious next steps. Favor ideas that exploit something specific in the transcript: a constraint, a chosen technology, a stated user pain. |

**Merging.** Combine Codex's list with your own ideas, de-duplicate by
headline similarity, and tag each `[host]`, `[codex]`, or `[both]` (both
produced it independently). Show the tag in the option description. Log the
full Codex response and the user's choices in the transcript.

## Completeness-critic prompt

Paste the full lens list from coverage-lenses.md where indicated.

```
You are a completeness critic for a brainstorm that is about to become an
implementation plan. Read:
- Draft (decisions, Surface Map, flush-out pass, acceptance criteria): {DRAFT_PATH}
- Transcript (everything said in the session): {TRANSCRIPT_PATH}

Using the Coverage Lenses below as your checklist, list the most important
unresolved gaps, ambiguities, or contradictions that would block or mislead an
implementer. Organize findings by lens. Pay particular attention to:
- Core functionality implied by the accepted concepts but missing from the Surface Map.
- Edge and boundary cases: empty, zero, one, max, duplicate, simultaneous, out of order.
- Failure modes: errors, timeouts, partial failure, conflicts, idempotency, retries, rollback.
- Mechanics that contradict each other or an existing system.
- Lifecycle and migration: creation, deletion, backward compatibility, in-flight state.
- How the thing ends, completes, or counts as done.
- Behavioral decisions that have no acceptance criterion.

For each finding give: the lens, what is unresolved, why it matters to an
implementer, severity (high / medium / low), and whether it is a design
decision for the user or a technical gap with an obvious default (state the
default). If there are no high-severity gaps, say so explicitly.

Coverage Lenses:
{LENSES}
```

## Plan-reviewer prompt

```
You are a plan reviewer. Read both documents in full:
1. Transcript (the complete brainstorm session log): {TRANSCRIPT_PATH}
2. Plan (the output plan): {PLAN_PATH}

Find anything discussed in the transcript that is missing from, or
inadequately covered by, the plan:
- Requirements, goals, or constraints the user stated.
- Decisions or tradeoffs the user confirmed, with their rationale and rejected alternatives.
- Ideas the user accepted during Expansion.
- Research findings (versions, security issues, alternatives) that belong in the plan.
- Edge cases, risks, or non-goals the user mentioned.
- Nuance or context from the user's answers that was lost in translation.

Also audit the plan's readiness to be implemented and validated:
- Surface coverage: every actor and core flow from the Surface Map appears, and no flow implied by the accepted concepts is absent.
- Edge cases and failure modes: each significant feature covers boundary states, errors, and concurrency, not only the happy path.
- Acceptance criteria: every behavioral feature has at least one observable, testable criterion; flag behaviors that cannot be validated as written.
- Decision rationale: key decisions record the rejected alternatives and why.
- Contradictions: no part of the plan conflicts with another part or with an existing system noted in the transcript.

For each gap give:
- What's missing: what was discussed but not captured.
- Where in transcript: the relevant part.
- Suggested addition: what to add and where in the plan.

The plan is a distillation, not a copy of the transcript; report substantive
omissions, not wording differences. If the plan fully covers the transcript
and passes the readiness audit, reply with exactly:
PLAN_COMPLETE: The plan accurately captures all topics discussed in the brainstorm session.
```
