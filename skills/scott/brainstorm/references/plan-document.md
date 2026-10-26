# The Plan Document

The plan is the design doc the code is built from. Two kinds of reader use it
without the brainstorm's memory: the implementer (often an agent in a fresh
session, or one restarting after a crash) and the Goldfish reviewers that gate
it (goldfish.md). Write for them: plain English, every term defined or linked,
and every project file referenced by repo-relative path so it can be opened.

## Header

Start the plan with:

```markdown
# [Feature / project name]

- **Status:** Draft | Approved | Implementing | Implemented
- **Readiness:** passed YYYY-MM-DD at commit `<short sha>` | open findings
  (listed under Open questions) | not run
- **Date:** YYYY-MM-DD
- **Read with:** [repo-relative paths of the files a reader must open to
  understand the current system]
```

Status is the user's approval; Readiness is the Goldfish gate's result
against the code at that commit. They are separate on purpose: a plan can be
approved with open findings, and build-to-complete re-checks readiness against
the current code before building anyway. Build-to-complete moves the status
forward and keeps the document in step with the code as it is built.

## Sections

Let the sections follow from what the brainstorm covered rather than a fixed
template. Candidates:

- Vision / elevator pitch
- Problem statement
- Goals and non-goals
- Target audience
- **Actors & core flows** — the Surface Map: actors and the end-to-end flows
  the thing must support.
- Architecture overview — components and how they fit together, with a block
  diagram where it helps; explanatory prose, not code.
- Components or modules
- **Key decisions (with rationale)** — from the decision log: each decision,
  the alternatives rejected, and why.
- **Alternatives considered** — the approaches ruled out in the Technical
  Proposal, each with why it lost. These are guardrails: an implementer who
  meets a hard spot will otherwise re-propose a rejected design.
- **Edge cases & failure handling** — the non-happy-path behavior the Coverage
  Lenses surfaced: boundaries, empty states, errors, concurrency, migration.
  Keep these explicit; implementers need them.
- **Entity lifecycle** (software plans) — for each main entity: owner, who can
  create, read, update, and delete it, what persists, and any migration,
  backfill, or retention rules. Ambiguity here is a leading cause of failed
  implementations.
- Tech stack with verified current versions
- **Dependencies & sequencing** — prerequisites, blocked-by relationships,
  migration-before-feature constraints, and the MVP cut versus later phases.
  Without this a plan can be validatable yet impossible to schedule.
- Phases or milestones
- Risks and mitigations
- **Assumptions register** — assumptions still in play: the assumption,
  confidence, impact if wrong, and how and when it will be verified, so
  guesses are not mistaken for decisions.
- **Success metrics / Definition of Done** — whether the project as a whole met
  its goal, as distinct from per-feature criteria.
- **Acceptance criteria / validation** — the accumulated criteria, grouped by
  feature or flow, with their IDs.
- **Validation strategy** — how the criteria will be verified: unit,
  integration, end-to-end, or manual checks; fixtures and test data; and the
  observability that confirms behavior in production. The criteria say what
  must be true; this says how it will be proven.
- Open questions
- **Detailed Implementation Plan** (last section, software only) — see below.

## Detailed Implementation Plan

Put this last, under exactly the heading `## Detailed Implementation Plan`,
written from the draft's Technical Proposal. Everything above it is the
feature spec (what and why); this section is how. It follows the
**zero-decision rule**: an implementer who has never seen the brainstorm can
execute it correctly on the first attempt without choosing a schema, an API
shape, a file location, a dependency, an error-handling strategy, or how an
edge case behaves. Any such choice still open is an open question, not an
implementation detail.

- **Phases.** Ordered phases, each leaving the code buildable and testable,
  each naming the acceptance criteria it satisfies.
- **Files.** Within each phase, every file to create, modify, or delete:
  repo-relative path, the action, and the change — new types, function
  signatures, schema fields, config keys, behavior — with a one-line reason.
  Name exact signatures and shapes; leave loop bodies and private helpers to
  the implementer.
- **Tests.** The test files and the specific cases (happy path and the edge
  cases from the lenses), each mapped to its `AC-n`.
- **Verification.** The exact build, lint, test, and end-to-end commands that
  prove each phase, taken from the project, never invented.

A file list is what keeps an implementer on the rails: work outside it is
scope drift, and a listed file left untouched is unfinished work. Build-to-
complete checks the diff against it.

## Mandatory sections

Include these whenever they apply to the domain, even though the rest is
adaptive, because they are what the Flush-Out Loop exists to guarantee:
*Actors & core flows*, *Edge cases & failure handling*, *Key decisions (with
rationale)*, *Dependencies & sequencing*, *Acceptance criteria / validation*,
and *Validation strategy*; for software, also *Alternatives considered* and
the *Detailed Implementation Plan*. Keep the `FLOW`/`CON`/`DEC`/`AC` IDs from
the draft so the trace from decision to criterion to section survives.

## Scope of the plan

The feature spec carries the what and the why: behavior, architecture, edge
cases, and acceptance criteria. The Detailed Implementation Plan carries every
design-level how. What stays with the implementer is code-level only: control
flow inside a function, private helper names, local variables.

## Handoff prompt

When the user chooses "Generate a handoff prompt", output one fenced block
they can paste into a new session, containing:

- A summary of the plan.
- Key decisions and constraints.
- The plan file's path.
- Clear instructions for whoever carries it out:
  - Software: read the plan and every file it references first; implement it
    as written, following the Detailed Implementation Plan exactly; if the
    plan is wrong or impossible, stop and report the conflict instead of
    improvising; the acceptance criteria define done; record any agreed change
    in the plan itself so it stays the source of truth.
  - Anything else: carry out the agreed actions with their owners,
    sequencing, and dependencies; the acceptance criteria and success metrics
    define done; raise conflicts with the plan rather than working around
    them.
- Verified tech-stack versions and compatibility notes.
