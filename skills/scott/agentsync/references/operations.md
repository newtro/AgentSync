# AgentSync Operations

Run commands from the source checkout unless a command uses the managed
launcher explicitly.

## Validate source changes

```sh
node src/cli.js security-scan --root . --json
node src/cli.js validate --source . --json
npm test
node src/cli.js build --source . --out .skillmesh/build --json
```

The candidate build must cover every required target. A quarantined skill is
not published and must not be described as synchronized.

## Publish

Commit and push the canonical source change. The protected source workflow
builds against the authoritative distribution state, promotes complete
candidates, and opens a generated distribution pull request when stable
content changed. Verify both repositories' checks before syncing endpoints.

## Synchronize and inspect

```sh
~/.skillmesh/bin/skillmesh sync --state ~/.skillmesh --json
~/.skillmesh/bin/skillmesh status --state ~/.skillmesh --json
```

Also inspect `~/.skillmesh/status.json` and `~/.skillmesh/scheduler.log`.
An empty status list means no stable skill matches that endpoint, not that a
skill was installed.

## Onboard an endpoint

With Node.js 22 or newer, Git, and private-repository authentication available:

```sh
npx --yes github:newtro/AgentSync onboard https://github.com/newtro/AgentSync.git --json
```

Use `--project /absolute/path/to/repository` for each project that should
receive project-scoped skills. Onboarding installs a native 15-minute schedule
and performs the initial reconciliation.

## Diagnose

```sh
~/.skillmesh/bin/skillmesh doctor --json
git -C ~/.skillmesh/repos/source status --short
git -C ~/.skillmesh/repos/distribution status --short
```

Confirm configured Git origins before pushing. Check the relevant GitHub
workflow run rather than assuming a push was published.

## Recovery

Use `snapshot`, `rollback`, `restore`, `reenroll`, and `offboard` through the
CLI's documented contracts. Do not delete stable artifacts or managed state to
simulate success. Preserve pending retirements and provider-unobservable states
until they can be verified.
