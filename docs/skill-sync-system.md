# Cross-Harness Skill Synchronization Plan

## Vision

Create or edit a reusable AI skill once, merge it into one private GitHub repository, and have compatible projections reach Codex, Claude Code, and Claude Desktop/Cowork on macOS and Windows without recreating the skill.

The system is a small, Git-driven skill supply chain. It treats installed copies as generated artifacts, validates every required target before release, preserves the last-known-good version, and makes unsupported or stale states visible.

## Problem statement

The current workflow has independent skill copies across multiple AI harnesses and machines. A change made in one place must be recreated elsewhere, which creates drift, missed updates, inconsistent behavior, and no reliable rollback history.

The target environment includes:

- Codex on macOS and Windows under one OpenAI account.
- Claude Code on macOS and Windows.
- Claude Desktop/Cowork on macOS and Windows.
- Two Claude accounts used on both computers: one personal account and one Team/Enterprise account.
- Global user skills and repository/project-scoped skills wherever the harness supports them.

This is six product surfaces but at least eight account-aware endpoint enrollments, plus dynamic project-scoped enrollments. An enrollment is identified by `(machine, harness, account/profile, scope)`.

## Goals

- One canonical, human-readable skill definition.
- Automatic post-merge synchronization after one-time onboarding.
- Onboarding by supplying a private GitHub repository pointer, plus unavoidable provider consent.
- Generated harness- and OS-specific projections without duplicating the skill's intent.
- Pre-merge validation for every declared required target.
- Per-skill atomic promotion across required targets.
- Last-known-good retention, quarantine, automatic technical rollback, and owner-triggered behavioral rollback.
- Non-destructive migration of existing divergent skill copies.
- Support for instructions, references, assets, templates, portable scripts, and explicitly OS-specific automation.
- Clear status without claiming knowledge the system does not have.

## Non-goals

- Multi-master or last-writer-wins reconciliation between installed copies.
- Byte-identical packages across Codex and Claude.
- Live mutation of skills already loaded into a running conversation.
- Public skill distribution in the MVP.
- A central fleet database or dashboard in the MVP.
- Automatic dependency installation or execution during synchronization.
- Browser automation that operates authenticated Claude sessions.
- Personal-versus-organization trust-zone editions. Eligible skills publish to every compatible configured target unless explicitly denied.
- Docker or container-backed runtime requirements.
- A skill dependency graph/package manager in the MVP.

## Product and platform facts

The implementation must reverify these behaviors against current official documentation during the compatibility spike and before each adapter change:

