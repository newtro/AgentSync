# Example Session

A condensed brainstorm that runs every phase in order, including the
Flush-Out Loop. Transcript and draft writes happen after every step and are
omitted here except where noted.

```
User: /brainstorm build a CLI tool for managing dotfiles

Agent: [No draft in <state>/brainstorms/ — fresh session]
[AskUserQuestion: "How should Codex (cross-provider AI) take part in this brainstorm?"
 Options: "Both review and idea contribution (Recommended)" / "Review only" /
          "Idea contribution only" / "Off"]
User selects: "Both review and idea contribution"
[Runs `codex --version && codex login status` — logged in]

Agent: **Phase 1: Seed**
You want a CLI that keeps config files in sync across machines and under
version control.
[AskUserQuestion: "What's the main pain point it should solve?"]
User selects: "Keeping configs in sync across multiple machines"
[Creates draft.md (codexMode: review+ideas) and transcript.md]

Agent: **Phase 2: Discovery**
[AskUserQuestion: "How many machines do you keep in sync?"]
User selects: "2-3 (work laptop, personal desktop, server)"
[AskUserQuestion: "What do you use today?"]
User selects: "A Git bare repo, but it's clunky"
[... more one-at-a-time discovery questions ...]

Agent: **Phase 3: Exploration**
[AskUserQuestion: "Which matters more: simplicity or flexibility?"]
User selects: "Simplicity — it should just work"
[Looks up current CLI frameworks with WebSearch, reads the registry and
 release pages with WebFetch]
[AskUserQuestion: "Commander.js and oclif are both actively maintained (current
 versions noted in the draft). Preferred language/runtime?"]
User selects: "Node.js / TypeScript"
[Runs codex exec with the Exploration idea-contribution prompt]
[AskUserQuestion multiSelect: "Codex flagged these angles I hadn't asked
 about — which are worth exploring?"
 Options: "Machine-specific secrets that must never sync" /
          "Conflicts when two machines edit the same file" /
          "Bootstrapping a brand-new machine"]
User selects: conflicts, bootstrapping
[Asks a follow-up question for each accepted angle]

Agent: **Phase 4: Expansion**
[Drafts own ideas; runs the Expansion idea-contribution call in parallel;
 merges and tags]
[AskUserQuestion, one call with two multiSelect questions:
 Q1 options: "[host] Machine profiles per device type" /
             "[both] Diff preview before every sync" /
             "[codex] Encrypted secret values" /
             "[host] Plugin recipes for popular tools"
 Q2 options: "[codex] Dry-run bootstrap for a new machine" /
             "[host] Shell-hook auto-sync on login"]
User selects: Machine profiles, Diff preview, Dry-run bootstrap
[AskUserQuestion: "More ideas, or move on to flushing out the plan?"]
User selects: "Move on"

Agent: **Phase 4.5: Flush-Out Loop**
Step 1 — Surface Map:
  Actors: user at a terminal; a background sync job; the Git remote.
  Flows: FLOW-1 user initializes a repo; FLOW-2 user syncs; FLOW-3 user
  previews a diff; FLOW-4 new machine bootstraps from a profile;
  FLOW-5 sync resolves a conflict; FLOW-6 user removes a tracked file.
  Entities: tracked file, machine profile, sync state.
  Inventory: CON-1 simplicity first; CON-2 profiles; CON-3 diff preview;
  CON-4 dry-run bootstrap; CON-5 Node/TypeScript.
[AskUserQuestion: "Here's the surface I've mapped. Anything missing or
 mis-scoped?"]
User selects: "Missing flows" — "Undo the last sync"
[Adds FLOW-7 user rolls back the last sync]

Step 2 — Depth tier: Standard. Walks the 15 lenses for each CON and FLOW,
classifying findings. Examples:
  FLOW-5 / Failure modes: conflicting edits on two machines → important
  FLOW-2 / Concurrency: sync launched twice at once → implementation-default
     (lock file; recorded, not asked)
  CON-2 / Actors & permissions → N/A (single user)
[Writes the classified backlog under ## Flush-Out Pass]

Step 3 — Resolve, batching related questions:
[AskUserQuestion, one call, three questions:
 "When the same file changed on two machines, what should sync do?"
   (Recommended: stop and show both diffs / last write wins / Not sure — recommend one)
 "Can a profile inherit from another profile?" (Yes, one level / No / Not sure)
 "What should undo restore?" (The whole last sync / One file at a time)]
User answers each.
[Records DEC-3..DEC-5 with alternatives and rationale, plus ACs, e.g.
 AC-7: Given file F changed on both machines since the last sync, when the
 user syncs, then sync stops before writing anything and shows both diffs.]

Step 4 — Completeness critic:
[Runs codex exec with the critic prompt, draft, and transcript]
Codex: "High: no behavior defined for a tracked file that is a symlink on
 Windows. Medium: no AC for bootstrap on a machine with no network."
[Resolves the network case with a recorded default; asks the user about
 Windows symlinks, which the user mentioned in Discovery]

Step 5 —
[AskUserQuestion: "Fully flushed out, or more to flush out?"]
User selects: "Looks fully flushed out — move on"

Agent: **Phase 4.6: Technical Proposal**
[Proposes first, in prose: a single Node CLI, a manifest file, a sync engine
 that copies or symlinks per OS, and the files it would create, with an ASCII
 block diagram]
[AskUserQuestion: "Where is this proposal wrong or thin?"]
User selects: "Other: symlinks need admin rights on Windows"
[Reads the Windows notes it gathered in Discovery, revises to copy-by-default
 with symlinks opt-in, logs DEC-9 with symlink-everywhere as the rejected
 alternative]
User selects: "Approach is settled"

Agent: **Phase 5: Crystallize**
[Shows the outline: Vision; Actors & core flows; Key decisions; Edge cases &
 failure handling; Dependencies & sequencing; Tech stack; Acceptance
 criteria; Validation strategy; Open questions]
User selects: "Looks good, write it"
[AskUserQuestion: where to save] User selects: "docs/designs/ in this project"
[Re-checks every package mentioned against current registry pages]
[Writes the plan section by section, keeping FLOW/DEC/AC IDs, ending with a
 Detailed Implementation Plan listing every file]

[In parallel: the comprehension, zoom-out, and implementation-readiness
 Goldfish, each given only the plan path]
Goldfish (readiness): "Major — the plan never says what happens to a dotfile
 that exists on disk but is not in the manifest: overwrite, skip, or adopt?"
Goldfish (comprehension): explains the goal correctly but describes conflict
 handling as last-write-wins, which the plan never says.
[Classifies: the first is a design decision; the second is a propose-fix —
 the plan is missing the conflict rule the user chose in DEC-6]

[Runs codex exec with the plan-reviewer prompt, transcript, and plan]
Codex: "The transcript records the user wants the server to be pull-only, but
 the plan has it pushing changes too."
[Applies both propose-fixes (pull-only server, DEC-6 conflict rule)]
[AskUserQuestion: "A file exists on disk but not in the manifest — what should
 sync do?" Options: "Skip and warn (Recommended)" / "Adopt into manifest" /
 "Overwrite" / "Not sure — recommend one"]
User selects: "Skip and warn (Recommended)"
[Adds DEC-10 and AC-14; round 1 re-runs the transcript reviewer and fresh
 comprehension, zoom-out, and readiness Goldfish on the revised plan]
Codex: "PLAN_COMPLETE: The plan accurately captures all topics discussed in
 the brainstorm session."
Goldfish (comprehension): restates conflict handling as the DEC-6 rule; only
 nits remain.
Goldfish (zoom-out): no blockers or majors.
Goldfish (readiness): "READY_TO_IMPLEMENT"

[Marks the plan Approved; summarizes it in chat, noting it was validated
 against the transcript and passed the Goldfish gate]
[AskUserQuestion: "Begin implementation" / "Generate a handoff prompt"]
User selects: "Generate a handoff prompt"

Agent: Here's your handoff prompt:

    [Fenced block: plan summary, key decisions, plan path, verified versions,
     and instructions that the acceptance criteria define done]

[Deletes the draft, transcript, and second-opinion scratch files]
Brainstorm complete. Plan saved to docs/designs/dotfiles-cli.md.
```
