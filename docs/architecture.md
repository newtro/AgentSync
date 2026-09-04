# SkillMesh implementation architecture

## Runtime and packaging

SkillMesh is a Node.js ESM command-line application using only the Node standard
library. Release builds additionally invoke Claude's installed strict plugin
validator. Versioned macOS and Windows launchers are published in the trusted
distribution feed and health-checked before replacing the managed launcher.

No Docker service, daemon, database, inbound webhook, automatic dependency
installer, or authenticated browser automation is part of the MVP.

## Repository contract

Canonical skills live at `skills/<namespaced-id>/skill.json`. A manifest points
to shared content and optional overlays. The compiler emits deterministic
projections into a staging directory. Generated output is never written into
an installed target directly.

The distribution repository contains compiler output, immutable release and
updater artifacts, `stable-index.json`, and its independent validation workflow.
The source and distribution repositories must be distinct when publication is
configured.

## Safety invariants

1. Canonical source is the only authoring authority.
2. Every required target for a logical skill is compiled and checked before it
   can be promoted.
3. A security finding blocks the entire source revision.
4. Installation stages, verifies, and then switches; the prior active version
   remains recoverable.
5. A locally edited generated copy is preserved before replacement.
6. Installed, active, provider-observed, and unknown are separate states.
7. Unsupported provider operations become `assisted-action-required` and are
   never reported as complete.
8. Logs and errors must not contain credentials.

## Modules

- `manifest`: validation, target expansion, path/runtime policy.
- `security`: source/generated secret scanning and redaction.
- `compiler`: deterministic Codex and Claude projections.
- `release`: candidates, stable-index transitions, rollback, snapshots.
- `publisher`: stable-only distribution staging and GitHub PR preparation.
- `updater`: fetch, verify, drift preservation, atomic local switching.
- `adapters`: target discovery, install paths, activation/removal semantics.
- `bootstrap`: one-pointer enrollment and native schedule configuration.
- `migration`: non-destructive inventory and merge proposals.
- `status`: truthful enrollment state reporting.

## State layout

The default state root is `~/.skillmesh` (or `%USERPROFILE%\\.skillmesh`). It
contains configuration, a managed Git checkout, staged artifacts, last-known-
good versions, drift patches, migration archives, snapshots, and redacted
status. Credentials remain in Git/GitHub or operating-system credential stores;
SkillMesh never stores token values.

## Test strategy

The built-in Node test runner covers deterministic compilation, validation,
security precedence, stable transitions, rollback, drift, migrations, and
adapter behavior. Platform-specific scheduling commands support dry-run plans
so their exact macOS and Windows behavior can be tested on either OS. Live
provider/account checks are capability probes and report unknown or assisted
states when authoritative confirmation is unavailable.