- Codex discovers repository, user, admin, and system skills; its documented user location is `$HOME/.agents/skills`, repository skills use `.agents/skills`, and symlinked skill folders are supported. OpenAI recommends plugins for reusable distribution beyond one repository. See [OpenAI: Build skills](https://developers.openai.com/codex/skills).
- Claude personal skills can be uploaded through Customize > Skills, while Claude plugins can be added from a GitHub repository or Git URL. Self-added Claude Desktop/Cowork plugins are stored locally. See [Anthropic: Use skills in Claude](https://support.claude.com/en/articles/12512180-use-skills-in-claude) and [Anthropic: Use plugins in Claude](https://support.claude.com/en/articles/13837440-use-plugins-in-claude).
- Claude Code supports Git-backed marketplaces, background marketplace/plugin updates, user/project/local installation scopes, and reload-or-next-launch activation. See [Anthropic: Discover and install plugins](https://code.claude.com/docs/en/discover-plugins).
- A Claude Team/Enterprise organization can synchronize a private GitHub marketplace automatically after a qualifying pull request with a plugin version bump is merged. See [Anthropic: Manage organization plugins](https://support.claude.com/en/articles/13837433-manage-plugins-for-your-organization).
- Claude Cowork on desktop can read and write explicitly connected local folders. Local access requires the Desktop app and relevant permissions; cloud and account policy boundaries still apply. See [Anthropic: Use Cowork across surfaces](https://support.claude.com/en/articles/15520349-use-claude-cowork-on-web-desktop-and-mobile).

## Actors and responsibilities

- **Skill owner:** Owns repository access, approves migrations, reviews changes, and initiates behavioral rollback.
- **AI authoring harness:** Codex, Claude Code, or Claude Desktop/Cowork drafts canonical changes and opens a pull request when capable.
- **Reviewer/merger:** Reviews source plus generated previews and merges only after required checks pass.
- **Source CI:** Validates canonical content, compiles projections, runs target smoke tests, and creates per-skill candidates.
- **Publisher:** Advances the stable index and writes only approved projections to the generated distribution repository.
- **Machine updater:** Runs on macOS and Windows, updates local targets atomically, detects drift, reports local status, and updates itself safely.
- **Claude personal account:** Uses the supported personal marketplace/plugin path after one-time enrollment.
- **Claude organization administrator:** Connects the private GitHub distribution repository and enables organization marketplace synchronization.

## Architecture

```text
Codex / Claude authoring conversation
                |
                v
      Canonical source branch + PR
                |
 pre-merge security, validation, and previews
                |
        reviewed merge to main
                |
 post-merge security repeat + candidate build
                |
   security gate + required-target tests
                |
        stable index promotion
                |
                v
  Generated private distribution repository
       |              |                |
       v              v                v
 local updater   Claude Code      Claude org/personal
 Mac + Windows   marketplaces     marketplace/plugin paths
```

### 1. Canonical source repository

The private GitHub source repository is the only authority. It contains:

- Canonical logical skills.
- Immutable namespaced skill IDs separate from display names.
- A versioned capability manifest schema.
- Shared instructions, scripts, references, templates, and assets.
- Explicit harness/OS/scope overlays.
- Explicit target deny rules.
- Generator and adapter source.
- Validation fixtures and smoke tests.

Installed copies, generated projections, caches, endpoint credentials, drift patches, and migration backups do not belong in this repository.

### 2. Capability-aware compiler

The compiler takes canonical source plus a declared target capability profile and produces a deterministic projection. Overlays may alter packaging, metadata, paths, or platform execution, but may not silently change the logical purpose of the skill.

Each projection records:

- Logical skill ID and logical version.
- Source commit.
- Generator and schema versions.
- Target harness, OS, account/profile class, and scope.
- SHA-256 digest.
- Required tools/runtimes and activation behavior.

Identical input, generator, schema, and capabilities must produce identical digests.

### 3. Stable index and per-skill releases

Promotion is atomic per logical skill across all required targets. The stable index maps each skill ID to:

- One common stable logical version.
- Every required target projection and digest.
- Enabled/deprecated/removed state.
- Minimum compatible updater/schema version.
- A monotonically increasing provider distribution revision distinct from the logical skill version.

Different targets may receive structurally different artifacts, but they may not independently advance to different logical versions. Explicitly denied or declared unsupported targets are outside the required set. An unexpected inability to build a declared target is a failure.

Security failures block the entire source commit. Ordinary post-merge compatibility or provider failures quarantine only the affected logical skill; unrelated valid skills may advance.

### 4. Generated distribution repository

Claude marketplaces and machine updaters must not consume the canonical source branch directly. CI publishes only stable-index-approved generated artifacts to a separate private GitHub distribution repository. Its default branch is the provider-facing stable feed.

Promotion creates a generated pull request in the distribution repository. That pull request contains only approved artifacts, the updated stable index, and the monotonically increasing plugin/marketplace distribution revision required by the provider. The pull request is validated and merged; its merge is the trigger consumed by Claude organization marketplace synchronization. Direct CI pushes do not substitute for this flow.

This prevents a merged but quarantined candidate from reaching Claude before promotion is complete.

### 5. Machine updater

One cross-platform updater manages local projections. The implementation ships versioned, digest-pinned macOS and Windows launchers that hand off to the managed source checkout; synchronization refreshes that checkout before schema validation, allowing an older process to install and health-check its successor before retrying a newer schema.

It runs through:

- `launchd` on macOS.
- Windows Task Scheduler on Windows.
- A lightweight harness-start check only where supported hooks or wrappers exist.
- A manual `sync now` command.

Default cadence is every 15 minutes with jitter and exponential failure backoff. GUI harnesses are compliant through periodic/login scheduling even when no supported launch hook exists.

The updater uses a managed checkout/cache separate from authoring worktrees. It stages versioned directories, verifies digests and schema compatibility, performs target-specific checks, and switches atomically. Windows uses rename/junction-safe behavior and does not require developer-mode symlink privileges.

### 6. Updater lifecycle

The updater automatically checks a trusted versioned GitHub release channel. It stages and verifies its replacement, health-checks the new version, and retains the previous version for automatic rollback. A skill release declaring a newer minimum updater/schema version remains unapplied until the updater upgrade succeeds.

## Canonical manifest requirements

Each logical skill must declare or derive:

- Immutable namespaced ID.
- Display name and description.
- Manifest schema version.
- Supported and required harnesses, operating systems, and scopes.
- Explicitly denied targets.
- Required tools/runtimes, without embedded credentials.
- Shared files and overlay precedence.
- Reload/activation expectations.
- Smoke-test inputs and assertions.
- Deprecation/removal metadata when applicable.

Validation rejects malformed manifests; duplicate or case-only IDs; unsafe archive paths; symlink escape; reserved Windows names; excessive path length; undeclared runtimes; unsupported required targets; hostile ZIP traversal; and material executable-bit or line-ending ambiguity.

Dependencies are detected and reported. Synchronization never installs or executes them automatically. Only allowlisted smoke tests run in an isolated CI workspace.

## Core flows

### FLOW-1 and FLOW-2: one-pointer onboarding

The user supplies the private GitHub repository URL/identity once. Bootstrap then:

1. Authenticates the endpoint with a dedicated read-only identity.
2. Discovers installed harnesses, Claude accounts/profiles, supported scopes, target paths, and refresh mechanisms.
3. Presents constrained selections when multiple discovered choices exist.
4. Configures selected global and project/repository enrollments.
5. Installs native scheduling and the manual status/sync commands.
6. Connects or guides unavoidable Claude/GitHub consent.
7. Runs read, generation, installation, activation, and rollback smoke checks.

Normal onboarding requires no manual path entry, file copying, manifest editing, or skill recreation.

### FLOW-3: conversation-to-PR authoring

Any harness may help author, but canonical files are the only output that matters.

- Codex and Claude Code write a branch and open a pull request when repository/GitHub access is available.
- Claude Desktop/Cowork does the same when the canonical folder and Git/GitHub capability are available.
- If a Claude session lacks those capabilities, it exports a canonical change bundle. The local helper validates the bundle and converts it into a branch and pull request without reauthoring the content.
- Installed projections are never an authoring destination.

The user's common bypass/skip-permissions preference may make direct authoring smoother, but the system does not depend on it and does not treat it as overriding OS, application, GitHub, or organization policy.

### FLOW-4 and FLOW-5: validation, merge, and promotion

Every changed skill must pass pre-merge secret/security scanning of both canonical source and generated previews, plus all known required-target checks. A merged commit creates immutable per-skill candidates. Source CI repeats secret/security scanning as defense in depth, performs final publication checks, and advances the stable index only for promotable skills.

- Known pre-merge failure blocks the pull request.
- Any pre-merge secret/security finding blocks the pull request so the secret does not enter canonical branch history.
- A post-merge secret/security finding stops publication for the entire commit, redacts diagnostic output, flags possible credential revocation, and initiates repository-history remediation rather than ordinary quarantine alone.
- Unexpected post-merge target/provider failure quarantines the affected skill.
- Quarantined candidates never enter the distribution repository.
- Other independent skills from the same merge may advance after passing all checks.

### FLOW-6 through FLOW-9: distribution and activation

- Codex global and project projections are installed into discovered supported locations.
- Claude Code consumes the stable generated marketplace and activates changes on a supported reload or next launch.
- The Claude organization consumes a private GitHub marketplace driven only by merged, version-bumped pull requests in the stable distribution repository.
- The personal Claude account uses its supported Git repository/plugin marketplace path.

Personal Claude receives a mandatory empirical compatibility spike. If no supported automatic refresh path exists for a given app version, the system prepares the artifact/action and reports `assisted action required`. It does not use authenticated browser automation and does not claim automatic convergence.

Installed and active are distinct states. The system never claims a running conversation has adopted a newly installed skill unless the harness exposes authoritative evidence.

### FLOW-10: drift handling

Generated copies are tamper-evident and disposable. Before replacing a modified projection, the updater writes a protected local patch with source/target metadata. Only after preservation succeeds may it restore the stable generated version. The patch can become a canonical pull request through an explicit command.

If preservation fails because of disk or permissions, synchronization leaves the existing projection untouched and reports the blocker.

### FLOW-11: rollback and quarantine

- Installation or verification failure automatically restores the previous active digest.
- A technically valid but behaviorally bad release can be rolled back by the owner.
- Rollback changes the stable index to a previous immutable logical skill version; it does not rewrite Git history.
- When a provider requires forward-only package versions, the publisher wraps the restored logical content and digest in a new, higher provider distribution revision. Claude surfaces therefore receive a normal forward update rather than a package-version downgrade.
- Unrelated skills remain unchanged.

### FLOW-12: status

MVP status combines:

- GitHub/CI publication and stable-index state.
- Desired, downloaded, installed, active, pinned, drifted, failed, denied, assisted-action-required, and unknown states for enrollments on the current machine.

The MVP does not infer the state of an offline other machine or a provider-controlled cloud surface without an authoritative API. It reports `unknown`. A privacy-safe central convergence ledger is Phase 2.

### FLOW-13: deprecation and removal

A normal deletion merge first publishes a disabled/deprecated tombstone. After a configurable grace period, defaulting to seven days, endpoint synchronization removes generated copies. Git and release history remain restorable.

Emergency removal requires an explicitly labeled reviewed override. An endpoint offline beyond the grace period must not briefly reactivate the removed skill when it returns.

The compatibility spike must test disable, uninstall, tombstone, and removal propagation on every Claude surface. If a provider surface exposes no supported automatic removal operation, status becomes `assisted action required`, presents the exact removal action, and never reports removal complete until authoritative confirmation exists.

### FLOW-14 and FLOW-15: re-enrollment and offboarding

Re-enrollment validates a replacement credential and projection before switching, retains last-known-good until success, revokes the old credential when possible, and reports incomplete revocation.

Offboarding removes native schedules and managed projections, revokes the endpoint credential, and retains canonical history plus protected migration/drift archives.

### FLOW-16: restore a release manifest

An MVP snapshot records the exact enabled skill IDs, logical versions, target artifact digests, source commits, and generator/schema versions. Restore reconstructs that set through the stable index. Automatic task-by-task capture and rehydration are Phase 2.

### FLOW-17: updater and adapter upgrades

Updater upgrades use the trusted release channel and rollback process. Adapter changes are versioned and must pass the same target matrix. An updater that cannot understand a schema fails closed and retains last-known-good.

## Migration of existing skills

Migration is non-destructive:

1. Inventory readable local and cloud/account skill sources.
2. Use an embedded immutable ID where present; otherwise group candidates by normalized slug and content similarity.
3. Request a user export where a cloud surface has no supported read/export API.
4. Quarantine suspected secrets locally outside Git with restrictive OS permissions and redacted metadata.
5. Produce a pull request with candidate groups, source provenance, diffs, and explicit merge choices.
6. Never choose a winner only by modification time.
7. Build and validate canonical replacements.
8. Treat unreachable or provider-unobservable activation as pending/unknown.
9. Archive originals only after reachable installations validate and the owner explicitly confirms migration.

Migration backups and drift archives live outside managed projection trees and remain until explicit cleanup.

## Security and permission model

- Keep author, CI publisher, local updater, and Claude organization connector identities separate.
- Grant local updaters read-only access to the stable distribution repository.
- Never place credentials, account cookies, or tokens in source, projections, logs, service definitions, or generated bundles.
- Use native credential storage and redact authentication errors.
- Rotate or revoke each endpoint identity independently.
- Scan canonical source and generated previews before merge; a finding blocks the pull request.
- Repeat the scan after merge as defense in depth. A late finding blocks the entire commit, redacts output, prompts credential revocation assessment, and starts Git history-remediation procedures.
- Verify source commit provenance and SHA-256 artifact manifests in MVP.
- Defer custom signing-key infrastructure unless a later threat model requires it.
- Treat explicit target deny as higher precedence than default publish-everywhere behavior.
- Do not execute arbitrary skill scripts or install dependencies during synchronization.

## Key decisions and rejected alternatives

| ID | Decision | Rejected alternatives and rationale |
|---|---|---|
| DEC-2 | Automatic post-merge sync | Manual publish or reinstall preserves the original pain. |
| DEC-3 | One canonical library | Multi-master reconciliation creates ambiguous ownership and conflicts. |
| DEC-4/17 | Private GitHub source | Git provides history/rollback, and GitHub enables the documented Claude organization integration. |
| DEC-5/18 | Reviewed merge with required checks | File-save/direct-push publication can distribute known-broken content. |
| DEC-6 | Safe eventual convergence | Immediate fleet-wide activation is not supported reliably by all harnesses. |
| DEC-7 | Shared source plus generated adapters | Byte identity cannot express real harness and OS differences; independent copies recreate drift. |
| DEC-8/24 | One-pointer onboarding | Manual paths, copies, and manifests reproduce the setup problem. |
| DEC-9/15 | Supported personal Claude path with assisted fallback | Browser automation is fragile and overprivileged; silently claiming automation is misleading. |
| DEC-10 | Native schedule plus supported start checks | A permanent daemon or inbound webhook is unnecessary for eventual convergence. |
| DEC-11 | Publish everywhere unless denied; no trust zones | The user explicitly rejected personal/organization trust-zone editions after the leakage tradeoff was surfaced. Secret scanning remains mandatory. |
| DEC-12 | Reviewed, non-destructive migration | Timestamps or a designated endpoint do not establish semantic correctness. |
| DEC-13 | Staged deletion | Immediate deletion risks accidental loss; never deleting leaves stale enabled behavior. |
| DEC-14 | Per-skill cross-target atomicity | Per-target advancement creates logical divergence; repository-wide atomicity blocks unrelated skills. |
| DEC-19 | Direct conversation-to-PR with bundle fallback | Requiring another harness causes rework; demanding unsupported direct access is brittle. |
| DEC-20 | Automatic and owner-triggered rollback | Each alone misses either deterministic technical failure or bad-but-valid behavior. |
| DEC-21 | Local plus CI status in MVP | A central fleet service is disproportionate for the first version. |
| DEC-22 | Restorable release manifests in MVP | Per-task capture requires deeper integration and belongs in Phase 2. |
| DEC-23 | Verified automatic updater upgrades | Manual updater maintenance breaks the one-time-setup promise. |
| DEC-25 | Secret/security checks before and after merge | Post-merge-only blocking can still place a secret in canonical Git history. |
| DEC-26 | Generated distribution pull request with monotonic version bump | A direct CI push may not trigger the documented Claude organization synchronization behavior. |
| DEC-27 | Separate logical version from provider distribution revision | Rollback must not depend on a provider accepting a package-version downgrade. |
| DEC-28 | Assisted removal when provider uninstall is unsupported | Unsupported browser automation or false completion would violate the established provider-boundary policy. |

## Edge cases and failure handling

- Empty library: bootstrap succeeds and reports zero managed skills.
- Duplicate/case-only names: fail validation before merge.
- Concurrent PRs: default-branch serialization and regenerated checks prevent stale promotion.
- Out-of-order polls: immutable versions and stable-index generation prevent rollback to stale state.
- Offline/asleep computer: retain last-known-good and retry with backoff.
- Expired Git authentication: retain active state, redact errors, and present re-enrollment.
- Disk full or partial filesystem switch: leave prior active version intact; do not discard drift.
- Corrupt download/cache: reject digest mismatch, quarantine candidate, and restore prior state.
- Account switch during update: bind operations to the discovered account/profile enrollment and never infer success for the other account.
- Provider/plugin layout change: fail capability probe or adapter validation and hold the affected skill.
- Old updater/new schema: fail closed, update the updater, then retry.
- Delete then restore: tombstone/version history supports restoration without identity reuse.
- Offline beyond deletion grace: apply current tombstone/removal state before enabling any cached old copy.
- Git history rewrite: reject provenance not reachable from the trusted configured source/ref.
- Secret discovered after merge: stop every publication from the commit, redact diagnostics, assess credential revocation, and remediate repository history before resuming.
- Provider rejects version downgrade: republish restored logical content under a new monotonically increasing distribution revision.
- Provider lacks automatic disable/uninstall: preserve the tombstone, report assisted action required, and do not claim removal completion.

## MVP scope

- Canonical source schema and capability manifests.
- Codex, Claude Code, and Claude Desktop/Cowork adapters for macOS and Windows.
- Global and repository/project scopes where supported.
- Source CI, deterministic projection compiler, target previews, secret/security checks, and smoke tests.
- Per-skill stable index and separate stable distribution repository.
- One-pointer bootstrap and account/provider consent guidance.
- Native scheduled updater, manual sync/status, self-update, atomic install, drift preservation, quarantine, and rollback.
- Private GitHub Claude organization marketplace integration.
- Personal Claude compatibility spike plus supported automatic path or visible assisted fallback.
- Non-destructive inventory/import workflow.
- Release-manifest snapshot and restore.
- Staged deprecation/removal and endpoint offboarding.

## Phase 2

- Central privacy-safe endpoint convergence ledger/dashboard.
- Harness-neutral behavioral conformance suites beyond MVP smoke tests.
- Automatic per-task skill snapshot capture and rehydration.
- Portable cross-platform action contract for skill scripts.
- Consider a skill dependency graph and atomic lockfile only after demonstrated reuse pressure.
- Consider stronger artifact signing if the threat model justifies dedicated key management.

## Dependencies and sequencing

1. **Compatibility spike:** Empirically verify every target's current discovery, install, refresh, account-switch, global/project, activation, disable, uninstall, tombstone, and removal behavior. The personal Claude refresh result is the critical feasibility gate.
2. **Repository contract:** Define immutable IDs, manifest schema, overlays, deny semantics, and validation fixtures.
3. **Compiler and checks:** Build deterministic projections, validation, secret scanning, target previews, and smoke tests.
4. **Stable publication:** Implement per-skill candidates, stable index, quarantine, provider distribution revisions, and generated pull-request publication to the separate distribution repository.
5. **Local bootstrap/updater:** Implement one-pointer discovery, native scheduling, atomic install, drift protection, status, and updater self-update on macOS and Windows.
6. **Harness adapters:** Complete Codex and Claude Code global/project adapters, then Claude Desktop/Cowork personal and organization paths.
7. **Migration:** Inventory existing copies, prepare merge PRs, validate replacements, and archive only after confirmation.
8. **Lifecycle hardening:** Rollback, release restore, deprecation/removal, re-enrollment, offboarding, and recovery tests.
9. **Pilot:** Run with a small representative skill set before migrating the entire library.

Do not connect provider marketplaces to the source repository before stable publication isolation exists.

## Risks and mitigations

| Risk | Mitigation |
|---|---|
| Personal Claude lacks a supported automatic refresh interface | Run the compatibility spike first; use a prepared visible assisted action and report non-convergence honestly. |
| Provider paths or formats change | Discover at onboarding, version adapters, test current official behavior, and fail closed. |
| Same skill behaves differently by harness | Use one logical version, target smoke tests, generated previews, and later behavioral conformance suites. |
| Generated copy is edited locally | Preserve a drift patch before restoring; require PR review to become canonical. |
| A quarantined candidate leaks through a marketplace | Publish only stable artifacts to a separate generated distribution repository. |
| Secrets enter source or artifacts | Release-wide fail-closed scanning, least-privilege credentials, redacted logs, and protected local quarantine for legacy copies. |
| Automatic updater breaks itself | Stage, verify, health-check, retain prior updater, and roll back automatically. |
| Offline endpoints create false confidence | Report remote/provider state as unknown and never infer activation. |
| Windows filesystem semantics differ | Validate names/paths and use atomic directory/junction operations rather than requiring symlinks. |
| Organization policy blocks a Claude capability | Capability-detect during onboarding and provide exact remediation or assisted fallback. |

## Assumptions register

| ID | Assumption | Confidence | Impact if wrong | Verification |
|---|---|---:|---|---|
| ASM-1 | Personal Claude's Git-backed plugin path exposes a supported refresh mechanism usable by the local updater. | Low | Personal account requires assisted updates. | Phase 0 compatibility spike on both accounts and both OSes. |
| ASM-2 | Both Claude accounts can be represented independently even where local plugin storage is shared. | Medium | Enrollment/status logic needs account-aware indirection. | Account-switch tests during onboarding spike. |
| ASM-3 | Current Codex and Claude target locations/forms can be discovered reliably. | Medium | Some targets require explicit adapters or become unsupported. | Probe actual installed versions; confirm against official docs. |
| ASM-4 | GitHub admin authorization and the Claude organization GitHub App are available. | High, user-confirmed | Organization sync cannot be automatic. | Bootstrap permission check before configuration. |
| ASM-5 | A low-dependency cross-platform updater can use native scheduling and atomic switching on both OSes. | High | Onboarding and recovery complexity increases. | Minimal updater prototype on macOS and Windows. |
| ASM-6 | The skill set is tens to low hundreds of skills, not a public registry at massive scale. | High | Incremental build/cache design may need expansion. | Inventory during migration. |

## Success metrics and definition of done

- A new or modified representative skill is authored once, merged, and reaches every compatible online selected enrollment without file recreation.
- Onboarding a fresh endpoint begins with only the private GitHub repository pointer and completes without manual path/configuration editing.
- All known target failures block merge; post-merge failures cannot expose quarantined artifacts.
- A failed local installation automatically retains or restores last-known-good.
- A behaviorally bad release can be rolled back without changing unrelated skills or rewriting history.
- Existing divergent copies migrate through a reviewed PR and remain recoverable until owner confirmation.
- Status never labels an unknown, assisted, denied, or merely installed endpoint as active/synchronized.
- Secret fixtures reliably block all publication.
- Secret fixtures are blocked before merge; a simulated late discovery exercises redaction, revocation assessment, and history-remediation behavior.
- The compatibility spike either proves supported personal Claude automatic refresh or implements the explicit assisted fallback.

## Acceptance criteria

1. **Onboarding:** Given an authorized private GitHub repository pointer, bootstrap discovers and configures supported selected enrollments without manual paths, copies, manifest edits, or skill recreation.
2. **Permissions:** Required provider consent is explicit; missing GitHub/Claude authority stops with precise remediation and never causes credential sharing.
3. **Source boundary:** Local edits and unmerged branches never change managed endpoint projections.
4. **Determinism:** Identical source, generator, schema, and capabilities produce identical artifact digests.
5. **Validation:** Invalid IDs, paths, manifests, runtimes, schemas, or required targets block the affected change before promotion.
6. **Security precedence:** A source/generated secret finding blocks the pull request before merge. A simulated late finding stops the entire commit after merge, redacts output, and triggers credential/history remediation.
7. **Merge gate:** Any known required-target failure blocks the pull request.
8. **Per-skill isolation:** An unexpected post-merge failure holds that skill at last-known-good across all targets while unrelated valid skills may advance.
9. **Marketplace isolation:** A quarantined candidate never appears in the generated distribution repository or a Claude marketplace feed.
10. **Target denial:** An explicit deny produces no artifact/install for that target and reports `denied`, not `failed`.
11. **Local update:** An online endpoint stages the newest compatible stable projection on its periodic or supported startup check.
12. **Offline/auth failure:** The active version remains intact and retries use backoff without logging secrets.
13. **Activation:** Installed and active remain distinct; reload/next launch is required when the harness cannot reload live.
14. **Personal Claude:** Supported local refresh advances automatically; otherwise the prepared assisted action is visible and convergence is not claimed.
15. **Organization Claude:** Insufficient GitHub/organization authority fails setup without a shared-credential workaround. A promoted skill creates and merges a stable-only distribution pull request with a higher provider revision, and the organization marketplace receives that revision.
16. **Drift:** A modified generated copy is archived as a patch before restoration and cannot become canonical without a reviewed PR.
17. **Drift failure:** If patch preservation fails, the existing projection is untouched.
18. **Automatic rollback:** Failed installation/verification restores the prior digest without changing unrelated skills.
19. **Owner rollback:** Selecting a prior immutable logical version advances the stable index; providers that require forward-only versions receive the restored content under a new higher distribution revision, and all Claude targets converge.
20. **Migration:** Divergent copies produce a reviewable merge proposal; no original is overwritten or deleted automatically.
21. **Migration completion:** Reachable enrollments validate, unreachable/provider states remain pending/unknown, and originals archive only after explicit confirmation.
22. **Status:** Local status distinguishes desired, downloaded, installed, active, pinned, drifted, failed, denied, assisted-action-required, and unknown.
23. **Deletion:** Normal deletion disables/deprecates during the grace period, then removes generated copies while retaining history. A provider without supported removal reports assisted action required and cannot report completion prematurely.
24. **Re-enrollment:** Replacement auth/state validates before switching; old credentials revoke when possible and incomplete revocation is visible.
25. **Offboarding:** Schedules, managed copies, and endpoint credentials are removed while history and protected archives remain.
26. **Snapshot restore:** A release manifest reconstructs the exact enabled skill versions and artifact digests.
27. **Updater compatibility:** An incompatible updater keeps last-known-good and upgrades before applying the skill release.
28. **Updater self-update:** A new updater activates only after verification/health checks and restores its predecessor on failure.
29. **Cross-account/scope:** Both Claude accounts on both machines and global/project scopes are independently represented and verified, even when storage is shared.
30. **Claude authoring:** Cowork with repository capability opens the normal PR; without it, the bundle handoff preserves the change without reauthoring.
31. **Distribution trigger:** Provider-facing publication occurs only through a validated, merged distribution-repository pull request containing stable-index-approved artifacts and the required monotonically increasing version change.
32. **Rollback propagation:** A rollback integration test proves that Claude Code, supported personal Claude, and the organization marketplace receive restored logical content without a provider package downgrade.
33. **Provider removal:** Every Claude adapter is tested for disable/uninstall semantics; unsupported operations produce a prepared assisted action and remain incomplete until confirmed.
34. **Late secret recovery:** A post-merge secret fixture proves publication stops, logs remain redacted, possible credential revocation is surfaced, and history remediation is initiated.

## Validation strategy

| Layer | What it proves |
|---|---|
| Schema/unit checks | IDs, manifests, overlay precedence, target deny, path safety, stable-index transitions, and deterministic output. |
| Golden projection tests | The same canonical fixtures produce the expected Codex/Claude and macOS/Windows artifacts. |
| Security tests | Secret fixtures, ZIP traversal, symlink escape, malicious paths, unsafe runtime declarations, and redaction. |
| CI integration tests | Pre-merge and post-merge security gates, release-wide security precedence, per-skill isolation, quarantine, generated distribution pull requests, monotonic provider revisions, and rollback index changes. |
| macOS end-to-end tests | One-pointer bootstrap, `launchd`, path discovery, atomic switch, drift, Codex, Claude Code, and Desktop/Cowork activation. |
| Windows end-to-end tests | One-pointer bootstrap, Task Scheduler, path discovery, junction/rename switching, reserved/case/path edge cases, and all harness targets. |
| Account matrix tests | Personal and organization Claude accounts on both computers, including switching, permissions, shared-versus-account-specific plugin state, rollback propagation, and disable/uninstall/removal semantics. |
| Failure injection | Offline GitHub, expired credentials, disk full, corrupt artifacts, old updater, provider failure, and endpoint offline past deletion grace. |
| Migration rehearsal | Duplicate/divergent skills, missing IDs, suspected legacy secrets, unreachable endpoints, archive confirmation, and restore. |
| Manual product checks | Direct conversation-to-PR, bundle fallback, status language, assisted personal update, owner rollback, and emergency removal. |

## Open implementation questions

These do not require another product decision before implementation begins:

- Which exact local refresh interface current Claude Desktop/Cowork versions expose to the updater.
- Which discovered installation forms should be preferred when a harness supports both direct skill folders and plugin marketplaces.
- Whether GitHub release attestations are sufficient or a dedicated artifact-signing key is justified after threat modeling.
