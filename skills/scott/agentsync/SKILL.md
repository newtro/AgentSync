---
name: agentsync
description: "Use when the user mentions AgentSync or SkillMesh, or asks to \"add a skill to AgentSync\", \"update/publish a shared skill\", \"sync my skills\", \"run a skill sync\", \"check sync status\", \"onboard this machine/endpoint\", \"remove/retire a skill\", or \"why didn't my skill update\". Covers editing, validating, versioning, publishing, syncing, and diagnosing skills across Codex and Claude."
---

# AgentSync

Manage the user's private, Git-driven skill library across Codex, Claude Code,
and Claude Desktop on macOS and Windows.

## Locate the system

Prefer the managed endpoint installation when it exists:

- Launcher: `~/.skillmesh/bin/skillmesh`
- Source checkout: `~/.skillmesh/repos/source`
- Distribution checkout: `~/.skillmesh/repos/distribution`
- Endpoint status: `~/.skillmesh/status.json`
- Scheduler log: `~/.skillmesh/scheduler.log`

When authoring from another AgentSync checkout, confirm its Git origin before
making changes. Never edit generated distribution artifacts by hand.

## Choose scope

Treat a skill found in a user-level skill directory as global unless the user
says otherwise. Keep the canonical copy in the AgentSync source repository.
For a project-scoped skill, target project scope and register the project with
`onboard` or `reenroll --project /path/to/repo`; Codex then installs it below
that project's `.agents/skills` directory.

## Safe workflow

1. Inventory the complete skill directory, including scripts, references,
   assets, tests, and UI metadata. Preserve files that support real behavior.
2. Create or update its canonical `skill.json`. Bump the logical version when
   immutable behavior or target projections change.
3. Run the repository security scan, manifest validation, tests, and candidate
   build before committing.
4. Commit and push only the intended source changes. Let the source workflow
   generate and validate distribution changes; do not bypass its quarantine or
   provenance checks.
5. Confirm the source workflow and distribution validation succeed. Then run
   an endpoint sync and report installed, assisted, unknown, or failed states
   exactly as observed.

Read [references/operations.md](references/operations.md) when executing a
publication, onboarding, synchronization, rollback, or diagnostic operation.

## Boundaries

- Never print, copy, commit, or log repository or provider credentials.
- Do not report a running conversation as active merely because files exist.
- Preserve local drift before restoring stable content.
- Claude Desktop actions may require account-specific confirmation when no
  unattended provider interface is available.
- Ask before widening a global skill to project scope or adding new endpoints.
