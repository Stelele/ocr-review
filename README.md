# ocr-review (shared)

Reusable self-test marker -8f3- [`workflow_call`](https://docs.github.com/en/actions/using-workflows/reusing-workflows)
workflow that runs [OpenCodeReview](https://github.com/alibaba/open-code-review)
on pull requests, with the account-wide tuned configuration:

- `incremental` — never re-posts a finding whose (path, line) already has a bot comment
- `checkpoint_range` — the next push reviews only what changed since the last reviewed head
- `resolve_outdated` — auto-resolves the bot's own stale threads (caller must grant `contents: write`)
- `verdict sweeper` (inlined in the workflow as `SWEEPER_SCRIPT`) — after the review, each
  unresolved OCR-owned thread is judged against the **current head version of the file**
  (fetched via the git trees API, so existence is verified and paths never hit
  URL-encoding edge cases); threads whose finding no longer holds are resolved on a
  confident "fixed" whose **evidence quote is verified verbatim against the head file**.
  Catches in-place fixes, which never become `outdated` and so are invisible to
  `resolve_outdated`. Fail-closed: human-replied threads, non-OCR threads, low-confidence
  and unclear verdicts are all left alone. One cheap LLM call per lingering thread. The
  step is `continue-on-error` and **skipped for fork PRs** (fork file content is
  attacker-controlled input to the verdict LLM).
- `two-stage gate` (per-repo opt-in: set the `VERDICT_JEV_SCREEN` variable to `"true"`) —
  stage 1 screens every unresolved thread with a **calibrated Noul** (`jev-1.13-free` via
  OpenCode's System One endpoint — hardcoded, *not* a variable, so a settings-writable
  value can never repoint a request that carries code and the token — sharing the
  existing `OCR_LLM_TOKEN` secret), batched per file: `noul < VERDICT_JEV_RESOLVE_BELOW`
  (default 0.2) **and** severity ≤ medium **and** the file changed vs merge-base →
  resolve without a reasoning-LLM call; `noul > VERDICT_JEV_PRESENT_ABOVE` (default 0.7)
  → keep open without one; everything else (middle band, high/critical severity, badge
  less findings, unchanged files) escalates to stage 2. Measured on 608 real threads
  (15 labeled + a 594-thread backlog replay): **zero false resolves below 0.2**, errors
  are one-directional (threads stay open), and 70% of threads decided without the
  reasoning LLM (594 threads judged in 0.8 min at $0 on the free tier). Jev failures
  fall through to stage 2.
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
