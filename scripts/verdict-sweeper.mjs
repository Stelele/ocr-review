// verdict-sweeper.mjs — resolve OCR review threads whose finding no longer exists in the head code.
//
// Why: the action's resolve_outdated only resolves threads GitHub flags isOutdated (the
// commented lines left the diff) and skips threads a live finding still covers. A fix that
// REWRITES the commented lines in place — the most common kind — never becomes outdated, so
// the thread stays open forever even though the issue is dead. Verified experimentally on
// Stelele/zaio-week4-node-js-api#11 (2026-11-13): in-place fixes left threads open while
// line-removal fixes were auto-resolved.
//
// What this does (fail-closed at every step):
//   1. List unresolved review threads on the PR.
//   2. Keep only OCR-owned threads: first comment authored by a bot AND carrying the
//      `<!-- ocr-review-run:` marker; skip any thread a human has replied to.
//   3. For each, send the finding + the CURRENT head version of the file to the LLM and ask
//      whether the described problem still exists in the code.
//   4. Resolve the thread only on an explicit, high-confidence "fixed". Anything else —
//      still present, unclear, low confidence, LLM/parse error, file unreadable — is skipped.
//
// Config: OCR_LLM_URL / OCR_LLM_TOKEN / OCR_LLM_MODEL (same secrets the review step uses),
// GITHUB_TOKEN, OCR_REPOSITORY ("owner/name"), OCR_PR_NUMBER, OCR_HEAD_SHA.
// Optional: VERDICT_MAX_THREADS (default 25 per run), VERDICT_DELAY_MS (default 800).
//
// Usage: node verdict-sweeper.mjs [--dry-run]

const args = process.argv.slice(2)
const DRY_RUN = args.includes('--dry-run')

const REPO = process.env.OCR_REPOSITORY || ''
const PR_NUMBER = Number(process.env.OCR_PR_NUMBER || 0)
const HEAD_SHA = process.env.OCR_HEAD_SHA || ''
const LLM_URL = (process.env.OCR_LLM_URL || '').replace(/\/+$/, '')
const LLM_TOKEN = process.env.OCR_LLM_TOKEN || ''
const LLM_MODEL = process.env.OCR_LLM_MODEL || ''
const MAX_THREADS = Number(process.env.VERDICT_MAX_THREADS || 25)
const DELAY_MS = Number(process.env.VERDICT_DELAY_MS || 800)
const MAX_FILE_CHARS = 60000

if (!REPO || !PR_NUMBER || !HEAD_SHA) {
  console.error('[verdict-sweeper] OCR_REPOSITORY / OCR_PR_NUMBER / OCR_HEAD_SHA are required')
  process.exit(1)
}
if (!LLM_URL || !LLM_TOKEN || !LLM_MODEL) {
  console.error('[verdict-sweeper] OCR_LLM_URL / OCR_LLM_TOKEN / OCR_LLM_MODEL are required — failing fast instead of per-thread')
  process.exit(1)
}

const TOKEN = process.env.GITHUB_TOKEN
if (!TOKEN) {
  console.error('[verdict-sweeper] GITHUB_TOKEN is required')
  process.exit(1)
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function gql(query, variables = {}) {
  const res = await fetch('https://api.github.com/graphql', {
    method: 'POST',
    headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, variables }),
  })
  const body = await res.json()
  if (body.errors || !body.data) {
    throw new Error(`graphql: ${JSON.stringify(body.errors || body)}`)
  }
  return body.data
}

// Ownership marker: OCR tags every inline comment it posts with a per-run HTML
// comment. Observed formats on real PRs:
//   inline:   <!-- ocr-43487464466-1-fa6dc4387a4c2473 -->
//   summary:  <!-- ocr-summary-run:43455882475-1 -->
// Match any HTML comment that starts with "ocr" followed by a separator.
const OCR_MARKER_RE = /<!--\s*ocr[-_:]/
const BOT_LOGINS = new Set(['github-actions']) // GITHUB_TOKEN identity, no [bot] suffix in GraphQL

function isBotLogin(login) {
  return login.endsWith('[bot]') || BOT_LOGINS.has(login)
}

