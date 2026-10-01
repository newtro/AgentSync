# The Plan Document

## Sections

Let the sections follow from what the brainstorm covered rather than a fixed
template. Candidates:

- Vision / elevator pitch
- Problem statement
- Goals and non-goals
- Target audience
- **Actors & core flows** — the Surface Map: actors and the end-to-end flows
  the thing must support.
- Architecture overview (high level only)
- Components or modules
- **Key decisions (with rationale)** — from the decision log: each decision,
  the alternatives rejected, and why.
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

## Mandatory sections

Include these whenever they apply to the domain, even though the rest is
adaptive, because they are what the Flush-Out Loop exists to guarantee:
*Actors & core flows*, *Edge cases & failure handling*, *Key decisions (with
rationale)*, *Dependencies & sequencing*, *Acceptance criteria / validation*,
and *Validation strategy*. Keep the `FLOW`/`CON`/`DEC`/`AC` IDs from the draft
so the trace from decision to criterion to section survives.

## Scope of the plan

The plan carries the what and the why: behavior, high-level architecture, edge
cases, and acceptance criteria. Leave specific code and low-level
implementation choices to the implementer.

## Handoff prompt

When the user chooses "Generate a handoff prompt", output one fenced block
they can paste into a new session, containing:

- A summary of the plan.
- Key decisions and constraints.
- The plan file's path.
- Clear instructions for the implementing agent, including that the
  acceptance criteria define done.
- Verified tech-stack versions and compatibility notes.
