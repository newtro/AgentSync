# crew.json reference

Per-project configuration at `.claude/crew.json`. Everything is optional: `crew.mjs` infers what it can from the repository and merges declared values over the inferred ones. `crew.mjs init` writes the inferred config out so you can correct it; `crew.mjs config` shows what is actually in effect.

```json
{
  "version": 1,
  "verify": {
    "typecheck": "npm run typecheck",
    "lint": "npm run lint",
    "test": "npm test",
    "build": "npm run build"
  },
  "run": { "name": "dev" },
  "parallel": { "maxWorkers": 3 },
  "tiers": {
    "orchestrator": "opus",
    "executor": "opus",
    "reviewer": "opus",
    "verifier": "sonnet",
    "validator": "sonnet",
    "scout": "haiku"
  },
  "reviewers": ["codex", "claude"],
  "outtake": "branch",
  "stateRoot": null
}
```

## Fields

| Field | Meaning |
|---|---|
| `verify` | The project's own commands. Run in order typecheck → lint → test → build, stopping at the first failure. Any key may be omitted. |
| `run` | Name of a `.claude/launch.json` configuration, for agents that need the app running to verify a user-visible change. |
| `parallel.maxWorkers` | Concurrent executors. Raise only if the machine and the provider's rate limits allow it; background agents die on 429s. |
| `tiers` | Model per role. See `tiering.md`. |
| `reviewers` | Review providers to prefer, in order. Detected from what is installed when absent. |
| `outtake` | `branch`, `github-pr`, `none`, or an adapter name the caller understands. The engine never pushes on its own. |
| `stateRoot` | Override the state directory. Default `~/.claude/crew/<repo-slug>/`, deliberately outside the project. |

## Inference

When `.claude/crew.json` is absent, `verify` is inferred from what the repository declares:

| Detected | Inferred |
|---|---|
| `package.json` | its own `test` / `build` / `lint` / `typecheck` scripts, via npm, pnpm, or yarn based on the lockfile |
| `*.sln`, `*.slnf`, `*.csproj` | `dotnet test`, `dotnet build` |
| `pyproject.toml`, `pytest.ini`, `setup.cfg` | `pytest`, `ruff check .` |
| `Cargo.toml` | `cargo test`, `cargo build`, `cargo clippy` |
| `go.mod` | `go test ./...`, `go build ./...`, `go vet ./...` |

Inference is a convenience, not a contract. If `crew.mjs doctor` reports no verification commands, declare them rather than proceeding - a build loop that cannot verify is not this skill.

## State layout

```
~/.claude/crew/<repo-slug>/
├── queue/            pending briefs
│   ├── running/      claimed (atomic rename; two workers cannot claim one brief)
│   └── done/         completed, prefixed done- or failed-
├── reports/          agent and review reports, each ending in REPORT-END
├── worktrees/        one isolated checkout per unit of work
└── logs/             raw provider output for failed runs
```

Nothing is written inside the project. `<repo-slug>` is the directory name plus a short hash of its absolute path, so two clones of the same repository never share state.

## Environment

| Variable | Effect |
|---|---|
| `CREW_STATE_ROOT` | Overrides the state directory for one invocation. |
| `CLAUDE_CONFIG_DIR` | Also relocates the default state root. Pointing this at a second Claude profile runs workers against a separate usage pool. |

## Secrets in a worktree

A worktree is a fresh checkout: it has no `.env`, so a suite that needs one will
not run there. Copying the project's `.env` in is the obvious fix and is usually
right, but that file is typically the whole production credential set - database
URLs, cloud keys, SMTP passwords, encryption keys - now sitting in a second
location outside the repository, outside its `.gitignore`, and easy to forget.

Before copying one in, read it and check what the tests actually need. Point the
copy at a local database rather than a production one. Confirm the file is
untracked in the worktree (`git ls-files --error-unmatch .env`) and that no
secret reached the commit, rather than assuming the root `.gitignore` covers a
path it was not written for.

Delete it when the unit retires. `crew worktree rm` removes the checkout, so run
it - but remove the credential file first and verify it is gone, because a
failed or partial removal leaves the secrets behind and reports success for the
worktree.
