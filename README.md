# ocr-review (shared)

Reusable self-test marker -8f3- [`workflow_call`](https://docs.github.com/en/actions/using-workflows/reusing-workflows)
workflow that runs [OpenCodeReview](https://github.com/alibaba/open-code-review)
on pull requests, with the account-wide tuned configuration:

- `incremental` — never re-posts a finding whose (path, line) already has a bot comment
- `checkpoint_range` — the next push reviews only what changed since the last reviewed head
- `resolve_outdated` — auto-resolves the bot's own stale threads (caller must grant `contents: write`)
- `verdict sweeper` (`scripts/verdict-sweeper.mjs`) — after the review, each unresolved
  OCR-owned thread is judged against the **current head version of the file**; threads
  whose finding no longer holds are resolved on a confident "fixed". Catches in-place
  fixes, which never become `outdated` and so are invisible to `resolve_outdated`.
  Fail-closed: human-replied threads, non-OCR threads, low-confidence and unclear
  verdicts are all left alone. One cheap LLM call per lingering thread.
- `route_severity_below: low` + `route_categories: style,documentation,other` — noise goes to the sticky summary; inline comments stay actionable

## One config, everywhere

Edit the reviewer configuration **only here**. Each consumer repo's
`.github/workflows/ocr-review.yml` is a dispatcher:

```yaml
name: ocr-review
on:
  pull_request:
    types: [opened, synchronize, reopened]

permissions:
  contents: write   # resolve_outdated needs it
  pull-requests: write

jobs:
  review:
    name: ai code review
    uses: Stelele/ocr-review/.github/workflows/ocr-review.yml@main
    secrets: inherit   # OCR_LLM_URL / OCR_LLM_TOKEN / OCR_LLM_MODEL of that repo
```

### Bumping the pinned action

```sh
gh api repos/alibaba/open-code-review/releases/latest --jq .target_commitish
```

then update the `uses:` SHA below, push a PR, and confirm a green self-run here.
