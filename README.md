# ocr-review (shared)

Reusable [`workflow_call`](https://docs.github.com/en/actions/using-workflows/reusing-workflows)
workflow that runs [OpenCodeReview](https://github.com/alibaba/open-code-review)
on pull requests, with the account-wide tuned configuration:

- `incremental` — never re-posts a finding whose (path, line) already has a bot comment
- `checkpoint_range` — next push reviews only what changed since the last reviewed head
- `resolve_outdated` — auto-resolves the bot's own stale threads (needs `contents: write` from the caller)
- `route_severity_below: low` + `route_categories: style,documentation,other` — noise goes to the sticky summary, inline stays actionable

## One thing to edit, everywhere

Config changes are made **only here**. Each consumer repo's
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