async function listCandidates() {
  const candidates = []
  const skipped = { resolved: 0, not_ocr: 0, human_replied: 0 }
  let cursor = null
  let counted = 0
  let truncated = false
  // Paginate: a PR can have more than 100 threads, and silently missing the
  // rest would be exactly the staleness this sweeper exists to clear.
  while (true) {
    const data = await gql(
      `query($owner: String!, $name: String!, $number: Int!, $cursor: String) {
        repository(owner: $owner, name: $name) {
          pullRequest(number: $number) {
            reviewThreads(first: 100, after: $cursor) {
              totalCount
              pageInfo { hasNextPage endCursor }
              nodes {
                id
                isResolved
                path
                comments(first: 100) {
                  totalCount
                  nodes { author { login } body }
                }
              }
            }
          }
        }
      }`,
      { owner: REPO.split('/')[0], name: REPO.split('/')[1], number: PR_NUMBER, cursor }
    )
    const conn = data.repository.pullRequest.reviewThreads
    counted = conn.totalCount
    for (const t of conn.nodes) {
      if (t.isResolved) { skipped.resolved++; continue }
      const first = t.comments.nodes[0]
      const login = first?.author?.login || ''
      if (!first || !isBotLogin(login) || !OCR_MARKER_RE.test(first.body)) {
        skipped.not_ocr++; continue
      }
      const humanReply = t.comments.nodes.some((c) => !isBotLogin(c.author?.login || ''))
      if (humanReply) { skipped.human_replied++; continue }
      // Strip marker comments and shields.io severity badges; keep the prose finding.
      const finding = first.body
        .replace(/<!--[\s\S]*?-->/g, '')
        .replace(/!\[[^\]]*\]\(https:\/\/img\.shields\.io[^)]*\)/g, '')
        .trim()
      candidates.push({ id: t.id, path: t.path, finding })
    }
    if (!conn.pageInfo.hasNextPage || !conn.pageInfo.endCursor) {
      truncated = conn.pageInfo.hasNextPage && !conn.pageInfo.endCursor
      break
    }
    cursor = conn.pageInfo.endCursor
  }
  if (truncated) {
    console.log(`[verdict-sweeper] warning: thread listing truncated (cursor missing); ${candidates.length} of ${counted} threads seen`)
  }
  return { candidates, skipped, total: counted }
}

// Sentinel: the file exists but is too large to judge reliably. A truncated
// file must produce "unclear", never "fixed" — resolution is destructive and
// a partial view could hide the very code the finding is about.
const FILE_TOO_LARGE = Symbol('file-too-large')

