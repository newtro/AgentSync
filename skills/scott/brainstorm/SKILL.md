---
name: brainstorm
description: Brainstorm an idea through an interactive interview, then produce an actionable plan. Use when the user wants to think through an idea before implementing it.
---

# Brainstorm a Plan

You are running an interactive brainstorming session that moves through six named phases: **Seed, Discovery, Exploration, Expansion, Flush-Out Loop, and Crystallize**. Your goal is to deeply understand an idea through a structured interview, resolve every accepted concept down to real decisions, then produce an actionable plan document.

---

## Core Rules

1. **Always use `AskUserQuestion`** for all questions — never ask freeform questions in text
2. **One question at a time** during Discovery, Exploration, and Expansion phases
3. **User controls pacing** — when you think there's enough info, offer suggestions or ask if the user wants to go deeper, but NEVER auto-advance to Crystallize. The user tells you when they're ready
4. **Announce phase transitions** clearly with the phase name and number (e.g., "**Phase 2: Discovery**")
5. **Be bold in Expansion** — suggest ambitious, unexpected ideas, not just safe/obvious ones
6. **Adaptive everything** — question topics, plan sections, and suggestion categories depend on what's being brainstormed. Not all brainstorms are about software
7. **Never trust training data for package versions** — when libraries, packages, frameworks, or tools come up, always verify current versions, security status, and alternatives using `resolve-library-id` + `query-docs` (Context7) or `WebSearch`. See the [Package & Library Research](#package--library-research) section
8. **Maintain a session transcript** — keep a running chronological log in `.Codex/brainstorms/transcript.md` that captures every interaction verbatim. Update it after **every single step** so nothing is lost, even if the session is interrupted. See [Session Transcript](#session-transcript)
9. **Rigor over speed** — the value of this skill is in what it *forces into the open*, not how fast it reaches a plan. A plan is not done because the user is tired of questions; it's done when the core surface is mapped, the coverage lenses have been applied, and every behavioral decision has an acceptance criterion. Never let an accepted idea reach the plan as a vibe.
10. **Every behavioral decision earns an acceptance criterion** — when a decision describes how the thing *behaves* (not just a preference or a name), capture a testable criterion in `Given / When / Then` form (or a checkable assertion) so the plan can be **validated**, not just built. See [Acceptance Criteria](#acceptance-criteria).
11. **Apply the Coverage Lenses** — the [Coverage Lenses](#coverage-lenses) are the systematic, domain-agnostic checklist that drives the Flush-Out Loop. They are what prevent edge cases and core functionality from going undiscovered. Use them deliberately; do not rely on ad-hoc intuition about "what else to ask."

---

## Session Transcript

The transcript at `.Codex/brainstorms/transcript.md` is a chronological, verbatim record of everything that happens during the brainstorm. Its purpose is to ensure that no idea, detail, or nuance from the conversation is lost — even things that don't make it into the structured draft. The transcript becomes the "source of truth" that the plan is validated against at the end.

### What to log

Every interaction gets a timestamped entry. Log these events:

- **Phase transitions** — which phase started
- **Questions asked** — the exact question text and all options presented
- **User responses** — what the user selected or typed, verbatim
- **Your observations** — any analysis, synthesis, or commentary you offered between questions
- **Research findings** — package lookups, codebase scans, web searches and their results
- **Suggestions offered** — all expansion ideas, noting which were accepted/declined
- **Decisions made** — any explicit decisions or tradeoffs the user confirmed, with the alternatives rejected and the rationale (the Decision Log)
- **Surface Map review** — the mapped actors/flows/entities/boundaries and any corrections the user made
- **Coverage Lens findings** — for each concept/flow, which lenses exposed sub-decisions (and which were marked N/A), plus the acceptance criteria captured
- **Outline review** — the outline shown and any adjustments requested
- **Plan review feedback** — reviewer findings, user responses, and plan updates

### Transcript format

```markdown
# Brainstorm Transcript
**Topic:** [topic]
**Started:** [ISO timestamp]

---

## [HH:MM] Phase 1: Seed
**Asked:** [question text]
**Options:** [list of options if applicable]
**User responded:** [user's response]

**Observation:** [any commentary you provided]

## [HH:MM] Phase 2: Discovery
**Asked:** [question text]
**User responded:** [user's response]

**Research:** Looked up [package] via Context7 — found v4.2.1 is current, v3 deprecated.

...
```

### When to update

Update the transcript file **immediately after each interaction** — do not batch updates. If the session crashes after step 7 of a 10-step discovery, the transcript should contain all 7 completed steps. Write to the file after every `AskUserQuestion` response, every research action, and every phase transition.

---

## Startup: Check for In-Progress Brainstorm

Before anything else, check if a draft file exists at `.Codex/brainstorms/draft.md` (relative to the current working directory).

**If a draft exists:**
- Read the draft file
- Also check for an existing transcript at `.Codex/brainstorms/transcript.md`
- Extract the topic and current phase from the YAML frontmatter
- Ask the user via `AskUserQuestion`:
  - **"I found an in-progress brainstorm about '[topic]'. What would you like to do?"**
  - Option 1: **Resume** — "Continue where we left off in the [phase] phase"
  - Option 2: **Start fresh** — "Discard the draft and start a new brainstorm"
- If resuming: load all collected answers and the transcript, then skip to the appropriate phase
- If starting fresh: delete the draft file and transcript, then proceed normally

**If no draft exists:** proceed to Phase 1.

## Codex Integration Mode Selection (before Phase 1)

Before starting Phase 1 (or immediately after deciding to resume a draft whose frontmatter has no `codexMode` field), ask the user once via `AskUserQuestion` how Codex should participate in this brainstorm.

Codex is a cross-family model accessed via `mcp__codex-bridge__codex_ask`. It can be used for **adversarial review** (Phase 5 Plan Review Loop) and/or **idea contribution** (generating bold suggestions during Exploration and Expansion alongside this agent's own ideas). Because it's a different model family, it tends to surface blind spots and angles same-family thinking rubber-stamps.

**Question to ask: "How should Codex (cross-provider AI) participate in this brainstorm?"**

| Option | Label | What it does |
|--------|-------|--------------|
| 1 | **Both review AND idea contribution (Recommended)** | Codex generates bold ideas alongside me in Exploration/Expansion AND audits the final plan against the transcript |
| 2 | **Review only** | Codex only audits the final plan (Phase 5 review loop). Exploration/Expansion ideas come from me alone. |
| 3 | **Idea contribution only** | Codex contributes ideas in Exploration/Expansion. Plan review uses an in-process Codex subagent. |
| 4 | **Off — don't use Codex** | Plan review uses in-process Codex subagent. Idea contribution comes from me alone. No Codex calls. |

Persist the chosen mode in the draft file's frontmatter as `codexMode: review+ideas | review | ideas | off`. On resume, read it from there instead of re-prompting.

**Codex availability check:** If the user selects any mode involving Codex, invoke `mcp__codex-bridge__codex_status` once before the FIRST Codex call in the session. If it returns `installed: false` or `authStatus !== 'logged_in'`, surface the warning via `AskUserQuestion` and offer to fall back (e.g., to "Off" or "Review only" with in-process). Do not silently proceed without auth.

### Reviewer dispatch helpers

Every reviewer call in Phase 5 Step 5 (5a, 5c, and the repeat cycles) MUST go through the dispatch helper that matches the chosen `codexMode`. Modes `review` and `review+ideas` use Codex for review; modes `ideas` and `off` use the in-process Codex subagent.

**Dispatch: in-process Codex subagent** (used when `codexMode` is `ideas` or `off`)

- Tool: `Agent` with `subagent_type: "general-purpose"`.
- Pass the self-contained reviewer prompt from Step 5a verbatim.

**Dispatch: Codex** (used when `codexMode` is `review` or `review+ideas`)

- Tool: `mcp__codex-bridge__codex_ask`.
- Pass the entire Step 5a reviewer prompt as the Codex `prompt` argument.
- Pass `context_files: [<transcript path>, <plan path>]` so Codex reads both documents directly.
- Pass `working_directory` to the project root if one exists, otherwise omit.
- Codex returns text in the same shape (a list of gaps OR the literal `PLAN_COMPLETE` sentinel).
- If the call returns an MCP `isError: true` result (`CODEX_NOT_AUTHENTICATED`, `CODEX_RATE_LIMITED`, `CODEX_TIMEOUT`, `CODEX_FAILED`), surface the error and either fall back to in-process review for this cycle or pause and ask the user how to proceed. Do not treat an errored response as `PLAN_COMPLETE`.

### Idea-contribution dispatch helper

Used when `codexMode` is `ideas` or `review+ideas`. Called from Phase 3 (Exploration) and Phase 4 (Expansion) to gather Codex's bold ideas alongside this agent's own.

- Tool: `mcp__codex-bridge__codex_ask`.
- Pass `context_files: [<transcript path>, <draft path>]` so Codex sees the full conversation context.
- Pass `working_directory` to the project root if one exists, otherwise omit.
- Prompt template (substitute `{PHASE}`, `{TOPIC}`, `{GUIDANCE}` per call site — see Phase 3 and Phase 4 for the exact values to use):

  ```
  You are contributing creative ideas to an interactive brainstorm session about: {TOPIC}

  The full session transcript and current draft are attached as context files. Read them to understand the goals, constraints, decisions, and ideas discussed so far.

  Current phase: {PHASE}

  Your task: Generate 4-6 bold, specific, non-obvious ideas/perspectives appropriate for this phase. Ground each idea in something from the transcript (a stated goal, constraint, or prior decision). Avoid generic suggestions the user has obviously already considered. Prefer ideas that stretch beyond the obvious.

  {GUIDANCE}

  Output format: A numbered list. For each item:
  1. **Headline** (one sentence, concrete and specific)
     Why it fits this brainstorm: 1-2 sentences referencing the transcript context.

  Do not include preamble, summary, or closing remarks — just the numbered list.
  ```

- On `isError: true`: log the failure to the transcript, fall back to this agent's ideas alone for that phase round, and surface the failure to the user before presenting suggestions.
- On success: parse the numbered list. Merge with this agent's own ideas, deduplicate by similarity of the headline, and tag each merged idea with provenance (`[Codex]`, `[codex]`, or `[both]` when both produced the same idea independently).

---

## Argument Handling

The user's input after `/brainstorm` is available as `$ARGUMENTS`.

- If `$ARGUMENTS` is provided: use it as the brainstorm topic seed and proceed to Phase 1 with context
- If `$ARGUMENTS` is empty: ask the user what they want to brainstorm in Phase 1

---

## Phase 1: Seed

**Announce: "Phase 1: Seed"**

Goal: Capture the initial idea.

**If topic was provided via `$ARGUMENTS`:**
- Briefly restate your understanding of the topic
- Ask ONE clarifying question via `AskUserQuestion` to confirm direction

**If no topic was provided:**
- Ask via `AskUserQuestion`: "What would you like to brainstorm?" with broad category options:
  - "A new feature or product"
  - "A technical architecture or system design"
  - "A process or workflow"
  - "Something else entirely"
- Follow up to capture the specific idea

**After capturing the seed:**

1. Create the draft file at `.Codex/brainstorms/draft.md`:

```markdown
---
topic: "[The brainstorm topic]"
phase: "seed"
started: "[ISO timestamp]"
---

## Seed
[Initial idea captured here]
```

2. Create the transcript file at `.Codex/brainstorms/transcript.md` and log the phase transition, the seed question, and the user's response.

---

## Phase 2: Discovery

**Announce: "Phase 2: Discovery"**

Goal: Understand goals, context, and motivation.

- Ask ONE question at a time using `AskUserQuestion`
- Topics are **fully adaptive** — pick questions relevant to this specific brainstorm. Examples:
  - Goals and desired outcomes
  - Target audience or users
  - Motivation / what prompted this idea
  - Existing systems or prior art
  - Key requirements or must-haves
  - Success criteria
- **Codebase awareness**: If the topic seems related to the current project, use the `Task` tool with `subagent_type="Explore"` to scan the codebase for relevant patterns, existing implementations, and tech stack. Ground your questions in what you find
- Naturally ask "Are there any existing docs, files, or references I should look at?" when relevant

**After each answer:**
- Append the Q&A to the draft file under `## Discovery` and update the `phase` field
- Append to the transcript: the question asked, options presented, the user's response, and any observations or research you conducted

---

## Phase 3: Exploration

**Announce: "Phase 3: Exploration"**

Goal: Dig into details, constraints, alternatives, and tradeoffs.

- Continue asking ONE question at a time via `AskUserQuestion`
- Topics adapt based on what was learned in Discovery. Examples:
  - Constraints (technical, time, budget, scope)
  - Alternative approaches considered
  - Tradeoffs the user is willing to make
  - Dependencies or integration points
  - Edge cases or potential risks
  - Non-goals (what is explicitly out of scope)

### Codex angle contribution (if `codexMode` includes ideas)

Once per Exploration phase, after 2-3 exploration questions have been answered and the shape of the problem is clear, call the [Idea-contribution dispatch helper](#idea-contribution-dispatch-helper) to ask Codex for alternative angles the agent may have missed. Use these values for the prompt:

- `{PHASE}`: `Exploration — surfacing alternative angles, tradeoffs, and considerations`
- `{TOPIC}`: the brainstorm topic from the draft frontmatter
- `{GUIDANCE}`: `Focus on angles, tradeoffs, constraints, edge cases, or non-goals that the user has NOT been asked about yet but that matter for this kind of project. Be specific about the failure mode or decision each idea unlocks.`

Present Codex's suggestions to the user via `AskUserQuestion` (multiSelect) framed as "Codex flagged these angles I hadn't asked about — which are worth exploring?" Each option's `description` should reference the Codex justification. For accepted angles, ask the corresponding follow-up question(s) before continuing. Decline = note in the transcript and move on.

If `codexMode` is `review` or `off`, skip this subsection entirely.

**After each answer:**
- Append to the draft file under `## Exploration` and update the phase
- Append to the transcript: the question, options, user's response, and any research or analysis. If Codex was called, log the full Codex response and which suggestions the user accepted/declined

---

## Phase 4: Expansion

**Announce: "Phase 4: Expansion"**

Goal: Elevate the idea with bold, creative suggestions.

### Generate this agent's ideas

- Brainstorm 3-4 bold suggestions internally before asking Codex
- Be **bold and ambitious** — include ideas that stretch beyond the original vision, not just incremental improvements
- Ground each in something specific from the Discovery/Exploration transcript

### Codex idea contribution (if `codexMode` includes ideas)

For each Expansion round (not just the first), call the [Idea-contribution dispatch helper](#idea-contribution-dispatch-helper) in parallel with composing this agent's own ideas. Use these values for the prompt:

- `{PHASE}`: `Expansion — bold ideas that stretch the original vision`
- `{TOPIC}`: the brainstorm topic from the draft frontmatter
- `{GUIDANCE}`: `Suggest features, capabilities, monetization angles, differentiation plays, or stretch goals that go BEYOND the obvious next steps. Avoid ideas already accepted or declined in prior rounds (check the draft's Expansion section). Bias toward ideas that exploit something specific from the transcript (a constraint, a chosen technology, a stated user pain).`

### Merge and present

- Combine this agent's ideas with Codex's. Deduplicate by headline similarity — if both produced essentially the same idea, tag it `[both]`.
- Tag each remaining idea `[Codex]` or `[codex]` (visible to the user in the option `description`).
- Present 4-6 merged suggestions per round via `AskUserQuestion` with `multiSelect: true`.
- After each round, ask if the user wants more suggestions or is ready to move on:
  - Option 1: "Show me more ideas"
  - Option 2: "I'm ready to create the plan"

If `codexMode` is `review` or `off`, skip the Codex call and present this agent's ideas alone (no provenance tags needed).

**After each round:**
- Append accepted/declined suggestions to the draft file under `## Expansion`, preserving provenance tags
- Append to the transcript: all suggestions presented (with provenance), the full Codex response if called, which ones the user accepted/declined, and any comments the user made

**Continue offering suggestions until the user chooses to move on.**

---

## Phase 4.5: Flush-Out Loop

**Announce: "Phase 4.5: Flush-Out Loop"**

Goal: **Never take an accepted concept at face value, and never assume the core surface is fully known.** Each idea accepted during Seed/Exploration/Expansion hides unresolved sub-decisions, and the brainstorm so far has almost certainly mapped only the *interesting* parts of the system — not its full functional surface. This phase first maps that surface, then systematically drives every concept through the [Coverage Lenses](#coverage-lenses) to resolve hidden sub-decisions and capture acceptance criteria *before* writing the plan.

Do NOT skip this phase, and do NOT short-circuit it. This is the single most important phase for producing plans that are implementable and validatable. Most plan-review rework — and most "we never thought about that" implementation surprises — trace back to a surface that was never mapped or a concept that was accepted but never run through the lenses. Run at least one full pass (Steps 1–5) even when the brainstorm "feels done."

### Step 1: Surface Map (do this first, before any sub-decisions)

Before flushing out individual concepts, map the **full functional surface** so core functionality can't go undiscovered. Build and record (under `## Surface Map` in the draft) — using the codebase as ground truth where relevant (`subagent_type="Explore"`):

1. **Actors / roles** — every kind of user, system, or agent that interacts with this. For software, include unauthenticated/guest, admin, background jobs, and external systems.
2. **Core flows / use cases (the spine)** — the end-to-end paths the thing *must* support, written as short verb phrases ("user creates X", "system reconciles Y nightly"), each tagged with an ID (`FLOW-1`, `FLOW-2`, …). Don't list only happy paths — deliberately enumerate across these flow categories so non-obvious flows become first-class (and therefore get lens coverage): **primary user flows, admin/ops flows, background/system/scheduled flows, recovery/error flows, onboarding/setup flows, and teardown/lifecycle flows.** Aim for breadth of flows here, not depth yet.
3. **Entities / state** — the main things that get created, read, updated, deleted, or persisted, and who owns them.
4. **Boundaries** — what this explicitly does NOT do, and what external systems/services it depends on.
5. **Accepted-concepts inventory** — an explicit list of every concept the user accepted across Seed/Discovery/Exploration/Expansion (not just flows: include accepted constraints, non-goals, requirements, and Expansion ideas), each marked `accepted / deferred / rejected` and tagged with an ID. This is the checklist the lens pass runs against, alongside the core flows — it's what keeps an accepted constraint or expansion idea from being silently dropped because it "isn't a flow."

Then present the Surface Map back to the user via `AskUserQuestion`: **"Here's the full surface I've mapped. Is anything missing or mis-scoped?"** with options like "Looks complete", "Missing flows/actors (I'll tell you)", "Some of this is out of scope". Reconcile before proceeding. A gap caught here is a whole feature saved from being undiscovered.

### Step 2: Drive each concept (and each core flow) through the Coverage Lenses

First, **pick a depth tier** for this brainstorm (record it in the draft) so the lens pass is proportional to the stakes — the goal is rigor, not a 50-question slog:
- **Light** — small, low-risk, or non-software ideas. Apply only the lenses that obviously matter; resolve most findings yourself.
- **Standard** (default) — ordinary features/systems. Walk all lenses, but route only genuine design decisions to the user.
- **Deep** — high-risk, security-sensitive, or architecturally central systems. Walk all lenses for every item and be exhaustive.

For every accepted concept (from the inventory) AND every core flow from the Surface Map, walk the [Coverage Lenses](#coverage-lenses). For each lens, write down the **open sub-decisions** it exposes, and **classify each finding**:
- `blocker` — would block or mislead an implementer; must be resolved before crystallizing.
- `important` — a real design decision affecting UX/behavior; route to the user.
- `implementation-default` — has an obvious sensible default with no UX/design consequence; resolve it yourself and record the default.
- `N/A` — lens doesn't apply to this item; note it as N/A rather than silently skipping.

You must *consciously consider each lens* (marking N/A is fine; skipping silently is not). This deliberate, classified pass is what surfaces edge cases the ad-hoc approach misses while keeping the user's attention budget for decisions that actually need them.

Record the enumerated open sub-decisions (with their classification and IDs) under `## Flush-Out Pass` before resolving them, so the backlog is visible even if the session is interrupted.

**Batching policy (applies to all Phase 4.5 user questions):** Ask **one at a time** only when a choice is high-impact, irreversible, or its options depend on the previous answer. Otherwise **batch up to 4 related low-/medium-risk decisions** per `AskUserQuestion` call. Never surface `implementation-default` or `N/A` findings as questions — resolve them silently and log the default. This is what prevents the lens pass from becoming death-by-questionnaire.

### Step 3: Resolve sub-decisions, one at a time

For each open sub-decision classified `blocker` or `important`, ask the user via `AskUserQuestion`, following the **batching policy** from Step 2 (one-at-a-time for high-impact/irreversible/dependent choices; batch up to 4 related lower-risk ones otherwise). Best practices:
- **Propose sensible defaults.** Make the recommended option first and label it; include a "Recommend one" / "Not sure — recommend one" option so the user can delegate the call. When the user asks for a recommendation, give a clear one *with reasoning*, then confirm.
- **Resolve `implementation-default` / trivial sub-decisions yourself.** Not every lens finding deserves a question. If the answer is an obvious default with no UX/design consequence, record the default in the draft and move on — reserve the user's attention for genuine decisions. (When genuinely unsure whether something is a real design decision, batch it into the next question rather than asking standalone.)
- **Ground in the codebase.** If a concept touches existing code, read the relevant files first so options reflect reality (and so you catch contradictions — e.g. "this concept removes a system that currently exists").
- **Capture an acceptance criterion.** For any decision that describes a *behavior*, record a testable [Acceptance Criteria](#acceptance-criteria) entry (`Given / When / Then`) alongside the decision. This is non-negotiable for behavioral decisions — it's what makes the plan validatable.
- **Capture the decision-log entry.** Record the chosen option, the alternatives considered, and the one-line rationale (see [Decision Log](#decision-log)). A decision without its rejected alternatives invites re-litigation during implementation.
- **Surface contradictions immediately.** If an answer rejects or replaces an existing mechanic or an earlier decision, record the rejection and the replacement explicitly, and update any earlier draft notes that now conflict.
- **Record after every answer** — append to the draft (under `## Flush-Out Pass`, `## Acceptance Criteria`, `## Decision Log` as appropriate) and to the transcript. Note any newly-spawned sub-systems or follow-ups the answer creates.

Accept that flush-out answers often **change scope**: deferring sub-features, rejecting accepted ideas, or spawning entirely new concepts (which themselves get mapped into the Surface Map and run through the lenses). That's the point.

### Step 4: Completeness check (critic pass)

Once the lens-driven sub-decisions are resolved, run a **completeness critic** to find what you still missed.

- Dispatch: if `codexMode` includes review (`review` or `review+ideas`), use `mcp__codex-bridge__codex_ask` with `context_files: [<draft>, <transcript>]`; otherwise use an in-process `Agent` (`subagent_type: "general-purpose"`).
- Give the critic the [Coverage Lenses](#coverage-lenses) as its checklist. Ask it to identify the top unresolved **gaps, ambiguities, or contradictions that would block or mislead an implementer**, organized by lens, with special attention to:
  - **Undiscovered core functionality** — flows or actors implied by the accepted concepts but absent from the Surface Map.
  - **Edge & boundary cases** — empty/zero/one/max/duplicate/simultaneous/out-of-order states.
  - **Failure modes** — what happens on error, timeout, partial failure, conflict; idempotency, retries, rollback.
  - **Interactions & contradictions** — newly-added mechanics that conflict with each other or with existing systems.
  - **Lifecycle & migration** — creation/deletion, backward-compatibility, in-progress/legacy state.
  - **Termination / success conditions** — how the thing ends, wins, completes, or is considered done.
  - **Missing acceptance criteria** — behavioral decisions recorded without a way to validate them.
- **Triage the findings:** resolve **technical/implementation gaps** yourself by recording a sensible default in the draft (no need to ask). Route genuine **design decisions** (ones that change the user experience or that you can't infer) to the user via `AskUserQuestion`, batching up to 4 related decisions per call. Add acceptance criteria for any newly-resolved behavior.

### Step 5: Loop until dry

After resolving the critic's findings, ask the user via `AskUserQuestion` whether anything else needs flushing out:
- Option 1: "Looks fully flushed out — crystallize"
- Option 2: "More to flush out" (then continue Steps 2–4)

Repeat Steps 2–5 until the user confirms it's fully flushed out AND the critic returns no high-severity gaps. Only then proceed to Phase 5. (The Phase 5 outline-confirm step should also offer a "More to flush out" escape hatch back to this phase.)

---

## Coverage Lenses

These are the systematic, domain-agnostic checklist that drives the Flush-Out Loop (Phase 4.5). For each accepted concept and each core flow, consciously consider **every** lens — resolve the sub-decisions it exposes, or explicitly mark it N/A. This deliberate pass is what keeps edge cases and core functionality from going undiscovered. Adapt the language to the domain; not every lens fits every brainstorm, but skipping a lens should be a decision, not an oversight.

> Some of these topics (constraints, non-goals, edge cases, tradeoffs) are also touched in Discovery/Exploration. That overlap is intentional and not redundant: earlier phases collect broad intent *opportunistically*, while Phase 4.5 is the **mandatory, systematic coverage pass** that verifies nothing fell through. Don't skip a lens just because the topic came up earlier — confirm it's actually resolved.

1. **Actors & permissions** — Who can do this, and to whom/what? What roles exist? Is it symmetric (does it apply to all actor types, or just some)? What requires authentication/authorization? Who can do it to *whom* — and what stops the wrong actor?
2. **Triggers & preconditions** — What initiates this? What state must exist first? Are there thresholds, cooldowns, rate limits, or frequency caps?
3. **Inputs & validation** — What data/parameters come in? What are valid ranges and formats? What's required vs optional? What happens on malformed, missing, or hostile input?
4. **Core flow (happy path)** — What is the precise success sequence, end to end? Is every step actually specified, or are there hand-waves?
5. **State, lifecycle & data model** — What entities exist, and what are their relationships, identity, ownership, and cardinality? How are they created, updated, and deleted? What's the source of truth? What persists vs is ephemeral?
6. **Edge & boundary cases** — Empty, zero, one, many, max. Duplicates. Simultaneous occurrences. Out-of-order events. The first time and the last time. What's the behavior at every boundary?
7. **Failure modes & recovery** — What happens on error, timeout, partial failure, or conflict? Is the operation idempotent? Are there retries, rollbacks, compensating actions? What state is left behind after a failure?
8. **Concurrency & ordering** — Can two actors do this at once? Are there race conditions, locking needs, or ordering guarantees?
9. **Scale & performance** — Expected volume now and growth over time. Limits, pagination, batching, cost. What breaks at 10x or 100x?
10. **Interactions & side effects** — How does this touch existing systems and other accepted concepts? What does it *replace or contradict*? What cascades when it fires?
11. **Termination & success conditions** — How does this end, complete, win, or get marked done? What's the steady state? Is there cleanup?
12. **Migration & backward compatibility** — What happens to existing data, in-progress state, or legacy behavior when this ships? Is a migration needed?
13. **Security, privacy & abuse** — Sensitive data handling. Abuse/exploit vectors. What's the worst a malicious actor could do with this?
14. **Observability & validation** — How do we *know* it worked? What's the acceptance criterion? How will it be tested or verified? What should be logged/measured?
15. **UX & error surfacing** — How is this surfaced to the user, including the unhappy paths? What does the user see on success, on error, on empty, while waiting?

---

## Acceptance Criteria

Acceptance criteria are what make the plan **validatable** rather than merely buildable. Every decision that describes a *behavior* (as opposed to a naming/styling preference or a pure implementation default) must carry at least one testable criterion.

Write them in `Given / When / Then` form, or as a plainly checkable assertion:

```
- AC: Given a logged-out user, when they open a shared link, then they see a read-only view and a sign-in prompt (no edit controls).
- AC: Given an import file with a duplicate ID, when processed, then the row is skipped and a warning is logged; the rest of the import succeeds.
- AC: Sync completes in < 5s for a 1,000-file dotfile repo on a warm cache.
```

Rules:
- Each criterion must be **observable** — phrased so an implementer (or a test) can check pass/fail without re-asking the user.
- **Cover the categories, not just one criterion.** For each significant flow, don't stop at "at least one" AC — aim for coverage across: **happy path, permission/role boundary, invalid/empty/boundary input, failure & recovery, and completion/observable outcome.** Mark a category `N/A` explicitly when it doesn't apply rather than leaving it unwritten — a single happy-path AC is the failure mode this skill exists to prevent.
- **Traceability.** Give each criterion an ID (`AC-1`, `AC-2`, …) and reference the flow/concept (`FLOW-n`) and any driving decision (`DEC-n`) it validates, so the chain decision → AC → plan section is explicit.
- Accumulate them in the draft under `## Acceptance Criteria` during Flush-Out; they flow directly into the plan's validation section.

---

## Decision Log

A decision log records not just *what* was decided but *what was rejected and why*, so implementation doesn't re-litigate settled questions. Capture an entry whenever a real choice is made in **any phase** — including Seed/Discovery decisions like target audience, primary goal, non-goals, success definition, and platform constraints, not just Exploration/Expansion/Flush-Out.

Format per entry (tag each with an ID for traceability):

```
- **DEC-1 — Decision:** [what was chosen]
  - **Alternatives considered:** [the options that were on the table]
  - **Rationale:** [one line — why this over the others]
  - **Default-if-unspecified:** [for anything resolved by the agent without asking, the default that was applied]
  - **Validated by:** [AC-n, if this decision drives a behavior]
```

Accumulate under `## Decision Log` in the draft. These flow into the plan's "Key decisions" section, giving the implementer the *why* behind each constraint.

---

## Phase 5: Crystallize

**Announce: "Phase 5: Crystallize"**

Goal: Produce the final plan document.

### Step 1: Quick Confirm

Show the user a brief outline of what the plan will cover (section headings with a 1-liner each). Present via `AskUserQuestion`:
- Option 1: "Looks good, write it"
- Option 2: "I want to adjust the outline"
- Option 3: "More to flush out" — escape hatch back to **Phase 4.5: Flush-Out Loop** if a concept still feels under-specified

If adjusting, iterate until the user approves. If "More to flush out," return to Phase 4.5.

### Step 2: Choose Save Location

Ask via `AskUserQuestion` where to save the plan file:
- Option 1: `.Codex/plans/` directory
- Option 2: A `docs/` or `plans/` folder in the current project
- Option 3: "Let me specify a custom path"

### Step 3: Research Before Writing

Before writing the plan, if the brainstorm involved any technology choices:
- Run the [Package & Library Research](#package--library-research) process for every library, framework, or tool that was discussed
- Include verified version numbers, compatibility notes, and any security advisories in the plan
- Flag anything from the brainstorm that conflicts with current reality (e.g., deprecated APIs, renamed packages, breaking changes in newer versions)

### Step 4: Write the Plan

Generate the plan file with **adaptive sections** based on what was discussed. Do NOT use a rigid template. Sections should emerge naturally from the brainstorm content. Possible sections include (but are not limited to):

- Vision / elevator pitch
- Problem statement
- Goals and non-goals
- Target audience
- **Actors & core flows** — the Surface Map: who the actors are and the primary end-to-end use cases the thing must support
- Architecture overview (high-level only)
- Components or modules
- **Key decisions made (with rationale)** — derived from the [Decision Log](#decision-log): each decision, the alternatives rejected, and why
- **Edge cases & failure handling** — the non-happy-path behaviors surfaced by the [Coverage Lenses](#coverage-lenses) (boundaries, empty states, errors, concurrency, migration). Do not bury these; an implementer needs them explicit.
- **Entity lifecycle** (software plans) — for each main entity: owner, who can create/read/update/delete it, what persists, and any migration/backfill/retention rules. Entity ambiguity is a top implementation-failure source.
- Tech stack with verified current versions
- **Dependencies & sequencing** — prerequisites and blocked-by relationships between features, migration-before-feature constraints, and the MVP cut vs. later phases. A plan can be validatable yet impossible to schedule without this.
- Phases or milestones
- Risks and mitigations
- **Assumptions register** — assumptions still in play (not yet verified decisions): the assumption, confidence, impact if wrong, and how/when it'll be verified. Keeps implementers from mistaking guesses for decisions.
- **Success metrics / Definition of Done** — the higher-level criteria for whether the project achieved its goal (distinct from per-feature acceptance criteria below).
- **Acceptance criteria / validation** — the accumulated [Acceptance Criteria](#acceptance-criteria), grouped by feature/flow with their IDs, so the build can be validated. Mandatory whenever the plan describes behavior.
- **Validation strategy** — *how* the acceptance criteria get verified: which need unit/integration/e2e/manual checks, required fixtures/test data, and observability/metrics to confirm behavior in production. ACs say *what* must be true; this says *how you'll prove it*.
- Open questions

**Mandatory sections** (when applicable to the domain): *Actors & core flows*, *Edge cases & failure handling*, *Key decisions (with rationale)*, *Dependencies & sequencing*, *Acceptance criteria / validation*, and *Validation strategy*. These are exactly what the enrichment exists to guarantee — do not drop them just because the section template is "adaptive." Preserve the `FLOW/DEC/AC` IDs from the draft so traceability survives into the plan.

**Important:** The plan guides the "what" and "why." The implementation agent handles the "how." Include high-level architecture, behaviors, edge cases, and acceptance criteria — but stay away from specific code or low-level implementation details.

### Step 5: Plan Review Loop

After the plan is written, launch a reviewer agent to validate it against the full transcript. This ensures nothing discussed during the brainstorm was lost or overlooked in the final plan.

**5a. Launch the reviewer**

Dispatch through the [Reviewer dispatch helpers](#reviewer-dispatch-helpers) based on the chosen `codexMode`. The prompt below is used verbatim for the in-process Codex backend, and passed as the `prompt` argument to the Codex backend:

```
You are a plan reviewer. You have two documents:

1. **Transcript** (the complete brainstorm session log): [path to transcript.md]
2. **Plan** (the output plan document): [path to plan file]

Read both documents carefully. Your job is to find anything discussed in the transcript that is missing from or inadequately covered in the plan. This includes:

- Requirements, goals, or constraints the user stated that aren't reflected in the plan
- Decisions or tradeoffs the user confirmed that aren't documented (with their rationale / rejected alternatives)
- Ideas the user accepted during Expansion that don't appear in the plan
- Research findings (package versions, security issues, alternatives) that should be in the plan
- Edge cases, risks, or non-goals the user mentioned that were omitted
- Any nuance or context from the user's responses that was lost in translation

Additionally, audit the plan for **implementation/validation readiness** (not just transcript fidelity):

- **Surface coverage** — Does every actor and core flow in the transcript's Surface Map appear in the plan? Are there flows implied by the accepted concepts but absent entirely?
- **Edge cases & failure modes** — For each significant feature, are boundary states, error/failure handling, and concurrency addressed, or only the happy path?
- **Acceptance criteria** — Does every behavioral feature have at least one observable, testable acceptance criterion? Flag behaviors that can't be validated as written.
- **Decision rationale** — Are key decisions recorded with the alternatives rejected and why, so they won't be re-litigated during implementation?
- **Contradictions** — Does any part of the plan conflict with another, or with an existing system noted in the transcript?

For each gap found, provide:
- **What's missing**: A clear description of what was discussed but not captured
- **Where in transcript**: Reference the relevant part of the transcript
- **Suggested addition**: How and where it should be added to the plan

If the plan fully covers everything in the transcript, respond with: "PLAN_COMPLETE: The plan accurately captures all topics discussed in the brainstorm session."

Be thorough but fair — the plan is a distillation, not a transcript copy. Focus on substantive omissions, not minor wording differences.
```

**5b. Process the reviewer's findings**

- **If the reviewer responds with "PLAN_COMPLETE":** The review loop is done. Log the successful review in the transcript and proceed to Step 6.

- **If the reviewer found gaps:** For each gap identified, present the finding to the user via `AskUserQuestion`:
  - Show what the reviewer found was missing and the suggested addition
  - Options:
    - **"Yes, add this to the plan"** — you agree this was missed
    - **"No, skip this"** — intentional omission or not important enough
    - **"Modify the suggestion"** — the reviewer is right that something's missing, but the suggested fix needs tweaking (follow up to get the user's preferred wording)

- **After processing all gaps:** Update the plan file with the approved additions. Log all reviewer findings and user decisions in the transcript.

**5c. Re-review**

After updating the plan, dispatch the reviewer again via the same dispatch helper for the chosen `codexMode`. This catches any issues introduced by the edits and ensures nothing else was missed now that the plan has changed.

**Repeat steps 5a-5c** until the reviewer returns "PLAN_COMPLETE."

The review loop is deliberately thorough — it's the safety net that makes sure the brainstorm's value isn't lost in translation. Most brainstorms should converge in 1-2 review rounds.

### Step 6: Display Summary

Show a concise summary of the plan in chat. Mention that the plan was validated against the session transcript.

### Step 7: Completion Options

Present via `AskUserQuestion`:
- **Option 1: "Begin implementation"** — Start implementing the plan in the current session
- **Option 2: "Generate a handoff prompt"** — Output a copy/paste prompt block for another AI session

**If Begin implementation:** Read the plan file and begin working through the implementation.

**If Generate handoff prompt:** Output a well-structured prompt block in a code fence that includes:
- The plan summary
- Key decisions and constraints
- Reference to the plan file path
- Clear instructions for the implementing agent
- Verified tech stack versions and any compatibility notes

Display it in chat so the user can copy/paste into a new session.

### Step 8: Cleanup

Delete the draft file at `.Codex/brainstorms/draft.md` and the transcript at `.Codex/brainstorms/transcript.md`.

---

## Package & Library Research

**CRITICAL: Never rely on training data for package versions, compatibility, or security status.** Training data goes stale and can lead to choosing vulnerable or deprecated packages.

### When to Trigger

Activate this process whenever the brainstorm involves:
- Choosing between libraries or frameworks
- Specifying a tech stack
- Discussing dependencies or integrations
- Mentioning any specific package by name

### How to Research

For each library, package, or framework discussed:

1. **Use Context7 first:**
   - Call `resolve-library-id` with the library name to get the Context7 ID
   - Call `query-docs` to retrieve current documentation, latest version info, and usage patterns

2. **Use `WebSearch` for supplementary info:**
   - Search for `"[package name] latest version 2026"` to confirm current stable release
   - Search for `"[package name] security vulnerabilities"` or `"[package name] CVE"` to check for known issues
   - Search for `"[package name] vs [alternative]"` when comparing options

3. **What to capture and include in the plan:**
   - Current stable version number
   - Last release date (to gauge maintenance activity)
   - Any known security advisories or deprecation notices
   - Breaking changes between major versions
   - License type
   - Compatibility with other chosen packages

4. **Red flags to surface to the user:**
   - Package hasn't been updated in 12+ months
   - Known unpatched CVEs
   - Package has been deprecated in favor of an alternative
   - Major version upgrade required that introduces breaking changes
   - License incompatibility with the project

### During the Interview

When the user mentions a specific package or library during any phase:
- Quietly research it in the background using Context7 and/or WebSearch
- If you discover something important (deprecated, vulnerable, better alternative exists), bring it up in the next question
- Frame it as helpful context, not a correction: "I looked into [package] and found that v4 was released last month with breaking changes to the API you mentioned. Worth considering?"

---

## Draft File Format

The draft file at `.Codex/brainstorms/draft.md` tracks all progress for pause/resume:

```markdown
---
topic: "The brainstorm topic"
phase: "discovery"
started: "2026-02-08T14:30:00"
codexMode: "review+ideas"  # or "review" or "ideas" or "off"
---

## Seed
[Initial idea captured]

## Discovery
### Q: [question asked]
A: [user's answer]

### Q: [question asked]
A: [user's answer]

## Exploration
### Q: [question asked]
A: [user's answer]

## Expansion
### Suggestions Offered
- [x] Suggestion user accepted
- [ ] Suggestion user declined
- [x] Suggestion user accepted

### Round 2
- [x] Another accepted suggestion

## Surface Map
**Depth tier:** Light | Standard | Deep

### Actors / roles
- [actor] — [what they do / their permissions]

### Core flows (the spine)
- FLOW-1 [category] [actor] [verb phrase] — [1-line description]

### Entities / state
- [entity] — owned by [x]; created/updated/deleted by [y]; persisted: [yes/no]

### Boundaries
- Out of scope: [...]
- External dependencies: [...]

### Accepted-concepts inventory
- CON-1 [concept] — accepted | deferred | rejected — source: [Discovery/Expansion/...]

## Flush-Out Pass
### [CON-n / FLOW-n]: open sub-decisions from the lenses
- [ ] [lens] → [sub-decision] — class: blocker | important | implementation-default | N/A
- [x] [lens] → [sub-decision] — Decision: [resolved] (DEC-n; AC-n if behavioral)
Notes: [contradictions surfaced / new sub-systems spawned / deferred items / lenses marked N/A]

### Completeness check ([Codex/in-process] critic)
- Findings by lens: [...]
- Technical gaps resolved with defaults: [...]
- Design decisions routed to user: [...]

## Acceptance Criteria
### [FLOW-n / CON-n]
- AC-1 [happy] Given [...], when [...], then [...].  (validates DEC-n)
- AC-2 [boundary/permission/failure] Given [...], when [...], then [...].

## Decision Log
- **DEC-1 — Decision:** [what was chosen]
  - **Alternatives considered:** [options on the table]
  - **Rationale:** [why this one]
  - **Default-if-unspecified:** [default applied without asking, if any]
  - **Validated by:** [AC-n, if behavioral]

## Assumptions Register
- ASM-1 [assumption] — confidence: high/med/low — impact if wrong: [...] — verify by: [how/when]

## Research Notes
### [Package Name]
- Current version: x.y.z
- Last updated: [date]
- Notes: [any relevant findings]
```

---

## Example Session

```
User: /brainstorm build a CLI tool for managing dotfiles

Agent: **Phase 1: Seed**
I understand you want to brainstorm a CLI tool for managing dotfiles —
syncing config files across machines, version controlling them, etc.

[AskUserQuestion: "What's the primary pain point this tool should solve?"]
User selects: "Keeping configs in sync across multiple machines"

Agent: [Creates draft file, transitions to Phase 2]

Agent: **Phase 2: Discovery**
[AskUserQuestion: "How many machines do you typically keep in sync?"]
User selects: "2-3 (work laptop, personal desktop, server)"

[AskUserQuestion: "Do you currently use any dotfile management approach?"]
User selects: "Git bare repo, but it's clunky"

[... more discovery questions ...]

Agent: **Phase 3: Exploration**
[AskUserQuestion: "What's more important: simplicity or flexibility?"]
User selects: "Simplicity — I want it to just work"

[Researches current CLI framework options via Context7]
[AskUserQuestion: "I looked into CLI frameworks — Commander.js v13 and
 oclif v4 are both actively maintained. Any preference on language/runtime?"]
User selects: "Node.js / TypeScript"

[... more exploration questions ...]

Agent: **Phase 4: Expansion**
[AskUserQuestion multiSelect: Here are some ideas to elevate this tool:]
- "Machine profiles — auto-apply different configs per device type"
- "Secret management — encrypt sensitive values in dotfiles"
- "Plugin system — community recipes for popular tools"
- "Diff preview — show what would change before syncing"
User selects: Machine profiles, Diff preview

[AskUserQuestion: "Want more ideas, or ready to create the plan?"]
User selects: "I'm ready to create the plan"

Agent: **Phase 5: Crystallize**
[Researches all mentioned packages for current versions/security]
[Shows outline, user confirms]
[Asks save location]
[Writes plan file with verified tech stack versions]

[Launches reviewer agent to compare plan against transcript]
Reviewer: "The transcript mentions the user wants symlink support on
 Windows, but the plan doesn't address Windows-specific behavior."

[AskUserQuestion: "The reviewer found a gap — you mentioned Windows
 symlink support during Discovery. Should I add this to the plan?"
 Options: "Yes, add this" / "No, skip this" / "Modify the suggestion"]
User selects: "Yes, add this"

[Updates plan, re-launches reviewer]
Reviewer: "PLAN_COMPLETE"

[Shows summary in chat]

[AskUserQuestion: "Begin implementation" or "Generate handoff prompt"]
User selects: "Generate a handoff prompt"

Agent: Here's your handoff prompt:

    [Well-structured prompt block with plan summary, key decisions,
     verified package versions, and implementation instructions]

Brainstorm complete! Plan saved to [location].
```
