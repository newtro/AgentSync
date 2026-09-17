# Model tiering

The engine's biggest lever on cost is not which model answers the first prompt - it is which model each *role* runs at for the rest of the job. An untiered crew runs reviewers, verifiers, and validators at the same tier as executors and spends most of its budget on work that did not need the top model.

## Published rates, per million tokens

| Model | Input | Output | Relative to Sonnet 5 |
|---|---|---|---|
| Fable 5.1 | $10 | $50 | 5× |
| Opus 5 | $5 | $25 | 2.5× |
| Sonnet 5 | $2 | $10 | — |
| Haiku 4.5 | $1 | $5 | 0.5× |

Subscription plans meter consumption rather than dollars, but the relative weights track these ratios closely enough to plan against.

## Defaults and why

| Role | Default | Reasoning |
|---|---|---|
| Orchestrator | `opus` | Few turns, but every one is a judgment call that shapes the rest: grouping, triage, integration, what to defer. |
| Executor | `opus` | Writes real code against a codebase it is discovering. The work most sensitive to capability. |
| Reviewer | `opus` | Exists to catch what the executor missed. A cheap reviewer defeats the gate and is worse than no gate, because it produces a clean report. |
| Verifier | `sonnet` | Drives documented repro steps, captures screenshots, compares against stated criteria. Mechanical, with the answer available. |
| Validator | `sonnet` | Walks requirements against a diff. Checklist work. |
| Scout | `haiku` | Locating files, enumerating candidates, mechanical sweeps whose output is checked downstream. |

Reviewer stays expensive on purpose. When trimming, trim verifier, validator, and scout first - together they are usually the larger share of agent-turns.

## Two rules that beat the table

**Never re-tier mid-session.** Prompt caches are model-scoped. Switching models inside a running session discards the cached prefix, and on a long agentic session that can cost more than the cheaper model saves. Tier only where an agent is spawned.

**Try lower effort before a cheaper model.** Effort trades depth within one model and keeps a single cache namespace. Lower effort on a current model frequently matches or beats a previous-generation model at high effort. Measure that before building a multi-model cascade.

## Measuring

Judge cost per *completed unit*, not per request. A cheaper model that needs three review cycles to pass the gate is not cheaper. When a tier change lands, compare: units completed, review cycles per unit, findings caught by the reviewer, and total agent-turns.

## Separate usage pools

Setting `CLAUDE_CONFIG_DIR` to a second Claude profile runs workers against a different account's limits. Combined with tiering this is often the difference between finishing a large run and hitting a weekly cap partway through. Reviewers on a different provider entirely (Codex, Grok) both widen the pool and give genuine adversarial independence - a different model family finds different defects.

## What a gated run actually costs

One unit on 2026-09-17 - correcting a mail client that displayed SMTP envelope
senders instead of `From:` headers - took five executor passes and five
adversarial reviews, about 1.35M subagent tokens, to reach a clean verdict.

The first pass passed every gate that is not a reviewer: typecheck clean, 1064
tests green, build clean, and a confident report. It shipped a working phishing
surface - display names were sanitized, addresses were not, so an address
carrying U+202E rendered as a different domain entirely. The test that claimed to
cover it asserted on the database row and never rendered the component, so it
passed while the interface failed.

Rounds two through five found three further ways a malformed API response could
permanently corrupt sender identity, each of which also set the flag that
excluded the row from the backfill built to repair it. None of these were
reachable from the test suite.

Two things that run is evidence for:

- **Keep the reviewer at the top tier.** A cheaper reviewer is worse than no
  reviewer, because it returns a clean report and the loop stops.
- **Reviewers are not oracles either.** Round two produced a confident BLOCKER
  that was wrong at that commit, and the orchestrator produced a confident
  rebuttal that was also wrong, because its probe printed escaped and unescaped
  characters identically. The disagreement was settled in thirty seconds by
  executing the function. Require executed evidence for any claim about
  characters, layout, or protocol shape - from the executor, from the reviewer,
  and from yourself.
