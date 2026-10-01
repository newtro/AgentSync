# Package & Library Research

Check every library, framework, or tool against current sources rather than
memory. Training data lags real releases, so versions, deprecations,
renamed packages, and security advisories recalled from it are often wrong,
and a plan built on them can pick a vulnerable or abandoned dependency.

## When to research

- The user is choosing between libraries or frameworks.
- A tech stack is being specified.
- Dependencies or integrations are discussed.
- Any package is mentioned by name.

## How to research

Use WebSearch to find authoritative sources and WebFetch to read them. Prefer
primary sources: the package registry page (npm, PyPI, crates.io, NuGet, …),
the project's GitHub releases or changelog, and its official docs.

- **Current version:** search for the package's releases or changelog, then
  fetch the registry page or releases page and read the version and release
  date from it. Do not put a year in the query; read the date off the source.
- **Security:** search for "[package] security advisory" or "[package] CVE",
  and check the GitHub advisory database or the project's security page.
- **Comparisons:** search for "[package] vs [alternative]", then confirm any
  claim that matters against each project's own docs.
- **API details** needed to judge fit: fetch the official documentation page
  for the version you found.

Record what you find under `## Research Notes` in the draft, with the source
URL, and log the lookup in the transcript.

## What to capture for the plan

- Current stable version and its release date.
- Known security advisories or deprecation notices.
- Breaking changes between major versions that affect the plan.
- License.
- Compatibility with the other chosen packages and the target runtime.

## Raise these with the user

- No release in 12+ months.
- Known unpatched CVEs.
- Deprecated in favor of another package.
- A required major upgrade with breaking changes.
- A license that conflicts with the project.

## During the interview

When a package comes up in any phase, look it up before your next question.
If you find something important (deprecated, vulnerable, a better-maintained
alternative), work it into the next question as useful context rather than a
correction, e.g. "I looked into [package]: v4 shipped last month with breaking
changes to the API you mentioned. Worth factoring in?"
