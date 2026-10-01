# Coverage Lenses

The domain-agnostic checklist that drives the Flush-Out Loop (Phase 4.5).
For each accepted concept and each core flow, consider every lens: resolve the
sub-decisions it exposes, or mark it `N/A`. Adapt the wording to the subject.
Not every lens fits every brainstorm, but leaving one out should be a decision
you can name, not an oversight.

Several of these topics (constraints, non-goals, edge cases, tradeoffs) also
come up in Discovery and Exploration. The overlap is deliberate: the earlier
phases collect intent opportunistically, while this pass verifies that nothing
fell through. A topic that came up earlier still needs confirming as resolved.

1. **Actors & permissions** — Who can do this, and to whom or what? Which roles
   exist? Does it apply to every actor type or only some? What needs
   authentication or authorization, and what stops the wrong actor?
2. **Triggers & preconditions** — What starts this? What state must already
   exist? Are there thresholds, cooldowns, rate limits, or frequency caps?
3. **Inputs & validation** — What data comes in? Valid ranges and formats?
   Required versus optional? What happens on malformed, missing, or hostile
   input?
4. **Core flow (happy path)** — What is the exact success sequence end to end?
   Is every step specified, or are some hand-waved?
5. **State, lifecycle & data model** — Which entities exist, and what are their
   relationships, identity, ownership, and cardinality? How are they created,
   updated, and deleted? What is the source of truth? What persists and what is
   ephemeral?
6. **Edge & boundary cases** — Empty, zero, one, many, max. Duplicates.
   Simultaneous occurrences. Out-of-order events. The first time and the last
   time. What happens at each boundary?
7. **Failure modes & recovery** — What happens on error, timeout, partial
   failure, or conflict? Is the operation idempotent? Are there retries,
   rollbacks, or compensating actions? What state does a failure leave behind?
8. **Concurrency & ordering** — Can two actors do this at once? Are there race
   conditions, locking needs, or ordering guarantees?
9. **Scale & performance** — Expected volume now and later. Limits,
   pagination, batching, cost. What breaks at 10x or 100x?
10. **Interactions & side effects** — How does this touch existing systems and
    other accepted concepts? What does it replace or contradict? What cascades
    when it fires?
11. **Termination & success conditions** — How does it end, complete, win, or
    get marked done? What is the steady state? Is there cleanup?
12. **Migration & backward compatibility** — What happens to existing data,
    in-flight state, or legacy behavior when this ships? Is a migration needed?
13. **Security, privacy & abuse** — How is sensitive data handled? What are the
    abuse or exploit vectors? What is the worst a malicious actor could do?
14. **Observability & validation** — How do we know it worked? What is the
    acceptance criterion? How will it be tested? What should be logged or
    measured?
15. **UX & error surfacing** — How is this shown to the user, including the
    unhappy paths? What does the user see on success, on error, when empty,
    and while waiting?
