# Brainstorm Records

The brainstorm keeps two files under `<state>/brainstorms/`: the **draft**
(structured progress, used for pause/resume and as the plan's raw material)
and the **transcript** (a verbatim chronological log, used to validate the
plan at the end). This file also defines the acceptance-criterion and
decision-log formats that accumulate in the draft.

## Transcript

`<state>/brainstorms/transcript.md` exists so that no idea, detail, or nuance
is lost, including things that never make it into the structured draft. The
plan reviewer reads it as the source of truth.

### What to log

Give every entry a timestamp. Log:

- Phase transitions.
- Questions asked: exact text and every option presented.
- User responses, verbatim.
- Your observations or synthesis between questions.
- Research: package lookups, codebase scans, web searches, and what they found.
- Suggestions offered, with provenance tags, and which were accepted or declined.
- Second-opinion calls: the full Codex or subagent response.
- Decisions, with the alternatives rejected and the rationale.
- The Surface Map review and the user's corrections.
- Coverage Lens findings per concept or flow (including lenses marked N/A) and
  the acceptance criteria captured.
- The outline review and any adjustments.
- Plan review findings, the user's responses, and the resulting plan changes.

### Format

```markdown
# Brainstorm Transcript
**Topic:** [topic]
**Started:** [ISO timestamp]

---

## [HH:MM] Phase 1: Seed
**Asked:** [question text]
**Options:** [options, if any]
**User responded:** [response]

**Observation:** [any commentary you gave]

## [HH:MM] Phase 2: Discovery
**Asked:** [question text]
**User responded:** [response]

**Research:** Checked [package] release notes via WebFetch — v4.2.1 is current; v3 is deprecated.
```

### When to update

Write to the file immediately after each interaction rather than batching:
after every `AskUserQuestion` response, every research action, and every
phase transition. If the session dies after step 7 of 10, the transcript
should hold all 7.

## Draft

`<state>/brainstorms/draft.md` tracks progress for pause and resume. Update
`phase` in the frontmatter as phases change.

```markdown
---
topic: "The brainstorm topic"
phase: "discovery"   # seed | discovery | exploration | expansion | flush-out | crystallize
started: "2026-02-08T14:30:00"
codexMode: "review+ideas"   # review+ideas | review | ideas | off
---

## Seed
[Initial idea]

## Discovery
### Q: [question]
A: [answer]

## Exploration
### Q: [question]
A: [answer]

## Expansion
### Round 1
- [x] [host] Suggestion the user accepted
- [ ] [codex] Suggestion the user declined

### Round 2
- [x] [both] Another accepted suggestion

## Surface Map
**Depth tier:** Light | Standard | Deep

### Actors / roles
- [actor] — [what they do / permissions]

### Core flows (the spine)
- FLOW-1 [category] [actor] [verb phrase] — [one line]

### Entities / state
- [entity] — owned by [x]; created/updated/deleted by [y]; persisted: [yes/no]

### Boundaries
- Out of scope: [...]
- External dependencies: [...]

### Accepted-concepts inventory
- CON-1 [concept] — accepted | deferred | rejected — source: [phase]

## Flush-Out Pass
### [CON-n / FLOW-n]: open sub-decisions from the lenses
- [ ] [lens] → [sub-decision] — class: blocker | important | implementation-default | N/A
- [x] [lens] → [sub-decision] — Decision: [resolved] (DEC-n; AC-n if behavioral)
Notes: [contradictions surfaced / new sub-systems / deferred items / lenses marked N/A]

### Completeness check ([Codex | subagent] critic)
- Findings by lens: [...]
- Technical gaps resolved with defaults: [...]
- Design decisions routed to the user: [...]

## Acceptance Criteria
### [FLOW-n / CON-n]
- AC-1 [happy] Given [...], when [...], then [...]. (validates DEC-n)
- AC-2 [boundary/permission/failure] Given [...], when [...], then [...].

## Decision Log
- **DEC-1 — Decision:** [...]
  ...

## Assumptions Register
- ASM-1 [assumption] — confidence: high/med/low — impact if wrong: [...] — verify by: [how/when]

## Research Notes
### [Package name]
- Current version: x.y.z
- Last release: [date]
- Notes: [findings, with source URLs]
```

## Acceptance criteria

Acceptance criteria are what make the plan validatable rather than merely
buildable. Every decision that describes a behavior, as opposed to a naming
or styling preference or a pure implementation default, carries at least one.

Write them as `Given / When / Then`, or as a plainly checkable assertion:

```
- AC-1: Given a logged-out user, when they open a shared link, then they see a read-only view and a sign-in prompt (no edit controls).
- AC-2: Given an import file with a duplicate ID, when it is processed, then that row is skipped with a logged warning and the rest of the import succeeds.
- AC-3: Sync completes in under 5s for a 1,000-file dotfile repo on a warm cache.
```

- **Observable.** An implementer or a test can decide pass/fail without asking
  the user again.
- **Covering, not token.** For each significant flow, aim for criteria across
  happy path, permission or role boundary, invalid/empty/boundary input,
  failure and recovery, and the completion or observable outcome. Mark a
  category `N/A` when it does not apply. A single happy-path criterion is the
  failure this skill exists to prevent.
- **Traceable.** Give each an ID (`AC-n`) and reference the flow or concept
  (`FLOW-n`, `CON-n`) and the driving decision (`DEC-n`), so decision → AC →
  plan section is explicit.
- Accumulate them under `## Acceptance Criteria` during the Flush-Out Loop;
  they become the plan's validation section.

## Decision log

A decision log records what was rejected and why, so implementation does not
re-litigate settled questions. Add an entry whenever a real choice is made in
any phase, including Seed and Discovery choices such as audience, primary goal,
non-goals, success definition, and platform constraints.

```
- **DEC-1 — Decision:** [what was chosen]
  - **Alternatives considered:** [the options on the table]
  - **Rationale:** [one line — why this over the others]
  - **Default-if-unspecified:** [for anything you resolved without asking, the default applied]
  - **Validated by:** [AC-n, if the decision drives a behavior]
```

Accumulate under `## Decision Log`; these become the plan's "Key decisions"
section.