async function headFile(path) {
  const url = `https://api.github.com/repos/${REPO}/contents/${encodeURIComponent(path)}?ref=${HEAD_SHA}`
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${TOKEN}`, Accept: 'application/vnd.github.raw' },
  })
  if (res.status === 404) return null // file deleted in head: the finding is moot
  if (!res.ok) throw new Error(`contents ${path}: HTTP ${res.status}`)
  const text = await res.text()
  if (text.length > MAX_FILE_CHARS) {
    console.log(`[verdict-sweeper] ${path}: file exceeds ${MAX_FILE_CHARS} chars, skipping (fail-closed)`)
    return FILE_TOO_LARGE
  }
  return text
}

async function verdict(finding, path, content) {
  const system =
    'You adjudicate code-review findings against the current version of a file. ' +
    'Answer with ONLY a JSON object, no markdown fences, in this exact shape: ' +
    '{"verdict": "fixed" | "still_present" | "unclear", "confidence": "high" | "low"}. ' +
    'Say "fixed" ONLY when the file content clearly shows the described problem no longer ' +
    'exists. If the problem still exists in any form, say "still_present". If you cannot ' +
    'tell from the file alone, say "unclear". Be strict: ambiguous cases are "unclear".'
  const user =
    `Review finding (about file \`${path}\`):\n"""${finding}"""\n\n` +
    `Current version of \`${path}\` at the PR head:\n"""\n${content}\n"""\n\n` +
    'Does the problem described in the finding still exist in the current file content?'

  const res = await fetch(`${LLM_URL}/chat/completions`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${LLM_TOKEN}`,
      'Content-Type': 'application/json',
      'x-opencode-session': 'verdict-sweeper',
    },
    body: JSON.stringify({
      model: LLM_MODEL,
      temperature: 0,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
    }),
  })
  if (!res.ok) throw new Error(`llm HTTP ${res.status}`)
  const body = await res.json()
  const text = body.choices?.[0]?.message?.content || ''
  // Tolerate fences if the model adds them despite instructions.
  const m = text.match(/\{[\s\S]*\}/)
  if (!m) throw new Error(`llm returned no JSON: ${text.slice(0, 120)}`)
  const parsed = JSON.parse(m[0])
  if (!['fixed', 'still_present', 'unclear'].includes(parsed.verdict)) {
    throw new Error(`llm verdict out of range: ${parsed.verdict}`)
  }
  return parsed
}

async function resolveThread(id) {
  const data = await gql(
    `mutation($id: ID!) {
      resolveReviewThread(input: { threadId: $id }) {
        thread { isResolved }
      }
    }`,
    { id }
  )
  return data.resolveReviewThread.thread.isResolved
}

const outcome = { candidates: 0, llm_calls: 0, resolved: 0, would_resolve: 0, skipped: [], failures: 0 }

try {
  const { candidates, skipped, total } = await listCandidates()
  console.log(`[verdict-sweeper] threads=${total} resolved_before=${skipped.resolved} not_ocr=${skipped.not_ocr} human_replied=${skipped.human_replied} candidates=${candidates.length}`)
  outcome.candidates = candidates.length

  for (const c of candidates.slice(0, MAX_THREADS)) {
    const short = c.finding.replace(/\s+/g, ' ').slice(0, 90)
    try {
      const content = await headFile(c.path)
      if (content === null) {
        // The whole file was deleted in head — the finding cannot apply anymore.
        if (DRY_RUN) { console.log(`[verdict-sweeper] ${c.path}: file deleted, would resolve "${short}"`); outcome.would_resolve++; continue }
        const ok = await resolveThread(c.id)
        if (ok) { console.log(`[verdict-sweeper] resolved ${c.path} (file deleted): "${short}"`); outcome.resolved++ }
        continue
      }
      if (content === FILE_TOO_LARGE) {
        // Fail-closed: a partial file view could hide the problem the finding
        // describes, so an oversized file can never earn a "fixed" verdict.
        console.log(`[verdict-sweeper] skipped ${c.path} (file too large): "${short}"`)
        outcome.skipped.push(`${c.path}: unclear/file_too_large`)
        continue
      }
      await sleep(DELAY_MS)
      outcome.llm_calls++
      const v = await verdict(c.finding, c.path, content)
      if (v.verdict === 'fixed' && v.confidence === 'high') {
        if (DRY_RUN) {
          console.log(`[verdict-sweeper] ${c.path}: verdict=fixed/high, would resolve "${short}"`)
          outcome.would_resolve++
        } else {
          const ok = await resolveThread(c.id)
          if (ok) { console.log(`[verdict-sweeper] resolved ${c.path} (verdict=fixed/high): "${short}"`); outcome.resolved++ }
          else { console.log(`[verdict-sweeper] resolve mutation returned false for ${c.path}`); outcome.failures++ }
        }
      } else {
        console.log(`[verdict-sweeper] skipped ${c.path} (verdict=${v.verdict}/${v.confidence}): "${short}"`)
        outcome.skipped.push(`${c.path}: ${v.verdict}/${v.confidence}`)
      }
    } catch (e) {
      outcome.failures++
      console.log(`[verdict-sweeper] FAIL ${c.path} "${short}": ${e.message}`)
    }
  }

  console.log(`[verdict-sweeper] done candidates=${outcome.candidates} llm_calls=${outcome.llm_calls} ${DRY_RUN ? `would_resolve=${outcome.would_resolve}` : `resolved=${outcome.resolved}`} unclear_or_present=${outcome.skipped.length} failures=${outcome.failures}${DRY_RUN ? ' (dry-run, nothing mutated)' : ''}`)
} catch (e) {
  console.error(`[verdict-sweeper] fatal: ${e.message}`)
  process.exit(1)
}
