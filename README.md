# SkillMesh

SkillMesh is a Git-driven supply chain for keeping one canonical skill library
synchronized across Codex, Claude Code, and Claude Desktop/Cowork on macOS and
Windows. It compiles target-specific projections, promotes only complete and
security-cleared releases, and preserves last-known-good local installations.

The implementation uses only the Node.js standard library. Release validation
also invokes the installed Claude CLI's strict plugin validator. It does not
require Docker, a daemon, a database, browser automation, or embedded credentials.

## What is implemented

- Versioned canonical manifests with shared files and target overlays.
- Deterministic Codex and Claude plugin projections, including binary assets.
- Portable-path, target, explicit executable-mode/runtime, smoke-test, and secret validation.
- Exact required-target promotion with per-skill quarantine boundaries.
- A separate stable distribution stage and generated GitHub pull-request flow.
- Post-merge GitHub Actions publication that reads authoritative distribution
  revisions and opens the generated cross-repository promotion pull request.
- Forward-only provider revisions for normal releases, rollback, and snapshot
  restore.
- One-pointer endpoint onboarding using `skillmesh.config.json` in the source
  repository.
- macOS `launchd` and Windows Task Scheduler plans with jitter, process locking,
  and exponential failure backoff.
- Atomic Codex installation, drift preservation, last-known-good rollback,
  staged removal, updater self-update rollback, and truthful status.
- Claude Code marketplace add/update/install/uninstall using supported CLI
  commands. The local plugin store is treated as shared across Claude accounts,
  while account enrollments and activation state remain distinct.
- Whole-tree legacy inventory/diffing with proof-bound selection, import,
  endpoint validation, archival, re-enrollment, offboarding, and release
  snapshots.

## Repository setup

Create two private GitHub repositories:

1. A source repository containing SkillMesh and canonical `skills/` content.
2. A distribution repository used only for generated stable artifacts.

This repository's `skillmesh.config.json` points to the separate
`newtro/AgentSync-Distribution` repository. Never point a Claude marketplace
at the source repository.

A canonical skill lives at `skills/<namespace>/<name>/`:

```text
skills/scott/example/
├── skill.json
├── SKILL.md
├── references/
└── assets/
```

See `schema/skill.schema.json` and `examples/example-skill/skill.json` for the
contract.

## Core commands

```sh
node src/cli.js doctor --json
node src/cli.js security-scan --root . --json
node src/cli.js validate --source . --json
node src/cli.js build --source . --out .skillmesh/build --json
node src/cli.js promote --build .skillmesh/build --json
node src/cli.js publish-stage --source . --build .skillmesh/build \
  --distribution /path/to/distribution --json
node src/cli.js publish-pr --source . --distribution /path/to/distribution \
  --stage /path/to/distribution/.skillmesh-stage --generation 1 --json
```

On a new Mac or Windows endpoint, the only SkillMesh-specific input is the
source repository pointer:

```sh
node src/cli.js onboard git@github.com:OWNER/SOURCE.git --json
```

Provider/GitHub consent may still be requested. Add `--project /path/to/repo`
for each project-scoped enrollment. SkillMesh stores no token value; Git uses
the operating system's configured credential helper. Onboarding immediately
runs the first reconciliation and reports `no-stable-skills`, `installed`,
`unknown`, or `assisted-action-required`; it does not equate saved
configuration with provider activation.

Configure the source repository Actions secret
`AGENTSYNC_DISTRIBUTION_TOKEN` with a fine-grained token that can read/write
`newtro/AgentSync-Distribution` and open pull requests. Source merges otherwise
fail closed before distribution publication. Pull-request contract checks run
the validator from protected `main` and treat candidate files strictly as data;
the cross-repository credential is supplied only to the pinned checkout action.

Configure the distribution repository secret `AGENTSYNC_SOURCE_TOKEN` with
read access to `newtro/AgentSync`, and require its `validate` Actions check on
the protected `main` branch. The generated PR head is independently checked
for stable-index shape, artifact and updater digests, secrets, and exact Claude
provider validity before merge. This check also runs from protected code via
`pull_request_target`, rejects changes to distribution support/workflow files,
and never exposes the source token to candidate code.

For this initial personal deployment, treat compiler or
`minimumUpdaterVersion` behavior changes as a coordinated migration: preserve
the 0.1.0 source history, bump the updater version, and validate existing stable
releases before merging.

Cowork bundles and migrations enter the canonical source through isolated,
deterministic pull-request branches:

```sh
node src/cli.js bundle-create --skill /path/to/skill --out change.skillmesh.json
node src/cli.js bundle-apply --bundle change.skillmesh.json --source .
node src/cli.js migrate --export /path/to/claude-export --json
node src/cli.js migrate select --proposal PROPOSAL --group GROUP \
  --candidate CANDIDATE --reviewer OWNER --json
node src/cli.js migrate stage --proposal PROPOSAL --group GROUP --json
node src/cli.js migrate publish --proposal PROPOSAL --group GROUP \
  --manifest /path/to/skill.json --source . --json
node src/cli.js migrate prove --proposal PROPOSAL --group GROUP \
  --proof /path/to/proof.json --json
node src/cli.js migrate status --proposal PROPOSAL --json
node src/cli.js migrate archive --proposal PROPOSAL --reviewer OWNER \
  --confirm-proof SHA256_DIGEST --json
```

Archival copies originals into protected local migration storage; it does not
delete the original provider copies. It is refused until canonical, security,
artifact, and endpoint evidence is recorded and owner confirmation matches the
exact proof digest. Pending or provider-unobservable endpoints remain visible.

Other lifecycle commands are `sync`, `status`, `snapshot`, `rollback`,
`restore`, `reenroll`, and `offboard`. Run `help` for their required options.
Re-enrollment retires artifacts that are absent from the new repository before
switching. Any provider removal that cannot yet be verified is retained as a
complete pending plan, shown by `reenroll` and `status`, and retried before each
subsequent sync.
Snapshot restoration accepts `--snapshot-artifacts` and
`--current-artifacts` separately so historical versions and post-snapshot
tombstones can be verified from different immutable checkouts.

Immediate removal (`graceDays: 0` or an explicit `removeAfter`) requires a
manifest `emergencyOverride` containing an approver, reason, and approval
timestamp. Detected local edits are archived and reported as `drifted` before
the stable projection is restored. Late secret findings open a redacted local
incident, block publication, and are preserved by CI for credential and Git
history remediation.

## Provider boundaries

- Codex user skills install at the documented `~/.agents/skills` location;
  repository skills install under `.agents/skills`.
- Claude Code is managed through its supported Git marketplace/plugin CLI.
- Claude Desktop personal marketplace refresh has no documented unattended
  interface. SkillMesh reports `assisted-action-required` and provides the
  exact action instead of automating an authenticated browser.
- Claude Team/Enterprise marketplace state remains `unknown` until the
  organization GitHub integration provides authoritative evidence.
- A running conversation is never reported active merely because files or a
  plugin were installed. Reload or a new session may be required.

Windows behavior is covered by platform-neutral unit tests and the CI matrix.
Desktop discovery uses `Get-AppxPackage` and absence remains `unknown`; a native
Windows endpoint probe is still required before claiming that a specific
installation is active.

## Development

```sh
npm test
npm run check
npm run smoke
```

The GitHub Actions workflow runs the suite and security/manifest validation on
Linux, macOS, and Windows using SHA-pinned official actions.
